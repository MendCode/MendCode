import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { PrTokenUsage } from "@mendcode/protocol"
import { EMPTY_TREE, runAudit } from "../src/pr-review/audit"
import { gitRun } from "../src/pr-review/context"
import { createEffectLedger } from "../src/pr-review/effects"
import type { ReviewSessionFactory } from "../src/pr-review/engine"
import { findingId } from "../src/pr-review/findings"
import type { GhCall } from "../src/pr-review/publish"
import { reviewNotice, runConfigKey, runPrReview } from "../src/pr-review/run"
import { ReviewTurnError } from "../src/pr-review/sessions"
import { emptyState } from "../src/pr-review/state"

/**
 * runPrReview with the platform fields (contracts.ts `RunPlatformInput`): config layers, coverage, stacks, budget stops, quota
 * stops, resume, the stale-head guard and per-turn accounting; and runAudit. A temp git repository, scripted review children and
 * a fake `gh` that records every call; nothing touches the network or a real repository.
 */

const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = (prefix: string) => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix))); temps.push(dir); return dir }
async function git(cwd: string, ...args: string[]) {
  const done = await gitRun(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], cwd)
  if (done.code !== 0) throw new Error(`git ${args.join(" ")} failed`)
  return done.out.trim()
}
const write = (dir: string, file: string, text: string) => { mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); writeFileSync(path.join(dir, file), text) }

const MATH_BASE = "export function total(values: number[]) {\n  let sum = 0\n  for (const value of values) sum += value\n  return sum\n}\nexport const half = (n: number) => n / 2\n"
const MATH_FEATURE = "export function total(values: number[]) {\n  let sum = 0\n  for (let i = 1; i < values.length; i++) sum += values[i]!\n  return sum\n}\nexport const half = (n: number) => n >> 1\n"

/** main (config + src/math.ts) and feature (two changed lines). `baseConfig`/`headConfig` are `.mendcode/review.yaml` texts. */
async function repository({ baseConfig = "enabled: true\n", headConfig }: { baseConfig?: string; headConfig?: string } = {}) {
  const dir = temp("mc-run-repo-")
  await git(dir, "init", "-q", "-b", "main")
  write(dir, ".mendcode/review.yaml", baseConfig)
  write(dir, "src/math.ts", MATH_BASE)
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "base")
  const base = await git(dir, "rev-parse", "HEAD")
  await git(dir, "checkout", "-q", "-b", "feature")
  write(dir, "src/math.ts", MATH_FEATURE)
  if (headConfig !== undefined) write(dir, ".mendcode/review.yaml", headConfig)
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "feature")
  return { dir, base, head: await git(dir, "rev-parse", "HEAD") }
}

type Candidate = { path: string; line: number; summary: string; category?: string }
const candidate = ({ path: file, line, summary, category = "correctness" }: Candidate) => ({ path: file, line, severity: "major", category, summary, detail: "d", evidence: [`${file}:${line}`] })
const LOOP = { path: "src/math.ts", line: 3, summary: "The loop skips the first value" }
const HALF = { path: "src/math.ts", line: 6, summary: "half() truncates odd numbers" }

type Turn = { purpose: "review" | "verify"; prompt: string }
/**
 * Children that answer the review pass with `findings` and confirm every finding a verify turn names. `fail` throws on the
 * first turn of that purpose (once); `tokens` is each turn's report.
 */
function children({ findings = [LOOP, HALF], fail, tokens = { input: 1000, output: 100 } }: { findings?: Candidate[]; fail?: { purpose: "review" | "verify"; error: Error }; tokens?: { input: number; output: number; cached?: number } } = {}) {
  const turns: Turn[] = []
  let failure = fail
  const factory: ReviewSessionFactory = async ({ purpose }) => ({
    async send(prompt) {
      turns.push({ purpose, prompt })
      if (failure && failure.purpose === purpose) { const error = failure.error; failure = undefined; throw error }
      if (purpose === "review") return { text: JSON.stringify({ summary: "Changes the math helpers.", findings: findings.map(candidate) }), tokens }
      const block = prompt.slice(prompt.indexOf("<findings"), prompt.indexOf("</findings>"))
      const ids = block.split("\n").flatMap((line) => { try { const value = JSON.parse(line) as { id?: string; path?: string; line?: number }; return value.id ? [value] : [] } catch { return [] } })
      return { text: JSON.stringify({ verdicts: ids.map((entry) => ({ id: entry.id, verdict: "confirmed", evidence: [`${entry.path}:${entry.line}`] })) }), tokens }
    },
    async close() {},
  })
  return { factory, turns, purposes: () => turns.map((turn) => turn.purpose) }
}

/** A `gh` that records calls: POST of a review answers id 101, every list is empty. */
function fakeGh() {
  const calls: Array<{ argv: string[]; stdin?: string }> = []
  const gh: GhCall = async (input) => {
    calls.push(input)
    if (input.argv.includes("POST") && /\/reviews$/.test(input.argv[1] ?? "")) return { code: 0, out: JSON.stringify({ id: 101 }) }
    if (input.argv[1] === "graphql") return { code: 0, out: "{}" }
    return { code: 0, out: "[]" }
  }
  const posts = () => calls.filter((call) => call.argv.includes("POST"))
  return { gh, calls, posts }
}

const baseInput = (repo: { dir: string; base: string; head: string }, sessionFactory: ReviewSessionFactory) => ({
  repo: "acme/app", number: 12, directory: repo.dir, base: repo.base, head: repo.head, state: emptyState(), sessionFactory, publish: false,
})

describe("runPrReview: config layers", () => {
  test("a personal layer narrows the repository's config and cannot widen it; the config key is deterministic", async () => {
    const repo = await repository({ baseConfig: "enabled: true\ncap: 8\nprofile: normal\n" })
    const kids = children()
    const layers = { personal: { profile: "quiet", cap: 2, checks: ["touch pwned"], fix: { push: true } } }
    const run = await runPrReview({ ...baseInput(repo, kids.factory), layers })
    expect(run.status).toBe("reviewed")
    expect(run.config).toMatchObject({ profile: "quiet", cap: 2, checks: [], fix: { push: false } })
    // The refusals are in the notes the summary shows, never silent.
    expect(run.info!.notes.join("\n")).toContain("personal checks: only the repository sets checks; not applied")
    expect(run.info!.notes.join("\n")).toContain("personal fix.push: the repository has it off")
    expect(kids.turns[0]!.prompt).toContain("Report only defects that break behaviour")
    expect(run.configKey).toBe(runConfigKey({ policy: repo.base, layers }))
    expect(run.configKey).toMatch(new RegExp(`^${repo.base}\\+[0-9a-f]{12}$`))
    expect(runConfigKey({ policy: repo.base, layers: { personal: { cap: 2, profile: "quiet", fix: { push: true }, checks: ["touch pwned"] } } })).toBe(run.configKey)
    expect(runConfigKey({ policy: repo.base, layers: { personal: { cap: 3 } } })).not.toBe(run.configKey)
    expect(runConfigKey({ policy: repo.base })).toBe(repo.base)
  })

  test("the PR's head config only adds path instructions: its checks never run and it cannot turn the reviewer on", async () => {
    const head = "enabled: true\nchecks:\n  - touch pwned\nprofile: strict\npaths:\n  - glob: \"src/**\"\n    instructions: Check integer division.\n"
    const repo = await repository({ baseConfig: "enabled: true\n", headConfig: head })
    const kids = children()
    let ran = 0
    const run = await runPrReview({ ...baseInput(repo, kids.factory), checks: async () => { ran++; return [] } })
    expect(run.config).toMatchObject({ checks: [], profile: "normal" })
    expect(ran).toBe(0)
    expect(kids.turns[0]!.prompt).toContain("- src/**: Check integer division.")

    const off = await repository({ baseConfig: "enabled: false\n", headConfig: "enabled: true\n" })
    const skipped = await runPrReview(baseInput(off, children().factory))
    expect(skipped).toMatchObject({ status: "skipped", configKey: off.base })
  })
})

describe("runPrReview: coverage and stacks", () => {
  test("a stacked PR reviews only its own commits and drops the findings its parent already reported", async () => {
    const dir = temp("mc-run-stack-")
    await git(dir, "init", "-q", "-b", "main")
    write(dir, ".mendcode/review.yaml", "enabled: true\n")
    write(dir, "README.md", "app\n")
    await git(dir, "add", "-A")
    await git(dir, "commit", "-q", "-m", "base")
    const base = await git(dir, "rev-parse", "HEAD")
    await git(dir, "checkout", "-q", "-b", "parent")
    write(dir, "src/parent-only.ts", "export const parentOnly = 1\n")
    write(dir, "src/util.ts", "export function ratio(x: number) {\n  return x / 0\n}\n")
    await git(dir, "add", "-A")
    await git(dir, "commit", "-q", "-m", "parent")
    const parentHead = await git(dir, "rev-parse", "HEAD")
    await git(dir, "checkout", "-q", "-b", "child")
    write(dir, "src/util.ts", "export function ratio(x: number) {\n  return x / 0\n}\nexport const twice = (x: number) => x * 3\n")
    await git(dir, "add", "-A")
    await git(dir, "commit", "-q", "-m", "child")
    const head = await git(dir, "rev-parse", "HEAD")

    const divide = { path: "src/util.ts", line: 2, summary: "Division by zero", category: "correctness" }
    const twice = { path: "src/util.ts", line: 4, summary: "twice() multiplies by three", category: "correctness" }
    const kids = children({ findings: [divide, twice] })
    const parentFinding = { ...candidate(divide), id: findingId({ ...divide, category: "correctness" }), side: "RIGHT" as const, severity: "major" as const, category: "correctness" as const, verdict: "confirmed" as const }
    const run = await runPrReview({ repo: "acme/app", number: 8, directory: dir, base, head, state: emptyState(), sessionFactory: kids.factory, publish: false, stack: { base: parentHead, parent: 7, parentFindings: [parentFinding] } })
    const prompt = kids.turns[0]!.prompt
    expect(prompt).not.toContain("parent-only.ts")
    expect(prompt).toContain("Stacked on #7")
    expect(prompt).toContain("This pull request is stacked on another one")
    expect(run.outcome!.result.findings.map((finding) => finding.line)).toEqual([4])
    expect(run.inherited).toBe(1)
    expect(run.info!.notes.join("\n")).toContain("1 finding #7 already reported was left out")
    expect(run.plan!.decisions).toContainEqual(expect.objectContaining({ phase: "stack", action: "added" }))
    expect(run.checkpoint!.decisions).toEqual(run.plan!.decisions)
  })

  test("coverage: full in the config reviews the whole PR on a new head; the same head is still skipped", async () => {
    const repo = await repository({ baseConfig: "enabled: true\ncoverage: full\n" })
    const middle = repo.base
    const run = await runPrReview({ ...baseInput(repo, children().factory), state: { version: 1, published: {}, lastHead: middle } })
    expect(run.incremental).toBe(false)
    const same = await runPrReview({ ...baseInput(repo, children().factory), state: { version: 1, published: {}, lastHead: repo.head } })
    expect(same.status).toBe("skipped")
  })
})

describe("runPrReview: stops, checkpoints and resume", () => {
  test("a budget stop checkpoints the candidates and publishes nothing, even with gh and publish", async () => {
    const repo = await repository({ baseConfig: "enabled: true\nbudget:\n  tokens_per_pr: 10000\n" })
    const kids = children({ tokens: { input: 20_000, output: 100 } })
    const github = fakeGh()
    const run = await runPrReview({ ...baseInput(repo, kids.factory), publish: true, gh: github.gh })
    expect(kids.purposes()).toEqual(["review"])
    expect(github.posts()).toEqual([])
    expect(run.status).toBe("reviewed")
    expect(run.stop).toMatchObject({ kind: "budget", unit: "tokens", limit: 10_000, resumable: true })
    expect(run.checkpoint!.candidates).toHaveLength(2)
    expect(run.reason).toContain("nothing was published")
    expect(reviewNotice({ repo: "acme/app", number: 12, run })).toContain("Stopped at MendCode's token budget")
  })

  test("a quota in the review pass is a resumable checkpoint, not a failure", async () => {
    const repo = await repository()
    const kids = children({ fail: { purpose: "review", error: new ReviewTurnError("[PR_REVIEW]: the review turn failed: You've hit your limit · resets 9pm", "quota", 1_900_000_000_000) } })
    const accounted: Array<{ purpose: string; tokens: PrTokenUsage }> = []
    const run = await runPrReview({ ...baseInput(repo, kids.factory), account: (entry) => accounted.push(entry) })
    expect(run.status).toBe("reviewed")
    expect(run.retryable).toBe(true)
    expect(run.stop).toMatchObject({ kind: "quota", resumable: true, resetsAt: 1_900_000_000_000 })
    expect(run.checkpoint).toMatchObject({ phase: "analysis", candidates: [], verified: [] })
    expect(run.checkpoint!.result).toBeUndefined()
    expect(accounted).toEqual([{ purpose: "review", tokens: { input: 0, output: 0, unreported: 1 } }])
  })

  test("a rate limit in the verify pass keeps the candidates; the resume verifies them without a second review pass, then publishes", async () => {
    const repo = await repository()
    const first = children({ fail: { purpose: "verify", error: new ReviewTurnError("[PR_REVIEW]: the review turn failed: 429 Too Many Requests", "rate_limit") } })
    const github = fakeGh()
    const stopped = await runPrReview({ ...baseInput(repo, first.factory), publish: true, gh: github.gh })
    expect(stopped.status).toBe("reviewed")
    expect(stopped.stop).toMatchObject({ kind: "rate_limit", resumable: true })
    expect(stopped.checkpoint!.candidates).toHaveLength(2)
    expect(stopped.outcome!.result.summary).toContain("Stopped by the provider's rate limit")
    expect(github.posts()).toEqual([])

    const second = children()
    const accounted: Array<{ purpose: string; tokens: PrTokenUsage }> = []
    const resumed = await runPrReview({ ...baseInput(repo, second.factory), publish: true, gh: github.gh, checkpoint: stopped.checkpoint, account: (entry) => accounted.push(entry) })
    expect(second.purposes()).toEqual(["verify"])
    expect(accounted.map((entry) => entry.purpose)).toEqual(["resume"])
    expect(resumed.status).toBe("published")
    expect(resumed.stop).toBeUndefined()
    expect(resumed.outcome!.result.findings).toHaveLength(2)
    expect(github.posts()).toHaveLength(1)
  })

  test("a checkpoint of another head is not resumed: the review runs again from the start", async () => {
    const repo = await repository()
    const kids = children()
    const run = await runPrReview({ ...baseInput(repo, kids.factory), checkpoint: { completedPhases: [], candidates: [], verified: [], rounds: [], decisions: [], result: { head: "f".repeat(40), base: repo.base, findings: [], dropped: 0, summary: "", tokens: { input: 0, output: 0 }, budgetHit: true } } })
    expect(kids.purposes()).toEqual(["review", "verify"])
    expect(run.info!.notes.join("\n")).toContain("reviewed again from the start")
  })
})

describe("runPrReview: publishing identity and accounting", () => {
  test("isCurrent false: the run is stale and nothing is posted", async () => {
    const repo = await repository()
    const github = fakeGh()
    const effects = createEffectLedger({ file: path.join(temp("mc-run-effects-"), "effects.json") })
    const run = await runPrReview({ ...baseInput(repo, children().factory), publish: true, gh: github.gh, publishAs: { effects, reviewer: "personal:alice", configKey: "cfg1", jobId: "job1", isCurrent: () => false } })
    expect(run).toMatchObject({ status: "reviewed", stale: true })
    expect(github.posts()).toEqual([])
    expect(effects.ofJob("job1")).toEqual([])
  })

  test("publishAs carries the reviewer and config into the marker and the effect ledger; each turn is accounted", async () => {
    const repo = await repository()
    const github = fakeGh()
    const effects = createEffectLedger({ file: path.join(temp("mc-run-effects-"), "effects.json") })
    const accounted: Array<{ purpose: string; tokens: PrTokenUsage }> = []
    const run = await runPrReview({ ...baseInput(repo, children({ tokens: { input: 1000, output: 100, cached: 400 } }).factory), publish: true, gh: github.gh, account: (entry) => accounted.push(entry), publishAs: { effects, reviewer: "personal:alice", configKey: "cfg1", jobId: "job1", isCurrent: () => true } })
    expect(run.status).toBe("published")
    const body = JSON.parse(github.posts()[0]!.stdin!).body as string
    expect(body).toContain("mendcode:reviewer=personal:alice config=cfg1")
    expect(effects.ofJob("job1").map((effect) => effect.state)).toEqual(["done"])
    expect(accounted).toEqual([{ purpose: "review", tokens: { input: 1000, output: 100, cached: 400 } }, { purpose: "verify", tokens: { input: 1000, output: 100, cached: 400 } }])
  })

  test("without platform fields the run publishes as before (no reviewer marker config, the policy commit as key)", async () => {
    const repo = await repository()
    const github = fakeGh()
    const run = await runPrReview({ ...baseInput(repo, children().factory), publish: true, gh: github.gh })
    expect(run).toMatchObject({ status: "published", configKey: repo.base })
    expect(JSON.parse(github.posts()[0]!.stdin!).body).toContain("config=unversioned")
  })
})

describe("runAudit", () => {
  test("audits HEAD against the empty tree, keeps the findings in the session and never calls gh", async () => {
    const repo = await repository()
    const kids = children({ findings: [HALF] })
    const audit = await runAudit({ directory: repo.dir, sessionFactory: kids.factory })
    expect(audit).toMatchObject({ status: "reviewed", coverage: "audit", base: EMPTY_TREE, head: repo.head })
    expect(audit.outcome!.result.findings.map((finding) => finding.line)).toEqual([6])
    expect(kids.turns[0]!.prompt).toContain("An audit of the whole repository")
    expect(kids.turns[0]!.prompt).toContain("+export const half = (n: number) => n >> 1")
    expect(audit.text).toContain("never posted")
  })

  test("the context is bounded by the budget's context tokens and says what it cut", async () => {
    const repo = await repository()
    write(repo.dir, "big/a.ts", `${"export const a = 1\n".repeat(2_000)}`)
    await git(repo.dir, "add", "-A")
    await git(repo.dir, "commit", "-q", "-m", "big")
    const kids = children({ findings: [] })
    const audit = await runAudit({ directory: repo.dir, sessionFactory: kids.factory, contextWindow: 16_000 })
    expect(audit.status).toBe("reviewed")
    expect(audit.cut).toContainEqual({ path: "big/a.ts", reason: "budget" })
    expect(kids.turns[0]!.prompt).toContain("left out 1 file: big/a.ts")
    expect(kids.turns[0]!.prompt).toContain("src/math.ts")
  })
})
