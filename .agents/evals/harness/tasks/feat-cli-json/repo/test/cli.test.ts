import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { run } from "../src/cli"
import { countText } from "../src/count"

function capture(argv: string[]) {
  let out = ""
  let err = ""
  const code = run(argv, { out: (text) => (out += text), err: (text) => (err += text) })
  return { code, out, err }
}

function fixture(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), "wc-"))
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text)
  return dir
}

describe("countText", () => {
  test("counts lines, words and bytes", () => {
    expect(countText("one two\nthree\n")).toEqual({ lines: 2, words: 3, bytes: 14 })
  })
})

describe("cli", () => {
  test("prints a row per file and a total", () => {
    const dir = fixture({ "a.txt": "x y\n", "b.txt": "z\n" })
    const result = capture([path.join(dir, "a.txt"), path.join(dir, "b.txt")])
    expect(result.code).toBe(0)
    expect(result.out.trim().split("\n")).toHaveLength(3)
  })

  test("a missing file is a usage error", () => {
    const result = capture(["/definitely/not/here.txt"])
    expect(result.code).toBe(2)
    expect(result.err).toContain("cannot read")
  })
})
