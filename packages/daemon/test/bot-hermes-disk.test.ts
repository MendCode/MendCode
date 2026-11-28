import { afterEach, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { diskProfiles } from "../src/bot-hermes-disk"

const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) { try { chmodSync(join(dir, "profiles"), 0o755) } catch {} rmSync(dir, { recursive: true, force: true }) } })
const home = () => { const dir = mkdtempSync(join(tmpdir(), "hermes-disk-")); temps.push(dir); return dir }

test("a home without a profiles folder lists the root profile alone", () => {
  expect(diskProfiles(home()).map((profile) => profile.name)).toEqual(["default"])
})

test("a profiles folder that cannot be read fails the refresh instead of listing the root alone", () => {
  if (process.getuid?.() === 0) return
  const dir = home()
  mkdirSync(join(dir, "profiles", "writer"), { recursive: true })
  expect(diskProfiles(dir).map((profile) => profile.name)).toEqual(["default", "writer"])
  chmodSync(join(dir, "profiles"), 0o000)
  expect(() => diskProfiles(dir)).toThrow()
})
