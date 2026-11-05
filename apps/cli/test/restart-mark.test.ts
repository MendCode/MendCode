import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { computeBuildId } from "@mendcode/build-id"
import { startDaemon } from "@mendcode/daemon"
import { createFauxEngine } from "@mendcode/engine-faux"
import { ensureDaemon } from "../src/launcher"
import { clearRestart, markRestart, RESTART_MARK, RESTART_MARK_MS, restartPending } from "../src/restart-mark"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const temp = () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-restart-mark-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
/** A live process that is not this one, standing in for the `daemon restart` command. */
const restarter = () => {
  const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" })
  cleanups.push(() => void child.kill())
  return child.pid
}

describe("the mark a daemon restart leaves while it starts the next daemon", () => {
  test("it holds only while its restart runs and is not past its time; the restart removes only its own", () => {
    const dir = temp()
    expect(restartPending(dir)).toBe(false)
    const pid = restarter()
    markRestart(dir, { pid, now: 1_000 })
    expect(readFileSync(path.join(dir, RESTART_MARK), "utf8")).toBe(`${pid} ${1_000 + RESTART_MARK_MS}\n`)
    expect(restartPending(dir, { now: 1_000 })).toBe(true)
    expect(restartPending(dir, { now: 1_000 + RESTART_MARK_MS })).toBe(false)
    expect(restartPending(dir, { now: 1_000, isAlive: () => false })).toBe(false)
    // A mark that claims a far future, or names this process, never holds a terminal back.
    writeFileSync(path.join(dir, RESTART_MARK), `${pid} ${Date.now() + 10 * RESTART_MARK_MS}\n`)
    expect(restartPending(dir)).toBe(false)
    writeFileSync(path.join(dir, RESTART_MARK), `${process.pid} ${Date.now() + 1_000}\n`)
    expect(restartPending(dir)).toBe(false)
    writeFileSync(path.join(dir, RESTART_MARK), "garbage")
    expect(restartPending(dir)).toBe(false)
    markRestart(dir, { pid })
    clearRestart(dir)
    expect(existsSync(path.join(dir, RESTART_MARK))).toBe(true)
    clearRestart(dir, pid)
    expect(existsSync(path.join(dir, RESTART_MARK))).toBe(false)
  })

  test("a terminal that lost its daemon during a restart waits for the daemon the restart starts instead of starting its own", async () => {
    const dir = temp()
    markRestart(dir, { pid: restarter() })
    const waiting = ensureDaemon({ dir, timeoutMs: 5_000 })
    await Bun.sleep(300)
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), defaultDirectory: dir, buildId: computeBuildId(), engine: ({ clock }) => createFauxEngine({ clock }) })
    cleanups.push(() => daemon.stop())
    const found = await waiting
    expect(found).toMatchObject({ started: false, socketPath: daemon.socketPath })
  }, 20_000)
})
