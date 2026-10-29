import { describe, expect, test } from "bun:test"
import { createClient } from "@mendcode/client"
import { readLocalEndpoint } from "@mendcode/client/local-endpoint"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { daemonCommand, daemonEnvs, ensureDaemon, forgetLeanJit, isDaemonPid, leanClientEnv, ownerListening, terminateDaemon } from "../src/launcher"
import { writeFileSync } from "node:fs"
import { createServer } from "node:net"

describe("a daemon that owns the data directory but does not listen yet", () => {
  test("is waited for: the client attaches once its socket opens, instead of failing at once", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-owner-"))
    const owner = Bun.spawn(["sleep", "10"])
    const server = createServer()
    try {
      writeFileSync(path.join(dir, "mendd.lock"), String(owner.pid))
      setTimeout(() => server.listen(path.join(dir, "mendd.sock")), 300)
      const started = Date.now()
      const up = await ownerListening(dir, Date.now() + 5_000)
      expect(up?.socketPath).toBe(path.join(dir, "mendd.sock"))
      expect(Date.now() - started).toBeGreaterThanOrEqual(250)
    } finally {
      server.close()
      owner.kill()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a lock without a live owner, or none at all, is not waited for", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-owner-"))
    const gone = Bun.spawn(["true"])
    await gone.exited
    try {
      const started = Date.now()
      expect(await ownerListening(dir, Date.now() + 5_000)).toBeUndefined()
      writeFileSync(path.join(dir, "mendd.lock"), String(gone.pid))
      expect(await ownerListening(dir, Date.now() + 5_000)).toBeUndefined()
      expect(Date.now() - started).toBeLessThan(1_000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("terminateDaemon signals only a real daemon pid", () => {
  test("a lock file that reads as 0, 1, -1, NaN, a fraction, this process or its parent signals nothing", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-lockpid-"))
    const sent: Array<[number, unknown]> = []
    const real = process.kill
    process.kill = ((pid: number, signal?: string | number) => { sent.push([pid, signal]); return true }) as typeof process.kill
    try {
      for (const text of ["", " ", "0", "1", "-1", "-5", "abc", "12.5", "1e999", String(process.pid), String(process.ppid)]) {
        writeFileSync(path.join(dir, "mendd.lock"), text)
        expect([text, await terminateDaemon(dir)]).toEqual([text, false])
      }
    } finally {
      process.kill = real
      rmSync(dir, { recursive: true, force: true })
    }
    expect(sent).toEqual([])
  })

  test("the pid check accepts whole numbers above 1 other than the caller and its parent", () => {
    expect([2, 4242, 4_194_304].map((pid) => isDaemonPid(pid, { self: 10, parent: 9 }))).toEqual([true, true, true])
    expect([0, 1, -1, 10, 9, 1.5, Number.NaN, Number.POSITIVE_INFINITY].map((pid) => isDaemonPid(pid, { self: 10, parent: 9 }))).toEqual([false, false, false, false, false, false, false, false])
  })
})

test("compiled launchers re-exec themselves; source launchers retain the Bun daemon entry", () => {
  expect(daemonCommand("/$bunfs/root/entry.ts", "/tmp/mendcode-next")).toEqual(["/tmp/mendcode-next", "__daemon"])
  expect(daemonCommand("B:/~BUN/root/entry.ts", "C:/bin/mendcode.exe")).toEqual(["C:/bin/mendcode.exe", "__daemon"])
  expect(daemonCommand("B:\\~BUN\\root\\entry.ts", "C:\\bin\\mendcode.exe")).toEqual(["C:\\bin\\mendcode.exe", "__daemon"])
  const source = daemonCommand(path.join(import.meta.dir, "../src/entry.ts"), "/tmp/bun")
  expect(source[0]).toBe("bun")
  expect(source[1]).toBe(path.join(import.meta.dir, "../../../packages/daemon/src/main.ts"))
})

describe("daemon environments", () => {
  test("by default the daemon starts without the top JIT tier, with a plain fallback; MENDCODE_V2_JIT=1 keeps every tier", () => {
    expect(daemonEnvs({ PATH: "/bin" })).toEqual([{ PATH: "/bin", BUN_JSC_useFTLJIT: "0", MENDCODE_V2_LEAN_JIT: "1" }, { PATH: "/bin" }])
    expect(daemonEnvs({ PATH: "/bin", MENDCODE_V2_JIT: "1" })).toEqual([{ PATH: "/bin", MENDCODE_V2_JIT: "1" }])
  })

  test("a terminal restarts lean once: without the DFG and FTL tiers, or only without FTL when it hosts the daemon; the marker stops a second restart, and forgetting it restores the user's environment", () => {
    expect(leanClientEnv({ PATH: "/bin" }, false)).toEqual({ PATH: "/bin", BUN_JSC_useDFGJIT: "0", BUN_JSC_useFTLJIT: "0", BUN_JSC_thresholdForJITAfterWarmUp: "8000", BUN_JSC_thresholdForJITSoon: "2000", MENDCODE_V2_LEAN_JIT: "1" })
    expect(leanClientEnv({ PATH: "/bin" }, true)).toEqual({ PATH: "/bin", BUN_JSC_useFTLJIT: "0", MENDCODE_V2_LEAN_JIT: "1" })
    const started = leanClientEnv({ PATH: "/bin" }, false)!
    expect(leanClientEnv(started, false)).toBeUndefined()
    expect(leanClientEnv({ PATH: "/bin", MENDCODE_V2_JIT: "1" }, false)).toBeUndefined()
    expect(leanClientEnv({ PATH: "/bin", BUN_JSC_useJIT: "0" }, false)).toBeUndefined()
    forgetLeanJit(started)
    expect(started).toEqual({ PATH: "/bin" })
    expect(daemonEnvs(started)[0]).toEqual({ PATH: "/bin", BUN_JSC_useFTLJIT: "0", MENDCODE_V2_LEAN_JIT: "1" })
  })

  test("MENDCODE_V2_JIT=0 opts into the low-memory environment first, with a plain fallback", () => {
    const envs = daemonEnvs({ PATH: "/bin", MENDCODE_V2_JIT: "0" })
    expect(envs).toEqual([{ PATH: "/bin", MENDCODE_V2_JIT: "0", BUN_JSC_useJIT: "0" }, { PATH: "/bin", MENDCODE_V2_JIT: "0" }])
  })

  test("an explicit BUN_JSC_useJIT is respected as-is, even alongside MENDCODE_V2_JIT=0", () => {
    expect(daemonEnvs({ BUN_JSC_useJIT: "1" })).toEqual([{ BUN_JSC_useJIT: "1" }])
    expect(daemonEnvs({ MENDCODE_V2_JIT: "0", BUN_JSC_useJIT: "1" })).toEqual([{ MENDCODE_V2_JIT: "0", BUN_JSC_useJIT: "1" }])
  })

  test("the caller's environment object is never mutated", () => {
    const base = { A: "1" }
    daemonEnvs(base)
    leanClientEnv(base, false)
    expect(base).toEqual({ A: "1" })
    const optedIn = { A: "1", MENDCODE_V2_JIT: "0" }
    daemonEnvs(optedIn)
    expect(optedIn).toEqual({ A: "1", MENDCODE_V2_JIT: "0" })
  })
})

describe("ensureDaemon", () => {
  test("starts a real daemon in a temp dir (faux engine) and reuses it on the next call", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-launch-"))
    try {
      const first = await ensureDaemon({ dir, engine: "faux", timeoutMs: 15_000 })
      expect(first.started).toBe(true)
      expect(first.socketPath).toBe(path.join(dir, "mendd.sock"))
      expect((await ensureDaemon({ dir, engine: "faux" })).started).toBe(false)
    } finally {
      await terminateDaemon(dir)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test("starts a daemon on the loopback TCP transport (the Windows default), reuses it and a client reaches it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-launch-tcp-"))
    const previous = process.env.MENDCODE_V2_LOCAL_TRANSPORT
    process.env.MENDCODE_V2_LOCAL_TRANSPORT = "tcp"
    try {
      const first = await ensureDaemon({ dir, engine: "faux", timeoutMs: 15_000 })
      expect(first).toMatchObject({ started: true, tcp: true, socketPath: path.join(dir, "mendd.endpoint") })
      expect(existsSync(path.join(dir, "mendd.sock"))).toBe(false)
      expect(await ensureDaemon({ dir, engine: "faux" })).toMatchObject({ started: false, tcp: true })
      const client = createClient({ localTcp: () => readLocalEndpoint(dir), name: "launcher-tcp", reconnect: false })
      await client.connect()
      expect(client.daemonDirectory).toBeDefined()
      client.close()
    } finally {
      if (previous === undefined) delete process.env.MENDCODE_V2_LOCAL_TRANSPORT
      else process.env.MENDCODE_V2_LOCAL_TRANSPORT = previous
      await terminateDaemon(dir)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
