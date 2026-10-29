import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { openImage } from "../src/open-url"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "open-image-")); dirs.push(dir); return dir }
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

test("an image opens in the system's viewer; a stored blob without an extension through a named copy; reveal shows its folder", async () => {
  const dir = temp()
  const named = path.join(dir, "lighthouse.png")
  const blob = path.join(dir, "c".repeat(64))
  writeFileSync(named, PNG)
  writeFileSync(blob, PNG)
  const runs: Array<{ program: string; args: string[] }> = []
  const run = async (program: string, args: string[]) => void runs.push({ program, args })
  await openImage({ path: named }, run)
  await openImage({ path: blob }, run)
  await openImage({ path: named, reveal: true }, run)
  const real = (file: string) => path.join(require("node:fs").realpathSync(dir), path.basename(file))
  expect(runs[0]!.args).toEqual([real(named)])
  expect(runs[1]!.args[0]).toEndWith(`${"c".repeat(64)}.png`)
  expect(readFileSync(runs[1]!.args[0]!)).toEqual(Buffer.from(PNG))
  expect(runs[2]!.args.at(-1)).toContain(process.platform === "linux" ? require("node:fs").realpathSync(dir) : real(named))
  rmSync(runs[1]!.args[0]!, { force: true })
})

test("a file that is not an image, a folder, a missing path, or a link to a text file is refused before anything runs", async () => {
  const dir = temp()
  const text = path.join(dir, "notes.png")
  writeFileSync(text, "#!/bin/sh\necho hi\n")
  const link = path.join(dir, "link.png")
  symlinkSync(text, link)
  let ran = 0
  const run = async () => void ran++
  await expect(openImage({ path: text }, run)).rejects.toThrow("not an image")
  await expect(openImage({ path: link }, run)).rejects.toThrow("not an image")
  await expect(openImage({ path: dir }, run)).rejects.toThrow()
  await expect(openImage({ path: path.join(dir, "gone.png") }, run)).rejects.toThrow("no longer there")
  expect(ran).toBe(0)
})
