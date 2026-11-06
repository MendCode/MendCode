import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient, type CommandInput, type CommandReply } from "@mendcode/client"
import type { DaemonStatusReport } from "@mendcode/protocol"
import { createDaemonServiceCli, parseDaemonService, type DaemonServiceDeps } from "../src/daemon-service"
import { daemonServicePlan, launchUserDaemon } from "../../../packages/daemon/src/user-service"

const health: DaemonStatusReport = { running: true, pid: 42, dataDir: "/tmp/data", engine: "faux", activeTurns: 0, backgroundJobs: 0, loops: { total: 1, active: 1, running: 0 }, dream: { configured: true, enabled: false, at: null, handled: null } }
function parsed(...args: string[]) { const value = parseDaemonService(args); if (!value) throw new Error("not parsed"); return value }

function harness(initial = false, installed = false, loaded = false) {
  let running = initial, out = "", err = "", time = 0
  const calls: string[] = []
  const report = structuredClone(health)
  const plan = daemonServicePlan({ dir: "/tmp/data", cwd: "/work/repo", command: ["/bin/mendcode", "__daemon"], platform: "darwin", serviceDir: "/tmp/services" })
  const drains: Array<NonNullable<DaemonStatusReport["drain"]>> = []
  let drainReply: CommandReply | undefined
  let draining = false
  /** The daemon lets its wait go instead of stopping (the wait failed): its status has no `drain` any more. */
  let letGo = false
  const peer = { close() {}, async send(command: CommandInput): Promise<CommandReply> {
    if (command.type === "daemon.shutdown" && command.drainMs !== undefined) {
      calls.push(`drain ${command.drainMs}`)
      draining = !drainReply
      return drainReply ?? { ok: true, result: { waiting: drains[0]?.waiting ?? [], ...(drains[0]?.asking ? { asking: drains[0].asking } : {}) } }
    }
    // A daemon whose wait ended stops by itself: its connection closes.
    if (!running) return { ok: false, error: { code: "internal", message: "[CLIENT]: connection closed" } } as CommandReply
    calls.push(command.type)
    if (command.type === "daemon.shutdown") { running = false; return { ok: true } }
    if (command.type === "daemon.status" && draining && drains.length) {
      const drain = drains.length > 1 ? drains.shift()! : drains[0]!
      if (drain.done && !letGo) { running = false; draining = false }
      if (letGo && drain.done) { draining = false; return { ok: true, result: report } }
      return { ok: true, result: { ...report, drain } }
    }
    if (command.type === "daemon.tick") return { ok: true, result: { scheduler: command.scheduler, execute: command.execute, due: [], started: [] } }
    return { ok: true, result: report }
  } }
  const deps: DaemonServiceDeps = {
    dir: health.dataDir, cwd: "/work/repo", now: () => time, sleep: async (ms) => { time += ms },
    out: { write: (text) => { out += text } }, err: { write: (text) => { err += text } },
    connect: async () => running ? peer : undefined,
    launch: async () => { calls.push("launch"); running = true }, foreground: async () => { calls.push("foreground") },
    waitStopped: async () => { calls.push("waitStopped") },
    host: {
      status: async () => ({ ...plan, installed, loaded, drift: installed ? [] : ["definition-missing"] }),
      control: async (action) => {
        calls.push(`host.${action}`)
        if (action === "install") installed = true
        if (action === "uninstall") installed = false
        if (["start", "restart"].includes(action)) { running = true; loaded = true }
        if (["stop", "uninstall"].includes(action)) { running = false; loaded = false }
        return { ...plan, installed, loaded, drift: [] }
      },
      logs: async () => ({ logs: [{ stream: "stdout", path: plan.stdoutPath, text: "ready", missing: false, truncated: false }] }),
    },
  }
  const run = (...args: string[]) => createDaemonServiceCli(deps)(parsed(...args))
  return { calls, report, deps, run, drains, refuseDrain: (reply: CommandReply) => { drainReply = reply }, letGo: () => { letGo = true }, output: () => out, error: () => err }
}

describe("daemon lifecycle CLI", () => {
  test("all v1 aliases address the shared service, with opt-in tick dispatch", () => {
    for (const prefix of [["loops"], ["loop"], ["control-plane", "loops"], ["memory", "dream"], ["control-plane", "memory", "dream"]]) {
      expect(parsed(...prefix, "service", "install").action).toBe("install")
      expect(parsed(...prefix, "daemon").action).toBe("run")
      expect(parsed(...prefix, "daemon", "--once").execute).toBe(false)
      expect(parsed(...prefix, "daemon", "--once", "--execute").execute).toBe(true)
    }
    expect(parsed("--dir=/tmp/a=b", "daemon", "status").dir).toBe("/tmp/a=b")
    expect(parseDaemonService(["run", "hello"])).toBeUndefined()
    expect(parseDaemonService(["memory", "dream", "status"])).toBeUndefined()
    for (const args of [["daemon", "stop", "--lines", "0"], ["daemon", "service", "install", "extra"], ["loops", "daemon", "--interval-ms", "500"], ["daemon", "--execute"], ["daemon", "--bogus"], ["daemon", "--dir", "--json"]]) expect(() => parsed(...args)).toThrow()
  })

  test("status/logs/help/plan do not launch and preserve the JSON envelope", async () => {
    for (const args of [["daemon", "status", "--json"], ["daemon", "logs"], ["daemon", "service", "plan"], ["daemon", "--help"]]) {
      const h = harness()
      expect(await h.run(...args)).toBe(0)
      expect(h.calls).not.toContain("launch")
      expect(h.calls).not.toContain("host.install")
      if (args.includes("--json")) expect(JSON.parse(h.output())).toMatchObject({ schema: "mendcode-next.cli.v1", kind: "result", data: { running: false } })
    }
  })

  test("start reuses the daemon; a stopped service starts via the manager", async () => {
    const running = harness(true)
    expect(await running.run("daemon", "start")).toBe(0)
    expect(running.calls).not.toContain("launch")
    const stopped = harness()
    expect(await stopped.run("daemon", "start")).toBe(0)
    expect(stopped.calls).toContain("launch")
    const service = harness(false, true)
    expect(await service.run("daemon", "start")).toBe(0)
    expect(service.calls).toContain("host.start")
    expect(service.calls).not.toContain("launch")
  })

  test("a daemon that holds the data directory but does not answer is named, never reported stopped or raced by a new one", async () => {
    const status = harness()
    status.deps.lockOwner = () => 2074
    expect(await status.run("daemon", "status")).toBe(0)
    expect(status.output()).toContain("Daemon: not answering · process 2074 holds the data directory")
    for (const action of ["start", "restart", "stop"]) {
      const h = harness()
      h.deps.lockOwner = () => 2074
      expect(await h.run("daemon", action)).toBe(1)
      expect(h.error()).toContain("Daemon process 2074 holds /tmp/data but does not answer; stop it (kill 2074) and retry")
      expect(h.calls).not.toContain("launch")
    }
    const free = harness()
    free.deps.lockOwner = () => undefined
    expect(await free.run("daemon", "status")).toBe(0)
    expect(free.output()).toContain("Daemon: stopped")
  })

  test("restart stops an idle daemon, waits for its socket and starts a new one; busy work and force follow stop", async () => {
    expect(parsed("daemon", "restart").action).toBe("restart")
    const idle = harness(true)
    expect(await idle.run("daemon", "restart")).toBe(0)
    expect(idle.calls.filter((call) => ["daemon.shutdown", "waitStopped", "launch"].includes(call))).toEqual(["daemon.shutdown", "waitStopped", "launch"])
    const stopped = harness()
    expect(await stopped.run("daemon", "restart")).toBe(0)
    expect(stopped.calls).not.toContain("daemon.shutdown")
    expect(stopped.calls).toContain("launch")
    const busy = harness(true)
    busy.report.activeTurns = 1
    expect(await busy.run("daemon", "restart")).toBe(1)
    expect(busy.error()).toContain("busy")
    expect(busy.calls).not.toContain("daemon.shutdown")
    expect(await busy.run("daemon", "restart", "--force")).toBe(0)
    expect(busy.calls).toContain("daemon.shutdown")
  })

  test("restart --force first waits for the commands and background tasks that run, says which; the daemon stops by itself and this command starts the next one", async () => {
    const h = harness(true)
    h.deps.restarting = (on) => void h.calls.push(`restarting ${on}`)
    h.report.activeTurns = 1
    h.report.backgroundJobs = 1
    const waiting = [{ sessionId: "ses_a", title: "owner-a", items: ["shell: bun run test", "background task: while sleep 5; do date; done"] }]
    h.drains.push({ waiting, until: 120_000, done: false }, { waiting: [waiting[0]!].map((entry) => ({ ...entry, items: [entry.items[1]!] })), until: 120_000, done: false }, { waiting: [], until: 120_000, done: true })
    const code = await h.run("daemon", "restart", "--force")
    expect(h.error()).toBe("")
    expect(code).toBe(0)
    // No second shutdown: the daemon stopped at the end of its wait; the terminals were held back from the wait on.
    expect(h.calls.filter((call) => call.startsWith("drain") || call.startsWith("restarting") || ["daemon.shutdown", "launch"].includes(call))).toEqual(["restarting true", "drain 120000", "restarting true", "launch", "restarting false"])
    expect(h.output()).toContain('Waiting up to 120 s for work that a restart would kill (--grace); keep this command running:\n  ses_a "owner-a": shell: bun run test; background task: while sleep 5; do date; done')
    expect(h.output()).toContain('Still waiting on:\n  ses_a "owner-a": background task: while sleep 5; do date; done')
    expect(h.output()).toContain("The work ended; restarting.")
  })

  test("a session waiting on an approval card is named as waiting for you, never as what the restart still waits on", async () => {
    const h = harness(true)
    h.report.activeTurns = 2
    const waiting = [{ sessionId: "ses_a", title: "tests", items: ["shell: bun run test"] }]
    const asking = [{ sessionId: "ses_b", title: "e2e mend-autopilot ledger", items: ["workflow_script: mend-quality"] }]
    h.drains.push({ waiting, asking, until: 120_000, done: false }, { waiting: [], asking, until: 120_000, done: true })
    expect(await h.run("daemon", "restart", "--force")).toBe(0)
    expect(h.output()).toContain('Waiting for you (an approval or a question; the restart does not wait for it, the turn resumes after it):\n  ses_b "e2e mend-autopilot ledger": workflow_script: mend-quality')
    expect(h.output()).not.toContain("Still waiting on")
    expect(h.output()).not.toMatch(/Waiting up to[^\n]*\n[^\n]*ses_b/)
    expect(h.output()).not.toMatch(/Still running after[\s\S]*ses_b/)
  })

  test("a wait the daemon let go without stopping is followed by the forced stop, so the restart still happens", async () => {
    const h = harness(true)
    h.report.activeTurns = 1
    h.letGo()
    h.drains.push({ waiting: [{ sessionId: "ses_a", title: "a", items: ["shell: sleep 9"] }], until: 120_000, done: false }, { waiting: [], until: 120_000, done: true })
    expect(await h.run("daemon", "restart", "--force")).toBe(0)
    expect(h.calls.filter((call) => call.startsWith("drain") || ["daemon.shutdown", "launch"].includes(call))).toEqual(["drain 120000", "daemon.shutdown", "launch"])
  })

  test("a restart whose grace ends with work running names what it kills; --grace 0, an idle daemon and an older daemon skip the wait", async () => {
    const late = harness(true)
    late.report.backgroundJobs = 1
    const waiting = [{ sessionId: "ses_b", title: "monitor", items: ["background task: tail -f build.log"] }]
    late.drains.push({ waiting, until: 5_000, done: false }, { waiting, until: 5_000, done: true })
    expect(await late.run("daemon", "restart", "--force", "--grace", "5")).toBe(0)
    expect(late.calls).toContain("drain 5000")
    expect(late.output()).toContain('Still running after 5 s; the restart stops it now:\n  ses_b "monitor": background task: tail -f build.log\nEach session is told what was stopped')
    expect(late.calls.filter((call) => call.startsWith("drain") || ["daemon.shutdown", "launch"].includes(call))).toEqual(["drain 5000", "launch"])

    const none = harness(true)
    none.report.activeTurns = 1
    expect(await none.run("daemon", "restart", "--force", "--grace", "0")).toBe(0)
    expect(none.calls.some((call) => call.startsWith("drain"))).toBe(false)
    expect(none.calls).toContain("daemon.shutdown")

    const idle = harness(true)
    expect(await idle.run("daemon", "restart", "--force")).toBe(0)
    expect(idle.calls.some((call) => call.startsWith("drain"))).toBe(false)

    const older = harness(true)
    older.report.activeTurns = 1
    older.refuseDrain({ ok: false, error: { code: "invalid_command", message: "unknown field drainMs" } } as CommandReply)
    expect(await older.run("daemon", "restart", "--force")).toBe(0)
    expect(older.calls.filter((call) => call.startsWith("drain") || ["daemon.shutdown", "launch"].includes(call))).toEqual(["drain 120000", "daemon.shutdown", "launch"])

    expect(() => parsed("daemon", "stop", "--grace", "5")).toThrow("--grace")
    expect(() => parsed("daemon", "restart", "--grace", "9999")).toThrow("--grace")
  })

  test("restart holds the terminals back from the stop through its own start, and lets go when it fails too; a refusal sets nothing", async () => {
    const h = harness(true)
    h.deps.restarting = (on) => void h.calls.push(`restarting ${on}`)
    expect(await h.run("daemon", "restart")).toBe(0)
    expect(h.calls.filter((call) => call.startsWith("restarting") || ["daemon.shutdown", "launch"].includes(call))).toEqual(["restarting true", "daemon.shutdown", "launch", "restarting false"])
    const failing = harness(true)
    failing.deps.restarting = (on) => void failing.calls.push(`restarting ${on}`)
    failing.deps.launch = async () => { throw new Error("no start") }
    expect(await failing.run("daemon", "restart")).toBe(1)
    expect(failing.calls.filter((call) => call.startsWith("restarting"))).toEqual(["restarting true", "restarting false"])
    const busy = harness(true)
    busy.report.activeTurns = 1
    busy.deps.restarting = (on) => void busy.calls.push(`restarting ${on}`)
    expect(await busy.run("daemon", "restart")).toBe(1)
    expect(busy.calls.filter((call) => call.startsWith("restarting"))).toEqual([])
  })

  test("a busy refusal names the turns and who started them; --force says what it interrupted and that it resumes", async () => {
    const busy = harness(true)
    busy.report.activeTurns = 2
    busy.report.work = [{ sessionId: "ses_a", title: "owner-a", launcher: "ses_l", launcherTitle: "seda" }, { sessionId: "ses_b", title: "own session" }]
    expect(await busy.run("daemon", "restart")).toBe(1)
    expect(busy.error()).toContain('Daemon is busy: 2 turns running: ses_a "owner-a" started by ses_l "seda"; ses_b "own session"; retry with --force')
    expect(busy.error()).toContain("resume when the daemon starts again")
    expect(await busy.run("daemon", "restart", "--force")).toBe(0)
    expect(busy.output()).toContain('Interrupted 2 turns running: ses_a "owner-a" started by ses_l "seda"; ses_b "own session". They resume when the daemon starts again')
    const json = harness(true)
    json.report.activeTurns = 1
    json.report.work = [{ sessionId: "ses_a", title: "owner-a" }]
    expect(await json.run("daemon", "stop", "--force", "--json")).toBe(0)
    expect(JSON.parse(json.output()).data.interrupted).toEqual({ turns: 1, sessions: [{ sessionId: "ses_a", title: "owner-a" }] })
  })

  test("busy work cannot be interrupted implicitly; force is explicit", async () => {
    for (const args of [["daemon", "stop"], ["daemon", "service", "restart"], ["daemon", "service", "uninstall"]]) {
      const h = harness(true, true, true)
      h.report.backgroundJobs = 1
      expect(await h.run(...args)).toBe(1)
      expect(h.error()).toContain("busy")
      expect(h.calls).not.toContain("daemon.shutdown")
      expect(h.calls.some((call) => call.startsWith("host."))).toBe(false)
    }
    const force = harness(true)
    force.report.activeTurns = 1
    expect(await force.run("daemon", "stop", "--force")).toBe(0)
    expect(force.calls).toContain("daemon.shutdown")
  })

  test("service start validates installation before stopping the unmanaged daemon", async () => {
    const missing = harness(true)
    expect(await missing.run("daemon", "service", "start")).toBe(1)
    expect(missing.calls).not.toContain("daemon.shutdown")
    const unmanaged = harness(true, true)
    expect(await unmanaged.run("daemon", "service", "start")).toBe(0)
    expect(unmanaged.calls.indexOf("daemon.shutdown")).toBeLessThan(unmanaged.calls.indexOf("host.start"))
    expect(unmanaged.calls.indexOf("waitStopped")).toBeLessThan(unmanaged.calls.indexOf("host.start"))
    const restart = harness(true, true, true)
    expect(await restart.run("daemon", "service", "restart")).toBe(0)
    expect(restart.calls.indexOf("host.stop")).toBeLessThan(restart.calls.indexOf("waitStopped"))
    expect(restart.calls.indexOf("waitStopped")).toBeLessThan(restart.calls.indexOf("host.start"))
  })

  test("once uses the protocol and foreground never launches a second detached process", async () => {
    const h = harness(true)
    expect(await h.run("memory", "dream", "daemon", "--once", "--execute")).toBe(0)
    expect(h.calls).toContain("daemon.tick")
    const fg = harness()
    expect(await fg.run("loops", "daemon")).toBe(0)
    expect(fg.calls).toContain("foreground")
    expect(fg.calls).not.toContain("launch")
    expect(await h.run("loops", "daemon")).toBe(1)
  })
})

test("the real CLI service help remains lazy and local-only validation precedes host I/O", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-service-cli-"))
  try {
    const entry = path.join(import.meta.dir, "../src/entry.ts")
    for (const args of [["daemon", "service", "--help"], ["daemon", "status", "--socket", path.join(dir, "forward.sock")]]) {
      const process = Bun.spawnSync(["bun", entry, "--dir", dir, ...args], { stdout: "pipe", stderr: "pipe" })
      expect(process.exitCode).toBe(args.includes("--socket") ? 64 : 0)
      expect(process.stderr.toString()).not.toContain("ENOENT")
      expect(process.stdout.toString() + process.stderr.toString()).toContain(args.includes("--socket") ? "local-only" : "service <action>")
    }
    const script = `process.argv = [process.execPath, ${JSON.stringify(entry)}, "daemon", "service", "--help"]; const stop = new Error("exit"); process.stdout.write = () => true; process.exit = () => { throw stop }; try { await import(${JSON.stringify(entry)}) } catch (e) { if (e !== stop) throw e }; const cache = Object.keys(require.cache); console.error(JSON.stringify({ zod: cache.some(k => k.includes("/zod/")), host: cache.some(k => k.endsWith("/user-service.ts")) }))`
    const probe = Bun.spawnSync(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" })
    expect(probe.exitCode).toBe(0)
    expect(JSON.parse(probe.stderr.toString())).toEqual({ zod: false, host: false })
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 15_000)

test("the CLI factory starts, reuses, reads logs and gracefully stops a real temp faux daemon", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-b68-process-"))
  const h = harness()
  const socketPath = path.join(dir, "mendd.sock")
  let pid: number | undefined, launches = 0, output = ""
  h.deps.dir = dir
  h.deps.cwd = dir
  h.deps.out = { write: (text) => { output += text } }
  h.deps.connect = async () => {
    const client = createClient({ socketPath, name: "b68-live", reconnect: false, timeoutMs: 1000 })
    try { await client.connect(); return client } catch { client.close(); return undefined }
  }
  const options = { dir, cwd: dir, command: [process.execPath, path.join(import.meta.dir, "../../../packages/daemon/src/main.ts")], engine: "faux" }
  h.deps.host.status = async () => ({ ...daemonServicePlan(options), installed: false, loaded: false, drift: ["definition-missing"] })
  h.deps.host.logs = async (lines) => (await import("../../../packages/daemon/src/daemon-logs")).daemonLogs(dir, lines)
  h.deps.launch = async () => { launches++; pid = await launchUserDaemon(options) }
  h.deps.now = Date.now
  h.deps.sleep = Bun.sleep
  h.deps.waitStopped = async () => {
    const end = Date.now() + 5000
    while (existsSync(socketPath) && Date.now() < end) await Bun.sleep(20)
  }
  try {
    expect(await h.run("daemon", "start")).toBe(0)
    expect(output).toContain("Engine: faux")
    expect(output).toContain(`Data: ${dir}`)
    expect(await h.run("daemon", "start")).toBe(0)
    expect(launches).toBe(1)
    output = ""
    expect(await h.run("daemon", "logs")).toBe(0)
    expect(output).toContain('"ready":true')
    expect(await h.run("daemon", "stop")).toBe(0)
    expect(existsSync(socketPath)).toBe(false)
  } finally {
    if (pid) { try { process.kill(pid, "SIGTERM") } catch {} }
    const end = Date.now() + 5000
    while (existsSync(path.join(dir, "mendd.lock")) && Date.now() < end) await Bun.sleep(20)
    rmSync(dir, { recursive: true, force: true })
  }
}, 20_000)
