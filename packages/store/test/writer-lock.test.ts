import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { acquireWriterLock, lockOwnerAlive, writerLockOwner, type LockProbe } from "../src/writer-lock"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const WRITTEN = Date.UTC(2026, 10, 23, 8, 0, 0)
/** A lock file written at WRITTEN by the pid `owner`, and a probe in which every pid is alive and started at `startMs`. */
function setup({ platform, startMs, alive = true }: { platform: string; startMs: number | "gone" | undefined; alive?: boolean }) {
  const dir = mkdtempSync(path.join(tmpdir(), "writer-lock-"))
  dirs.push(dir)
  const file = path.join(dir, "mendd.lock")
  writeFileSync(file, "4242")
  utimesSync(file, WRITTEN / 1000, WRITTEN / 1000)
  const probe: LockProbe = { platform, alive: () => alive, startMs: () => startMs, lockMs: () => WRITTEN }
  return { file, probe }
}

test("a live owner that started before its lock was written keeps the lock", () => {
  const { file, probe } = setup({ platform: "win32", startMs: WRITTEN - 3_600_000 })
  expect(lockOwnerAlive(file, 4242, probe)).toBe(true)
  expect(() => acquireWriterLock(file, 9999, probe)).toThrow("owned by running process 4242")
  expect(writerLockOwner(file, probe)).toBe(4242)
})

test("on Windows a process that started after the lock was written reused the pid: the lock is stale and is replaced", () => {
  const { file, probe } = setup({ platform: "win32", startMs: WRITTEN + 3_600_000 })
  expect(lockOwnerAlive(file, 4242, probe)).toBe(false)
  expect(writerLockOwner(file, probe)).toBeUndefined()
  const lock = acquireWriterLock(file, 9999, probe)
  expect(readFileSync(file, "utf8")).toBe("9999")
  lock.release()
  expect(existsSync(file)).toBe(false)
})

test("on Windows a pid with no process is a stale lock, and a start time that cannot be read keeps the lock", () => {
  const gone = setup({ platform: "win32", startMs: "gone" })
  expect(lockOwnerAlive(gone.file, 4242, gone.probe)).toBe(false)
  const unreadable = setup({ platform: "win32", startMs: undefined })
  expect(lockOwnerAlive(unreadable.file, 4242, unreadable.probe)).toBe(true)
})

test("a start time within the slack of the lock's write is the same process", () => {
  const { file, probe } = setup({ platform: "win32", startMs: WRITTEN + 1_500 })
  expect(lockOwnerAlive(file, 4242, probe)).toBe(true)
})

test("off Windows the start time is never read", () => {
  const { file, probe } = setup({ platform: "linux", startMs: WRITTEN + 3_600_000 })
  let read = false
  expect(lockOwnerAlive(file, 4242, { ...probe, startMs: () => { read = true; return undefined } })).toBe(true)
  expect(read).toBe(false)
})

test("a dead pid is a stale lock on every platform", () => {
  const { file, probe } = setup({ platform: "linux", startMs: undefined, alive: false })
  expect(lockOwnerAlive(file, 4242, probe)).toBe(false)
})
