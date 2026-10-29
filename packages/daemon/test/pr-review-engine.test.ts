import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIndexer } from "@mendcode/codegraph"
import { PrFinding } from "@mendcode/protocol"
import { buildReviewContext, gitRun, parseUnifiedDiff, type ReviewContext } from "../src/pr-review/context"
import { DEFAULT_ENGINE_CONFIG, reviewPrompt, reviewPullRequest, runReview, type ReviewSessionFactory } from "../src/pr-review/engine"
import { findingId, parseFindings } from "../src/pr-review/findings"
import { publishable, rankFindings, runChecks, verifyFindings } from "../src/pr-review/verify"

const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = (prefix: string) => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix))); temps.push(dir); return dir }

async function git(cwd: string, ...args: string[]) {
  const done = await gitRun(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], cwd)
  if (done.code !== 0) throw new Error(`git ${args.join(" ")} failed`)
  return done.out.trim()
}

/** A repository whose `feature` branch changes `total`, which three functions call. */
async function repository() {
  const dir = temp("pr-review-repo-")
  await git(dir, "init", "-q", "-b", "main")
  mkdirSync(path.join(dir, "src"))
  writeFileSync(path.join(dir, "src", "math.ts"), "export function total(values: number[]) {\n  let sum = 0\n  for (const value of values) sum += value\n  return sum\n}\n")
  writeFileSync(path.join(dir, "src", "use.ts"), "import { total } from \"./math\"\nexport function cart(prices: number[]) { return total(prices) }\nexport function invoice(lines: number[]) { return total(lines) * 1.2 }\nexport function report(rows: number[]) { return total(rows) / rows.length }\n")
  writeFileSync(path.join(dir, "big.txt"), Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n") + "\n")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "base")
  await git(dir, "checkout", "-q", "-b", "feature")
  writeFileSync(path.join(dir, "src", "math.ts"), "export function total(values: number[]) {\n  let sum = 0\n  for (let i = 1; i < values.length; i++) sum += values[i]!\n  return sum\n}\n")
  writeFileSync(path.join(dir, "big.txt"), Array.from({ length: 400 }, (_, i) => `changed ${i}`).join("\n") + "\n")
  await git(dir, "commit", "-q", "-am", "feature")
  return dir
}

async function graphOf(dir: string) {
  return createIndexer({ cacheDir: temp("pr-review-graph-"), now: Date.now }).graph({ cwd: dir, signal: new AbortController().signal })
}

/** A scripted engine: each child answers from the list in order, and records what it was asked and for what. */
function scripted(answers: string[]) {
  const asked: Array<{ purpose: string; prompt: string }> = []
  let opened = 0, closed = 0
  const factory: ReviewSessionFactory = async ({ purpose }) => {
    opened++
    return {
      async send(prompt) { asked.push({ purpose, prompt }); return { text: answers.shift() ?? "", tokens: { input: 1000, output: 100 } } },
      async close() { closed++ },
    }
  }
  return { factory, asked, sessions: () => ({ opened, closed }) }
}
const finding = (extra: Record<string, unknown> = {}) => ({ path: "src/math.ts", line: 3, severity: "major", category: "correctness", summary: "The loop skips the first value", detail: "Starting at 1 drops values[0], so total([5]) is 0.", evidence: ["src/math.ts:3"], ...extra })

describe("review context", () => {
  test("a changed function lists its three callers from the code graph, and the RIGHT side holds the hunk's lines", async () => {
    const dir = await repository()
    const context = await buildReviewContext({ directory: dir, base: "main", head: "feature", budgetTokens: 200_000, graph: await graphOf(dir) })
    const symbol = context.changedSymbols.find((entry) => entry.symbol === "total")
    expect(symbol?.path).toBe("src/math.ts")
    expect(symbol?.callers.map((caller) => caller.split(" ")[0]).sort()).toEqual(["cart", "invoice", "report"])
    expect(context.truncated).toBe(false)
    expect(context.files.find((file) => file.path === "src/math.ts")?.right.has(3)).toBe(true)
    expect(context.notes).toEqual([])
  })
  test("without a graph index the review proceeds on the diff and says so", async () => {
    const dir = await repository()
    const context = await buildReviewContext({ directory: dir, base: "main", head: "feature", budgetTokens: 200_000 })
    expect(context.changedSymbols).toEqual([])
    expect(context.diff).toContain("values[i]")
    expect(context.notes.join(" ")).toContain("No code graph index")
  })
  test("over budget, callers go first, then the largest files' diffs, and truncated is set", async () => {
    const dir = await repository()
    const graph = await graphOf(dir)
    const roomy = await buildReviewContext({ directory: dir, base: "main", head: "feature", budgetTokens: 200_000, graph })
    // Just under the full context: callers are cut, every diff is kept.
    const tight = await buildReviewContext({ directory: dir, base: "main", head: "feature", budgetTokens: (roomy.tokens - 5) * 2, graph })
    expect(tight.truncated).toBe(true)
    expect(tight.changedSymbols.find((entry) => entry.symbol === "total")!.callers.length).toBeLessThan(3)
    expect(tight.diff).toContain("changed 399")
    // Far under: the 400-line file's diff is left out, the small one stays.
    const small = await buildReviewContext({ directory: dir, base: "main", head: "feature", budgetTokens: 2_200, graph })
    expect(small.truncated).toBe(true)
    expect(small.diff).not.toContain("changed 399")
    expect(small.diff).toContain("values[i]")
    expect(small.notes.join(" ")).toContain("big.txt")
    expect(small.changedSymbols.every((entry) => entry.callers.length === 0)).toBe(true)
  })
  test("a ref that could be an option or a range is refused before git runs", async () => {
    const dir = await repository()
    for (const ref of ["--output=x", "main..feature", ""]) await expect(buildReviewContext({ directory: dir, base: ref, head: "feature", budgetTokens: 1000 })).rejects.toThrow("[PR_REVIEW]: invalid ref")
  })
  test("unified diffs split by file; a deleted file has no RIGHT lines", () => {
    const files = parseUnifiedDiff("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n one\n+two\n three\ndiff --git a/gone.ts b/gone.ts\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n")
    expect(files.map((file) => file.path)).toEqual(["a.ts", "gone.ts"])
    expect([...files[0]!.right]).toEqual([1, 2, 3])
    expect(files[0]!.touched).toEqual([2])
    expect(files[1]!.right.size).toBe(0)
  })
})

describe("review pass", () => {
  async function context(): Promise<ReviewContext> {
    const dir = await repository()
    return buildReviewContext({ directory: dir, base: "main", head: "feature", budgetTokens: 200_000, graph: await graphOf(dir) })
  }
  test("findings come back validated with a stable id and the RIGHT side; one outside the diff is dropped", async () => {
    const engine = scripted([JSON.stringify({ summary: "Changes the sum loop.", findings: [finding(), finding({ path: "src/use.ts", line: 2, summary: "Not changed here" }), finding({ path: "src/math.ts", line: 40, summary: "Past the end" })] })])
    const result = await runReview({ sessionFactory: engine.factory, context: await context(), config: DEFAULT_ENGINE_CONFIG })
    expect(result.findings).toHaveLength(1)
    expect(PrFinding.parse(result.findings[0])).toMatchObject({ side: "RIGHT", id: findingId({ path: "src/math.ts", line: 3, category: "correctness", summary: "The loop skips the first value" }) })
    expect(result.findings[0]!.verdict).toBeUndefined()
    expect(result.dropped).toBe(2)
    expect(result.summary).toBe("Changes the sum loop.")
    expect(result.tokens).toEqual({ input: 1000, output: 100 })
    expect(result.budgetHit).toBe(false)
    expect(engine.sessions()).toEqual({ opened: 1, closed: 1 })
    expect(engine.asked[0]!.purpose).toBe("review")
    expect(engine.asked[0]!.prompt).toContain("callers: ")
    expect(engine.asked[0]!.prompt).toContain("untrusted evidence")
  })
  test("invalid JSON gets one repair turn in the same child; a second invalid answer fails", async () => {
    const repaired = scripted(["I think the loop is wrong.", "```json\n" + JSON.stringify({ summary: "ok", findings: [finding()] }) + "\n```"])
    const result = await runReview({ sessionFactory: repaired.factory, context: await context(), config: DEFAULT_ENGINE_CONFIG })
    expect(result.findings).toHaveLength(1)
    expect(result.tokens).toEqual({ input: 2000, output: 200 })
    expect(repaired.asked[1]!.prompt).toContain("could not be used")
    expect(repaired.sessions()).toEqual({ opened: 1, closed: 1 })
    const broken = scripted(["prose", JSON.stringify({ findings: [{ path: "src/math.ts", line: "three" }] })])
    await expect(runReview({ sessionFactory: broken.factory, context: await context(), config: DEFAULT_ENGINE_CONFIG })).rejects.toThrow("[PR_REVIEW]: invalid findings")
    expect(broken.sessions().closed).toBe(1)
  })
  test("a clean change is an empty findings array; the token budget is reported as hit, not guessed", async () => {
    const engine = scripted([JSON.stringify({ summary: "Fine.", findings: [] })])
    const result = await runReview({ sessionFactory: engine.factory, context: await context(), config: { ...DEFAULT_ENGINE_CONFIG, budgetTokens: 500 } })
    expect(result.findings).toEqual([])
    expect(result.budgetHit).toBe(true)
  })
  test("the prompt carries scoped path instructions and learnings, never the repository", async () => {
    const ctx = await context()
    const prompt = reviewPrompt(ctx, { ...DEFAULT_ENGINE_CONFIG, instructions: [{ glob: "src/**", instructions: "treat off-by-one as major" }], learnings: "- prefer early returns" })
    expect(prompt).toContain("src/**: treat off-by-one as major")
    expect(prompt).toContain("prefer early returns")
    expect(prompt).not.toContain("export function cart")
  })
  test("parseFindings never turns prose into a finding", () => {
    expect(parseFindings("The loop at src/math.ts:3 is wrong.")).toMatchObject({ ok: false })
    expect(parseFindings(JSON.stringify({ findings: [finding({ severity: "blocker" })] }))).toMatchObject({ ok: false })
    expect(parseFindings(JSON.stringify({ findings: [] }))).toEqual({ ok: true, summary: "", findings: [] })
  })
})

describe("verify pass and ranking", () => {
  const verdicts = (entries: Array<[string, string, string[]?]>) => JSON.stringify({ verdicts: entries.map(([id, verdict, evidence]) => ({ id, verdict, evidence: evidence ?? [] })) })
  const make = (summary: string, extra: Record<string, unknown> = {}) => PrFinding.parse({ id: findingId({ path: "src/math.ts", line: 3, category: String(extra.category ?? "correctness"), summary }), path: "src/math.ts", line: 3, side: "RIGHT", severity: "major", category: "correctness", summary, detail: "d", evidence: [], ...extra })
  async function context() {
    const dir = await repository()
    return buildReviewContext({ directory: dir, base: "main", head: "feature", budgetTokens: 200_000 })
  }

  test("a finding the verifier refutes from a guarding caller is rejected; a confirmed one keeps its new evidence", async () => {
    const real = make("The loop skips the first value"), guarded = make("total may get undefined")
    const engine = scripted([verdicts([[real.id, "confirmed", ["src/math.ts:3 starts at 1"]], [guarded.id, "rejected", ["src/use.ts:2 cart always passes an array"]]])])
    const done = await verifyFindings({ sessionFactory: engine.factory, findings: [real, guarded], context: await context() })
    expect(done.findings.map((finding) => finding.verdict)).toEqual(["confirmed", "rejected"])
    expect(done.findings[0]!.evidence).toContain("src/math.ts:3 starts at 1")
    expect(publishable(done.findings, "normal").map((finding) => finding.id)).toEqual([real.id])
    expect(engine.asked[0]!.purpose).toBe("verify")
    expect(engine.asked[0]!.prompt).toContain("refute")
  })
  test("each batch of at most ten is a fresh child, never the session that found them; an unjudged finding counts as rejected", async () => {
    const findings = Array.from({ length: 12 }, (_, i) => make(`finding ${i}`))
    const engine = scripted([verdicts(findings.slice(0, 10).map((finding) => [finding.id, "confirmed"])), verdicts([[findings[10]!.id, "confirmed"]])])
    const done = await verifyFindings({ sessionFactory: engine.factory, findings, context: await context() })
    expect(engine.sessions()).toEqual({ opened: 2, closed: 2 })
    expect(done.findings.filter((finding) => finding.verdict === "confirmed")).toHaveLength(11)
    expect(done.findings[11]!.verdict).toBe("rejected")
  })
  test("plausible findings are published only by the strict profile", async () => {
    const maybe = make("Maybe a race")
    const engine = scripted([verdicts([[maybe.id, "plausible"]])])
    const done = await verifyFindings({ sessionFactory: engine.factory, findings: [maybe], context: await context() })
    expect(publishable(done.findings, "normal")).toEqual([])
    expect(publishable(done.findings, "strict").map((finding) => finding.verdict)).toEqual(["plausible"])
  })
  test("a profile publishes only its kinds, whatever the child reported: quiet no minor, normal no maintainability", () => {
    const confirmed = (summary: string, severity: PrFinding["severity"], category: PrFinding["category"]): PrFinding => ({ ...make(summary), severity, category, verdict: "confirmed" })
    const all = [confirmed("breaks totals", "major", "correctness"), confirmed("slow loop", "minor", "performance"), confirmed("long function", "minor", "maintainability")]
    expect(publishable(all, "quiet").map((finding) => finding.summary)).toEqual(["breaks totals"])
    expect(publishable(all, "normal").map((finding) => finding.summary)).toEqual(["breaks totals", "slow loop"])
    expect(publishable(all, "strict")).toHaveLength(3)
  })
  test("a verifier that fails twice leaves everything unpublished and the summary says verification failed", async () => {
    const ctx = await context()
    const review = JSON.stringify({ summary: "Changes the sum loop.", findings: [finding()] })
    const engine = scripted([review, "I could not decide.", "still prose"])
    const outcome = await reviewPullRequest({ sessionFactory: engine.factory, context: ctx, config: DEFAULT_ENGINE_CONFIG, cap: 8 })
    expect(outcome.verified).toBe(false)
    expect(outcome.result.findings).toEqual([])
    expect(outcome.result.summary).toContain("Verification failed")
    expect(engine.sessions()).toEqual({ opened: 2, closed: 2 })
    const crashing: ReviewSessionFactory = async ({ purpose }) => ({ async send() { if (purpose === "verify") throw new Error("[PR_REVIEW]: child crashed"); return { text: review, tokens: { input: 1, output: 1 } } }, async close() {} })
    const crashed = await reviewPullRequest({ sessionFactory: crashing, context: ctx, config: DEFAULT_ENGINE_CONFIG, cap: 8 })
    expect(crashed.verified).toBe(false)
    expect(crashed.result.findings).toEqual([])
  })
  test("ranking puts confirmed first, then severity and category, caps and folds the rest into the summary", async () => {
    const minor = make("minor style", { severity: "minor", category: "maintainability" })
    const critical = make("critical hole", { severity: "critical", category: "security" })
    const majorTests = make("missing test", { category: "tests" })
    const majorBug = make("major bug")
    const plausible = { ...make("plausible crit", { severity: "critical" }), verdict: "plausible" as const }
    const confirmed = [minor, critical, majorTests, majorBug].map((finding) => ({ ...finding, verdict: "confirmed" as const }))
    const ranked = rankFindings([plausible, ...confirmed], 3)
    expect(ranked.shown.map((finding) => finding.summary)).toEqual(["critical hole", "major bug", "missing test"])
    expect(ranked.folded).toBe(2)
    expect(rankFindings(confirmed, 8)).toMatchObject({ folded: 0 })
    // The whole pipeline: three confirmed of which the cap shows two, one rejected.
    const ctx = await context()
    const found = [finding(), finding({ line: 2, summary: "second" }), finding({ line: 4, summary: "third", severity: "minor" }), finding({ line: 1, summary: "wrong" })]
    const ids = found.map((entry) => findingId({ path: entry.path as string, line: entry.line as number, category: "correctness", summary: entry.summary as string }))
    const engine = scripted([JSON.stringify({ summary: "S.", findings: found }), verdicts([[ids[0]!, "confirmed"], [ids[1]!, "confirmed"], [ids[2]!, "confirmed"], [ids[3]!, "rejected"]])])
    const outcome = await reviewPullRequest({ sessionFactory: engine.factory, context: ctx, config: DEFAULT_ENGINE_CONFIG, cap: 2 })
    // Equal severity and category: by line.
    expect(outcome.result.findings.map((entry) => entry.summary)).toEqual(["second", "The loop skips the first value"])
    expect(outcome.folded).toBe(1)
    expect(outcome.result.dropped).toBe(2)
    expect(outcome.result.summary).toContain("And 1 smaller note not shown")
    expect(outcome.result.tokens).toEqual({ input: 2000, output: 200 })
  })
  test("check results reach the verifier; without a sandbox backend a check never runs and says why", async () => {
    const results = await runChecks({ directory: tmpdir(), commands: ["echo hi"], backend: null })
    expect(results).toEqual([{ command: "echo hi", code: -1, output: expect.stringContaining("not run: sandbox") }])
    const real = make("The loop skips the first value")
    const engine = scripted([verdicts([[real.id, "confirmed"]])])
    await verifyFindings({ sessionFactory: engine.factory, findings: [real], context: await context(), checks: [{ command: "bun test", code: 1, output: "1 fail: total([5])" }] })
    expect(engine.asked[0]!.prompt).toContain("$ bun test (exit 1)")
  })
})
