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
import { ReviewTurnError, ReviewTurnOverBudget } from "../src/pr-review/sessions"
import { emptyState, reviewMarker } from "../src/pr-review/state"

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

type Turn = { purpose: "review" | "verify" | "read"; prompt: string }
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
  test("a review pass that alone passes the cap never ends empty: one short closing check verifies its candidates and the review is posted whole", async () => {
    const repo = await repository({ baseConfig: "enabled: true\nbudget:\n  tokens_per_pr: 10000\n" })
    const kids = children({ tokens: { input: 20_000, output: 100 } })
    const github = fakeGh()
    const run = await runPrReview({ ...baseInput(repo, kids.factory), publish: true, gh: github.gh })
    expect(kids.purposes()).toEqual(["review", "verify"])
    expect(kids.turns[1]!.prompt).toContain("short closing check")
    // The closing check carries the findings, not the diff again.
    expect(kids.turns[1]!.prompt).not.toContain("diff --git")
    expect(github.posts()).toHaveLength(1)
    expect(run.status).toBe("published")
    expect(run.stop).toBeUndefined()
    expect(run.outcome!.partial).toBeUndefined()
    expect(run.outcome!.result.findings).toHaveLength(2)
    expect(JSON.parse(github.posts()[0]!.stdin!).body).toContain("## MendCode review")
  })

  test("a budget stop whose closing check cannot judge the candidates posts nothing as a finding and keeps them for the resume", async () => {
    const repo = await repository({ baseConfig: "enabled: true\nbudget:\n  tokens_per_pr: 10000\n" })
    const kids = children({ tokens: { input: 20_000, output: 100 }, fail: { purpose: "verify", error: new Error("[PR_REVIEW]: the closing check crashed") } })
    const github = fakeGh()
    const run = await runPrReview({ ...baseInput(repo, kids.factory), publish: true, gh: github.gh })
    expect(kids.purposes()).toEqual(["review", "verify"])
    const body = JSON.parse(github.posts()[0]!.stdin!) as { body: string; comments: unknown[] }
    // Posted as a partial review that says nothing was verified; the two candidates are counted, not published.
    expect(body.comments).toEqual([])
    expect(body.body).toContain("## MendCode partial review")
    expect(body.body).toContain("2 candidate findings were found but not verified")
    expect(body.body).not.toContain(reviewMarker(repo.head))
    expect(run.status).toBe("published")
    expect(run.stop).toMatchObject({ kind: "budget", unit: "tokens", limit: 10_000, resumable: true })
    expect(run.checkpoint!.candidates).toHaveLength(2)
    expect(run.state.lastHead).toBeUndefined()
    expect(reviewNotice({ repo: "acme/app", number: 12, run })).toContain("Partial review:")
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

  test("a model child that never answered initialize (a load spike) is a retryable failure; another failed turn is not", async () => {
    const repo = await repository()
    const startup = children({ fail: { purpose: "review", error: new ReviewTurnError("[PR_REVIEW]: the review turn failed: [CLAUDE]: no answer to initialize", "error") } })
    const run = await runPrReview(baseInput(repo, startup.factory))
    expect(run.status).toBe("failed")
    expect(run.reason).toContain("no answer to initialize")
    expect(run.retryable).toBe(true)

    const other = children({ fail: { purpose: "review", error: new ReviewTurnError("[PR_REVIEW]: the review turn failed: the model answered without JSON", "error") } })
    const failed = await runPrReview(baseInput(repo, other.factory))
    expect(failed.status).toBe("failed")
    expect(failed.retryable).toBeUndefined()
  })

  test("a verifier whose answer cannot be used twice is a retryable failure that names the cause; the retry only verifies, then publishes", async () => {
    const repo = await repository()
    const answers = children()
    // The live case: a verify child answered twice (the answer and its one repair turn) with nothing parseable.
    const prose: ReviewSessionFactory = async (input) => {
      const session = await answers.factory(input)
      return input.purpose === "verify" ? { async send(prompt) { answers.turns.push({ purpose: "verify", prompt }); return { text: "I checked both findings and they look right.", tokens: { input: 1000, output: 100 } } }, close: session.close } : session
    }
    const github = fakeGh()
    const failed = await runPrReview({ ...baseInput(repo, prose), publish: true, gh: github.gh })
    expect(answers.purposes()).toEqual(["review", "verify", "verify"])
    expect(failed.status).toBe("failed")
    expect(failed.retryable).toBe(true)
    expect(failed.reason).toBe("verification failed (the verifier's answer could not be used after one repair turn (no JSON object in the answer; it began \"I checked both findings and they look right.\")); 2 candidate findings kept for the retry; nothing was published")
    expect(failed.checkpoint).toMatchObject({ phase: "corroboration", completedPhases: ["analysis"] })
    expect(failed.checkpoint!.candidates).toHaveLength(2)
    expect(github.posts()).toEqual([])

    const second = children()
    const resumed = await runPrReview({ ...baseInput(repo, second.factory), publish: true, gh: github.gh, checkpoint: failed.checkpoint })
    expect(second.purposes()).toEqual(["verify"])
    expect(resumed.status).toBe("published")
    expect(resumed.outcome!.result.findings).toHaveLength(2)
  })

  test("the run tells each step it starts: analysis with its files, the verify pass with its candidates, posting", async () => {
    const repo = await repository()
    const github = fakeGh()
    const steps: Array<{ phase: string; label: string; detail?: string | undefined }> = []
    const run = await runPrReview({ ...baseInput(repo, children().factory), publish: true, gh: github.gh, progress: (step) => steps.push(step) })
    expect(run.status).toBe("published")
    expect(steps).toEqual([
      { phase: "analysis", label: "Analysis", detail: "1 file" },
      { phase: "corroboration", label: "Verifying 2 candidates" },
      { phase: "posting", label: "Posting review" },
    ])
    // A listener that throws never stops the review.
    const loud = await runPrReview({ ...baseInput(repo, children().factory), progress: () => { throw new Error("terminal gone") } })
    expect(loud.status).toBe("reviewed")
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

  test("a second run of a head this reviewer already posted posts nothing, and its notice says so instead of a bare published", async () => {
    // Seen live (e2e #16): a manual /pr review of a reviewed head told the session "published" while GitHub kept the one review.
    const repo = await repository()
    const github = fakeGh()
    const effects = createEffectLedger({ file: path.join(temp("mc-run-effects-"), "effects.json") })
    const as = (jobId: string) => ({ effects, reviewer: "global:team", configKey: "cfg1", jobId, isCurrent: () => true })
    const first = await runPrReview({ ...baseInput(repo, children().factory), publish: true, gh: github.gh, publishAs: as("job1") })
    expect(first.status).toBe("published")
    expect(first.reason).toBeUndefined()
    const second = await runPrReview({ ...baseInput(repo, children().factory), publish: true, gh: github.gh, publishAs: as("job2") })
    expect(github.posts()).toHaveLength(1)
    expect(second.report?.duplicate).toBe(true)
    expect(reviewNotice({ repo: "acme/app", number: 12, run: second }).split("\n")[0]).toBe("PR review of acme/app#12: published (nothing was posted: this head's review 101 was already posted; the pull request keeps the earlier review, not this run's result)")

    // The same head asked again with the state of the first run, as the live #16 was: nothing is new, nothing is posted, it says so.
    const again = await runPrReview({ ...baseInput(repo, children({ findings: [] }).factory), state: first.state!, full: true, publish: true, gh: github.gh })
    expect(github.posts()).toHaveLength(1)
    expect(again.status).toBe("published")
    expect(again.reason).toBe("nothing was posted: this head was already reviewed and nothing is new; the pull request keeps the earlier review, not this run's result")
  })

  test("without platform fields the run publishes as before (no reviewer marker config, the policy commit as key)", async () => {
    const repo = await repository()
    const github = fakeGh()
    const run = await runPrReview({ ...baseInput(repo, children().factory), publish: true, gh: github.gh })
    expect(run).toMatchObject({ status: "published", configKey: repo.base })
    expect(JSON.parse(github.posts()[0]!.stdin!).body).toContain("config=unversioned")
  })

  test("a clean PR posts No findings with no verify turn, and its body says no separate pass was needed", async () => {
    const repo = await repository()
    const github = fakeGh()
    const kids = children({ findings: [] })
    const run = await runPrReview({ ...baseInput(repo, kids.factory), publish: true, gh: github.gh })
    expect(run.status).toBe("published")
    expect(kids.purposes()).toEqual(["review"])
    expect(run.info?.checked).toBe(0)
    const body = JSON.parse(github.posts()[0]!.stdin!).body as string
    expect(body).toContain("**No findings**")
    expect(body).toContain("- **Verification:** the review pass raised no candidate findings, so no separate pass was needed")
    expect(body).not.toContain("every finding was checked again")
  })

  test("verified findings carry the number of candidates the verify pass judged", async () => {
    const repo = await repository()
    const github = fakeGh()
    const run = await runPrReview({ ...baseInput(repo, children().factory), publish: true, gh: github.gh })
    expect(run.info?.checked).toBe(2)
    expect(JSON.parse(github.posts()[0]!.stdin!).body).toContain("- **Verification:** every finding was checked again by a separate pass (2 candidates judged)")
  })
})

describe("runPrReview: onlyIfPublishable", () => {
  /** A `gh` whose reviews list holds one MendCode review of `head` by `login`; everything else is empty. */
  const withReviewBy = (head: string, login: string): GhCall => async ({ argv }) =>
    /\/pulls\/12\/reviews\?/.test(argv[1] ?? "") ? { code: 0, out: JSON.stringify([{ id: 5, state: "COMMENTED", commit_id: head, body: `## MendCode review\n${reviewMarker(head)}`, user: { login, type: "User" }, author_association: "OWNER" }]) } : { code: 0, out: "[]" }

  test("a reviewer that may not post, or whose head another publisher already reviewed, is skipped before any model call", async () => {
    const repo = await repository()
    const denied = children()
    const refused = await runPrReview({ ...baseInput(repo, denied.factory), publish: true, onlyIfPublishable: true, gh: fakeGh().gh, publisher: { login: "nora", check: async () => ({ ok: false, reason: "@nora has no write access to acme/app" }) } })
    expect(refused).toMatchObject({ status: "skipped", notPublisher: true })
    expect(refused.reason).toBe("@nora has no write access to acme/app; nothing was sent to a model")
    expect(denied.turns).toEqual([])

    const taken = children()
    const stood = await runPrReview({ ...baseInput(repo, taken.factory), publish: true, onlyIfPublishable: true, gh: withReviewBy(repo.head, "obed"), publisher: { login: "nora", check: async () => ({ ok: true }) } })
    expect(stood).toMatchObject({ status: "skipped", notPublisher: true })
    expect(stood.reason).toBe("@obed already posted a MendCode review of this head; nothing was sent to a model")
    expect(taken.turns).toEqual([])
  })

  test("a reviewer that may post still reviews, and a manual run keeps its review in the session as before", async () => {
    const repo = await repository()
    const open = children()
    const posted = await runPrReview({ ...baseInput(repo, open.factory), publish: true, onlyIfPublishable: true, gh: fakeGh().gh, publisher: { login: "nora", check: async () => ({ ok: true }) } })
    expect(posted.status).toBe("published")
    expect(open.turns.length).toBeGreaterThan(0)

    const manual = children()
    const kept = await runPrReview({ ...baseInput(repo, manual.factory), publish: true, gh: withReviewBy(repo.head, "obed"), publisher: { login: "nora", check: async () => ({ ok: true }) } })
    expect(kept).toMatchObject({ status: "reviewed", notPublisher: true })
    expect(kept.reason).toBe("@obed already posted a MendCode review of this head; kept in this session")
    expect(manual.turns.length).toBeGreaterThan(0)
  })

  test("a run that does not publish is not gated", async () => {
    const repo = await repository()
    const kids = children()
    const run = await runPrReview({ ...baseInput(repo, kids.factory), publish: false, onlyIfPublishable: true, gh: fakeGh().gh, publisher: { login: "nora", check: async () => ({ ok: false, reason: "no" }) } })
    expect(run.status).toBe("reviewed")
    expect(kids.turns.length).toBeGreaterThan(0)
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

describe("runPrReview: the review ends early and stays within what its diff earns", () => {
  test("a first pass that says it could not review ends the review: no verification, nothing published, no 'no new findings'", async () => {
    const repo = await repository()
    const github = fakeGh()
    const turns: string[] = []
    const factory: ReviewSessionFactory = async ({ purpose }) => ({
      async send() { turns.push(purpose); return { text: JSON.stringify({ summary: "x", findings: [], incomplete: "my tools are read-only and I could not open the changed files" }), tokens: { input: 1000, output: 50 } } },
      async close() {},
    })
    const run = await runPrReview({ ...baseInput(repo, factory), publish: true, gh: github.gh })
    expect(turns).toEqual(["review"])
    expect(github.posts()).toEqual([])
    expect(run.reason).toContain("review incomplete")
    expect(run.reason).toContain("nothing was published")
    expect(run.reason).not.toContain("no new findings")
  })

  test("a defect the verification discarded is named as ruled out, never as a finding", async () => {
    const repo = await repository()
    const factory: ReviewSessionFactory = async ({ purpose }) => ({
      async send(prompt) {
        if (purpose === "review") return { text: JSON.stringify({ summary: "Changes the math helpers.", findings: [LOOP, HALF].map(candidate) }), tokens: { input: 100, output: 10 } }
        const ids = prompt.slice(prompt.indexOf("<findings"), prompt.indexOf("</findings>")).split("\n").flatMap((line) => { try { const value = JSON.parse(line) as { id?: string; path?: string; line?: number }; return value.id ? [value] : [] } catch { return [] } })
        return { text: JSON.stringify({ verdicts: ids.map((entry) => ({ id: entry.id, verdict: entry.line === 6 ? "rejected" : "confirmed", evidence: [`${entry.path}:${entry.line}`], reason: "the caller never passes odd numbers" })) }), tokens: { input: 100, output: 10 } }
      },
      async close() {},
    })
    const run = await runPrReview(baseInput(repo, factory))
    expect(run.outcome!.result.findings.map((finding) => finding.line)).toEqual([3])
    expect(run.outcome!.result.summary).toContain("ruled out")
    expect(run.outcome!.result.summary).toContain("half() truncates odd numbers")
  })
})

/**
 * The real case of #23: a diff of four parts under a cap that carries one or two of them. The review used to stop with nothing posted;
 * it now closes with one short check and posts a partial review, and the next run reviews only what is missing.
 */
describe("runPrReview: a review that reaches the cap closes as a partial one", () => {
  const PARTS = ["src/p1.ts", "src/p2.ts", "src/p3.ts", "src/p4.ts"]
  const body = (name: string) => Array.from({ length: 150 }, (_, i) => `export const ${name}_${i} = ${i} // padding that makes the diff of this file about the size of one review part`).join("\n") + "\n"

  /** main with a config, feature adding four large files: with `context_tokens: 8000` every file is its own part. */
  async function fourParts(budget: string) {
    const dir = temp("mc-run-parts-")
    await git(dir, "init", "-q", "-b", "main")
    write(dir, ".mendcode/review.yaml", `enabled: true\nbudget:\n${budget}\n`)
    write(dir, "README.md", "app\n")
    await git(dir, "add", "-A")
    await git(dir, "commit", "-q", "-m", "base")
    const base = await git(dir, "rev-parse", "HEAD")
    await git(dir, "checkout", "-q", "-b", "feature")
    for (const file of PARTS) write(dir, file, body(path.basename(file, ".ts")))
    await git(dir, "add", "-A")
    await git(dir, "commit", "-q", "-m", "feature")
    return { dir, base, head: await git(dir, "rev-parse", "HEAD") }
  }

  /** Review children that report one defect per file their part names and confirm every id a verify turn names; `cost` is each review turn's input tokens, by call order. */
  function partKids(cost: (review: number) => number) {
    const reviewed: string[][] = []
    const verified: string[][] = []
    const prompts: string[] = []
    const factory: ReviewSessionFactory = async ({ purpose }) => ({
      async send(prompt) {
        prompts.push(prompt)
        if (purpose === "review") {
          const files = [...new Set([...prompt.matchAll(/^diff --git a\/(\S+) /gm)].map((match) => match[1]!))]
          reviewed.push(files)
          const findings = files.map((file) => candidate({ path: file, line: 1, summary: `unchecked shape in ${file}` }))
          return { text: JSON.stringify({ summary: `Adds ${files.join(", ")}.`, findings }), tokens: { input: cost(reviewed.length), output: 0 } }
        }
        const ids = prompt.slice(prompt.indexOf("<findings"), prompt.indexOf("</findings>")).split("\n").flatMap((line) => { try { const value = JSON.parse(line) as { id?: string; path?: string }; return value.id ? [value] : [] } catch { return [] } })
        verified.push(ids.map((entry) => entry.path!))
        return { text: JSON.stringify({ verdicts: ids.map((entry) => ({ id: entry.id, verdict: "confirmed", evidence: [`${entry.path}:1`] })) }), tokens: { input: 500, output: 0 } }
      },
      async close() {},
    })
    return { factory, reviewed, verified, prompts }
  }
  const BUDGET = "  tokens_per_pr: 40000\n  context_tokens: 8000"

  test("it stops after part 1, posts a partial review of what it verified, lists what it did not review, and the next run reviews only the rest", async () => {
    const repo = await fourParts(BUDGET)
    const first = partKids((review) => review === 1 ? 12_000 : 1_000)
    const github = fakeGh()
    const run = await runPrReview({ ...baseInput(repo, first.factory), publish: true, gh: github.gh })
    expect(first.reviewed).toEqual([[PARTS[0]!]])
    // One closing check over part 1's candidate: its prompt holds the finding, not the diff, and says it is short.
    expect(first.verified).toEqual([[PARTS[0]!]])
    expect(first.prompts.at(-1)).toContain("short closing check")
    expect(first.prompts.at(-1)).not.toContain("diff --git")
    expect(run.status).toBe("published")
    expect(run.outcome!.partial).toMatchObject({ reviewed: [PARTS[0]!], notReviewed: PARTS.slice(1), unverified: 0 })
    expect(run.info!.partial).toMatchObject({ number: 12 })
    expect(run.outcome!.result.findings.map((finding) => finding.path)).toEqual([PARTS[0]!])
    expect(run.stop).toMatchObject({ kind: "budget", resumable: true, remaining: "3 of 4 parts of the diff not reviewed" })
    expect(run.checkpoint).toMatchObject({ phase: "analysis 1/4", candidates: [] })
    expect(run.checkpoint!.verified.map((finding) => finding.path)).toEqual([PARTS[0]!])
    expect(run.checkpoint!.result!.tokens).toEqual({ input: 0, output: 0, cached: 0 })

    const posted = JSON.parse(github.posts()[0]!.stdin!) as { body: string; comments: Array<{ path: string }> }
    expect(posted.comments.map((comment) => comment.path)).toEqual([PARTS[0]!])
    expect(posted.body).toContain("## MendCode partial review")
    expect(posted.body).toContain("**Partial review** · 1 of 4 files reviewed")
    for (const file of PARTS.slice(1)) expect(posted.body).toContain(`\`${file}\``)
    expect(posted.body).toContain("/pr review 12")
    expect(posted.body).toContain("budget.tokens_per_pr")
    expect(posted.body).not.toContain(reviewMarker(repo.head))
    // A partial review is not a review of the head: the dedupe state does not know this head.
    expect(run.state.lastHead).toBeUndefined()
    expect(Object.keys(run.state.published)).toHaveLength(1)

    // The next /pr review (the job's checkpoint, the state the partial left): only parts 2 to 4 are reviewed, the verified finding is not judged again.
    const second = partKids(() => 1_000)
    const rest = await runPrReview({ ...baseInput(repo, second.factory), publish: true, gh: github.gh, state: run.state, checkpoint: run.checkpoint })
    expect(second.reviewed).toEqual(PARTS.slice(1).map((file) => [file]))
    expect(second.verified.flat().sort()).toEqual(PARTS.slice(1))
    expect(rest.status).toBe("published")
    expect(rest.stop).toBeUndefined()
    expect(rest.outcome!.partial).toBeUndefined()
    expect(rest.outcome!.result.findings.map((finding) => finding.path).sort()).toEqual(PARTS)
    expect(rest.state.lastHead).toBe(repo.head)
    const whole = JSON.parse(github.posts()[1]!.stdin!) as { body: string; comments: Array<{ path: string }> }
    expect(whole.body).toContain("## MendCode review")
    expect(whole.body).toContain(reviewMarker(repo.head))
    // Part 1's finding was posted with the partial review: only the new ones are comments now.
    expect(whole.comments.map((comment) => comment.path).sort()).toEqual(PARTS.slice(1))
  })

  test("it stops after part 2: both parts are listed as reviewed, the other two as not reviewed", async () => {
    const repo = await fourParts(BUDGET)
    // Part 1 is cheap and part 2 is not: after part 1 the rest still fits, after part 2 it does not.
    const kids = partKids((review) => review === 1 ? 2_000 : 16_000)
    const github = fakeGh()
    const run = await runPrReview({ ...baseInput(repo, kids.factory), publish: true, gh: github.gh })
    expect(kids.reviewed).toEqual([[PARTS[0]!], [PARTS[1]!]])
    expect(run.outcome!.partial).toMatchObject({ reviewed: PARTS.slice(0, 2), notReviewed: PARTS.slice(2) })
    expect(run.outcome!.result.findings.map((finding) => finding.path).sort()).toEqual(PARTS.slice(0, 2))
    expect(run.checkpoint!.phase).toBe("analysis 2/4")
    expect(github.posts()).toHaveLength(1)
  })

  test("a turn that counts past the cap in part 3 keeps parts 1 and 2: they are posted as a partial review, not lost", async () => {
    const repo = await fourParts("  tokens_per_pr: 1000000\n  context_tokens: 8000")
    const kids = partKids(() => 1_000)
    let reviews = 0
    const over: ReviewSessionFactory = async (input) => {
      const child = await kids.factory(input)
      return { async send(prompt, options) { if (input.purpose === "review" && ++reviews === 3) throw new ReviewTurnOverBudget(10_000, 342_037); return child.send(prompt, options) }, close: () => child.close() }
    }
    const github = fakeGh()
    const run = await runPrReview({ ...baseInput(repo, over), publish: true, gh: github.gh })
    expect(run.outcome?.partial).toMatchObject({ reviewed: PARTS.slice(0, 2), notReviewed: PARTS.slice(2) })
    expect(run.status).toBe("published")
    expect(run.stop).toMatchObject({ kind: "budget", resumable: true })
    expect(JSON.parse(github.posts()[0]!.stdin!).body).toContain("## MendCode partial review")
  })
})
