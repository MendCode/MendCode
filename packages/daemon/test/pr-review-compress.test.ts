import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { estimateTokens } from "@mendcode/protocol"
import { buildReviewContext, gitRun, mainLanguage, withoutDeletionHunks } from "../src/pr-review/context"

/**
 * Context compression (docs/pr-review.md, "What the reviewer reads"): hunks that only delete are one line, and a diff too large
 * for one call is cut outside the repository's main language first. Real git in a temp directory; the fixture is a large PR.
 */

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const GIT_ID = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"]
const git = async (cwd: string, ...args: string[]) => { const done = await gitRun([...GIT_ID, ...args], cwd); if (done.code) throw new Error(`git ${args.join(" ")}: exit ${done.code}`); return done.out.trim() }

const lines = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `  const ${prefix}${i} = compute(${i}, "${prefix}-${i}") // line ${i}`).join("\n") + "\n"
const tsFile = (name: string, count: number) => `export function ${name}() {\n${lines(name, count)}}\n`

async function repoWith(base: Record<string, string>, change: (dir: string) => void) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "compress-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  await git(dir, "init", "-q", "-b", "main")
  for (const [name, content] of Object.entries(base)) { mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); writeFileSync(path.join(dir, name), content) }
  await git(dir, "add", "-A"); await git(dir, "commit", "-q", "-m", "base")
  const baseSha = await git(dir, "rev-parse", "HEAD")
  change(dir)
  await git(dir, "add", "-A"); await git(dir, "commit", "-q", "-m", "head")
  return { dir, base: baseSha, head: await git(dir, "rev-parse", "HEAD") }
}

describe("withoutDeletionHunks", () => {
  const hunk = (header: string, body: string[]) => `${header}\n${body.join("\n")}\n`
  const head = "diff --git a/a.ts b/a.ts\nindex 1..2 100644\n--- a/a.ts\n+++ b/a.ts\n"

  test("a hunk with removed lines and no added line becomes one line; a mixed hunk stays", () => {
    const removed = Array.from({ length: 12 }, (_, i) => `-old line ${i} with some text in it`)
    const text = head + hunk("@@ -10,15 +10,3 @@", [" ctx", ...removed, " ctx"]) + hunk("@@ -40,3 +30,3 @@", [" ctx", "-before", "+after", " ctx"])
    const out = withoutDeletionHunks(text)
    expect(out).toContain("+after")
    expect(out).not.toContain("old line 3")
    expect(out).toContain("(12 deleted lines in 1 hunk with no added lines, not shown; old lines near 10)")
    expect(out.startsWith(head)).toBe(true)
    expect(out.length).toBeLessThan(text.length)
  })

  test("a whole deleted file keeps its header and says how many lines went", () => {
    const body = Array.from({ length: 30 }, (_, i) => `-export const v${i} = ${i}`)
    const text = "diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\nindex 1..0\n--- a/gone.ts\n+++ /dev/null\n" + hunk("@@ -1,30 +0,0 @@", body)
    const out = withoutDeletionHunks(text)
    expect(out).toContain("deleted file mode")
    expect(out).toContain("(30 deleted lines in 1 hunk")
    expect(out).not.toContain("export const v3")
  })

  test("it never makes a diff longer: a tiny deletion is left as it is", () => {
    const text = head + hunk("@@ -1,2 +1,1 @@", [" a", "-b"])
    expect(withoutDeletionHunks(text)).toBe(text)
  })

  test("a diff with no hunks or only additions is returned unchanged", () => {
    const binary = "diff --git a/x.png b/x.png\nBinary files differ\n"
    expect(withoutDeletionHunks(binary)).toBe(binary)
    const added = head + hunk("@@ -0,0 +1,2 @@", ["+one", "+two"])
    expect(withoutDeletionHunks(added)).toBe(added)
  })
})

describe("a large pull request", () => {
  const baseFiles: Record<string, string> = {}
  for (let i = 0; i < 24; i++) baseFiles[`src/mod${i}.ts`] = tsFile(`mod${i}`, 120)
  for (let i = 0; i < 6; i++) baseFiles[`scripts/tool${i}.py`] = Array.from({ length: 100 }, (_, n) => `value_${n} = compute(${n})`).join("\n") + "\n"
  const change = (dir: string) => {
    for (let i = 0; i < 12; i++) unlinkSync(path.join(dir, `src/mod${i}.ts`))
    for (let i = 12; i < 20; i++) writeFileSync(path.join(dir, `src/mod${i}.ts`), tsFile(`mod${i}`, 120).replace(/^ {2}const mod\d+(?:[0-9]) = .*\n/gm, (line) => /mod\d+[0-4] =/.test(line) ? "" : line))
    for (let i = 20; i < 24; i++) writeFileSync(path.join(dir, `src/mod${i}.ts`), tsFile(`mod${i}`, 120).replace("compute(0,", "compute(1,"))
    for (let i = 0; i < 6; i++) writeFileSync(path.join(dir, `scripts/tool${i}.py`), Array.from({ length: 100 }, (_, n) => `value_${n} = compute(${n + 1})`).join("\n") + "\n")
  }

  test("deletion-only hunks cost less: prompt bytes and tokens before and after", async () => {
    const repo = await repoWith(baseFiles, change)
    const input = { directory: repo.dir, base: repo.base, head: repo.head, budgetTokens: 4_000_000 }
    const before = await buildReviewContext({ ...input, compress: false })
    const after = await buildReviewContext(input)
    const bytes = (diff: string) => Buffer.byteLength(diff)
    console.log(`context compression, large PR: diff ${bytes(before.diff)} -> ${bytes(after.diff)} bytes, ${before.tokens} -> ${after.tokens} tokens (${(100 - (100 * after.tokens) / before.tokens).toFixed(1)}% fewer)`)
    expect(after.tokens).toBeLessThan(before.tokens)
    expect(after.tokens).toBeLessThan(before.tokens * 0.7)
    // Every file stays reviewable: the files, their lines and their added text are unchanged.
    expect(after.files.map((file) => file.path)).toEqual(before.files.map((file) => file.path))
    expect(after.files.map((file) => [...file.right])).toEqual(before.files.map((file) => [...file.right]))
    expect(after.diff).toContain("deleted lines in")
    expect(after.diff).toContain("diff --git a/src/mod0.ts b/src/mod0.ts")
    expect(after.diff).toContain("+  const mod20")
  }, 60_000)

  test("a PR with nothing to drop costs exactly what it did", async () => {
    const repo = await repoWith({ "src/a.ts": tsFile("a", 40) }, (dir) => writeFileSync(path.join(dir, "src/a.ts"), tsFile("a", 40).replace("compute(3,", "compute(4,")))
    const input = { directory: repo.dir, base: repo.base, head: repo.head, budgetTokens: 100_000 }
    expect((await buildReviewContext(input)).diff).toBe((await buildReviewContext({ ...input, compress: false })).diff)
  }, 30_000)

  test("when the diff must be cut, files outside the main language go before the largest main-language file", async () => {
    const repo = await repoWith({ "README.md": "x\n" }, (dir) => {
      mkdirSync(path.join(dir, "src"), { recursive: true }); mkdirSync(path.join(dir, "tools"), { recursive: true })
      writeFileSync(path.join(dir, "src/big.ts"), tsFile("big", 200))
      writeFileSync(path.join(dir, "src/small.ts"), tsFile("small", 20))
      writeFileSync(path.join(dir, "tools/helper.py"), Array.from({ length: 120 }, (_, n) => `value_${n} = compute(${n}) # python helper line`).join("\n") + "\n")
    })
    const whole = await buildReviewContext({ directory: repo.dir, base: repo.base, head: repo.head, budgetTokens: 4_000_000 })
    const limit = Math.ceil(whole.tokens * 0.8)
    const input = { directory: repo.dir, base: repo.base, head: repo.head, budgetTokens: limit * 2 }
    const old = await buildReviewContext({ ...input, compress: false })
    const now = await buildReviewContext(input)
    // Before: the largest file (the TypeScript one) was cut. Now: the Python helper is, and the main language stays whole.
    expect(old.diff).toContain("src/big.ts b/src/big.ts\n(")
    expect(now.diff).toContain("diff --git a/tools/helper.py b/tools/helper.py\n(")
    expect(now.diff).toContain("+  const big199")
    expect(now.tokens).toBeLessThanOrEqual(limit)
  }, 30_000)

  test("the main language is the graph's, else the diff's, and a family counts as one", () => {
    const file = (p: string, text: string) => ({ path: p, text, right: new Set<number>(), touched: [], deleted: false })
    expect(mainLanguage({ files: [file("a.ts", "xxxxxxxx"), file("b.tsx", "xxxxxxxx"), file("c.py", "xxxxxxxxxxxxx")] })).toBe("js")
    expect(mainLanguage({ files: [file("README", "x")] })).toBeUndefined()
    const graph = { byPath: new Map([["a.py", []], ["b.py", []], ["c.ts", []]]) } as unknown as Parameters<typeof mainLanguage>[0]["graph"]
    expect(mainLanguage({ graph, files: [file("c.ts", "x".repeat(1000))] })).toBe("py")
  })
})
