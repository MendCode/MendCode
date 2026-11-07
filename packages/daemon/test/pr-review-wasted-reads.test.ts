import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { PrFinding } from "@mendcode/protocol"
import { buildReviewContext, CONTEXT_SHARE, gitRun } from "../src/pr-review/context"
import type { ReviewSessionFactory } from "../src/pr-review/engine"
import { extractJson, findingId } from "../src/pr-review/findings"
import { runPrReview } from "../src/pr-review/run"
import { emptyState, type ReviewState } from "../src/pr-review/state"
import { verifyFindings } from "../src/pr-review/verify"

/**
 * Model calls a review made for nothing, from the reviewer's records of 2026-11-07 (MendCode/MendCode #99 to #103): a verifier answer
 * that began with the asked JSON was refused ("no JSON object in the answer"), so the job spent a repair turn and two retries on one
 * candidate, and each retry asked the readers again about files whose summaries no review pass would read; #99's diff, 2% over one
 * call, became a second part of 8 files whose call read 330 K tokens. Plus the guards that a head with nothing new costs no call.
 * Real git in temp directories, scripted children, no provider.
 */

const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "pr-wasted-"))); temps.push(dir); return dir }
async function git(cwd: string, ...args: string[]) {
  const done = await gitRun(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], cwd)
  if (done.code !== 0) throw new Error(`git ${args.join(" ")} failed`)
  return done.out.trim()
}
const write = (dir: string, file: string, text: string) => { mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); writeFileSync(path.join(dir, file), text) }

/** main with the config and a branch that changes `src/a.ts` (and whatever `extra` adds). */
async function repository({ config = "enabled: true\n", extra = {} }: { config?: string; extra?: Record<string, string> } = {}) {
  const dir = temp()
  await git(dir, "init", "-q", "-b", "main")
  write(dir, ".mendcode/review.yaml", config)
  write(dir, "src/a.ts", "export const a = 1\n")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "base")
  const base = await git(dir, "rev-parse", "HEAD")
  await git(dir, "checkout", "-q", "-b", "feature")
  write(dir, "src/a.ts", "export const a = 2 // CHANGED\n")
  for (const [file, text] of Object.entries(extra)) write(dir, file, text)
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "change")
  return { dir, base, head: await git(dir, "rev-parse", "HEAD") }
}

const FINDING = PrFinding.parse({
  id: findingId({ path: "src/a.ts", line: 1, category: "correctness", summary: "a is off by one" }),
  path: "src/a.ts", line: 1, side: "RIGHT", severity: "major", category: "correctness", summary: "a is off by one", detail: "d", evidence: ["src/a.ts:1"],
})
const VERDICT = JSON.stringify({ verdicts: [{ id: FINDING.id, verdict: "confirmed", evidence: ["src/a.ts:1 if (a) { b } holds"], score: 8 }] })

/** Children by purpose: the review pass reports `FINDING`, the verifier answers `verdict` (once each call), readers answer nothing usable. */
function children({ verdict = () => VERDICT }: { verdict?: (call: number) => string } = {}) {
  const calls: Array<{ purpose: string; prompt: string }> = []
  let verifies = 0
  const factory: ReviewSessionFactory = async ({ purpose }) => ({
    async send(prompt) {
      calls.push({ purpose, prompt })
      if (purpose === "review") return { text: JSON.stringify({ summary: "Changes a.", findings: [{ path: FINDING.path, line: FINDING.line, severity: FINDING.severity, category: FINDING.category, summary: FINDING.summary, detail: "d", evidence: FINDING.evidence }] }), tokens: { input: 1_000, output: 10 } }
      if (purpose === "verify") return { text: verdict(verifies++), tokens: { input: 500, output: 10 } }
      return { text: "not json", tokens: { input: 300, output: 5 } }
    },
    async close() {},
  })
  return { factory, calls, of: (purpose: string) => calls.filter((call) => call.purpose === purpose) }
}

describe("a verifier answer that holds the asked JSON is used the first time", () => {
  const ok = (value: Record<string, unknown>) => Array.isArray(value.verdicts)
  for (const [name, text] of [
    ["prose with a brace after the object", `${VERDICT}\nI also checked that \`{}\` is never passed.`],
    ["the object written twice", `${VERDICT}${VERDICT}`],
    ["a stray brace in prose before it", `The guard { in parse() matters. ${VERDICT}`],
    ["an empty object in prose before it", `Checked {} first. ${VERDICT}`],
    ["a backslash JSON does not escape", VERDICT.replace("holds", "matches /\\d+/ holds")],
    ["a raw line break inside a string", VERDICT.replace("holds", "holds\nand more")],
  ] as const) {
    test(name, () => {
      expect((extractJson(text, ok) as { verdicts: Array<{ id: string }> }).verdicts[0]!.id).toBe(FINDING.id)
    })
  }

  test("a cut answer is still refused, so a repair turn asks again", () => {
    expect(() => extractJson(VERDICT.slice(0, 60), ok)).toThrow("no JSON object in the answer")
  })

  test("the verify pass takes it without a repair turn", async () => {
    const kids = children({ verdict: () => `${VERDICT}\nNote: \`{ held: true }\` is only sent by new clients.` })
    const context = { directory: "/x", base: "a", head: "b", diff: "", files: [], changedSymbols: [], truncated: false, notes: [], tokens: 0 }
    const done = await verifyFindings({ sessionFactory: kids.factory, findings: [FINDING], context })
    expect(done.findings.map((finding) => finding.verdict)).toEqual(["confirmed"])
    expect(kids.of("verify")).toHaveLength(1)
  })
})

describe("a retry that only verifies reads nothing again", () => {
  test("the resume of a failed verifier calls no reader and no review pass; it verifies the kept candidate once", async () => {
    // No internal cap: a diff this small would otherwise be too small for a reader call.
    const repo = await repository({ config: "enabled: true\nbudget:\n  tokens_per_pr: null\n", extra: { "src/b.ts": "export const b = 1\n" } })
    const readerCalls: string[] = []
    const reader: ReviewSessionFactory = async () => ({ async send(prompt) { readerCalls.push(prompt); return { text: "not json", tokens: { input: 300, output: 5 } } }, async close() {} })
    const readers = { tier: "full" as const, source: () => ({ ok: true as const, model: "claude-haiku", factory: reader }) }
    // The first run: the verifier's answer is unusable twice (the turn and its repair), so the job fails with a checkpoint.
    const first = children({ verdict: () => "I could not decide." })
    const failed = await runPrReview({ repo: "acme/api", number: 7, directory: repo.dir, base: repo.base, head: repo.head, state: emptyState(), sessionFactory: first.factory, publish: false, readers })
    expect(failed.status).toBe("failed")
    expect(failed.checkpoint?.candidates.map((finding) => finding.id)).toEqual([FINDING.id])
    const read = readerCalls.length
    expect(read).toBeGreaterThan(0)
    // The retry: no reader is asked again, no review pass runs, one verify call.
    const retry = children()
    const resumed = await runPrReview({ repo: "acme/api", number: 7, directory: repo.dir, base: repo.base, head: repo.head, state: emptyState(), sessionFactory: retry.factory, publish: false, readers, checkpoint: failed.checkpoint })
    expect(readerCalls.length).toBe(read)
    expect(retry.of("review")).toHaveLength(0)
    expect(retry.of("verify")).toHaveLength(1)
    expect(resumed.outcome?.result.findings.map((finding) => finding.id)).toEqual([FINDING.id])
  })
})

describe("a head with nothing new costs no model call", () => {
  async function reviewed(repo: { dir: string; head: string }): Promise<ReviewState> {
    return { version: 1, lastHead: repo.head, published: {} }
  }

  test("an empty commit on the reviewed head", async () => {
    const repo = await repository()
    await git(repo.dir, "commit", "-q", "--allow-empty", "-m", "retrigger CI")
    const head = await git(repo.dir, "rev-parse", "HEAD")
    const kids = children()
    const run = await runPrReview({ repo: "acme/api", number: 7, directory: repo.dir, base: repo.base, head, state: await reviewed(repo), sessionFactory: kids.factory, publish: false })
    expect(kids.calls).toEqual([])
    expect(run.status).toBe("reviewed")
    expect(run.outcome?.result.summary).toContain("nothing changed, so no model was called")
  })

  test("a reworded commit force-pushed over the reviewed head (same files, not its descendant)", async () => {
    const repo = await repository()
    await git(repo.dir, "commit", "-q", "--amend", "-m", "change, reworded")
    const head = await git(repo.dir, "rev-parse", "HEAD")
    expect(head).not.toBe(repo.head)
    const kids = children()
    const run = await runPrReview({ repo: "acme/api", number: 7, directory: repo.dir, base: repo.base, head, state: await reviewed(repo), sessionFactory: kids.factory, publish: false })
    expect(kids.calls).toEqual([])
    expect(run.outcome?.result.summary).toContain("has the same files as the reviewed head")
  })

  test("a push that changes only files the config ignores", async () => {
    const repo = await repository({ config: "enabled: true\nignore:\n  - \"docs/**\"\n" })
    write(repo.dir, "docs/notes.md", "notes\n")
    await git(repo.dir, "add", "-A")
    await git(repo.dir, "commit", "-q", "-m", "docs")
    const head = await git(repo.dir, "rev-parse", "HEAD")
    const kids = children()
    const run = await runPrReview({ repo: "acme/api", number: 7, directory: repo.dir, base: repo.base, head, state: await reviewed(repo), sessionFactory: kids.factory, publish: false })
    expect(kids.calls).toEqual([])
    expect(run.outcome?.result.summary).toContain("No file this review reads changed")
  })

  test("`full` still reviews the same files again when asked", async () => {
    const repo = await repository()
    await git(repo.dir, "commit", "-q", "--allow-empty", "-m", "retrigger CI")
    const head = await git(repo.dir, "rev-parse", "HEAD")
    const kids = children()
    await runPrReview({ repo: "acme/api", number: 7, directory: repo.dir, base: repo.base, head, state: await reviewed(repo), sessionFactory: kids.factory, publish: false, full: true })
    expect(kids.of("review")).toHaveLength(1)
  })
})

describe("a diff just over one call is one call", () => {
  /** `count` files of about `chars` characters of diff each. */
  async function wide(count: number, chars: number) {
    const dir = temp()
    await git(dir, "init", "-q", "-b", "main")
    for (let index = 0; index < count; index++) write(dir, `src/f${index}.ts`, "export const x = 0\n")
    await git(dir, "add", "-A")
    await git(dir, "commit", "-q", "-m", "base")
    const base = await git(dir, "rev-parse", "HEAD")
    const line = (index: number, n: number) => `export const v${index}_${n} = "${"x".repeat(60)}"\n`
    for (let index = 0; index < count; index++) write(dir, `src/f${index}.ts`, Array.from({ length: Math.ceil(chars / 85) }, (_, n) => line(index, n)).join(""))
    await git(dir, "add", "-A")
    await git(dir, "commit", "-q", "-m", "change")
    return { dir, base, head: await git(dir, "rev-parse", "HEAD") }
  }

  test("a diff 2% over one call's share is not split into a second part; one 30% over still is", async () => {
    const repo = await wide(10, 4_000)
    const probe = await buildReviewContext({ directory: repo.dir, base: repo.base, head: repo.head, budgetTokens: 10_000_000 })
    const budgetFor = (over: number) => Math.floor(probe.tokens / over / CONTEXT_SHARE)
    const near = await buildReviewContext({ directory: repo.dir, base: repo.base, head: repo.head, budgetTokens: budgetFor(1.02) })
    expect(near.parts).toBeUndefined()
    expect(near.notes.some((note) => note.startsWith("The token budget left out"))).toBe(false)
    const far = await buildReviewContext({ directory: repo.dir, base: repo.base, head: repo.head, budgetTokens: budgetFor(1.3) })
    expect(far.parts?.length).toBe(2)
  })
})
