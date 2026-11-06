import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { removeBunBuildLeftovers } from "./bun-build-leftovers"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

test("old bun-build temp files go; fresh ones (a build in progress) and every other file stay", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-leftovers-"))
  dirs.push(dir)
  const now = Date.now()
  const old = path.join(dir, ".0123abcd-00000000.bun-build")
  const fresh = path.join(dir, ".4567ef01-00000000.bun-build")
  const binary = path.join(dir, "mendcode")
  const lookalike = path.join(dir, "notes.bun-build")
  for (const file of [old, fresh, binary, lookalike]) writeFileSync(file, "x")
  const longAgo = new Date(now - 60 * 60_000)
  for (const file of [old, binary, lookalike]) utimesSync(file, longAgo, longAgo)
  expect(removeBunBuildLeftovers(dir, now)).toEqual([old])
  expect(existsSync(old)).toBe(false)
  expect([fresh, binary, lookalike].every(existsSync)).toBe(true)
  expect(removeBunBuildLeftovers(path.join(dir, "missing"), now)).toEqual([])
})
