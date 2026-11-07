import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { estimateTokens } from "@mendcode/protocol"
import { gitRun, parseUnifiedDiff } from "../src/pr-review/context"
import { createAccounting, accountingFile } from "../src/pr-review/accounting"
import type { ReviewSessionFactory } from "../src/pr-review/engine"
import { createJobLedger } from "../src/pr-review/jobs"
import { annotateDiff, riskHunks, validRisks } from "../src/pr-review/read-code"
import { READER_SHARE, READER_SHARE_ALL } from "../src/pr-review/readers"
import { runPrReview } from "../src/pr-review/run"
import { emptyState } from "../src/pr-review/state"

/**
 * Readers read all the changed code (docs/pr-review.md, "Readers read the code"): every code file goes to the cheap readers, the
 * review pass gets their summaries and only the hunks of the risk spots they cite (small files whole), and a file no reader could
 * read goes to the review pass raw. Scripted children and a temp git repository; no provider is called.
 */

const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mc-readers-code-"))); temps.push(dir); return dir }
async function git(cwd: string, ...args: string[]) {
  const done = await gitRun(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], cwd)
  if (done.code !== 0) throw new Error(`git ${args.join(" ")} failed`)
  return done.out.trim()
}
const write = (dir: string, file: string, text: string) => { mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); writeFileSync(path.join(dir, file), text) }

const FILES = 8
const HUNKS = 5
/** A module of 90 small functions; `changed` rewrites five functions in each of five places, so its diff has five hunks. */
const module = (index: number, changed: boolean) => Array.from({ length: 90 }, (_, n) => {
  const hunk = Math.floor(n / 16)
  const touched = changed && n % 16 < 5 && hunk < HUNKS
  return `export function f${index}_${n}(a: number, b: number): number {\n  return a + b * ${n}${touched ? ` + guard(a) // HUNK_${index}_${hunk}` : ""}\n}\n`
}).join("")

/** Eight service modules with five changed places each, one three-line change (small), and a README. */
async function repository(config = "enabled: true\n") {
  const dir = temp()
  await git(dir, "init", "-q", "-b", "main")
  write(dir, ".mendcode/review.yaml", config)
  for (let index = 0; index < FILES; index++) write(dir, `src/services/mod${index}.ts`, module(index, false))
  write(dir, "src/small.ts", "export const limit = 10\n")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "base")
  const base = await git(dir, "rev-parse", "HEAD")
  await git(dir, "checkout", "-q", "-b", "feature")
  for (let index = 0; index < FILES; index++) write(dir, `src/services/mod${index}.ts`, module(index, true))
  write(dir, "src/small.ts", "export const limit = 20 // SMALL_CHANGE\n")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "change")
  return { dir, base, head: await git(dir, "rev-parse", "HEAD") }
}

type Reader = { omit?: string[]; bad?: Record<string, Array<[number, number]>>; nothing?: string[]; fail?: boolean }
/** Reader children: for each code group, flag the second hunk's added lines (read from the numbered diff), as scripted. */
function readerKids(script: Reader = {}) {
  const prompts: string[] = []
  const factory: ReviewSessionFactory = async ({ purpose }) => ({
    async send(prompt) {
      if (purpose !== "read") throw new Error(`unexpected ${purpose}`)
      prompts.push(prompt)
      if (script.fail) throw new Error("the reader crashed")
      const groups = [...prompt.matchAll(/<group id="(g\d+)" path="([^"]+)">\n([^\n]*)\n([\s\S]*?)\n<\/group>/g)]
      return {
        text: JSON.stringify({ groups: groups.flatMap(([, id, file, , body]) => {
          if (script.omit?.includes(file!)) return []
          const hunks: number[][] = []
          for (const line of body!.split("\n")) {
            if (line.startsWith("@@")) { hunks.push([]); continue }
            const added = /^\s*(\d+) \+/.exec(line)
            if (added) hunks.at(-1)!.push(Number(added[1]))
          }
          const spot = hunks[1] ?? hunks[0]!
          const risks = script.bad?.[file!]?.map(([start, end]) => ({ start, end, kind: "error_path", why: "made up" })) ?? (script.nothing?.includes(file!) ? [] : [{ start: spot[0]!, end: spot.at(-1)!, kind: "error_path", why: `guard() may throw before ${file} validates` }])
          return [{ id, files: [{ path: file, changed: `Adds guard(a) to five functions of ${file}.`, risks, nothing_risky: risks.length === 0 }] }]
        }) }),
        tokens: { input: 9_000, output: 400, cached: 2_000 },
      }
    },
    async close() {},
  })
  return { factory, prompts }
}

function reviewKids() {
  const prompts: string[] = []
  const factory: ReviewSessionFactory = async ({ purpose }) => ({
    async send(prompt) {
      if (purpose === "read") throw new Error("the review's own factory never runs a reader")
      prompts.push(prompt)
      return { text: JSON.stringify({ summary: "Adds guard calls.", findings: [] }), tokens: { input: 5_000, output: 300 } }
    },
    async close() {},
  })
  return { factory, prompts }
}

async function review({ config, script = {}, source = true }: { config?: string; script?: Reader; source?: boolean } = {}) {
  const repo = await repository(config)
  const main = reviewKids()
  const readers = readerKids(script)
  const accounted: Array<{ purpose: string; input: number }> = []
  const run = await runPrReview({
    repo: "acme/api", number: 7, directory: repo.dir, base: repo.base, head: repo.head, state: emptyState(), sessionFactory: main.factory, publish: false,
    readers: { tier: "full", source: () => source ? { ok: true, model: "claude-haiku", factory: readers.factory } : { ok: false, reason: "no cheap model" } },
    account: ({ purpose, tokens }) => accounted.push({ purpose, input: tokens.input }),
  })
  return { run, main: main.prompts[0]!, readers: readers.prompts, accounted }
}

describe("readers read all the changed code", () => {
  test("every code file goes to the readers; the review pass gets summaries and the hunks of the risk spots, not the whole diff", async () => {
    const { run, main, readers } = await review()
    expect(run.status).toBe("reviewed")
    for (let index = 0; index < FILES; index++) expect(readers.join("\n")).toContain(`path="src/services/mod${index}.ts"`)
    expect(readers.join("\n")).toContain("path=\"src/small.ts\"")
    // The readers saw the whole diff of a file, with new-side numbers.
    expect(readers.join("\n")).toContain("HUNK_3_4")
    expect(main).toContain("Reader summary (claude-haiku, unverified): Adds guard(a) to five functions of src/services/mod3.ts.")
    expect(main).toContain("guard() may throw before src/services/mod3.ts validates")
    // Only the flagged hunk (the second) of a large file is shown.
    expect(main).toContain("HUNK_3_1")
    expect(main).not.toContain("HUNK_3_0")
    expect(main).not.toContain("HUNK_3_2")
    expect(main).toContain("1 of 5 hunks shown")
    // The file list with sizes, and the small file whole.
    expect(main).toContain("Changed files (+added -removed lines):")
    expect(main).toContain("src/services/mod0.ts (+25 -25)")
    expect(main).toContain("SMALL_CHANGE")
    expect(main).toContain("small, shown whole")
    expect(run.info!.notes.join("\n")).toContain(`Readers: ${FILES + 1} files went to readers instead of the review pass whole: ${FILES + 1} code files by claude-haiku`)
  })

  test("reader turns are accounted as their own purpose, apart from the review pass", async () => {
    const { accounted } = await review()
    const read = accounted.filter((entry) => entry.purpose === "read")
    expect(read.length).toBeGreaterThan(0)
    expect(read.every((entry) => entry.input === 9_000)).toBe(true)
    expect(accounted.filter((entry) => entry.purpose === "review").map((entry) => entry.input)).toEqual([5_000])
  })

  test("a file whose reader answer is missing, or whose every cited line is outside the diff, goes to the review pass raw", async () => {
    const { main, run } = await review({ script: { omit: ["src/services/mod1.ts"], bad: { "src/services/mod2.ts": [[9_000, 9_010], [0, 3]] } } })
    // Raw: the whole diff, every hunk, and no reader summary for it.
    for (const file of [1, 2]) for (let hunk = 0; hunk < HUNKS; hunk++) expect(main).toContain(`HUNK_${file}_${hunk}`)
    expect(main).not.toContain("Adds guard(a) to five functions of src/services/mod1.ts")
    expect(main).not.toContain("Adds guard(a) to five functions of src/services/mod2.ts")
    // The others are still read.
    expect(main).not.toContain("HUNK_4_0")
    const note = run.info!.notes.join("\n")
    expect(note).toContain("2 code files no reader could read went to the review pass whole")
  })

  test("risk spots with lines outside the diff are dropped; the valid ones stay and the note counts the dropped", async () => {
    const real = (await review()).main
    const [start, end] = /- (\d+)-(\d+) \[error_path\] guard\(\) may throw before src\/services\/mod5/.exec(real)!.slice(1).map(Number) as [number, number]
    const { main, run } = await review({ script: { bad: { "src/services/mod5.ts": [[start, end], [7_000, 7_001]] } } })
    expect(main).toContain(`- ${start}-${end} [error_path] made up`)
    expect(main).not.toContain("7000")
    expect(run.info!.notes.join("\n")).toContain("1 risk spot the readers cited outside the diff was dropped")
  })

  test("a reader that says nothing is risky leaves only its summary; a file with no flag and no 'nothing risky' is raw", async () => {
    const quiet = await review({ script: { nothing: ["src/services/mod6.ts"] } })
    expect(quiet.main).toContain("The reader flagged no risk spot")
    expect(quiet.main).not.toContain("HUNK_6_1")
    expect(quiet.main).toContain("0 of 5 hunks shown")
  })

  test("when every reader call fails, all the code goes to the review pass whole and nothing falls back to a large model", async () => {
    const { main, run, readers } = await review({ script: { fail: true } })
    for (let index = 0; index < FILES; index++) for (let hunk = 0; hunk < HUNKS; hunk++) expect(main).toContain(`HUNK_${index}_${hunk}`)
    expect(main).not.toContain("Reader summary")
    expect(run.status).toBe("reviewed")
    expect(readers.length).toBeGreaterThan(0)
    expect(run.info!.notes.join("\n")).toContain("went to the review pass whole (a reader failed (the reader crashed)")
  })

  test("without a cheap model the review pass reads the code itself, as before", async () => {
    const { main, readers } = await review({ source: false })
    expect(readers).toEqual([])
    expect(main).toContain("HUNK_0_0")
    expect(main).toContain("HUNK_7_4")
    expect(main).not.toContain("Reader summary")
  })

  test("readers.code: overflow restores the old behaviour: the review pass reads all the code, readers only take data", async () => {
    const { main, readers } = await review({ config: "enabled: true\nreaders: { code: overflow }\n" })
    expect(readers).toEqual([])
    for (let index = 0; index < FILES; index++) for (let hunk = 0; hunk < HUNKS; hunk++) expect(main).toContain(`HUNK_${index}_${hunk}`)
    expect(main).not.toContain("Changed files (+added -removed lines):")
  })

  test("the review pass prompt is a fraction of what it was when it read every file itself", async () => {
    const all = (await review()).main
    const overflow = (await review({ config: "enabled: true\nreaders: { code: overflow }\n" })).main
    const tokens = { all: estimateTokens(all.length), overflow: estimateTokens(overflow.length) }
    // Printed for the record of the change; the assertion is the bound that matters.
    console.log(`main-pass prompt tokens on the ${FILES + 1}-file fixture: readers.code all ${tokens.all}, overflow ${tokens.overflow} (${Math.round((100 * tokens.all) / tokens.overflow)}%)`)
    expect(tokens.all).toBeLessThan(tokens.overflow * 0.6)
  })

  test("readers get a larger share of the cap than the data-only readers did", () => {
    expect(READER_SHARE_ALL).toBeGreaterThan(READER_SHARE)
    expect(READER_SHARE_ALL).toBeLessThanOrEqual(0.5)
  })
})

describe("read-code helpers", () => {
  const file = parseUnifiedDiff("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -20,2 +20,3 @@\n x\n+y\n z\n")[0]!

  test("the numbered diff gives every added and context line its new-side number and none to removed lines", () => {
    expect(annotateDiff(file.text).split("\n")).toEqual(["@@ -1,3 +1,3 @@", "    1  a", "      -b", "    2 +B", "    3  c", "@@ -20,2 +20,3 @@", "   20  x", "   21 +y", "   22  z"])
  })

  test("a risk spot is kept only when both ends are new-side lines of the diff", () => {
    const risks = [{ start: 2, end: 3, kind: "x", why: "" }, { start: 4, end: 5, kind: "x", why: "" }, { start: 21, end: 20, kind: "x", why: "" }, { start: 1, end: 22, kind: "x", why: "" }]
    const { kept, dropped } = validRisks(file, risks)
    expect(kept.map((risk) => [risk.start, risk.end])).toEqual([[2, 3], [1, 22]])
    expect(dropped).toBe(2)
  })

  test("only the hunks a risk spot touches are kept, with the header", () => {
    const shown = riskHunks(file.text, [{ start: 21, end: 21 }])
    expect(shown).toMatchObject({ shown: 1, total: 2 })
    expect(shown.header).toContain("+++ b/a.ts")
    expect(shown.body).toContain("+y")
    expect(shown.body).not.toContain("+B")
  })
})

describe("accounting and the job's tokens keep readers apart", () => {
  test("a read purpose is its own total, and an accounting file written before it existed still loads", () => {
    const dir = temp()
    const file = accountingFile(dir)
    const key = { repo: "acme/api", number: 7, head: "a".repeat(40), reviewer: "global" }
    mkdirSync(path.dirname(file), { recursive: true })
    const old = { version: 1, open: [], records: [{ ...key, updatedAt: Date.now(), entries: [], totals: { tokens: { input: 10, output: 1, cached: 0, unreported: 0 }, calls: 1, byPurpose: { review: { input: 10, output: 1, cached: 0, unreported: 0 } }, attempts: 1, jobs: [{ id: "job_1", attempts: 1 }] } }] }
    writeFileSync(file, JSON.stringify(old))
    const accounting = createAccounting({ file })
    expect(accounting.totals(key)?.byPurpose.review?.input).toBe(10)
    const totals = accounting.record({ ...key, jobId: "job_1", purpose: "read", attempt: 1, input: 9_000, output: 400, cached: 2_000 })
    expect(totals.byPurpose.read).toEqual({ input: 9_000, output: 400, cached: 2_000, unreported: 0 })
    expect(totals.byPurpose.review?.input).toBe(10)
    expect(createAccounting({ file }).totals(key)?.byPurpose.read?.input).toBe(9_000)
  })

  test("the job counts reader tokens in its total and apart in readTokens", () => {
    const dir = temp()
    const jobs = createJobLedger({ file: path.join(dir, "jobs.json") })
    const job = jobs.upsert({ provider: "github", repo: "acme/api", directory: "/repo", number: 7, sessionId: "ses_a", reviewer: "global", scope: "global", trigger: "opened", coverage: "full", base: "b".repeat(40), head: "a".repeat(40), configKey: "cfg" })
    jobs.addTokens(job.id, { input: 5_000, output: 300 })
    jobs.addTokens(job.id, { input: 9_000, output: 400, cached: 2_000 }, true)
    const after = jobs.get(job.id)!
    expect(after.tokens).toMatchObject({ input: 14_000, output: 700, cached: 2_000 })
    expect(after.readTokens).toEqual({ input: 9_000, output: 400, cached: 2_000 })
  })
})
