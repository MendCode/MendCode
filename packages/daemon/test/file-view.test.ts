import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { FILE_VIEW_MAX_BYTES, FILE_VIEW_MAX_ENTRIES, FILE_VIEW_MAX_LINE, FILE_VIEW_MAX_ROWS } from "@mendcode/protocol"
import { viewFile } from "../src/file-view"

const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function project() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mendcode-file-view-")))
  temps.push(dir)
  return dir
}
const numbered = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n") + "\n"

test("a text file answers a window of lines with the total", async () => {
  const dir = project()
  writeFileSync(path.join(dir, "a.ts"), numbered(500))
  const first = await viewFile({ directory: dir, path: "a.ts" })
  expect(first).toMatchObject({ kind: "text", path: "a.ts", lines: 500, from: 1 })
  expect(first.rows).toHaveLength(200)
  expect(first.rows![0]).toBe("line 1")
  const middle = await viewFile({ directory: dir, path: "a.ts", from: 250, count: 3 })
  expect(middle.rows).toEqual(["line 250", "line 251", "line 252"])
  expect((await viewFile({ directory: dir, path: "a.ts", count: 9999 as never })).rows).toHaveLength(FILE_VIEW_MAX_ROWS)
})

test("a jump to the last line of an 11,000-line file reads one window and is fast", async () => {
  const dir = project()
  writeFileSync(path.join(dir, "big.rs"), numbered(11_000))
  const started = performance.now()
  const tail = await viewFile({ directory: dir, path: "big.rs", from: 11_000, count: 50 })
  expect(performance.now() - started).toBeLessThan(500)
  expect(tail).toMatchObject({ lines: 11_000, from: 11_000, rows: ["line 11000"] })
  expect((await viewFile({ directory: dir, path: "big.rs", from: 99_999 })).from).toBe(11_000)
})

test("the first row of a file keeps its indentation and the CR of a CRLF file is dropped", async () => {
  const dir = project()
  writeFileSync(path.join(dir, "i.py"), "\n    indented\r\nnext\r\n")
  expect((await viewFile({ directory: dir, path: "i.py" })).rows).toEqual(["", "    indented", "next"])
})

test("an empty file has no lines and a missing one says so", async () => {
  const dir = project()
  writeFileSync(path.join(dir, "empty.txt"), "")
  expect(await viewFile({ directory: dir, path: "empty.txt" })).toMatchObject({ kind: "text", lines: 0, rows: [] })
  expect(await viewFile({ directory: dir, path: "nope.txt" })).toMatchObject({ kind: "missing" })
  expect(await viewFile({ directory: dir, path: "nope/deeper/file.txt" })).toMatchObject({ kind: "missing" })
})

test("a folder is reported as a folder", async () => {
  const dir = project()
  mkdirSync(path.join(dir, "src"))
  expect(await viewFile({ directory: dir, path: "src" })).toMatchObject({ kind: "directory", path: "src" })
})

test("a folder lists its entries: folders first, each group by name, sizes for files, and no .git", async () => {
  const dir = project()
  mkdirSync(path.join(dir, "src/deep"), { recursive: true })
  mkdirSync(path.join(dir, ".git"))
  mkdirSync(path.join(dir, "Zed"))
  writeFileSync(path.join(dir, "src/b.ts"), "12345")
  writeFileSync(path.join(dir, "src/A.ts"), "")
  writeFileSync(path.join(dir, "src/a.md"), "ab")
  symlinkSync(path.join(dir, "src/b.ts"), path.join(dir, "src/alias.ts"))
  const listed = await viewFile({ directory: dir, path: "src" })
  expect(listed).toMatchObject({ kind: "directory", path: "src", entriesTotal: 5 })
  expect(listed.entries).toEqual([
    { name: "deep", kind: "dir" },
    { name: "a.md", kind: "file", size: 2 },
    { name: "A.ts", kind: "file", size: 0 },
    { name: "alias.ts", kind: "link" },
    { name: "b.ts", kind: "file", size: 5 },
  ])
  const root = await viewFile({ directory: dir, path: "." })
  expect(root).toMatchObject({ kind: "directory", path: "." })
  expect(root.entries!.map((entry) => entry.name)).toEqual(["src", "Zed"])
  expect(root.rows).toBeUndefined()
})

test("a folder of 600 files lists 500 and says how many there are", async () => {
  const dir = project()
  mkdirSync(path.join(dir, "many"))
  for (let index = 0; index < 600; index++) writeFileSync(path.join(dir, "many", `f${String(index).padStart(3, "0")}.txt`), "")
  const listed = await viewFile({ directory: dir, path: "many" })
  expect(FILE_VIEW_MAX_ENTRIES).toBe(500)
  expect(listed.entries).toHaveLength(FILE_VIEW_MAX_ENTRIES)
  expect(listed.entriesTotal).toBe(600)
})

test("a folder outside the project is never listed, also through a symlink", async () => {
  const dir = project()
  const outside = project()
  writeFileSync(path.join(outside, "secret.txt"), "top secret\n")
  symlinkSync(outside, path.join(dir, "linked"))
  for (const target of ["..", "../", outside, "linked", "src/../.."]) {
    const reply = await viewFile({ directory: dir, path: target })
    expect(reply.kind).toBe("outside")
    expect(reply.entries).toBeUndefined()
  }
  expect((await viewFile({ directory: dir, path: ".git" })).kind).toBe("outside")
})

test("an empty folder lists nothing", async () => {
  const dir = project()
  mkdirSync(path.join(dir, "empty"))
  expect(await viewFile({ directory: dir, path: "empty" })).toMatchObject({ kind: "directory", entries: [], entriesTotal: 0 })
})

test("paths that leave the project are outside and are never read", async () => {
  const dir = project()
  const outside = project()
  writeFileSync(path.join(outside, "secret.txt"), "top secret\n")
  for (const target of ["../secret.txt", path.join(outside, "secret.txt"), "src/../../secret.txt", "/etc/hosts"]) {
    const reply = await viewFile({ directory: dir, path: target })
    expect(reply.kind).toBe("outside")
    expect(reply.rows).toBeUndefined()
  }
})

test("a symlink out of the project is outside, also through a symlinked folder and an absent child", async () => {
  const dir = project()
  const outside = project()
  writeFileSync(path.join(outside, "secret.txt"), "top secret\n")
  symlinkSync(path.join(outside, "secret.txt"), path.join(dir, "link.txt"))
  symlinkSync(outside, path.join(dir, "linked"))
  for (const target of ["link.txt", "linked/secret.txt", "linked/absent.txt"]) expect((await viewFile({ directory: dir, path: target })).kind).toBe("outside")
})

test("a symlink to a device is outside and a FIFO inside the project is special, neither hangs", async () => {
  const dir = project()
  symlinkSync("/dev/zero", path.join(dir, "zero"))
  expect((await viewFile({ directory: dir, path: "zero" })).kind).toBe("outside")
  const made = Bun.spawnSync(["mkfifo", path.join(dir, "pipe")])
  expect(made.exitCode).toBe(0)
  const started = performance.now()
  expect((await viewFile({ directory: dir, path: "pipe" })).kind).toBe("special")
  expect(performance.now() - started).toBeLessThan(1000)
  symlinkSync(path.join(dir, "pipe"), path.join(dir, "pipe-link"))
  expect((await viewFile({ directory: dir, path: "pipe-link" })).kind).toBe("special")
})

test("a symlink to a file inside the project is read", async () => {
  const dir = project()
  writeFileSync(path.join(dir, "real.txt"), "hello\n")
  symlinkSync(path.join(dir, "real.txt"), path.join(dir, "alias.txt"))
  expect(await viewFile({ directory: dir, path: "alias.txt" })).toMatchObject({ kind: "text", rows: ["hello"] })
})

test("binary files are described, by NUL bytes or by type, and a huge one is not read", async () => {
  const dir = project()
  writeFileSync(path.join(dir, "blob.dat"), Buffer.from([1, 2, 0, 3]))
  writeFileSync(path.join(dir, "pic.png"), Buffer.from("not really a png"))
  const blob = await viewFile({ directory: dir, path: "blob.dat" })
  expect(blob).toMatchObject({ kind: "binary", size: 4 })
  expect(blob.rows).toBeUndefined()
  expect(await viewFile({ directory: dir, path: "pic.png" })).toMatchObject({ kind: "binary", mime: "image/png" })
  writeFileSync(path.join(dir, "huge.log"), Buffer.alloc(FILE_VIEW_MAX_BYTES + 1, 97))
  const huge = await viewFile({ directory: dir, path: "huge.log" })
  expect(huge).toMatchObject({ kind: "large", size: FILE_VIEW_MAX_BYTES + 1 })
  expect(huge.rows).toBeUndefined()
})

test("a very long line is cut and counted, and secrets are masked", async () => {
  const dir = project()
  writeFileSync(path.join(dir, "env.txt"), `${"x".repeat(FILE_VIEW_MAX_LINE + 50)}\nOPENAI_API_KEY=sk-proj-${"a1B2c3D4".repeat(8)}\nplain\n`)
  const reply = await viewFile({ directory: dir, path: "env.txt" })
  expect(reply.cut).toBe(1)
  expect(reply.rows![0]).toHaveLength(FILE_VIEW_MAX_LINE)
  expect(reply.redacted).toBeGreaterThan(0)
  expect(reply.rows!.join("\n")).not.toContain("a1B2c3D4a1B2")
  expect(reply.rows![2]).toBe("plain")
})

test("search lists the matching lines, smart case, and counts past the cap", async () => {
  const dir = project()
  writeFileSync(path.join(dir, "s.ts"), "Alpha\nbeta\nALPHA beta\ngamma\n")
  expect((await viewFile({ directory: dir, path: "s.ts", search: "alpha" })).hits).toEqual({ lines: [1, 3], total: 2 })
  expect((await viewFile({ directory: dir, path: "s.ts", search: "Alpha" })).hits).toEqual({ lines: [1], total: 1 })
  expect((await viewFile({ directory: dir, path: "s.ts", search: "zzz" })).hits).toEqual({ lines: [], total: 0 })
})

test("a matching version answers unchanged without rows, a changed file answers again", async () => {
  const dir = project()
  const file = path.join(dir, "v.txt")
  writeFileSync(file, "one\n")
  const first = await viewFile({ directory: dir, path: "v.txt" })
  const same = await viewFile({ directory: dir, path: "v.txt", known: first.version })
  expect(same).toMatchObject({ unchanged: true, version: first.version })
  expect(same.rows).toBeUndefined()
  writeFileSync(file, "one\ntwo\n")
  const changed = await viewFile({ directory: dir, path: "v.txt", known: first.version })
  expect(changed.unchanged).toBeUndefined()
  expect(changed.rows).toEqual(["one", "two"])
})

test("git internals are not shown", async () => {
  const dir = project()
  mkdirSync(path.join(dir, ".git"))
  writeFileSync(path.join(dir, ".git", "config"), "[remote]\nurl = https://user:token@example.com/x.git\n")
  expect((await viewFile({ directory: dir, path: ".git/config" })).kind).toBe("outside")
})

test("a project directory that does not exist is an error, not a read", async () => {
  await expect(viewFile({ directory: "/nonexistent-mendcode-dir", path: "a.txt" })).rejects.toThrow("not a directory")
})
