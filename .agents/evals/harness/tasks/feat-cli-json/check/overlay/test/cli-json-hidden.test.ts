import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")

function fixture(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), "wcj-"))
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text)
  return dir
}

async function cli(args: string[]) {
  const child = Bun.spawn([process.execPath, path.join(root, "src/cli.ts"), ...args], { stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { out, err, code }
}

describe("--json", () => {
  test("emits an object with files and total", async () => {
    const dir = fixture({ "a.txt": "one two\nthree\n", "b.txt": "x\n" })
    const a = path.join(dir, "a.txt")
    const b = path.join(dir, "b.txt")
    const result = await cli(["--json", a, b])
    expect(result.code).toBe(0)
    const parsed = JSON.parse(result.out)
    expect(parsed).toEqual({
      files: [
        { file: a, lines: 2, words: 3, bytes: 14 },
        { file: b, lines: 1, words: 1, bytes: 2 },
      ],
      total: { lines: 3, words: 4, bytes: 16 },
    })
  })

  test("the flag may come after the files", async () => {
    const dir = fixture({ "a.txt": "hi\n" })
    const a = path.join(dir, "a.txt")
    const result = await cli([a, "--json"])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.out).files).toEqual([{ file: a, lines: 1, words: 1, bytes: 3 }])
  })

  test("a single file still reports a total", async () => {
    const dir = fixture({ "a.txt": "a b c" })
    const result = await cli(["--json", path.join(dir, "a.txt")])
    expect(JSON.parse(result.out).total).toEqual({ lines: 0, words: 3, bytes: 5 })
  })

  test("a missing file is still exit 2 with nothing on stdout", async () => {
    const result = await cli(["--json", "/definitely/not/here.txt"])
    expect(result.code).toBe(2)
    expect(result.out.trim()).toBe("")
    expect(result.err.length).toBeGreaterThan(0)
  })

  test("unknown options are still rejected", async () => {
    const result = await cli(["--yaml", "x"])
    expect(result.code).toBe(2)
  })
})

describe("table mode is unchanged", () => {
  test("without the flag the output is not JSON and has a total row", async () => {
    const dir = fixture({ "a.txt": "x\n", "b.txt": "y z\n" })
    const result = await cli([path.join(dir, "a.txt"), path.join(dir, "b.txt")])
    expect(result.code).toBe(0)
    expect(() => JSON.parse(result.out)).toThrow()
    expect(result.out).toContain("total")
  })
})
