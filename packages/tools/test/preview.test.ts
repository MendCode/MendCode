import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { applyPatch, edit, read, write } from "../src"
import { boundPreview } from "../src/util"
import { makeContext, put, useTempDir } from "./helpers"

const tmp = useTempDir()

describe("edit preview", () => {
  test("matches the diff execute reports and writes nothing", async () => {
    const root = tmp()
    put({ root, path: "f.ts", content: "a\nb\nc\n" })
    const ctx = makeContext({ cwd: root })
    const preview = await edit.preview!({ path: "f.ts", oldString: "b", newString: "B" }, ctx)
    expect(readFileSync(join(root, "f.ts"), "utf8")).toBe("a\nb\nc\n")
    expect(preview).toBe("@@ -2,1 +2,1 @@\n-b\n+B")
    const result = await edit.execute({ path: "f.ts", oldString: "b", newString: "B" }, ctx)
    expect(result.output).toBe(preview!)
  })
  test("is undefined when the edit would fail", async () => {
    const root = tmp()
    put({ root, path: "f.ts", content: "x x" })
    const ctx = makeContext({ cwd: root })
    expect(await edit.preview!({ path: "f.ts", oldString: "x", newString: "y" }, ctx)).toBeUndefined()
    expect(await edit.preview!({ path: "f.ts", oldString: "zzz", newString: "y" }, ctx)).toBeUndefined()
    expect(await edit.preview!({ path: "f.ts", oldString: "x", newString: "x" }, ctx)).toBeUndefined()
    expect(await edit.preview!({ path: "nope.ts", oldString: "x", newString: "y" }, ctx)).toBeUndefined()
  })
  test("is bounded to 200 lines with a note", async () => {
    const root = tmp()
    put({ root, path: "big.txt", content: Array.from({ length: 500 }, (_, i) => `line${i}`).join("\n") })
    const preview = await edit.preview!({ path: "big.txt", oldString: "line", newString: "LINE", replaceAll: true }, makeContext({ cwd: root }))
    const lines = preview!.split("\n")
    expect(lines.length).toBe(201)
    expect(lines.at(-1)).toMatch(/^… [\d,]+ more lines$/)
  })
})

describe("write preview", () => {
  test("new file shows its line count and first lines", async () => {
    const root = tmp()
    const preview = await write.preview!({ path: "sub/new.txt", content: "one\ntwo\n" }, makeContext({ cwd: root }))
    expect(preview).toBe("+ new file 2 lines\n+one\n+two")
    expect(existsSync(join(root, "sub"))).toBe(false)
  })
  test("existing file shows a diff; identical content says so", async () => {
    const root = tmp()
    put({ root, path: "a.txt", content: "keep\nold\nkeep2\n" })
    const ctx = makeContext({ cwd: root })
    expect(await write.preview!({ path: "a.txt", content: "keep\nnew\nkeep2\n" }, ctx)).toBe("@@ -2,1 +2,1 @@\n-old\n+new")
    expect(await write.preview!({ path: "a.txt", content: "keep\nold\nkeep2\n" }, ctx)).toBe("(no changes)")
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("keep\nold\nkeep2\n")
  })
  test("directories and binary files have no preview; big new files are bounded", async () => {
    const root = tmp()
    put({ root, path: "d/x", content: "" })
    put({ root, path: "bin", content: new Uint8Array([1, 0, 2]) })
    const ctx = makeContext({ cwd: root })
    expect(await write.preview!({ path: "d", content: "x" }, ctx)).toBeUndefined()
    expect(await write.preview!({ path: "bin", content: "x" }, ctx)).toBeUndefined()
    const big = await write.preview!({ path: "n.txt", content: "l\n".repeat(1000) }, ctx)
    expect(big!.split("\n").length).toBe(201)
    expect(big!).toContain("more lines")
  })
})

describe("apply_patch preview", () => {
  const patch = [
    "*** Begin Patch",
    "*** Add File: new.txt",
    "+hello",
    "*** Update File: u.txt",
    "@@",
    " one",
    "-two",
    "+TWO",
    "*** Delete File: d.txt",
    "*** End Patch",
  ].join("\n")
  test("shows every file's hunks and changes nothing", async () => {
    const root = tmp()
    put({ root, path: "u.txt", content: "one\ntwo\nthree\n" })
    put({ root, path: "d.txt", content: "bye\n" })
    const preview = await applyPatch.preview!({ patch }, makeContext({ cwd: root }))
    expect(preview).toBe(
      ["*** Add File: new.txt", "+hello", "*** Update File: u.txt", "@@ -2,1 +2,1 @@", "-two", "+TWO", "*** Delete File: d.txt"].join("\n"),
    )
    expect(readdirSync(root).sort()).toEqual(["d.txt", "u.txt"])
    expect(readFileSync(join(root, "u.txt"), "utf8")).toBe("one\ntwo\nthree\n")
  })
  test("is undefined when validation fails", async () => {
    const root = tmp()
    put({ root, path: "u.txt", content: "different\n" })
    put({ root, path: "d.txt", content: "bye\n" })
    const ctx = makeContext({ cwd: root })
    expect(await applyPatch.preview!({ patch }, ctx)).toBeUndefined()
    expect(await applyPatch.preview!({ patch: "garbage" }, ctx)).toBeUndefined()
  })
})

describe("tools without a preview and boundPreview", () => {
  test("read has no preview", () => {
    expect(read.preview).toBeUndefined()
  })
  test("boundPreview also caps bytes without splitting lines", () => {
    const text = Array.from({ length: 100 }, () => "x".repeat(500)).join("\n")
    const bounded = boundPreview(text)
    expect(Buffer.byteLength(bounded)).toBeLessThan(17 * 1024)
    expect(bounded).toMatch(/\n… \d+ more lines$/)
    expect(boundPreview("short")).toBe("short")
  })
})
