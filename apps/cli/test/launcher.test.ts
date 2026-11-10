import { describe, expect, test } from "bun:test"
import { createClient } from "@mendcode/client"
import { readLocalEndpoint } from "@mendcode/client/local-endpoint"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { daemonCommand, daemonEnvs, ensureDaemon, forgetLeanJit, isDaemonPid, leanClientEnv, ownerListening, terminateDaemon } from "../src/launcher"
import { readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { askHarnessesAndStop, CLAUDE_SHELL_ENV, expectCleanChild, fakeClaude, USER_ENV } from "../../../packages/daemon/test/inherited-env-fixture"

/** A process whose command line is a daemon's (`__daemon --dir <dir>`) without being one: what the lock check reads. */
const fakeDaemon = (dir: string) => Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 30000)", "__daemon", "--dir", dir], { stdout: "ignore", stderr: "ignore" })
/** Waits until the OS shows the child's full command line (the launch is not instant). */
async function commandShown(pid: number, needle: string) {
  const { processCommand } = await import("@mendcode/program/daemon-identity")
  for (let i = 0; i < 200 && !processCommand(pid)?.includes(needle); i++) await Bun.sleep(10)
}

describe("a daemon that owns the data directory but does not listen yet", () => {
  test("is waited for: the client attaches once its socket opens, instead of failing at once", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-owner-"))
    const owner = fakeDaemon(dir)
    await commandShown(owner.pid, "__daemon")
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
    process.kill = ((pid: number, signal?: string | number) => { if (signal !== 0) sent.push([pid, signal]); return true }) as typeof process.kill
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

  test("a lock naming a live process that is not a daemon (a recycled pid) is never signalled, and says what it found", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-foreign-"))
    const stranger = Bun.spawn(["sleep", "30"])
    const sent: Array<[number, unknown]> = []
    const real = process.kill
    const said: string[] = []
    try {
      writeFileSync(path.join(dir, "mendd.lock"), String(stranger.pid))
      process.kill = ((pid: number, signal?: string | number) => { if (signal !== 0) { sent.push([pid, signal]); return true } return real(pid, 0) }) as typeof process.kill
      expect(await terminateDaemon(dir, { report: (message) => said.push(message) })).toBe(false)
      process.kill = real
      expect(sent).toEqual([])
      expect(stranger.exitCode).toBeNull()
      expect(said.join("\n")).toMatch(new RegExp(`process ${stranger.pid} is not a MendCode daemon`))
      expect(existsSync(path.join(dir, "mendd.lock"))).toBe(true)
      // The wait for an owner does not outlast such a lock either.
      const started = Date.now()
      expect(await ownerListening(dir, Date.now() + 5_000)).toBeUndefined()
      expect(Date.now() - started).toBeLessThan(1_000)
    } finally {
      process.kill = real
      stranger.kill()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a daemon of another directory is not signalled; a daemon of this one is, and the lock of a process that is gone is removed", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-ident-"))
    const other = mkdtempSync(path.join(tmpdir(), "mendd-ident-other-"))
    const elsewhere = fakeDaemon(other)
    const mine = fakeDaemon(dir)
    const gone = Bun.spawn(["true"])
    await gone.exited
    try {
      await commandShown(elsewhere.pid, "__daemon")
      await commandShown(mine.pid, "__daemon")
      const said: string[] = []
      writeFileSync(path.join(dir, "mendd.lock"), String(elsewhere.pid))
      expect(await terminateDaemon(dir, { report: (message) => said.push(message) })).toBe(false)
      expect(elsewhere.exitCode).toBeNull()
      expect(said.join("\n")).toContain(`a MendCode daemon for ${other}, not ${dir}`)

      writeFileSync(path.join(dir, "mendd.lock"), String(gone.pid))
      expect(await terminateDaemon(dir, { report: (message) => said.push(message) })).toBe(false)
      expect(existsSync(path.join(dir, "mendd.lock"))).toBe(false)

      writeFileSync(path.join(dir, "mendd.lock"), String(mine.pid))
      const lock = path.join(dir, "mendd.lock")
      setTimeout(() => rmSync(lock, { force: true }), 100)
      expect(await terminateDaemon(dir)).toBe(true)
      await mine.exited
      expect(mine.signalCode).toBe("SIGTERM")
      expect(elsewhere.exitCode).toBeNull()
    } finally {
      elsewhere.kill()
      mine.kill()
      rmSync(dir, { recursive: true, force: true })
      rmSync(other, { recursive: true, force: true })
    }
  })

  test("the process table is injectable: a daemon command line is told from its directory, a terminal, and an unreadable process", async () => {
    const { inspectLockOwner, daemonDirOf } = await import("@mendcode/program/daemon-identity")
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-probe-"))
    try {
      writeFileSync(path.join(dir, "mendd.lock"), "4242")
      const state = (command: string | undefined) => inspectLockOwner({ dir, probe: { alive: () => true, commandOf: () => command, self: 1, parent: 1 } }).state
      expect([
        state(`/usr/local/bin/mendcode __daemon --dir ${dir} --cwd /x`),
        state(`bun /repo/packages/daemon/src/main.ts --dir ${dir}`),
        state("/usr/local/bin/mendcode __daemon --dir /somewhere/else"),
        state("kitty --single-instance"),
        state(undefined),
      ]).toEqual(["daemon", "daemon", "foreign", "foreign", "foreign"])
      expect(daemonDirOf("mendcode __daemon --dir /a b/c --cwd /x")).toBe("/a b/c")
      expect(inspectLockOwner({ dir, probe: { alive: () => false } }).state).toBe("gone")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the pid check accepts whole numbers above 1 other than the caller and its parent", () => {
    expect([2, 4242, 4_194_304].map((pid) => isDaemonPid(pid, { self: 10, parent: 9 }))).toEqual([true, true, true])
    expect([0, 1, -1, 10, 9, 1.5, Number.NaN, Number.POSITIVE_INFINITY].map((pid) => isDaemonPid(pid, { self: 10, parent: 9 }))).toEqual([false, false, false, false, false, false, false, false])
  })
})

test("compiled launchers re-exec themselves; source launchers retain the Bun daemon entry", () => {
  expect(daemonCommand("/$bunfs/root/entry.ts", "/tmp/mendcode")).toEqual(["/tmp/mendcode", "__daemon"])
  expect(daemonCommand("B:/~BUN/root/entry.ts", "C:/bin/mendcode.exe")).toEqual(["C:/bin/mendcode.exe", "__daemon"])
  expect(daemonCommand("B:\\~BUN\\root\\entry.ts", "C:\\bin\\mendcode.exe")).toEqual(["C:\\bin\\mendcode.exe", "__daemon"])
  const source = daemonCommand(path.join(import.meta.dir, "../src/entry.ts"), "/tmp/bun")
  expect(source[0]).toBe("bun")
  expect(source[1]).toBe(path.join(import.meta.dir, "../../../packages/daemon/src/main.ts"))
})

describe("daemon environments", () => {
  test("by default the daemon starts without the top JIT tier, with a plain fallback; MENDCODE_V2_JIT=1 keeps every tier", () => {
    expect(daemonEnvs({ PATH: "/bin" })).toEqual([{ PATH: "/bin", BUN_JSC_useFTLJIT: "0", BUN_JSC_thresholdForJITAfterWarmUp: "8000", BUN_JSC_thresholdForJITSoon: "2000", MENDCODE_V2_LEAN_JIT: "1" }, { PATH: "/bin" }])
    expect(daemonEnvs({ PATH: "/bin", MENDCODE_V2_JIT: "1" })).toEqual([{ PATH: "/bin", MENDCODE_V2_JIT: "1" }])
  })

  test("a terminal restarts lean once, without the DFG and FTL tiers, whether or not it hosts the daemon; the marker stops a second restart, and forgetting it restores the user's environment", () => {
    expect(leanClientEnv({ PATH: "/bin" })).toEqual({ PATH: "/bin", BUN_JSC_useDFGJIT: "0", BUN_JSC_useFTLJIT: "0", BUN_JSC_thresholdForJITAfterWarmUp: "8000", BUN_JSC_thresholdForJITSoon: "2000", MENDCODE_V2_LEAN_JIT: "1" })
    const started = leanClientEnv({ PATH: "/bin" })!
    expect(leanClientEnv(started)).toBeUndefined()
    expect(leanClientEnv({ PATH: "/bin", MENDCODE_V2_JIT: "1" })).toBeUndefined()
    expect(leanClientEnv({ PATH: "/bin", BUN_JSC_useJIT: "0" })).toBeUndefined()
    forgetLeanJit(started)
    expect(started).toEqual({ PATH: "/bin" })
    expect(daemonEnvs(started)[0]).toEqual({ PATH: "/bin", BUN_JSC_useFTLJIT: "0", BUN_JSC_thresholdForJITAfterWarmUp: "8000", BUN_JSC_thresholdForJITSoon: "2000", MENDCODE_V2_LEAN_JIT: "1" })
  })

  test("a daemon and a terminal that hosts one compile functions late too, and both forget every option they started with", () => {
    for (const env of [daemonEnvs({ PATH: "/bin" })[0]!, leanClientEnv({ PATH: "/bin" })!]) {
      expect(env.BUN_JSC_thresholdForJITAfterWarmUp).toBe("8000")
      expect(env.BUN_JSC_thresholdForJITSoon).toBe("2000")
      forgetLeanJit(env)
      expect(env).toEqual({ PATH: "/bin" })
    }
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
    leanClientEnv(base)
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

  test.skipIf(process.platform === "win32")("from a Claude Code shell: the daemon starts without its session variables and is told their names; what it starts keeps the user's API settings", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-launch-env-"))
    const claude = fakeClaude(dir)
    const extra: Record<string, string> = { ...CLAUDE_SHELL_ENV, ...USER_ENV, ...claude.env }
    const saved = Object.fromEntries(Object.keys(extra).map((name) => [name, process.env[name]]))
    Object.assign(process.env, extra)
    try {
      let started: Awaited<ReturnType<typeof ensureDaemon>>
      try { started = await ensureDaemon({ dir, engine: "faux", timeoutMs: 15_000 }) } finally {
        for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : (process.env[name] = value)
      }
      expect(started.started).toBe(true)
      // The flag carries names only, for the daemon's log; this process keeps its own environment.
      const args = Bun.spawnSync(["ps", "-o", "args=", "-p", readFileSync(path.join(dir, "mendd.lock"), "utf8").trim()]).stdout.toString()
      expect(args).toContain("--dropped-env CLAUDECODE,")
      for (const value of ["leaked-session-id", "leaked-token"]) expect(args).not.toContain(value)
      await askHarnessesAndStop(started)
      expectCleanChild(claude)
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

describe("mendcode --restart-daemon on its own", () => {
  test("restarts the daemon and exits instead of opening the terminal; a lock naming another process signals nobody", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-restart-"))
    const home = mkdtempSync(path.join(tmpdir(), "mendd-restart-home-"))
    const entry = path.join(import.meta.dir, "../src/entry.ts")
    const env = { ...process.env, HOME: home, MENDCODE_DIR: "", MENDCODE_V2_DIR: "" }
    const cli = (...args: string[]) => Bun.spawnSync([process.execPath, entry, "--dir", dir, ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const stranger = Bun.spawn(["sleep", "30"])
    try {
      writeFileSync(path.join(dir, "mendd.lock"), String(stranger.pid))
      const refused = cli("--restart-daemon")
      expect(refused.stderr.toString()).toContain(`process ${stranger.pid} is not a MendCode daemon`)
      expect(stranger.exitCode).toBeNull()
      rmSync(path.join(dir, "mendd.lock"))
      const first = cli("--restart-daemon")
      expect([first.exitCode, first.stdout.toString()]).toEqual([0, "daemon started\n"])
      const second = cli("--restart-daemon")
      expect([second.exitCode, second.stdout.toString()]).toEqual([0, "daemon restarted\n"])
    } finally {
      cli("daemon", "stop", "--force")
      stranger.kill()
      rmSync(dir, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  }, 60_000)
})

describe("terminateDaemon asks over the protocol first", () => {
  test("the daemon answering for the directory stops without a signal; with nobody answering and no readable process table, nothing is signalled", async () => {
    const { liveDaemon } = await import("../src/launcher")
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-proto-"))
    const home = mkdtempSync(path.join(tmpdir(), "mendd-proto-home-"))
    const saved = { HOME: process.env.HOME, MENDCODE_DIR: process.env.MENDCODE_DIR, MENDCODE_V2_DIR: process.env.MENDCODE_V2_DIR }
    const stranger = Bun.spawn(["sleep", "30"])
    const real = process.kill
    const sent: Array<[number, unknown]> = []
    try {
      process.env.HOME = home
      delete process.env.MENDCODE_DIR
      delete process.env.MENDCODE_V2_DIR
      await ensureDaemon({ dir })
      const pid = Number(readFileSync(path.join(dir, "mendd.lock"), "utf8"))
      process.kill = ((target: number, signal?: string | number) => { if (signal !== 0) { sent.push([target, signal]); return true } return real(target, 0) }) as typeof process.kill
      expect(await terminateDaemon(dir)).toBe(true)
      process.kill = real
      expect(sent).toEqual([])
      expect(await liveDaemon(dir)).toBeUndefined()
      expect(existsSync(path.join(dir, "mendd.lock"))).toBe(false)
      for (let i = 0; i < 300; i++) { try { real(pid, 0) } catch { break } await Bun.sleep(10) }
      expect(() => real(pid, 0)).toThrow()

      writeFileSync(path.join(dir, "mendd.lock"), String(stranger.pid))
      const said: string[] = []
      process.kill = ((target: number, signal?: string | number) => { if (signal !== 0) { sent.push([target, signal]); return true } return real(target, 0) }) as typeof process.kill
      expect(await terminateDaemon(dir, { report: (message) => said.push(message), probe: { commandOf: () => undefined } })).toBe(false)
      process.kill = real
      expect(sent).toEqual([])
      expect(said.join("\n")).toContain("cannot be confirmed as a MendCode daemon")
    } finally {
      process.kill = real
      for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
      stranger.kill()
      rmSync(dir, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  }, 60_000)
})
