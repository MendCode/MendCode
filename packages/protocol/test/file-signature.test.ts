import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileSignature, sameFileVersion } from "../src/file-signature"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "file-signature-")); dirs.push(dir); return dir }
const TICK = 1_700_000_000

describe("fileSignature", () => {
  test("a rewrite stamped with the previous mtime still changes the signature", () => {
    const file = path.join(temp(), "a.txt")
    writeFileSync(file, "before")
    utimesSync(file, TICK, TICK)
    const before = statSync(file)
    writeFileSync(file, "after!!")
    utimesSync(file, TICK, TICK)
    const after = statSync(file)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(fileSignature(after)).not.toBe(fileSignature(before))
  })

  test("a replacement by rename with the same size and mtime changes the inode", () => {
    const dir = temp()
    const file = path.join(dir, "a.txt")
    writeFileSync(file, "same-size")
    utimesSync(file, TICK, TICK)
    const before = statSync(file)
    writeFileSync(`${file}.next`, "SAME-SIZE")
    utimesSync(`${file}.next`, TICK, TICK)
    renameSync(`${file}.next`, file)
    const after = statSync(file)
    expect(after.size).toBe(before.size)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(sameFileVersion(after, before)).toBe(false)
  })

  test("an untouched file keeps its signature", () => {
    const file = path.join(temp(), "a.txt")
    writeFileSync(file, "stable")
    expect(sameFileVersion(statSync(file), statSync(file))).toBe(true)
  })
})
