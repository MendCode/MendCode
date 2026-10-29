import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { installKillGuard, refuseSignal } from "./test-kill-guard"

const own = { self: 500, parent: 400 }

describe("which signals a test may send", () => {
  test("whole groups, init, non-numbers, the runner and its parent are refused", () => {
    const spawned = new Set([777])
    for (const pid of [0, -1, 1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, undefined, null, "12", 500, 400, -500, -400]) {
      expect([pid, typeof refuseSignal({ pid, signal: "SIGTERM", spawned, ...own })]).toEqual([pid, "string"])
    }
  })

  test("a child, and the group of a child this run spawned, are allowed; the group of a stranger is not", () => {
    const spawned = new Set([777])
    expect(refuseSignal({ pid: 777, signal: "SIGKILL", spawned, ...own })).toBeUndefined()
    expect(refuseSignal({ pid: 4242, signal: "SIGTERM", spawned, ...own })).toBeUndefined()
    expect(refuseSignal({ pid: -777, signal: "SIGKILL", spawned, ...own })).toBeUndefined()
    expect(refuseSignal({ pid: -778, signal: "SIGKILL", spawned, ...own })).toContain("not the process group of a child")
  })

  test("signal 0 only asks whether a process is alive, so it is never refused", () => {
    for (const pid of [0, -1, 1, 500, 400, Number.NaN]) expect(refuseSignal({ pid, signal: 0, spawned: new Set(), ...own })).toBeUndefined()
  })
})

describe("the installed guard", () => {
  test("process.kill throws EPERM for a group nobody here spawned, and does not signal", () => {
    const calls: unknown[][] = []
    const fake = { pid: 500, ppid: 400, kill: ((...args: unknown[]) => { calls.push(args); return true }) as unknown as typeof process.kill }
    installKillGuard({ proc: fake })
    for (const pid of [0, -1, 1, 500, 400, -12345]) expect(() => fake.kill(pid, "SIGTERM")).toThrow(/refused to signal/)
    expect(calls).toEqual([])
    expect(() => fake.kill(4242, 0)).not.toThrow()
    expect(calls).toEqual([[4242, 0]])
  })

  test("the preloaded guard is on this very process: a group kill of this process or of -1 never leaves it", () => {
    // Without bunfig.toml (a run from another directory) these calls would be real, so the guard has to be there first.
    expect((globalThis as { __mendcodeKillGuard?: boolean }).__mendcodeKillGuard).toBe(true)
    if (!(globalThis as { __mendcodeKillGuard?: boolean }).__mendcodeKillGuard) return
    expect(() => process.kill(0, "SIGTERM")).toThrow(/refused/)
    expect(() => process.kill(-1, "SIGTERM")).toThrow(/refused/)
    expect(() => process.kill(process.ppid, "SIGTERM")).toThrow(/refused/)
    expect(() => process.kill(-process.pid, "SIGTERM")).toThrow(/refused/)
  })

  test("the group of a detached child spawned here can be killed", async () => {
    const child = spawn("/bin/sh", ["-c", "sleep 30 & wait"], { detached: true, stdio: "ignore" })
    const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()))
    process.kill(-child.pid!, "SIGKILL")
    await exited
    expect(child.signalCode).toBe("SIGKILL")
  })
})
