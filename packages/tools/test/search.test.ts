import { afterEach, describe, expect, test } from "bun:test"
import { glob, GLOB_MAX_ENTRIES_ENV, grep, GREP_FALLBACK_ENV, runTool } from "../src"
import { nestedRepetition } from "../src/tools/grep"
import { makeContext, put, useTempDir } from "./helpers"
import { utimesSync } from "node:fs"

const tmp = useTempDir()

describe("glob", () => {
  test("matches, skips node_modules/.git/dotfiles, sorts by mtime desc", async () => {
    const root = tmp()
    const older = put({ root, path: "src/old.ts", content: "" })
    put({ root, path: "src/new.ts", content: "" })
    put({ root, path: "node_modules/p/x.ts", content: "" })
    put({ root, path: ".git/x.ts", content: "" })
    put({ root, path: ".hidden/x.ts", content: "" })
    utimesSync(older, new Date(2020, 1, 1), new Date(2020, 1, 1))
    const result = await glob.execute({ pattern: "**/*.ts" }, makeContext({ cwd: root }))
    expect(result.output.split("\n")).toEqual(["src/new.ts", "src/old.ts"])
    expect(result.meta?.matches).toBe(2)
  })
  test("reports empty results and bad directories", async () => {
    const root = tmp()
    const ctx = makeContext({ cwd: root })
    expect((await glob.execute({ pattern: "*.zzz" }, ctx)).output).toBe("No files found")
    expect((await glob.execute({ pattern: "*", path: "nope" }, ctx)).isError).toBe(true)
  })
  test("caps at 1000 results", async () => {
    const root = tmp()
    for (let i = 0; i < 1010; i++) put({ root, path: `f/${i}.txt`, content: "" })
    const result = await glob.execute({ pattern: "f/*.txt" }, makeContext({ cwd: root }))
    expect(result.truncated).toBe(true)
    expect(result.meta?.matches).toBe(1000)
  })
  const twoTrees = () => {
    const root = tmp()
    const oldest = put({ root, path: "src/a.ts", content: "" })
    const middle = put({ root, path: "test/a.test.ts", content: "" })
    put({ root, path: "src/b.ts", content: "" })
    put({ root, path: "docs/c.ts", content: "" })
    put({ root, path: "src/node_modules/p/x.ts", content: "" })
    utimesSync(oldest, new Date(2020, 1, 1), new Date(2020, 1, 1))
    utimesSync(middle, new Date(2021, 1, 1), new Date(2021, 1, 1))
    return root
  }
  test("brace alternatives in one pattern cover several directories", async () => {
    const result = await runTool(glob, { pattern: "{src,test}/**/*.ts" }, makeContext({ cwd: twoTrees() }))
    expect(result.output.split("\n")).toEqual(["src/b.ts", "test/a.test.ts", "src/a.ts"])
    expect(result.title).toBe("Glob {src,test}/**/*.ts")
  })
  test("`patterns` merges several globs into one newest-first list without repeating a file", async () => {
    const result = await runTool(glob, { patterns: ["src/**/*.ts", "test/**/*.ts", "**/a.ts"] }, makeContext({ cwd: twoTrees() }))
    expect(result.isError).toBe(false)
    expect(result.output.split("\n")).toEqual(["src/b.ts", "test/a.test.ts", "src/a.ts"])
    expect(result.meta?.matches).toBe(3)
    expect(result.title).toBe("Glob src/**/*.ts, test/**/*.ts, **/a.ts")
  })
  test("`pattern` and `patterns` together are one merged search; neither, an empty list or more than 8 is refused", async () => {
    const ctx = makeContext({ cwd: twoTrees() })
    expect((await runTool(glob, { pattern: "docs/*.ts", patterns: ["test/**/*.ts"] }, ctx)).output.split("\n")).toEqual(["docs/c.ts", "test/a.test.ts"])
    expect((await runTool(glob, {}, ctx)).output).toContain("glob needs `pattern` or `patterns`")
    expect((await runTool(glob, { patterns: [] }, ctx)).output).toContain("invalid arguments: patterns")
    expect((await runTool(glob, { patterns: Array.from({ length: 9 }, (_, index) => `${index}/*`) }, ctx)).output).toContain("invalid arguments: patterns")
    expect((await runTool(glob, { patterns: Array.from({ length: 8 }, (_, index) => `${index}/*`) }, ctx)).output).toBe("No files found")
  })
  test("the result cap is shared by all the patterns of a call", async () => {
    const root = tmp()
    for (let i = 0; i < 600; i++) { put({ root, path: `f/${i}.txt`, content: "" }); put({ root, path: `g/${i}.txt`, content: "" }) }
    const result = await runTool(glob, { patterns: ["f/*.txt", "g/*.txt", "{f,g}/*.txt"] }, makeContext({ cwd: root }))
    expect(result.truncated).toBe(true)
    expect(result.meta?.matches).toBe(1000)
    expect(result.output).toContain("[output truncated: 200 more files]")
  })
  test("a directory that does not exist is named, with the nearest directory that does", async () => {
    const root = tmp()
    put({ root, path: "src/a.ts", content: "" })
    const ctx = makeContext({ cwd: root })
    const result = await glob.execute({ pattern: "*.ts", path: "src/lib/deep" }, ctx)
    expect(result.isError).toBe(true)
    expect(result.output).toBe("src/lib/deep: no such file or directory (nearest existing directory: src)")
    expect((await glob.execute({ pattern: "*.ts", path: "nope" }, ctx)).output).toBe("nope: no such file or directory (nearest existing directory: .)")
    expect((await glob.execute({ pattern: "*.ts", path: "src/a.ts" }, ctx)).output).toBe("src/a.ts is not a directory")
    expect((await grep.execute({ pattern: "x", path: "src/lib/deep" }, ctx)).output).toBe("src/lib/deep: no such file or directory (nearest existing directory: src)")
  })
  test("node_modules, .git and hidden directories are not walked, unless the pattern names them", async () => {
    const root = tmp()
    put({ root, path: "src/a.ts", content: "" })
    put({ root, path: "node_modules/p/x.ts", content: "" })
    put({ root, path: "src/node_modules/q/y.ts", content: "" })
    put({ root, path: ".git/hooks/h.ts", content: "" })
    put({ root, path: ".github/workflows/ci.yml", content: "" })
    put({ root, path: ".hidden/z.ts", content: "" })
    put({ root, path: ".env.ts", content: "" })
    const ctx = makeContext({ cwd: root })
    const list = async (pattern: string) => (await glob.execute({ pattern }, ctx)).output.split("\n").sort()
    expect(await list("**/*.ts")).toEqual(["src/a.ts"])
    expect(await list("node_modules/**/*.ts")).toEqual(["node_modules/p/x.ts"])
    expect(await list("**/node_modules/**/*.ts")).toEqual(["node_modules/p/x.ts", "src/node_modules/q/y.ts"])
    expect(await list(".github/**/*.yml")).toEqual([".github/workflows/ci.yml"])
    expect(await list("{src,.hidden}/*.ts")).toEqual([".hidden/z.ts", "src/a.ts"])
    expect(await list(".git/**/*.ts")).toEqual([".git/hooks/h.ts"])
    expect(await list(".*.ts")).toEqual([".env.ts"])
    expect(await list("*.ts")).toEqual(["No files found"])
    // Read through a skipped directory that holds far more entries than the budget allows: it is never listed.
    for (let i = 0; i < 300; i++) put({ root, path: `node_modules/big/${i}.js`, content: "" })
    process.env[GLOB_MAX_ENTRIES_ENV] = "50"
    try {
      const bounded = await glob.execute({ pattern: "**/*.ts" }, ctx)
      expect(bounded.output).toBe("src/a.ts")
      expect(bounded.truncated).toBe(false)
    } finally {
      delete process.env[GLOB_MAX_ENTRIES_ENV]
    }
  })
  test("a walk past its entry budget stops and returns what it has with a note", async () => {
    const root = tmp()
    put({ root, path: "top.ts", content: "" })
    for (let d = 0; d < 20; d++) for (let i = 0; i < 20; i++) put({ root, path: `d${d}/f${i}.txt`, content: "" })
    put({ root, path: "d19/deep/last.ts", content: "" })
    const ctx = makeContext({ cwd: root })
    process.env[GLOB_MAX_ENTRIES_ENV] = "100"
    try {
      const partial = await glob.execute({ pattern: "**/*.ts" }, ctx)
      expect(partial.isError).toBe(false)
      expect(partial.truncated).toBe(true)
      expect(partial.output).toMatch(/^top\.ts\n\[stopped after 1\d\d entries in [\d.]+ s: results are partial; narrow the pattern or the directory\]$/)
      const nothing = await glob.execute({ pattern: "**/*.zzz" }, ctx)
      expect(nothing.output).toMatch(/^No files found in the first 1\d\d entries \([\d.]+ s\): narrow the pattern or the directory$/)
      expect(nothing.truncated).toBe(true)
      // A pattern with a fixed directory reads only that directory, so the same budget is enough.
      const narrow = await glob.execute({ pattern: "d19/deep/*.ts" }, ctx)
      expect(narrow.output).toBe("d19/deep/last.ts")
      expect(narrow.truncated).toBe(false)
    } finally {
      delete process.env[GLOB_MAX_ENTRIES_ENV]
    }
    expect((await glob.execute({ pattern: "**/*.ts" }, ctx)).output.split("\n").sort()).toEqual(["d19/deep/last.ts", "top.ts"])
  })
  test("patterns without ** stay at their depth; absolute and ./ patterns work", async () => {
    const root = tmp()
    put({ root, path: "a.ts", content: "" })
    put({ root, path: "src/b.ts", content: "" })
    put({ root, path: "src/deep/c.ts", content: "" })
    const ctx = makeContext({ cwd: root })
    const list = async (pattern: string) => (await glob.execute({ pattern }, ctx)).output.split("\n").sort()
    expect(await list("*.ts")).toEqual(["a.ts"])
    expect(await list("*/*.ts")).toEqual(["src/b.ts"])
    expect(await list("src/b.ts")).toEqual(["src/b.ts"])
    expect(await list("./src/*.ts")).toEqual(["src/b.ts"])
    expect(await list("src/**")).toEqual(["src/b.ts", "src/deep/c.ts"])
    expect(await list(`${root}/src/**/*.ts`)).toEqual(["src/b.ts", "src/deep/c.ts"])
    expect(await list("{src/deep,nope}/*.ts")).toEqual(["src/deep/c.ts"])
  })
})

const modes: Array<{ name: string; fallback: boolean }> = [
  { name: "rg", fallback: false },
  { name: "fallback", fallback: true },
]
const hasRg = Bun.which("rg") !== null

for (const { name, fallback } of modes) {
  describe(`grep (${name})`, () => {
    const previous = process.env[GREP_FALLBACK_ENV]
    const setup = () => {
      if (fallback) process.env[GREP_FALLBACK_ENV] = "1"
      else delete process.env[GREP_FALLBACK_ENV]
    }
    afterEach(() => {
      if (previous === undefined) delete process.env[GREP_FALLBACK_ENV]
      else process.env[GREP_FALLBACK_ENV] = previous
    })
    const t = fallback || hasRg ? test : test.skip

    t("finds matches as path:line:text, skipping node_modules and binaries", async () => {
      setup()
      const root = tmp()
      put({ root, path: "src/a.ts", content: "const foo = 1\nbar\nfoo again\n" })
      put({ root, path: "node_modules/p/i.js", content: "foo\n" })
      put({ root, path: "bin.dat", content: new Uint8Array([102, 111, 111, 0]) })
      const result = await grep.execute({ pattern: "foo" }, makeContext({ cwd: root }))
      expect(result.output.split("\n").sort()).toEqual(["src/a.ts:1:const foo = 1", "src/a.ts:3:foo again"])
      expect(result.meta?.matches).toBe(2)
    })
    t("supports include and ignoreCase", async () => {
      setup()
      const root = tmp()
      put({ root, path: "a.ts", content: "Hello\n" })
      put({ root, path: "b.md", content: "Hello\n" })
      const result = await grep.execute({ pattern: "hello", include: "*.ts", ignoreCase: true }, makeContext({ cwd: root }))
      expect(result.output).toBe("a.ts:1:Hello")
      const none = await grep.execute({ pattern: "hello", include: "*.ts" }, makeContext({ cwd: root }))
      expect(none.output).toBe("No matches found")
    })
    t("bad regex is an error", async () => {
      setup()
      const root = tmp()
      put({ root, path: "a.ts", content: "x\n" })
      const result = await grep.execute({ pattern: "(" }, makeContext({ cwd: root }))
      expect(result.isError).toBe(true)
    })
    t("caps at 500 matches", async () => {
      setup()
      const root = tmp()
      put({ root, path: "a.txt", content: Array.from({ length: 700 }, () => "hit").join("\n") })
      const result = await grep.execute({ pattern: "hit" }, makeContext({ cwd: root }))
      expect(result.truncated).toBe(true)
      expect(result.meta?.matches).toBe(500)
    })
    t("searches a single file and errors on missing path", async () => {
      setup()
      const root = tmp()
      put({ root, path: "a.txt", content: "needle\n" })
      const ctx = makeContext({ cwd: root })
      expect((await grep.execute({ pattern: "needle", path: "a.txt" }, ctx)).output).toBe("a.txt:1:needle")
      expect((await grep.execute({ pattern: "x", path: "zzz" }, ctx)).isError).toBe(true)
    })
    t("aborted signal cancels", async () => {
      setup()
      const root = tmp()
      const controller = new AbortController()
      controller.abort()
      const result = await grep.execute({ pattern: "x" }, makeContext({ cwd: root, signal: controller.signal }))
      expect(result.isError).toBe(true)
      expect(result.output).toBe("cancelled")
    })
  })
}

describe("grep fallback and runaway patterns", () => {
  test("the built-in search refuses a repeated group that repeats inside instead of hanging the daemon", async () => {
    const previous = process.env[GREP_FALLBACK_ENV]
    process.env[GREP_FALLBACK_ENV] = "1"
    try {
      const root = tmp()
      put({ root, path: "a.txt", content: `${"a".repeat(40)}!\n` })
      const started = performance.now()
      const result = await grep.execute({ pattern: "^(a+)+$" }, makeContext({ cwd: root }))
      expect(performance.now() - started).toBeLessThan(1_000)
      expect(result.isError).toBe(true)
      expect(result.output).toContain("install ripgrep")
      expect(nestedRepetition("(\\w*,)*")).toBe(true)
      expect(nestedRepetition("function\\s+\\w+\\(")).toBe(false)
      expect(nestedRepetition("(?:ab)+")).toBe(false)
    } finally {
      if (previous === undefined) delete process.env[GREP_FALLBACK_ENV]
      else process.env[GREP_FALLBACK_ENV] = previous
    }
  })
})
