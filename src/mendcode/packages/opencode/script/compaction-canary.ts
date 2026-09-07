import { createHash } from "node:crypto"
import { performance } from "node:perf_hooks"
import { writeFile } from "node:fs/promises"

export type CanaryStrategy = "portable" | "native"
export type CanaryMode = "fixture" | "live"

export type FixtureState = {
  readonly facts: readonly string[]
  readonly actions: readonly string[]
  readonly latestIntent: string
  readonly constraints: readonly string[]
  readonly toolPairs: readonly { readonly callID: string; readonly resultID: string }[]
}

export type FixtureCorpus = {
  readonly name: "medium" | "large"
  readonly text: string
  readonly expected: FixtureState
  readonly sha256: string
  readonly estimatedInputTokens: number
  readonly tokenMethod: "utf8-bytes-divided-by-four"
}

export type CanaryResult = {
  readonly mode: CanaryMode
  readonly strategy: CanaryStrategy
  readonly corpus: Pick<FixtureCorpus, "name" | "sha256" | "estimatedInputTokens" | "tokenMethod">
  readonly status: "PASS" | "FAIL" | "NOT_RUN"
  readonly evidenceKind: "synthetic-fixture" | "live-provider"
  readonly fidelity?: {
    readonly facts: boolean
    readonly actions: boolean
    readonly latestIntent: boolean
    readonly constraints: boolean
    readonly toolPairs: boolean
  }
  readonly timingMs?: {
    readonly preparation: number
    readonly compaction: number
    readonly installation: number
    readonly resume: number
    readonly total: number
  }
  readonly reason?: string
}

const facts = Array.from({ length: 20 }, (_, index) => `fact-${index + 1}: retained sanitized fact ${index + 1}`)
const actions = Array.from({ length: 5 }, (_, index) => `action-${index + 1}: pending follow-up ${index + 1}`)
const constraints = [
  "preserve the latest user intent",
  "do not repeat completed work",
  "keep tool call/result pairs valid",
  "retain the original language",
]
const toolPairs = Array.from({ length: 5 }, (_, index) => ({ callID: `call-${index + 1}`, resultID: `result-${index + 1}` }))

export const fixtureState: FixtureState = {
  facts,
  actions,
  latestIntent: "Continue the bounded implementation from the latest correction.",
  constraints,
  toolPairs,
}

const fixtureBody = (targetTokens: number) => {
  const header = [
    "SANITIZED COMPACTION CANARY",
    `latest-intent: ${fixtureState.latestIntent}`,
    ...fixtureState.facts,
    ...fixtureState.actions,
    ...fixtureState.constraints.map((item) => `constraint: ${item}`),
    ...fixtureState.toolPairs.map((pair) => `tool: ${pair.callID} -> ${pair.resultID}`),
  ].join("\n")
  const filler = "context filler preserves ordering and language without adding instructions.\n"
  return `${header}\n${filler.repeat(Math.max(1, Math.ceil((targetTokens * 4 - header.length) / filler.length)))}.END\n`
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")
const estimateTokens = (value: string) => Math.max(1, Math.ceil(new TextEncoder().encode(value).length / 4))

export function fixtureCorpora(): readonly FixtureCorpus[] {
  return [30_000, 100_000].map((target, index) => {
    const text = fixtureBody(target)
    return {
      name: index === 0 ? "medium" : "large",
      text,
      expected: fixtureState,
      sha256: sha256(text),
      estimatedInputTokens: estimateTokens(text),
      tokenMethod: "utf8-bytes-divided-by-four",
    }
  })
}

export function compactFixture(input: { readonly strategy: CanaryStrategy; readonly corpus: FixtureCorpus }): FixtureState {
  // The fixture provider models a settled compaction boundary. The native
  // branch keeps an opaque checkpoint conceptually, while the portable branch
  // keeps a bounded summary. Both must preserve the same deterministic oracle.
  void input.strategy
  return structuredClone(input.corpus.expected)
}

export function corruptedFixture(state: FixtureState, kind: "missing-fact" | "broken-tool-pair" | "wrong-intent") {
  if (kind === "missing-fact") return { ...state, facts: state.facts.slice(1) }
  if (kind === "broken-tool-pair") return { ...state, toolPairs: state.toolPairs.slice(0, -1) }
  return { ...state, latestIntent: "Do an unrelated action." }
}

export function checkFixtureFidelity(actual: FixtureState, expected: FixtureState) {
  return {
    facts: JSON.stringify(actual.facts) === JSON.stringify(expected.facts),
    actions: JSON.stringify(actual.actions) === JSON.stringify(expected.actions),
    latestIntent: actual.latestIntent === expected.latestIntent,
    constraints: JSON.stringify(actual.constraints) === JSON.stringify(expected.constraints),
    toolPairs: JSON.stringify(actual.toolPairs) === JSON.stringify(expected.toolPairs),
  }
}

const fidelityPassed = (fidelity: CanaryResult["fidelity"]) => Boolean(fidelity && Object.values(fidelity).every(Boolean))

export function runFixtureCanary(strategy: CanaryStrategy, corpus: FixtureCorpus): CanaryResult {
  const started = performance.now()
  const preparation = performance.now()
  const prepared = structuredClone(corpus)
  const afterPreparation = performance.now()
  const actual = compactFixture({ strategy, corpus: prepared })
  const afterCompaction = performance.now()
  const fidelity = checkFixtureFidelity(actual, corpus.expected)
  const afterInstallation = performance.now()
  // Fixture resume is intentionally local and deterministic; it is not a
  // provider round trip and must never be reported as live native latency.
  const afterResume = performance.now()
  return {
    mode: "fixture",
    strategy,
    corpus: {
      name: corpus.name,
      sha256: corpus.sha256,
      estimatedInputTokens: corpus.estimatedInputTokens,
      tokenMethod: corpus.tokenMethod,
    },
    status: fidelityPassed(fidelity) ? "PASS" : "FAIL",
    evidenceKind: "synthetic-fixture",
    fidelity,
    timingMs: {
      preparation: afterPreparation - preparation,
      compaction: afterCompaction - afterPreparation,
      installation: afterInstallation - afterCompaction,
      resume: afterResume - afterInstallation,
      total: afterResume - started,
    },
  }
}

export function liveCanaryUnavailable(strategy: CanaryStrategy, corpus?: FixtureCorpus): CanaryResult {
  return {
    mode: "live",
    strategy,
    corpus: corpus
      ? { name: corpus.name, sha256: corpus.sha256, estimatedInputTokens: corpus.estimatedInputTokens, tokenMethod: corpus.tokenMethod }
      : { name: "medium", sha256: "not-provided", estimatedInputTokens: 0, tokenMethod: "utf8-bytes-divided-by-four" },
    status: "NOT_RUN",
    evidenceKind: "live-provider",
    reason: "Live mode requires a separately authorized provider route, credentials, sanitized corpus and spend cap; this command never auto-enables them.",
  }
}

function option(name: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

export async function main() {
  const mode = (option("--mode") ?? "fixture") as CanaryMode
  const strategy = (option("--strategy") ?? "portable") as CanaryStrategy
  if (mode !== "fixture" && mode !== "live") throw new Error("--mode must be fixture or live")
  if (strategy !== "portable" && strategy !== "native") throw new Error("--strategy must be portable or native")

  const corpora = fixtureCorpora()
  const results = mode === "fixture"
    ? corpora.map((corpus) => runFixtureCanary(strategy, corpus))
    : [liveCanaryUnavailable(strategy, corpora[0])]
  const output = JSON.stringify({ mode, strategy, results }, null, 2)
  const outputPath = option("--output")
  if (outputPath) await writeFile(outputPath, `${output}\n`, "utf8")
  process.stdout.write(`${output}\n`)
}

if (import.meta.main) {
  await main()
}
