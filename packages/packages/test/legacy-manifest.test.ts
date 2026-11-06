import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { installPackage, listPackages } from "../src"
import { LEGACY_MANIFEST_FILE, MANIFEST_FILE, readManifest } from "../src/manifest"

const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mend-legacy-manifest-")); temps.push(dir); return dir }
const manifest = (name: string, description: string) => JSON.stringify({ name, version: "1.0.0", description })

test("a folder with the older manifest name still reads, installs and lists; the new name wins when both exist", async () => {
  expect(MANIFEST_FILE).toBe("mendcode-profile.json")
  const userDir = temp(), directory = temp(), source = temp()
  mkdirSync(path.join(source, "skills", "x"), { recursive: true })
  writeFileSync(path.join(source, "skills", "x", "SKILL.md"), "Do x")
  writeFileSync(path.join(source, LEGACY_MANIFEST_FILE), manifest("old-one", "from the older file"))
  const read = readManifest(source)
  expect("manifest" in read && read.manifest.description).toBe("from the older file")

  const installed = await installPackage({ spec: source, scope: "user", userDir, directory })
  expect(installed.name).toBe("old-one")
  expect(listPackages({ userDir, directory }).map((entry) => entry.name)).toContain("old-one")

  writeFileSync(path.join(source, MANIFEST_FILE), manifest("old-one", "from the current file"))
  const both = readManifest(source)
  expect("manifest" in both && both.manifest.description).toBe("from the current file")
})

test("a folder with no manifest names the current file in its problem", () => {
  const read = readManifest(temp())
  expect("problem" in read && read.problem).toBe("no mendcode-profile.json")
})
