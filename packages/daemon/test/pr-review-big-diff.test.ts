import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildReviewContext, gitRun, MAX_DIFF_BYTES, parseNumstat, type ContextReaders } from "../src/pr-review/context"

/**
 * A pull request whose diff against its base is far larger than 4 MiB because of data and generated files (the Symbex #23 incident:
 * the whole diff was refused before triage). Real git in a temp directory: the file list and sizes come first, data files are
 * fetched as samples for readers, and only the reviewable rest counts toward the bound.
 */

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const GIT_ID = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"]
const git = async (cwd: string, ...args: string[]) => { const done = await gitRun([...GIT_ID, ...args], cwd); if (done.code) throw new Error(`git ${args.join(" ")}: exit ${done.code}`); return done.out.trim() }

async function fixture(files: Record<string, string>) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "bigdiff-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  await git(dir, "init", "-q", "-b", "main")
  writeFileSync(path.join(dir, "README.md"), "base\n")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "base")
  const base = await git(dir, "rev-parse", "HEAD")
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    writeFileSync(path.join(dir, name), content)
  }
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "head")
  return { dir, base, head: await git(dir, "rev-parse", "HEAD") }
}

const results = (rows: number) => JSON.stringify(Array.from({ length: rows }, (_, i) => ({ step: i, loss: i * 0.001, acc: 0.5 + i * 0.0001 })), null, 2)
const code = (name: string) => `export function ${name}(value: number): number {\n  return value * 2\n}\n`.repeat(30)

describe("a diff far larger than 4 MiB made of data is not refused: triage separates it before its content is fetched", () => {
  test("data and generated files go to readers as samples; only the code files are in the diff", async () => {
    const big = results(150_000)
    expect(big.length).toBeGreaterThan(MAX_DIFF_BYTES * 2)
    const repo = await fixture({ "results/run-1.json": big, "results/run-2.json": big, "src/a.ts": code("alpha"), "src/b.ts": code("beta"), "src/c.ts": code("gamma") })
    const seen: string[][] = []
    const readers: ContextReaders = async ({ data }) => {
      seen.push(data.map((entry) => entry.file.path))
      return [{ id: "g1", paths: data.map((entry) => entry.file.path), text: "two result files of step, loss and acc", by: "local" }]
    }
    const context = await buildReviewContext({ directory: repo.dir, base: repo.base, head: repo.head, budgetTokens: 400_000, readers })
    expect(seen).toEqual([["results/run-1.json", "results/run-2.json"]])
    expect(context.files.map((file) => file.path)).toEqual(["results/run-1.json", "results/run-2.json", "src/a.ts", "src/b.ts", "src/c.ts"])
    expect(context.diff).toContain("diff --git a/src/a.ts b/src/a.ts")
    expect(context.diff).toContain("+export function alpha")
    expect(context.diff).toContain("a reader read it")
    expect(context.diff).toContain("two result files")
    // The sample is bounded and the real size is kept for what the review pass is told.
    expect(context.files[0]!.text.length).toBeLessThan(2_000_000)
    expect(context.files[0]!.size?.added).toBeGreaterThan(100_000)
    expect(context.diff).toMatch(/\(\+\d{1,3}(,\d{3})+ -0 lines, not shown: a reader read it\)/)
    expect(context.readTokens).toBeGreaterThan(1_000_000)
  }, 60_000)

  test("with readers off the data file is a bounded sample the budget cuts, not an error", async () => {
    const repo = await fixture({ "results/run-1.json": results(150_000), "src/a.ts": code("alpha") })
    const context = await buildReviewContext({ directory: repo.dir, base: repo.base, head: repo.head, budgetTokens: 40_000 })
    expect(context.diff).toContain("+export function alpha")
    expect(context.files[0]!.text.length).toBeLessThanOrEqual(256 * 1024)
    expect(context.truncated).toBe(true)
  }, 60_000)

  test("a data file the name does not give away is separated by its content after a bounded read", async () => {
    const numbers = Array.from({ length: 400_000 }, (_, i) => `${i}, ${i * 3}, ${(i % 7) / 3}`).join("\n") + "\n"
    expect(numbers.length).toBeGreaterThan(MAX_DIFF_BYTES)
    const repo = await fixture({ "out/table.txt": numbers, "src/a.ts": code("alpha") })
    const readers: ContextReaders = async ({ data }) => [{ id: "g1", paths: data.map((entry) => entry.file.path), text: "a numeric table", by: "local" }]
    const context = await buildReviewContext({ directory: repo.dir, base: repo.base, head: repo.head, budgetTokens: 400_000, readers })
    expect(context.diff).toContain("a numeric table")
    expect(context.diff).toContain("+export function alpha")
  }, 60_000)

  test("the safety bound is on the reviewable part: too much code is refused with a message that names the part and the way out", async () => {
    const word = (i: number) => Bun.hash(String(i)).toString(36)
    const lines = Array.from({ length: 60_000 }, (_, i) => `export function ${word(i)}(${word(i + 1)}: string) { return ${word(i + 2)}.concat("${word(i + 3)}", ${word(i + 4)}) }`).join("\n") + "\n"
    const repo = await fixture({ "src/generated-looking-but-code.ts": lines, "results/run.json": results(2_000) })
    const readers: ContextReaders = async ({ data }) => [{ id: "g1", paths: data.map((entry) => entry.file.path), text: "results", by: "local" }]
    await expect(buildReviewContext({ directory: repo.dir, base: repo.base, head: repo.head, budgetTokens: 400_000, readers })).rejects.toThrow(/reviewable part of the diff is .*4\.0 MiB.*set aside for readers.*split the pull request/)
  }, 60_000)

  test("a normal change and paths with spaces keep working", async () => {
    const repo = await fixture({ "src/with space.ts": code("spaced"), "src/b.ts": code("beta") })
    const context = await buildReviewContext({ directory: repo.dir, base: repo.base, head: repo.head, budgetTokens: 400_000, readers: async () => [] })
    expect(context.files.map((file) => file.path)).toEqual(["src/b.ts", "src/with space.ts"])
    expect(context.diff).toContain("+export function spaced")
  }, 30_000)

  test("parseNumstat reads text and binary rows, and nothing else", () => {
    expect(parseNumstat("1\t2\ta.ts\0-\t-\timg.png\0")).toEqual([{ path: "a.ts", added: 1, removed: 2, binary: false }, { path: "img.png", added: 0, removed: 0, binary: true }])
    expect(parseNumstat("diff --git a/x b/x\n")).toBeUndefined()
    expect(parseNumstat("")).toEqual([])
  })
})
