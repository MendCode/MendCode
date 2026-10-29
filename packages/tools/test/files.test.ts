import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, lstatSync, readFileSync, readdirSync, statSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { BUILTIN_TOOLS, applyPatch, edit, ls, read, runTool, write } from "../src"
import { truncateHeadTail, truncateText } from "../src/util"
import { boundedLines } from "../src/tools/read"
import { createInterface } from "node:readline"
import { Readable } from "node:stream"
import { makeContext, put, useTempDir } from "./helpers"

const tmp = useTempDir()

describe("read", () => {
  test("numbers lines and honours offset/limit", async () => {
    const root = tmp()
    put({ root, path: "a.txt", content: "one\ntwo\nthree\nfour\n" })
    const result = await read.execute({ path: "a.txt", offset: 2, limit: 2 }, makeContext({ cwd: root }))
    expect(result.isError).toBe(false)
    expect(result.output).toContain("     2\ttwo")
    expect(result.output).toContain("     3\tthree")
    expect(result.output).toContain("[output truncated: 1 more lines]")
    expect(result.title).toBe("Read a.txt")
    expect(result.meta).toEqual({ path: join(root, "a.txt"), lines: 2 })
  })
  test("errors on missing files and binary; directories are readable", async () => {
    const root = tmp()
    put({ root, path: "bin.dat", content: new Uint8Array([65, 0, 66]) })
    put({ root, path: "d/x", content: "x" })
    const ctx = makeContext({ cwd: root })
    expect((await read.execute({ path: "nope" }, ctx)).isError).toBe(true)
    const dir = await read.execute({ path: "d" }, ctx)
    expect(dir.isError).toBe(false)
    expect(dir.output).toContain("directory")
    const bin = await read.execute({ path: "bin.dat" }, ctx)
    expect(bin.isError).toBe(true)
    expect(bin.output).toBe("bin.dat is a binary file (3 bytes); not shown. Use shell with file, xxd | head, or strings to inspect it")
    expect((await read.execute({ path: "d/nope/x.ts" }, ctx)).output).toBe("cannot read d/nope/x.ts: no such file or directory (nearest existing directory: d)")
  })
  test("truncates to the default line limit", async () => {
    const root = tmp()
    put({ root, path: "big.txt", content: Array.from({ length: 2500 }, (_, i) => `l${i}`).join("\n") })
    const result = await read.execute({ path: "big.txt" }, makeContext({ cwd: root }))
    expect(result.truncated).toBe(true)
    expect(result.meta?.lines).toBe(2000)
    expect(result.output).toContain("500 more lines")
  })
  test("accepts absolute paths", async () => {
    const root = tmp()
    const full = put({ root, path: "abs.txt", content: "hi" })
    expect((await read.execute({ path: full }, makeContext({ cwd: "/" }))).output).toContain("hi")
  })
})

describe("write", () => {
  test("creates parents and reports created; overwrite reports false", async () => {
    const root = tmp()
    const ctx = makeContext({ cwd: root })
    const first = await write.execute({ path: "a/b/c.txt", content: "héllo" }, ctx)
    expect(first.meta).toEqual({ path: join(root, "a/b/c.txt"), bytes: 6, created: true })
    expect(readFileSync(join(root, "a/b/c.txt"), "utf8")).toBe("héllo")
    const second = await write.execute({ path: "a/b/c.txt", content: "x" }, ctx)
    expect(second.meta?.created).toBe(false)
    expect(readdirSync(join(root, "a/b"))).toEqual(["c.txt"])
  })
  test("errors when target is a directory", async () => {
    const root = tmp()
    put({ root, path: "d/x", content: "" })
    expect((await write.execute({ path: "d", content: "x" }, makeContext({ cwd: root }))).isError).toBe(true)
  })
})

describe("edit", () => {
  test("replaces a unique match and shows a diff", async () => {
    const root = tmp()
    put({ root, path: "f.ts", content: "a\nb\nc\n" })
    const result = await edit.execute({ path: "f.ts", oldString: "b", newString: "B" }, makeContext({ cwd: root }))
    expect(result.isError).toBe(false)
    expect(result.output).toContain("-b")
    expect(result.output).toContain("+B")
    expect(readFileSync(join(root, "f.ts"), "utf8")).toBe("a\nB\nc\n")
    expect(result.meta?.replacements).toBe(1)
  })
  test("ambiguous match errors with the count; replaceAll works", async () => {
    const root = tmp()
    put({ root, path: "f.ts", content: "x x x" })
    const ctx = makeContext({ cwd: root })
    const bad = await edit.execute({ path: "f.ts", oldString: "x", newString: "y" }, ctx)
    expect(bad.isError).toBe(true)
    expect(bad.output).toContain("3 times")
    expect(readFileSync(join(root, "f.ts"), "utf8")).toBe("x x x")
    const good = await edit.execute({ path: "f.ts", oldString: "x", newString: "y", replaceAll: true }, ctx)
    expect(good.meta?.replacements).toBe(3)
    expect(readFileSync(join(root, "f.ts"), "utf8")).toBe("y y y")
  })
  test("not found, identical strings and missing file are errors", async () => {
    const root = tmp()
    put({ root, path: "f.ts", content: "abc" })
    const ctx = makeContext({ cwd: root })
    expect((await edit.execute({ path: "f.ts", oldString: "zzz", newString: "y" }, ctx)).output).toContain("not found")
    expect((await edit.execute({ path: "f.ts", oldString: "a", newString: "a" }, ctx)).output).toContain("identical")
    expect((await edit.execute({ path: "gone.ts", oldString: "a", newString: "b" }, ctx)).isError).toBe(true)
  })
  test("$ patterns in newString are literal", async () => {
    const root = tmp()
    put({ root, path: "f.ts", content: "a" })
    await edit.execute({ path: "f.ts", oldString: "a", newString: "$&$1" }, makeContext({ cwd: root }))
    expect(readFileSync(join(root, "f.ts"), "utf8")).toBe("$&$1")
  })
})

describe("apply_patch", () => {
  test("adds, updates and deletes atomically", async () => {
    const root = tmp()
    put({ root, path: "u.txt", content: "one\ntwo\nthree\n" })
    put({ root, path: "d.txt", content: "bye\n" })
    const patch = [
      "*** Begin Patch",
      "*** Add File: new/n.txt",
      "+hello",
      "+world",
      "*** Update File: u.txt",
      "@@",
      " one",
      "-two",
      "+TWO",
      " three",
      "*** Delete File: d.txt",
      "*** End Patch",
    ].join("\n")
    const result = await applyPatch.execute({ patch }, makeContext({ cwd: root }))
    expect(result.isError).toBe(false)
    expect(result.meta).toEqual({ files: 3 })
    expect(readFileSync(join(root, "new/n.txt"), "utf8")).toBe("hello\nworld\n")
    expect(readFileSync(join(root, "u.txt"), "utf8")).toBe("one\nTWO\nthree\n")
    expect(existsSync(join(root, "d.txt"))).toBe(false)
    // The model reads the file list; the card gets the diff.
    expect(result.output).toBe("A new/n.txt\nM u.txt\nD d.txt")
    expect(result.display).toContain("*** Update File: u.txt")
    expect(result.display).toContain("-two\n+TWO")
    expect(result.display).toContain("*** Add File: new/n.txt\n+hello\n+world")
  })
  test("a mismatch anywhere leaves every file untouched", async () => {
    const root = tmp()
    put({ root, path: "u.txt", content: "one\ntwo\n" })
    const patch = [
      "*** Begin Patch",
      "*** Add File: added.txt",
      "+x",
      "*** Update File: u.txt",
      "@@",
      "-nonexistent",
      "+y",
      "*** End Patch",
    ].join("\n")
    const result = await applyPatch.execute({ patch }, makeContext({ cwd: root }))
    expect(result.isError).toBe(true)
    expect(result.output).toContain("no files changed")
    expect(existsSync(join(root, "added.txt"))).toBe(false)
    expect(readFileSync(join(root, "u.txt"), "utf8")).toBe("one\ntwo\n")
  })
  test("rejects malformed patches, existing add targets and missing deletes", async () => {
    const root = tmp()
    put({ root, path: "e.txt", content: "x\n" })
    const ctx = makeContext({ cwd: root })
    expect((await applyPatch.execute({ patch: "nonsense" }, ctx)).isError).toBe(true)
    const exists = ["*** Begin Patch", "*** Add File: e.txt", "+y", "*** End Patch"].join("\n")
    expect((await applyPatch.execute({ patch: exists }, ctx)).output).toContain("already exists")
    const missing = ["*** Begin Patch", "*** Delete File: nope.txt", "*** End Patch"].join("\n")
    expect((await applyPatch.execute({ patch: missing }, ctx)).isError).toBe(true)
    expect(readFileSync(join(root, "e.txt"), "utf8")).toBe("x\n")
  })
  test("uses @@ context to locate a hunk and supports Move to", async () => {
    const root = tmp()
    put({ root, path: "m.txt", content: "a\nx\nb\nx\n" })
    const patch = [
      "*** Begin Patch",
      "*** Update File: m.txt",
      "*** Move to: moved.txt",
      "@@ b",
      "-x",
      "+y",
      "*** End Patch",
    ].join("\n")
    const result = await applyPatch.execute({ patch }, makeContext({ cwd: root }))
    expect(result.isError).toBe(false)
    expect(existsSync(join(root, "m.txt"))).toBe(false)
    expect(readFileSync(join(root, "moved.txt"), "utf8")).toBe("a\nx\nb\ny\n")
  })
})

describe("ls", () => {
  test("lists dirs first, skips node_modules and .git", async () => {
    const root = tmp()
    put({ root, path: "b.txt", content: "" })
    put({ root, path: "a.txt", content: "" })
    put({ root, path: "src/x.ts", content: "" })
    put({ root, path: "node_modules/p/i.js", content: "" })
    put({ root, path: ".git/HEAD", content: "" })
    const result = await ls.execute({}, makeContext({ cwd: root }))
    expect(result.output.split("\n")).toEqual(["src/", "a.txt", "b.txt"])
  })
  test("errors on missing dir and caps entries", async () => {
    const root = tmp()
    const ctx = makeContext({ cwd: root })
    expect((await ls.execute({ path: "nope" }, ctx)).isError).toBe(true)
    for (let i = 0; i < 1005; i++) put({ root, path: `many/f${i}`, content: "" })
    const result = await ls.execute({ path: "many" }, ctx)
    expect(result.truncated).toBe(true)
    expect(result.meta?.entries).toBe(1000)
  })
})

describe("truncation helpers", () => {
  test("never splits a UTF-8 character", () => {
    const text = "é".repeat(100)
    const { text: out, truncated } = truncateText({ text, limits: { maxBytes: 51, maxLines: 10 } })
    expect(truncated).toBe(true)
    expect(out).not.toContain("�")
    expect(out.startsWith("é".repeat(25))).toBe(true)
  })
  test("head+tail keeps both ends with a marker", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
    const { text: out } = truncateHeadTail({ text, limits: { maxBytes: 100_000, maxLines: 20 } })
    expect(out).toContain("line0")
    expect(out).toContain("line99")
    expect(out).toMatch(/… \d+ lines omitted …/)
  })
})

describe("runTool", () => {
  test("returns zod issues as an error result", async () => {
    const result = await runTool(read, { offset: 0 }, makeContext({ cwd: tmp() }))
    expect(result.isError).toBe(true)
    expect(result.output).toContain("offset")
    // `path` is optional now (a call gives `path` or `paths`): leaving both out is refused by the tool itself.
    expect((await runTool(read, {}, makeContext({ cwd: tmp() }))).output).toContain("path")
  })
  test("BUILTIN_TOOLS lists all seventeen uniquely (shell_session is added by the daemon where a PTY exists)", () => {
    expect(BUILTIN_TOOLS.map((t) => t.name).sort()).toEqual(
      ["apply_patch", "edit", "glob", "grep", "ls", "notebook_edit", "read", "review", "screenshot", "shell", "shell_kill", "shell_monitor", "shell_output", "sleep", "task_status", "webfetch", "write"],
    )
  })
})

describe("writes that keep what is there", () => {
  test("edit through a symlink changes the file it names and leaves the link a link", async () => {
    const root = tmp()
    put({ root, path: "shared/config.ts", content: "a = 1\n" })
    symlinkSync(join(root, "shared/config.ts"), join(root, "config.ts"))
    const result = await edit.execute({ path: "config.ts", oldString: "a = 1", newString: "a = 2" }, makeContext({ cwd: root }))
    expect(result.isError).toBe(false)
    expect(lstatSync(join(root, "config.ts")).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(root, "shared/config.ts"), "utf8")).toBe("a = 2\n")
  })
  test("two edits of one file at once both land", async () => {
    const root = tmp()
    put({ root, path: "f.ts", content: "a=1\nb=1\n" })
    const ctx = makeContext({ cwd: root })
    const [one, two] = await Promise.all([
      edit.execute({ path: "f.ts", oldString: "a=1", newString: "a=2" }, ctx),
      edit.execute({ path: "f.ts", oldString: "b=1", newString: "b=2" }, ctx),
    ])
    expect([one.isError, two.isError]).toEqual([false, false])
    expect(readFileSync(join(root, "f.ts"), "utf8")).toBe("a=2\nb=2\n")
  })
  test("*** End of File puts the hunk at the end, not on an earlier match", async () => {
    const root = tmp()
    put({ root, path: "f.txt", content: "x\nkeep\nx\n" })
    const patch = ["*** Begin Patch", "*** Update File: f.txt", "@@", "-x", "+y", "*** End of File", "*** End Patch"].join("\n")
    expect((await applyPatch.execute({ patch }, makeContext({ cwd: root }))).isError).toBe(false)
    expect(readFileSync(join(root, "f.txt"), "utf8")).toBe("x\nkeep\ny\n")
  })
  test("a CRLF file stays CRLF after a patch", async () => {
    const root = tmp()
    put({ root, path: "f.txt", content: "a\r\nb\r\n" })
    const patch = ["*** Begin Patch", "*** Update File: f.txt", "@@", "-a", "+A", " b", "*** End Patch"].join("\n")
    expect((await applyPatch.execute({ patch }, makeContext({ cwd: root }))).isError).toBe(false)
    expect(readFileSync(join(root, "f.txt"), "utf8")).toBe("A\r\nb\r\n")
  })
  test("a moved script keeps its execute bit", async () => {
    const root = tmp()
    put({ root, path: "run.sh", content: "echo one\n" })
    chmodSync(join(root, "run.sh"), 0o755)
    const patch = ["*** Begin Patch", "*** Update File: run.sh", "*** Move to: bin/run.sh", "@@", "-echo one", "+echo two", "*** End Patch"].join("\n")
    expect((await applyPatch.execute({ patch }, makeContext({ cwd: root }))).isError).toBe(false)
    expect(statSync(join(root, "bin/run.sh")).mode & 0o777).toBe(0o755)
  })
})

describe("read lines", () => {
  test("splits like readline wherever a read cuts the text, and holds only the kept prefix of a long line", async () => {
    const samples = ["", "a", "a\n", "a\nb", "a\r\nb\r\n", "a\rb\n", "\n\n", "a\r", "a\r\r\nb", "x\n\ny"]
    for (const sample of samples) {
      for (let cut = 0; cut <= sample.length; cut++) {
        const chunks = [sample.slice(0, cut), sample.slice(cut)].filter(Boolean)
        const want: string[] = []
        for await (const line of createInterface({ input: Readable.from(chunks.length ? chunks : [""]), crlfDelay: Infinity })) want.push(line)
        const got: string[] = []
        for await (const line of boundedLines(Readable.from(chunks), 100)) got.push(line.text)
        expect(got).toEqual(want)
      }
    }
    const long: Array<{ text: string; long: boolean }> = []
    for await (const line of boundedLines(Readable.from(["x".repeat(3000), "y".repeat(3000), "\nshort"]), 5)) long.push(line)
    expect(long).toEqual([{ text: "xxxxx", long: true }, { text: "short", long: false }])
  })
})

describe("edit near misses", () => {
  test("LF strings edit a CRLF file and keep it CRLF; trailing spaces do not block a unique match; two near matches stay not found", async () => {
    const root = tmp()
    const ctx = makeContext({ cwd: root })
    put({ root, path: "crlf.ts", content: "one\r\ntwo\r\nthree\r\n" })
    expect((await edit.execute({ path: "crlf.ts", oldString: "one\ntwo", newString: "ONE\nTWO" }, ctx)).isError).toBe(false)
    expect(readFileSync(join(root, "crlf.ts"), "utf8")).toBe("ONE\r\nTWO\r\nthree\r\n")
    put({ root, path: "spaces.ts", content: "a  \nb\t\nc\n" })
    expect((await edit.execute({ path: "spaces.ts", oldString: "a\nb", newString: "A\nB" }, ctx)).isError).toBe(false)
    expect(readFileSync(join(root, "spaces.ts"), "utf8")).toBe("A\nB\nc\n")
    put({ root, path: "twice.ts", content: "x \ny\nx\t\ny\n" })
    expect((await edit.execute({ path: "twice.ts", oldString: "x\ny", newString: "z" }, ctx)).output).toContain("not found")
    expect(readFileSync(join(root, "twice.ts"), "utf8")).toBe("x \ny\nx\t\ny\n")
  })
})
