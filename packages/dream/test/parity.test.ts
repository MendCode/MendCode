import { describe, expect, test } from "bun:test"
import { createIdFactory, DreamReport, type EvolutionSuggestion, type MemoryEntry, type SessionEvent } from "@mendcode/protocol"
import { buildDigest, collectEvidence, DIGEST_LIMITS, fingerprint, runDream, type DigestCache, type EvolutionPort, type ProposalOutcome } from "../src"

const ids = createIdFactory()
const SECRET = "sk-abcdEFGH1234ijklMNOP5678"

function session(pairs: Array<[string, string]>, title = "t") {
  const sessionId = ids("session")
  let seq = 0
  const events: SessionEvent[] = []
  const ev = (e: Record<string, unknown>) => void events.push({ sessionId, seq: ++seq, at: 0, ...e } as SessionEvent)
  const turnId = ids("turn")
  for (const [user, agent] of pairs) {
    const u = ids("item")
    const a = ids("item")
    ev({ type: "item.started", turnId, itemId: u, kind: "user_message" })
    ev({ type: "item.completed", itemId: u, status: "ok", text: user })
    ev({ type: "item.started", turnId, itemId: a, kind: "agent_message" })
    ev({ type: "item.completed", itemId: a, status: "ok", text: agent })
  }
  return { sessionId, title, events, seq }
}

const memory = (text: string, patch: Partial<MemoryEntry> = {}): MemoryEntry => ({ memoryId: ids("memory"), scope: "project", directory: "/repo", text, category: "commands", status: "saved", source: "user", createdAt: 0, updatedAt: 0, ...patch })

function cacheOf(): DigestCache & { puts: number; rows: Map<string, { sourceSeq: number; version: number; payload: string }> } {
  const rows = new Map<string, { sourceSeq: number; version: number; payload: string }>()
  return {
    rows,
    puts: 0,
    get(sessionId, input) {
      const row = rows.get(sessionId)
      return row && row.sourceSeq === input.sourceSeq && row.version === input.version ? row.payload : undefined
    },
    put(sessionId, input) {
      this.puts++
      rows.set(sessionId, input)
    },
  }
}

describe("session digests", () => {
  test("a digest of a huge conversation stays bounded and keeps the first request and the newest exchange", () => {
    const pairs: Array<[string, string]> = Array.from({ length: 400 }, (_, i) => [`question number ${i} ${"x".repeat(300)}`, `answer number ${i} ${"y".repeat(300)}`])
    const digest = buildDigest(session(pairs).events)
    expect(digest.messages).toBe(800)
    expect(digest.lines.length).toBeLessThanOrEqual(DIGEST_LIMITS.lines)
    expect(digest.lines[0]).toContain("question number 0 ")
    expect(digest.lines.at(-1)).toContain("answer number 399 ")
    const chars = digest.lines.reduce((total, line) => total + line.length, 0)
    expect(chars).toBeLessThanOrEqual(DIGEST_LIMITS.chars + DIGEST_LIMITS.lineChars + 16)
    expect(JSON.stringify(digest).length).toBeLessThan(16_000)
  })

  test("a digest drops tool output, redacts secrets and keeps corrections and preferences apart", () => {
    const digest = buildDigest(session([[`Actually use pnpm instead of npm here. Always answer in Spanish. My key is ${SECRET}.`, "Done, pnpm it is."]]).events)
    expect(digest.corrections).toEqual(["Actually use pnpm instead of npm here."])
    expect(digest.preferences).toEqual(["Always answer in Spanish."])
    expect(digest.redactions).toBe(1)
    expect(JSON.stringify(digest)).not.toContain(SECRET)
  })

  test("an unchanged session reuses its cached digest without reading its events; a changed one is rebuilt", () => {
    const cache = cacheOf()
    const s = session([["how do we test?", "Run bun test."]])
    let reads = 0
    const read = (seq: number) => [{ sessionId: s.sessionId, title: s.title, seq, events: () => (reads++, s.events) }]
    expect(collectEvidence(read(5), { cache })[0]).toMatchObject({ digest: "built", lines: ["user: how do we test?", "agent: Run bun test."] })
    expect(collectEvidence(read(5), { cache })[0]).toMatchObject({ digest: "reused", lines: ["user: how do we test?", "agent: Run bun test."] })
    expect(reads).toBe(1)
    expect(cache.puts).toBe(1)
    expect(collectEvidence(read(6), { cache })[0]).toMatchObject({ digest: "built" })
    expect(reads).toBe(2)
    // A cached payload of another format is not trusted.
    cache.rows.set(s.sessionId, { sourceSeq: 6, version: 1, payload: '{"version":1,"lines":"nope"}' })
    expect(collectEvidence(read(6), { cache })[0]).toMatchObject({ digest: "built" })
  })
})

describe("the safety report", () => {
  const base = { directory: "/repo", memories: () => [memory("Tests run with bun test")], signal: new AbortController().signal }

  test("says what was read, proposed, refused and why, what was redacted and what the model cost", async () => {
    const cache = cacheOf()
    const result = await runDream({
      ...base,
      digests: cache,
      sessions: () => [{ ...session([[`release? my key is ${SECRET}`, "We release with bun run release."]], "Release talk") }],
      propose: (entry) => (entry.category === "volatile" ? "dropped" : "pending"),
      complete: async () => ({
        text: JSON.stringify({
          proposals: [
            { text: "Release with bun run release after tagging", scope: "project", category: "commands", why: "s1" },
            { text: `Deploy key is ${SECRET} for the server`, scope: "project", category: "security", why: "s1" },
            { text: "Tests run with bun test", scope: "project", category: "commands", why: "dup" },
            { text: "tmp", scope: "project" },
            { text: "Scratch value that must not be kept", scope: "project", category: "volatile", why: "s1" },
          ],
          notes: "",
        }),
        usage: { input: 900, output: 100 },
      }),
    })
    if (result.status !== "done") throw new Error(JSON.stringify(result))
    const report = DreamReport.parse(result.report)
    expect(report.read.sessions).toEqual([{ sessionId: expect.any(String), title: "Release talk", digest: "built", messages: 2, redactions: 1 }])
    expect(report.read.memories).toBe(1)
    expect(report.read.promptChars).toBeGreaterThan(200)
    expect(report.proposed.map((p) => [p.kind, p.category, p.outcome])).toEqual([
      ["new", "commands", "pending"],
      ["new", "security", "pending"],
      ["new", "volatile", "dropped"],
    ])
    expect(report.refused.map((r) => r.reason)).toEqual(expect.arrayContaining(["already remembered or repeated in this run", "not a valid proposal (text of 8 to 500 characters)", "the category policy drops proposals"]))
    expect(report.redactions).toEqual({ evidence: 1, proposals: 1 })
    expect(JSON.stringify(report)).not.toContain(SECRET)
    expect(report.model).toEqual({ calls: 1, inputTokens: 900, outputTokens: 100, estimated: false })
    expect(report.budget).toMatchObject({ used: 1000, stopped: false })
    expect(report.evolution).toBeUndefined()
    // Two proposals reached review (the dropped one did not).
    expect(result.proposed).toBe(2)
  })

  test("a text that had a secret redacted is handed on as must-review whatever the policy", async () => {
    const seen: Array<{ text: string; forceReview?: boolean }> = []
    await runDream({
      ...base,
      sessions: () => [session([["anything to remember?", "Yes."]])],
      propose: (entry) => (seen.push({ text: entry.text, ...(entry.forceReview ? { forceReview: true } : {}) }), "pending" as ProposalOutcome),
      complete: async () => JSON.stringify({ proposals: [{ text: `The CI token is ${SECRET} always`, category: "commands" }, { text: "Releases are tagged on main", category: "release" }] }),
    })
    expect(seen).toEqual([{ text: "The CI token is [redacted:openai-key] always", forceReview: true }, { text: "Releases are tagged on main" }])
  })

  test("token counts are estimated (and said so) when the provider reports none", async () => {
    const result = await runDream({ ...base, sessions: () => [session([["q", "a"]])], propose: () => "pending", complete: async () => '{"proposals":[]}' })
    expect(result.report.model.estimated).toBe(true)
    expect(result.report.model.calls).toBe(1)
    expect(result.report.model.inputTokens).toBeGreaterThan(0)
  })

  test("a failed run still reports what it read and why it failed", async () => {
    const result = await runDream({ ...base, sessions: () => [session([["q", "a"]])], propose: () => "pending", complete: async () => "not json at all" })
    expect(result.status).toBe("failed")
    expect(DreamReport.parse(result.report).failures).toEqual(["no JSON object in the model output"])
    expect(result.report.read.sessions).toHaveLength(1)
  })
})

describe("the token budget", () => {
  const correction = "Actually use pnpm instead of npm for installs in this repo."
  function evolutionPort(): EvolutionPort & { suggestions: unknown[] } {
    return {
      suggestions: [],
      record: () => {},
      recurring: () => [{ fingerprint: "f1", source: "correction", sessions: 2, text: correction, evidenceId: "x" }],
      suggest() {
        return undefined
      },
    }
  }

  test("a call that would not fit is not made: the run is skipped and says so", async () => {
    let calls = 0
    const result = await runDream({
      directory: "/repo",
      memories: () => [],
      sessions: () => [session([["q".repeat(300), "a"]])],
      propose: () => "pending",
      signal: new AbortController().signal,
      maxTokens: 1_000,
      complete: async () => (calls++, "{}"),
    })
    expect(calls).toBe(0)
    expect(result.status).toBe("skipped")
    expect(result.report.budget).toMatchObject({ limit: 1_000, used: 0, stopped: true })
    expect(result.report.budget.reason).toContain("Dream skipped")
  })

  test("a run stops cleanly when its first call used the budget: proposals are kept, Evolution is skipped, the report says so", async () => {
    let calls = 0
    const proposed: string[] = []
    const result = await runDream({
      directory: "/repo",
      memories: () => [],
      sessions: () => [session([[correction, "Understood."]])],
      propose: (entry) => (proposed.push(entry.text), "pending"),
      signal: new AbortController().signal,
      maxTokens: 2_000,
      evolution: { mode: "suggest", port: evolutionPort() },
      complete: async () => (calls++, { text: JSON.stringify({ proposals: [{ text: "Installs use pnpm in this repo", category: "commands" }] }), usage: { input: 1_700, output: 100 } }),
    })
    expect(calls).toBe(1)
    expect(proposed).toEqual(["Installs use pnpm in this repo"])
    if (result.status !== "done") throw new Error(JSON.stringify(result))
    expect(result.report.budget).toMatchObject({ limit: 2_000, used: 1_800, stopped: true })
    expect(result.report.budget.reason).toContain("Evolution skipped")
    expect(result.report.evolution).toMatchObject({ mode: "suggest", note: "no model call: the token budget is used up" })
    expect(result.notes).toContain("Evolution skipped")
  })
})

describe("missing pieces of a run", () => {
  test("a project without readable conversations is skipped with a report", async () => {
    const result = await runDream({ directory: "/repo", memories: () => [], sessions: () => [session([])], propose: () => "pending", signal: new AbortController().signal, complete: async () => "{}" })
    expect(result).toMatchObject({ status: "skipped", reason: "no recent conversations in this project" })
    expect(DreamReport.parse(result.report).model.calls).toBe(0)
  })
})

describe("Evolution modes", () => {
  const pnpm = "Actually use pnpm instead of npm for installs in this repo."
  const reply = (candidates: unknown[]) => JSON.stringify({ candidates })

  /** An in-memory port that behaves like the store's: evidence by (session, source, fingerprint), recurring = 2+ sessions. */
  function port() {
    const rows = new Map<string, { directory: string; sessionId: string; source: "correction" | "preference"; fingerprint: string; text?: string }>()
    const suggestions: EvolutionSuggestion[] = []
    const value: EvolutionPort & { rows: typeof rows; suggestions: typeof suggestions } = {
      rows,
      suggestions,
      record(entries) {
        for (const entry of entries) rows.set(`${entry.sessionId}:${entry.source}:${entry.fingerprint}`, { ...(rows.get(`${entry.sessionId}:${entry.source}:${entry.fingerprint}`) ?? {}), ...entry })
      },
      recurring() {
        const groups = new Map<string, Array<(typeof rows extends Map<string, infer R> ? R : never)>>()
        for (const row of rows.values()) groups.set(row.fingerprint, [...(groups.get(row.fingerprint) ?? []), row])
        return [...groups.values()]
          .filter((group) => new Set(group.map((row) => row.sessionId)).size >= 2)
          .map((group) => ({ fingerprint: group[0]!.fingerprint, source: group[0]!.source, sessions: new Set(group.map((row) => row.sessionId)).size, evidenceId: "x", ...(group.find((row) => row.text)?.text ? { text: group.find((row) => row.text)!.text! } : {}) }))
      },
      suggest(input) {
        if (suggestions.some((entry) => entry.kind === input.kind && entry.name === input.name)) return undefined
        const suggestion: EvolutionSuggestion = { suggestionId: suggestions.length + 1, directory: input.directory, kind: input.kind, name: input.name, description: input.description, content: input.content, evidence: input.evidence, status: "pending", createdAt: 0 }
        suggestions.push(suggestion)
        return suggestion
      },
    }
    return value
  }

  async function run(mode: "off" | "observe" | "suggest" | "auto-safe", evolutionPort: ReturnType<typeof port>, answer: string, policy: (category: string) => ProposalOutcome = () => "pending") {
    let modelCalls = 0
    const proposals: Array<{ text: string; category: string; cap?: "review" | undefined; outcome: ProposalOutcome }> = []
    const result = await runDream({
      directory: "/repo",
      memories: () => [],
      sessions: () => [session([[pnpm, "ok"]], "one"), session([[pnpm, "ok"]], "two")],
      propose: (entry) => {
        const outcome = entry.cap === "review" && policy(entry.category) === "saved" ? "pending" : policy(entry.category)
        proposals.push({ text: entry.text, category: entry.category, cap: entry.cap, outcome })
        return outcome
      },
      signal: new AbortController().signal,
      complete: async (prompt) => {
        modelCalls++
        // The Dream pass proposes nothing; the Evolution pass answers with `answer`.
        return prompt.includes("## Evidence") ? answer : '{"proposals":[]}'
      },
      evolution: { mode, port: evolutionPort },
    })
    if (result.status !== "done") throw new Error(JSON.stringify(result))
    return { result, modelCalls, proposals }
  }

  test("off does nothing: nothing recorded, no model call for Evolution, no evolution in the report", async () => {
    const p = port()
    const { result, modelCalls } = await run("off", p, reply([]))
    expect(p.rows.size).toBe(0)
    expect(modelCalls).toBe(1)
    expect(result.report.evolution).toBeUndefined()
  })

  test("observe records only fingerprints: no text, no model call, no proposals", async () => {
    const p = port()
    const { result, modelCalls, proposals } = await run("observe", p, reply([{ kind: "memory", content: "never used", evidence: ["e1"] }]))
    expect(p.rows.size).toBe(2)
    expect([...p.rows.values()].every((row) => row.text === undefined && row.fingerprint.length > 0)).toBe(true)
    expect(modelCalls).toBe(1)
    expect(proposals).toEqual([])
    expect(result.report.evolution).toMatchObject({ mode: "observe", observed: { corrections: 1, preferences: 0, recurring: 1 }, suggested: { memories: 0, skills: 0, instructions: 0 }, applied: 0 })
  })

  test("suggest turns a recurring correction into a memory for review and a skill suggestion, never saved directly", async () => {
    const p = port()
    const { result, modelCalls, proposals } = await run(
      "suggest",
      p,
      reply([
        { kind: "memory", content: "Installs in this repo use pnpm, not npm", category: "commands", evidence: ["e1"] },
        { kind: "skill", name: "use-pnpm", description: "Install dependencies with pnpm", content: "Run pnpm install; never npm install.", evidence: ["e1"] },
        { kind: "instruction", name: "bad name!", description: "x", content: "Use pnpm always here.", evidence: ["e1"] },
        { kind: "memory", content: "Has a secret sk-abcdEFGH1234ijklMNOP5678 inside", category: "commands", evidence: ["e1"] },
        { kind: "memory", content: "Claims evidence that was never shown", category: "commands", evidence: ["e9"] },
      ]),
      () => "saved",
    )
    expect(modelCalls).toBe(2)
    // Even where the category policy says auto, suggest only sends memories to review.
    expect(proposals).toEqual([{ text: "Installs in this repo use pnpm, not npm", category: "commands", cap: "review", outcome: "pending" }])
    expect(p.suggestions.map((s) => [s.kind, s.name, s.status])).toEqual([["skill", "use-pnpm", "pending"]])
    expect(result.report.evolution).toMatchObject({ mode: "suggest", suggested: { memories: 1, skills: 1, instructions: 0 }, applied: 0 })
    expect(result.report.refused.map((r) => r.reason)).toEqual(expect.arrayContaining(["needs a lowercase-hyphen name and a description", "may contain a secret or credential", "cites no evidence it was shown"]))
    expect(p.rows.size).toBe(2)
    expect([...p.rows.values()].every((row) => row.text?.startsWith("Actually use pnpm"))).toBe(true)
  })

  test("auto-safe applies only memory proposals whose category policy allows it: skills and instructions still wait, dropped categories stay dropped", async () => {
    const p = port()
    const { result, proposals } = await run(
      "auto-safe",
      p,
      reply([
        { kind: "memory", content: "Installs in this repo use pnpm, not npm", category: "commands", evidence: ["e1"] },
        { kind: "memory", content: "The user likes terse answers always", category: "preferences", evidence: ["e1"] },
        { kind: "memory", content: "A throwaway detail worth nothing", category: "volatile", evidence: ["e1"] },
        { kind: "skill", name: "use-pnpm", description: "Install dependencies with pnpm", content: "Run pnpm install.", evidence: ["e1"] },
      ]),
      (category) => (category === "commands" ? "saved" : category === "volatile" ? "dropped" : "pending"),
    )
    expect(proposals.map((entry) => [entry.category, entry.cap, entry.outcome])).toEqual([
      ["commands", undefined, "saved"],
      ["preferences", undefined, "pending"],
      ["volatile", undefined, "dropped"],
    ])
    expect(p.suggestions.map((s) => s.status)).toEqual(["pending"])
    expect(result.report.evolution).toMatchObject({ mode: "auto-safe", suggested: { memories: 2, skills: 1 }, applied: 1 })
    expect(result.report.refused.map((r) => r.reason)).toContain("the category policy drops proposals")
  })

  test("fingerprints match the same idea worded differently and ignore vague sentences", () => {
    expect(fingerprint("Don't use npm, use pnpm")).toBe(fingerprint("Use pnpm instead of npm"))
    expect(fingerprint("Don't use npm, use pnpm")).not.toBe(fingerprint("Use bun instead of npm"))
    expect(fingerprint("Please do that")).toBe("")
  })
})
