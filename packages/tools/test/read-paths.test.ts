import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { applyPatch, read, runTool } from "../src"
import { MAX_READ_PATHS } from "../src/tools/read"
import { makeContext, put, useTempDir } from "./helpers"

const tmp = useTempDir()

describe("read with several paths", () => {
  test("returns every file under its own header, each with its own offset and limit", async () => {
    const root = tmp()
    put({ root, path: "a.txt", content: "one\ntwo\nthree\n" })
    put({ root, path: "b/c.txt", content: "alpha\nbeta\n" })
    const result = await read.execute({ paths: [{ path: "a.txt", offset: 2, limit: 1 }, { path: "b/c.txt" }] }, makeContext({ cwd: root }))
    expect(result.isError).toBe(false)
    expect(result.title).toBe("Read 2 files")
    expect(result.output).toContain("=== a.txt ===\n     2\ttwo")
    expect(result.output).not.toContain("\tone")
    expect(result.output).toContain("=== b/c.txt ===\n     1\talpha\n     2\tbeta")
    expect(result.meta).toEqual({ files: 2, failed: 0 })
  })

  test("each stored path uses decrypted bytes while ordinary paths still read from disk", async () => {
    const root = tmp()
    const stored = put({ root, path: "stored.txt", content: "sealed bytes" })
    put({ root, path: "plain.txt", content: "ordinary" })
    const seen: string[] = []
    const result = await read.execute({ paths: [{ path: "stored.txt", offset: 2, limit: 1 }, { path: "plain.txt" }] }, {
      ...makeContext({ cwd: root }),
      readStoredFile(file) { seen.push(file); return file === stored ? Buffer.from("first\nprivate\nlast") : undefined },
    })
    expect(result.isError).toBe(false)
    expect(result.output).toContain("=== stored.txt ===\n     2\tprivate")
    expect(result.output).toContain("=== plain.txt ===\n     1\tordinary")
    expect(result.output).not.toContain("sealed bytes")
    expect(seen).toHaveLength(2)
  })

  test("a missing file is reported in its section and the others still come back; all failing is an error", async () => {
    const root = tmp()
    put({ root, path: "a.txt", content: "one\n" })
    const mixed = await read.execute({ paths: [{ path: "nope.txt" }, { path: "a.txt" }] }, makeContext({ cwd: root }))
    expect(mixed.isError).toBe(false)
    expect(mixed.output).toContain("=== nope.txt ===\ncannot read nope.txt")
    expect(mixed.output).toContain("=== a.txt ===\n     1\tone")
    expect(mixed.meta).toEqual({ files: 2, failed: 1 })
    expect((await read.execute({ paths: [{ path: "x" }, { path: "y" }] }, makeContext({ cwd: root }))).isError).toBe(true)
  })

  test("path and paths together, or neither, are refused with a plain message", async () => {
    const root = tmp()
    put({ root, path: "a.txt", content: "one\n" })
    const context = makeContext({ cwd: root })
    expect((await read.execute({ path: "a.txt", paths: [{ path: "a.txt" }] }, context)).output).toContain("not both")
    expect((await read.execute({}, context)).output).toContain("needs `path` or `paths`")
  })

  test("a call that already returned its budget leaves the remaining files for another call", async () => {
    const root = tmp()
    const big = `${"x".repeat(60)}\n`.repeat(900)
    for (const name of ["1", "2", "3", "4"]) put({ root, path: `${name}.txt`, content: big })
    const result = await read.execute({ paths: [{ path: "1.txt" }, { path: "2.txt" }, { path: "3.txt" }, { path: "4.txt" }] }, makeContext({ cwd: root }))
    expect(result.truncated).toBe(true)
    expect(result.output).toContain("=== 3.txt ===\n     1\t")
    expect(result.output.endsWith("[not read: this call already returned 120,000 bytes; read the remaining 1 path in another call]\n4.txt")).toBe(true)
    expect(result.output).not.toContain("=== 4.txt ===")
    expect(result.meta).toEqual({ files: 4, failed: 0 })
  })

  test("21 paths in one call pass the schema and every file is read", async () => {
    const root = tmp()
    const paths = Array.from({ length: 21 }, (_, index) => ({ path: `m${index}.ts` }))
    for (const [index, item] of paths.entries()) put({ root, path: item.path, content: `export const v${index} = ${index}\n` })
    const result = await runTool(read, { paths }, makeContext({ cwd: root }))
    expect(result.isError).toBe(false)
    expect(result.title).toBe("Read 21 files")
    for (const [index, item] of paths.entries()) expect(result.output).toContain(`=== ${item.path} ===\n     1\texport const v${index} = ${index}`)
    expect(result.output).not.toContain("[not read")
  })

  test("64 paths is the schema limit, and the byte budget lists every file it left unread once, at the end", async () => {
    const root = tmp()
    const big = `${"x".repeat(60)}\n`.repeat(900)
    const paths = Array.from({ length: MAX_READ_PATHS }, (_, index) => ({ path: `f${index}.txt`, limit: 900 }))
    for (const item of paths) put({ root, path: item.path, content: big })
    expect(MAX_READ_PATHS).toBe(64)
    const result = await runTool(read, { paths }, makeContext({ cwd: root }))
    expect(result.isError).toBe(false)
    expect(result.truncated).toBe(true)
    const [body, marker] = result.output.split("\n\n[not read: ") as [string, string]
    const read_ = body.match(/^=== f\d+\.txt ===$/gm) ?? []
    expect(read_.length).toBeGreaterThan(0)
    expect(read_.length).toBeLessThan(8)
    // The output stays near the budget however many paths were asked for: one file past it at most, plus the list of names.
    expect(Buffer.byteLength(body)).toBeLessThan(120_000 + 51_200 + 1_000)
    const unread = marker.split("\n").slice(1)
    expect(marker.split("\n")[0]).toBe(`this call already returned 120,000 bytes; read the remaining ${unread.length} paths in another call]`)
    expect(unread).toEqual(paths.slice(read_.length).map((item) => item.path))
    expect((await runTool(read, { paths: [...paths, { path: "one-more.txt" }] }, makeContext({ cwd: root }))).output).toContain("invalid arguments: paths")
  })

  test("media in a list stops at the attachment budget instead of attaching 5 MiB per path", async () => {
    const root = tmp()
    const png = new Uint8Array(5 * 1024 * 1024)
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const paths = Array.from({ length: 20 }, (_, index) => ({ path: `i${index}.png` }))
    for (const item of paths) put({ root, path: item.path, content: png })
    const result = await runTool(read, { paths }, makeContext({ cwd: root }))
    expect(result.isError).toBe(false)
    expect(result.attachments).toHaveLength(16)
    expect(result.output.endsWith("[not read: this call already attached 80 MiB of media; read the remaining 4 paths in another call]\ni16.png\ni17.png\ni18.png\ni19.png")).toBe(true)
  })

  test("the single-file form is unchanged", async () => {
    const root = tmp()
    put({ root, path: "a.txt", content: "one\n" })
    const result = await read.execute({ path: "a.txt" }, makeContext({ cwd: root }))
    expect(result.title).toBe("Read a.txt")
    expect(result.output).toBe("     1\tone")
  })
})

describe("apply_patch mismatch", () => {
  test("names the line where the hunk's first line is, and what the file has there, so the model does not have to read again", async () => {
    const root = tmp()
    put({ root, path: "a.ts", content: "const a = 1\nconst total = a + 2\nexport { total }\n" })
    const result = await applyPatch.execute({ patch: "*** Begin Patch\n*** Update File: a.ts\n@@\n-const total = a + 3\n+const total = a + 4\n*** End Patch" }, makeContext({ cwd: root }))
    expect(result.isError).toBe(true)
    expect(result.output).toContain("hunk does not match")
    expect(result.output).toContain("closest line 2: const total = a + 2")
  })
})

const patchOf = (...rows: string[]) => ["*** Begin Patch", ...rows, "*** End Patch"].join("\n")

describe("apply_patch hunks out of file order", () => {
  const source = "import a\nimport b\n\nfunction one() {\n  return 1\n}\n\nfunction two() {\n  return 2\n}\n\nfunction three() {\n  return 3\n}\n"

  test("a hunk for an earlier part of the file applies after a later one, with every line where it belongs", async () => {
    const root = tmp()
    const file = put({ root, path: "a.ts", content: source })
    const patch = patchOf("*** Update File: a.ts", "@@", " function three() {", "-  return 3", "+  const n = 3", "+  return n", "@@", "-import b", "@@", " function two() {", "-  return 2", "+  return 22")
    const result = await applyPatch.execute({ patch }, makeContext({ cwd: root }))
    expect(result.output).toBe("M a.ts")
    expect(result.isError).toBe(false)
    expect(readFileSync(file, "utf8")).toBe("import a\n\nfunction one() {\n  return 1\n}\n\nfunction two() {\n  return 22\n}\n\nfunction three() {\n  const n = 3\n  return n\n}\n")
  })

  test("an out-of-order hunk that fits several places is refused as ambiguous, with the lines and the way out", async () => {
    const root = tmp()
    const file = put({ root, path: "a.ts", content: "x = 1\nkeep\nx = 1\nkeep\ny = 2\n" })
    const result = await applyPatch.execute({ patch: patchOf("*** Update File: a.ts", "@@", "-y = 2", "+y = 3", "@@", "-x = 1", "+x = 9") }, makeContext({ cwd: root }))
    expect(result.isError).toBe(true)
    expect(result.output).toContain("update a.ts: hunk 2 is out of file order and matches 2 places (lines 1, 3)")
    expect(result.output).toContain("add context lines to make it unique or put the hunks in file order")
    expect(result.output).toContain("no files changed")
    expect(readFileSync(file, "utf8")).toBe("x = 1\nkeep\nx = 1\nkeep\ny = 2\n")
  })

  test("in file order the first match after the previous hunk is still taken, as before", async () => {
    const root = tmp()
    const file = put({ root, path: "a.ts", content: "x = 1\nkeep\nx = 1\n" })
    expect((await applyPatch.execute({ patch: patchOf("*** Update File: a.ts", "@@", "-x = 1", "+x = 9", "@@", "-x = 1", "+x = 8") }, makeContext({ cwd: root }))).isError).toBe(false)
    expect(readFileSync(file, "utf8")).toBe("x = 9\nkeep\nx = 8\n")
  })

  test("hunks that claim the same lines are refused, in either order", async () => {
    const root = tmp()
    const file = put({ root, path: "a.ts", content: "a\nb\nc\nd\n" })
    for (const hunks of [["@@", " b", "-c", "+C", "@@", "-b", "+B"], ["@@", "-b", "+B", " c", "@@", " a", "-b", "+BB"]]) {
      const result = await applyPatch.execute({ patch: patchOf("*** Update File: a.ts", ...hunks) }, makeContext({ cwd: root }))
      expect(result.isError).toBe(true)
      expect(result.output).toContain("update a.ts: hunk 2 overlaps hunk 1")
      expect(result.output).toContain("merge them into one hunk")
      expect(readFileSync(file, "utf8")).toBe("a\nb\nc\nd\n")
    }
  })

  test("a hunk never matches text an earlier hunk of the same patch inserted", async () => {
    const root = tmp()
    const file = put({ root, path: "a.ts", content: "a\nz\n" })
    const result = await applyPatch.execute({ patch: patchOf("*** Update File: a.ts", "@@", "-z", "+fresh", "@@", "-fresh", "+stale") }, makeContext({ cwd: root }))
    expect(result.isError).toBe(true)
    expect(result.output).toContain("hunk does not match")
    expect(readFileSync(file, "utf8")).toBe("a\nz\n")
  })

  test("an @@ context line still picks the place when the hunk comes out of order", async () => {
    const root = tmp()
    const file = put({ root, path: "a.ts", content: "top\nx\nmid\nend\nlast\n" })
    const patch = patchOf("*** Update File: a.ts", "@@ end", "-last", "+LAST", "@@ top", "-x", "+y")
    expect((await applyPatch.execute({ patch }, makeContext({ cwd: root }))).isError).toBe(false)
    expect(readFileSync(file, "utf8")).toBe("top\ny\nmid\nend\nLAST\n")
    const missing = await applyPatch.execute({ patch: patchOf("*** Update File: a.ts", "@@ nowhere", "-y", "+z") }, makeContext({ cwd: root }))
    expect(missing.output).toContain('context "nowhere" not found')
  })

  test("lines added without old lines still go to the end of the file, in patch order", async () => {
    const root = tmp()
    const file = put({ root, path: "a.ts", content: "a\nb\n" })
    expect((await applyPatch.execute({ patch: patchOf("*** Update File: a.ts", "@@", "+one", "@@", "+two", "@@", "-a", "+A") }, makeContext({ cwd: root }))).isError).toBe(false)
    expect(readFileSync(file, "utf8")).toBe("A\nb\none\ntwo\n")
  })
})

describe("apply_patch hunks that change nothing", () => {
  test("a hunk with only context lines is an error that names the file, not a reported modification", async () => {
    const root = tmp()
    const file = put({ root, path: "src/format.ts", content: "export function format() {\n  return 1\n}\n" })
    const result = await applyPatch.execute({ patch: patchOf("*** Update File: src/format.ts", "@@", " export function format() {", "   return 1", " }") }, makeContext({ cwd: root }))
    expect(result.isError).toBe(true)
    expect(result.output).not.toContain("M src/format.ts")
    expect(result.output).toContain("update src/format.ts: the patch leaves the file exactly as it is (no hunk adds or removes a line")
    expect(readFileSync(file, "utf8")).toBe("export function format() {\n  return 1\n}\n")
  })

  test("a no-op hunk beside a real one is an anchor: the patch applies, and the other file is written", async () => {
    const root = tmp()
    const file = put({ root, path: "a.ts", content: "a\nb\n" })
    const result = await applyPatch.execute({ patch: patchOf("*** Add File: new.ts", "+x", "*** Update File: a.ts", "@@", "-a", "+A", "@@", " b") }, makeContext({ cwd: root }))
    expect(result.isError).toBe(false)
    expect(readFileSync(file, "utf8")).toBe("A\nb\n")
    expect(existsSync(join(root, "new.ts"))).toBe(true)
  })

  test("a context-only hunk says where the next one goes: the repeated closing line after the anchor is the one that changes", async () => {
    const root = tmp()
    const file = put({ root, path: "t.ts", content: "test(\"one\", () => {\n  a()\n})\n\ntest(\"two\", () => {\n  b()\n})\n" })
    const result = await applyPatch.execute({ patch: patchOf("*** Update File: t.ts", "@@", " test(\"two\", () => {", "@@", " })", "+", "+test(\"three\", () => {})") }, makeContext({ cwd: root }))
    expect(result.isError).toBe(false)
    expect(readFileSync(file, "utf8")).toBe("test(\"one\", () => {\n  a()\n})\n\ntest(\"two\", () => {\n  b()\n})\n\ntest(\"three\", () => {})\n")
  })

  test("removing and adding the same text beside a real hunk changes nothing there and does not fail the patch", async () => {
    const root = tmp()
    const file = put({ root, path: "a.ts", content: "a\nb\n" })
    const result = await applyPatch.execute({ patch: patchOf("*** Update File: a.ts", "@@", "-a", "+a", "@@", "-b", "+B") }, makeContext({ cwd: root }))
    expect(result.isError).toBe(false)
    expect(readFileSync(file, "utf8")).toBe("a\nB\n")
  })

  test("a file whose every hunk changes nothing is refused: the same text removed and added, and a bare @@", async () => {
    const root = tmp()
    put({ root, path: "a.ts", content: "a\nb\n" })
    const same = await applyPatch.execute({ patch: patchOf("*** Update File: a.ts", "@@", "-a", "+a") }, makeContext({ cwd: root }))
    expect(same.isError).toBe(true)
    expect(same.output).toContain("update a.ts: the patch leaves the file exactly as it is")
    const bare = await applyPatch.execute({ patch: patchOf("*** Update File: a.ts", "@@") }, makeContext({ cwd: root }))
    expect(bare.isError).toBe(true)
    expect(bare.output).toContain("update a.ts: the patch leaves the file exactly as it is")
  })

  test("a hunk whose only difference is whitespace the match ignored leaves the file as it was and is refused", async () => {
    const root = tmp()
    const file = put({ root, path: "a.ts", content: "a\nb\n" })
    const result = await applyPatch.execute({ patch: patchOf("*** Update File: a.ts", "@@", "-a  ", "+a") }, makeContext({ cwd: root }))
    expect(result.isError).toBe(true)
    expect(result.output).toContain("update a.ts: the patch leaves the file exactly as it is")
    expect(readFileSync(file, "utf8")).toBe("a\nb\n")
  })

  test("a rename keeps its context-only hunk: Move to is the change", async () => {
    const root = tmp()
    put({ root, path: "old.ts", content: "a\nb\n" })
    const result = await applyPatch.execute({ patch: patchOf("*** Update File: old.ts", "*** Move to: new.ts", "@@", " a") }, makeContext({ cwd: root }))
    expect(result.isError).toBe(false)
    expect(result.output).toBe("M old.ts -> new.ts")
    expect(readFileSync(join(root, "new.ts"), "utf8")).toBe("a\nb\n")
    expect(existsSync(join(root, "old.ts"))).toBe(false)
  })
})
