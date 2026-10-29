import { describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { join } from "node:path"
import { BUILTIN_TOOLS, review, runTool } from "../src"
import { parseDiff } from "../src/tools/review"
import { makeContext, put, useTempDir } from "./helpers"

const tmp = useTempDir()

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } })
  expect(result.exitCode).toBe(0)
  return result.stdout.toString()
}

const BASE = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa", "lambda", "mu", "nu", "xi", "omicron", "pi"].join("\n") + "\n"

function repo() {
  const root = tmp()
  git(root, "init", "-q", "-b", "main")
  put({ root, path: "src/a.txt", content: BASE })
  put({ root, path: "src/gone.txt", content: "bye\n" })
  put({ root, path: "keep.txt", content: "same\n" })
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "base")
  return root
}

function change(root: string) {
  put({ root, path: "src/a.txt", content: BASE.replace("beta\n", "BETA\nbeta two\n").replace("pi\n", "PI\n") })
  rmSync(join(root, "src/gone.txt"))
  put({ root, path: "notes.txt", content: "one\ntwo\n" })
}

describe("review tool", () => {
  test("shared actions delegate to the host, with bounded results and honest unavailable/cancelled errors", async () => {
    const seen: unknown[] = []
    const context = { ...makeContext({ cwd: tmp() }), review: { async run(input: Record<string, unknown>) { seen.push(input); return { output: "x".repeat(40_000), meta: { comments: 1 } } } } }
    for (const action of ["current", "summary", "file", "navigate", "reload", "comment_add", "comment_list", "comment_clear"] as const) {
      const result = await runTool(review, { action }, context)
      expect(result.isError).toBe(false)
      expect(result.truncated).toBe(true)
      expect(result.meta).toEqual({ comments: 1 })
    }
    expect(seen).toHaveLength(8)
    expect((await runTool(review, { action: "navigate" }, makeContext({ cwd: tmp() }))).output).toBe("shared review workspace is unavailable")
    const signal = AbortSignal.abort()
    expect((await runTool(review, { action: "summary" }, { ...context, signal })).output).toBe("cancelled")
    expect(seen).toHaveLength(8)
  })
  test("is a read-only builtin", () => {
    expect(review.permission).toBe("read")
    expect(BUILTIN_TOOLS.some((tool) => tool.name === "review")).toBe(true)
  })

  test("summarizes the changed files with hunk line ranges", async () => {
    const root = repo()
    change(root)
    const result = await runTool(review, {}, makeContext({ cwd: root }))
    expect(result.isError).toBe(false)
    expect(result.meta).toEqual({ files: 3, additions: 5, deletions: 3 })
    expect(result.output).toContain("review: 3 files changed, +5 -3 (branch main)")
    expect(result.output).toContain("M src/a.txt +3 -2")
    expect(result.output).toContain("hunk 1: old 1-5, new 1-6")
    expect(result.output).toContain("hunk 2: old 13-16, new 14-17")
    expect(result.output).toContain("D src/gone.txt +0 -1")
    expect(result.output).toContain("? notes.txt +2 -0")
    expect(result.output).toContain("hunk 1: old 0, new 1-2")
  })

  test("a path returns that file with old and new line numbers", async () => {
    const root = repo()
    change(root)
    const result = await runTool(review, { path: "src/a.txt" }, makeContext({ cwd: root }))
    expect(result.isError).toBe(false)
    const rows = result.output.split("\n")
    expect(rows[0]).toBe("src/a.txt (modified, +3 -2)")
    expect(rows).toContain("@@ -1,5 +1,6 @@")
    expect(rows).toContain(" 1  1 │  alpha")
    expect(rows).toContain(" 2    │ -beta")
    expect(rows).toContain("    2 │ +BETA")
    expect(rows).toContain("    3 │ +beta two")
    expect(rows).toContain("16    │ -pi")
    expect(rows).toContain("   17 │ +PI")
  })

  test("an untracked file shows as added lines", async () => {
    const root = repo()
    change(root)
    const result = await runTool(review, { path: "notes.txt" }, makeContext({ cwd: root }))
    expect(result.output).toContain("notes.txt (untracked, +2 -0)")
    expect(result.output).toContain("    1 │ +one")
  })

  test("a clean tree, an unchanged path and a missing repository are reported", async () => {
    const root = repo()
    expect((await runTool(review, {}, makeContext({ cwd: root }))).output).toBe("no changes in the working tree")
    change(root)
    const missing = await runTool(review, { path: "keep.txt" }, makeContext({ cwd: root }))
    expect(missing.isError).toBe(true)
    expect(missing.output).toContain("keep.txt has no changes")
    const outside = await runTool(review, {}, makeContext({ cwd: tmp() }))
    expect(outside.isError).toBe(true)
    expect(outside.output).toBe("not a git repository")
  })

  test("never writes: the index and the files are untouched", async () => {
    const root = repo()
    change(root)
    const before = git(root, "status", "--porcelain")
    await runTool(review, {}, makeContext({ cwd: root }))
    await runTool(review, { path: "src/a.txt" }, makeContext({ cwd: root }))
    expect(git(root, "status", "--porcelain")).toBe(before)
  })

  test("a big diff is bounded", async () => {
    const root = repo()
    put({ root, path: "big.txt", content: Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n") + "\n" })
    const result = await runTool(review, { path: "big.txt" }, makeContext({ cwd: root }))
    expect(result.truncated).toBe(true)
    expect(result.output.split("\n").length).toBeLessThan(700)
  })

  test("parseDiff reads renames and binary markers", () => {
    const files = parseDiff(["diff --git a/old.txt b/new.txt", "similarity index 90%", "rename from old.txt", "rename to new.txt", "index 1..2 100644", "--- a/old.txt", "+++ b/new.txt", "@@ -1 +1 @@", "-a", "+b", "diff --git a/i.png b/i.png", "index 1..2 100644", "Binary files a/i.png and b/i.png differ", ""].join("\n"))
    expect(files.map((file) => [file.path, file.oldPath, file.status, file.binary, file.additions, file.deletions])).toEqual([
      ["new.txt", "old.txt", "renamed", false, 1, 1],
      ["i.png", undefined, "modified", true, 0, 0],
    ])
  })
})
