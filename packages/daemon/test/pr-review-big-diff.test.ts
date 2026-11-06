import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildReviewContext, gitRun, HARD_DIFF_BYTES, MAX_DIFF_BYTES, MAX_DIFF_FILES, parseNumstat, type ContextReaders, type GitRun } from "../src/pr-review/context"
import { groupFiles, parseReaderAnswer, readerPrompt, readGroups } from "../src/pr-review/readers"
import { graftCallers } from "../src/pr-review/readers-graft"

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

  test("a code file beyond the main bound is deferred, not retained, and readers off still fails", async () => {
    const word = (i: number) => Bun.hash(String(i)).toString(36)
    const lines = Array.from({ length: 60_000 }, (_, i) => `export function ${word(i)}(${word(i + 1)}: string) { return ${word(i + 2)}.concat("${word(i + 3)}", ${word(i + 4)}) }`).join("\n") + "\n"
    const repo = await fixture({ "src/generated-looking-but-code.ts": lines, "results/run.json": results(2_000) })
    let loaded = false
    const readers: ContextReaders = async ({ cut, load }) => {
      expect(cut[0]!.text).toBe("")
      expect(cut[0]!.bytes).toBeGreaterThan(MAX_DIFF_BYTES)
      const piece = await load!(cut[0]!)
      expect(Buffer.byteLength(piece.text)).toBeLessThanOrEqual(MAX_DIFF_BYTES)
      loaded = true
      return [{ id: "g1", paths: cut.map((file) => file.path), text: "export contract risk at src/generated-looking-but-code.ts:1", by: "claude-haiku" }]
    }
    const context = await buildReviewContext({ directory: repo.dir, base: repo.base, head: repo.head, budgetTokens: 400_000, readers })
    expect(loaded).toBe(true)
    expect(context.files.find((file) => file.deferred)!.text).toBe("")
    expect(context.diff).toContain("export contract risk")
    await expect(buildReviewContext({ directory: repo.dir, base: repo.base, head: repo.head, budgetTokens: 400_000 })).rejects.toThrow(/reviewable part of the diff is .*4\.0 MiB.*readers are off.*split the pull request/)
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

  test("the hard byte and file bounds fail before readers, without giant output strings", async () => {
    for (const tooManyFiles of [false, true]) {
      let called = false
      const runner: GitRun = async (args) => args.includes("--numstat")
        ? { code: 0, out: tooManyFiles ? Array.from({ length: MAX_DIFF_FILES + 1 }, (_, i) => `1\t0\tsrc/a${i}.ts\0`).join("") : "1\t0\tsrc/a.ts\0" }
        : { code: 0, out: "diff --git a/src/a.ts b/src/a.ts\n--- /dev/null\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+export const a = 1\n", bytes: HARD_DIFF_BYTES + 1, cut: true }
      await expect(buildReviewContext({ directory: "/unused", base: "base", head: "head", budgetTokens: 400_000, git: runner, readers: async () => { called = true; return [] } })).rejects.toThrow(/reviewable part of the diff is .*64\.0 MiB.*20,000 files.*split the pull request/)
      expect(called).toBe(false)
    }
  })

  test("real git counts beyond the hard bound while retaining only a small prefix", async () => {
    const block = Array.from({ length: 1000 }, (_, i) => `export const f${Bun.hash(String(i)).toString(36)} = () => caller${Bun.hash(String(i + 1)).toString(36)}()\n`).join("")
    const repo = await fixture({ "src/absurd.ts": block.repeat(Math.ceil((HARD_DIFF_BYTES + 1024) / block.length)) })
    let maximum = 0
    const runner: GitRun = async (...args) => { const done = await gitRun(...args); maximum = Math.max(maximum, Buffer.byteLength(done.out)); return done }
    await expect(buildReviewContext({ directory: repo.dir, base: repo.base, head: repo.head, budgetTokens: 400_000, git: runner, readers: async () => { throw new Error("must fail before readers") } })).rejects.toThrow(/reviewable part of the diff is .*64\.0 MiB/)
    expect(maximum).toBeLessThanOrEqual(64 * 1024)
  }, 60_000)

  test("risk order prefers source, changed import targets and changed lines, with no graph", async () => {
    const names = ["docs/notes.md", "test/a.test.ts", "src/a.ts", "src/b.ts", "src/contract.ts"]
    const runner: GitRun = async (args, _cwd, _max, count) => {
      if (args.includes("--numstat")) return { code: 0, out: names.map((name, i) => `${i === 2 ? 200 : 100}\t0\t${name}\0`).join("") }
      const name = args.at(-1)!.replace(":(literal)", "")
      const out = `diff --git a/${name} b/${name}\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1,2 @@\n+import { contract } from './contract'\n+export const value = contract()\n`
      return { code: 0, out, bytes: count ? 1_500_000 : Buffer.byteLength(out) }
    }
    // Full reads report their actual fixture size, so selection is asserted through fetch order.
    const fetched: string[] = []
    await buildReviewContext({ directory: "/unused", base: "base", head: "head", budgetTokens: 400_000, readers: async () => [], git: async (...args) => {
      if (args[0][0] === "diff" && !args[0].includes("--numstat") && !args[3]) fetched.push(args[0].at(-1)!)
      return runner(...args)
    } })
    expect(fetched.slice(0, 3)).toEqual([":(literal)src/contract.ts", ":(literal)src/a.ts", ":(literal)src/b.ts"])
  })

  test("spent reader allowance fetches no deferred text and labels every remaining path not read", async () => {
    let loads = 0
    const files = Array.from({ length: 8 }, (_, i) => ({ path: `src/f${i}.ts`, text: "", right: new Set<number>(), touched: [], deleted: false, deferred: true }))
    const read = await readGroups({ groups: groupFiles({ data: [], cut: files }), source: { ok: true, model: "claude-haiku", factory: async () => { throw new Error("must not start") } }, parallel: 3, allowance: 0, load: async (file) => { loads++; return file } })
    expect(loads).toBe(0)
    expect(read.notRead).toEqual(files.map((file) => file.path))
    expect([...read.summaries.values()].every((summary) => summary.by === "not read")).toBe(true)
  })

  test("code readers retain both diff sides, hunk coordinates and concrete file:line risks; absent graft is harmless", async () => {
    const file = { path: "src/api.ts", text: "diff --git a/src/api.ts b/src/api.ts\n--- a/src/api.ts\n+++ b/src/api.ts\n@@ -42 +42 @@\n-export function api(x: string) {}\n+export function api(x: number) {}\n", right: new Set([42]), touched: [42], deleted: false }
    const groups = groupFiles({ data: [], cut: [file] })
    const prompt = readerPrompt(groups)
    expect(prompt).toContain("-export function api(x: string)")
    expect(prompt).toContain("@@ -42 +42 @@")
    expect(prompt).toContain("changed signature, export, config key, schema or behaviour")
    const parsed = parseReaderAnswer(JSON.stringify({ groups: [{ id: "g1", contains: "API change", risks: [{ path: "src/api.ts", line: 42, detail: "string callers no longer typecheck" }] }] }), groups, "claude-haiku")
    expect(parsed![0]!.text).toContain("src/api.ts:42: string callers no longer typecheck")
    expect(await graftCallers("/nonexistent-review-repository", [file])).toBeUndefined()
    expect(readerPrompt(groupFiles({ data: [], cut: [{ ...file, path: "config.json" }] }))).toContain("@@ -42 +42 @@")
  })

  test("optional graft names callers using argument-safe changed exports and skips a failed CLI", async () => {
    const repo = await fixture({ "src/api.ts": code("api") })
    mkdirSync(path.join(repo.dir, "graft"))
    const cli = path.join(repo.dir, "fake-graft")
    writeFileSync(cli, '#!/bin/sh\n[ "$1" = callers ] && [ "$2" = api ] || exit 1\nprintf "src/caller.ts:7 calls api\\n"\n')
    chmodSync(cli, 0o755)
    const file = { path: "src/api.ts", text: "+export function api() {}\n", right: new Set<number>(), touched: [], deleted: false }
    expect(await graftCallers(repo.dir, [file], cli)).toContain("src/caller.ts:7 calls api")
    writeFileSync(cli, "#!/bin/sh\nexit 1\n")
    expect(await graftCallers(repo.dir, [file], cli)).toBeUndefined()
    expect(await graftCallers(repo.dir, [file], path.join(repo.dir, "missing-cli"))).toBeUndefined()
  })
})
