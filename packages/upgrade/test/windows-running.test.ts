import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, copyFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import path from "node:path"
import { lockOwnerAlive } from "../../store/src/writer-lock"
import { sha256Hex } from "../src/checksum"
import { installWindowsBinary } from "../src/install"
import { nodeFs } from "../src/io"
import { tempDir } from "./helpers"

// These run only on Windows (the windows-smoke workflow): they use the operating system's own rules for a running executable
// and for process ids, which no other platform has.
const onWindows = process.platform === "win32"
const cleanups: (() => void)[] = []
const children: ReturnType<typeof Bun.spawn>[] = []
afterEach(() => {
  for (const child of children.splice(0)) child.kill()
  for (const cleanup of cleanups.splice(0)) cleanup()
})

/** A copy of this Bun runtime started from `exe`, idling until killed: a program running from the file that gets replaced. */
async function runFrom(exe: string) {
  copyFileSync(process.execPath, exe)
  const child = Bun.spawn([exe, "-e", "console.log('up'); setInterval(() => {}, 1000)"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" })
  children.push(child)
  await child.stdout.getReader().read()
  return child
}

test.skipIf(!onWindows)("a program that is running can be replaced: it is renamed to .old, which cannot be deleted until it exits", async () => {
  const temp = tempDir()
  cleanups.push(temp.cleanup)
  const exe = path.join(temp.dir, "mendcode.exe")
  const child = await runFrom(exe)
  const next = new TextEncoder().encode("the next program")
  await installWindowsBinary({ fs: nodeFs, target: exe, bytes: next, sha256: sha256Hex(next) })
  expect(readFileSync(exe, "utf8")).toBe("the next program")
  expect(existsSync(`${exe}.old`)).toBe(true)
  expect(existsSync(`${exe}.new`)).toBe(false)
  expect(child.exitCode).toBeNull()
  // The old program still holds its file: this is why the removal waits for the next start.
  expect(() => rmSync(`${exe}.old`)).toThrow()
  // A second swap while that program still runs is refused before anything moves, and says why.
  const again = new TextEncoder().encode("a third program")
  await expect(installWindowsBinary({ fs: nodeFs, target: exe, bytes: again, sha256: sha256Hex(again) })).rejects.toThrow("is still running")
  expect(readFileSync(exe, "utf8")).toBe("the next program")
  child.kill()
  await child.exited
  await installWindowsBinary({ fs: nodeFs, target: exe, bytes: again, sha256: sha256Hex(again) })
  expect(readFileSync(exe, "utf8")).toBe("a third program")
}, 60_000)

test.skipIf(!onWindows)("a lock naming a live process that started after the lock was written is stale; one that started before it is held", async () => {
  const temp = tempDir()
  cleanups.push(temp.cleanup)
  mkdirSync(temp.dir, { recursive: true })
  const child = await runFrom(path.join(temp.dir, "other.exe"))
  const lock = path.join(temp.dir, "mendd.lock")
  writeFileSync(lock, String(child.pid))
  const hourAgo = (Date.now() - 3_600_000) / 1000
  utimesSync(lock, hourAgo, hourAgo)
  expect(lockOwnerAlive(lock, child.pid)).toBe(false)
  const later = (Date.now() + 60_000) / 1000
  utimesSync(lock, later, later)
  expect(lockOwnerAlive(lock, child.pid)).toBe(true)
  child.kill()
  await child.exited
  expect(lockOwnerAlive(lock, child.pid)).toBe(false)
}, 60_000)
