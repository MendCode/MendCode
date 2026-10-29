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
  const peer = { close() {}, async send(command: CommandInput): Promise<CommandReply> {
    calls.push(command.type)
    if (command.type === "daemon.shutdown") { running = false; return { ok: true } }
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
  return { calls, report, deps, run, output: () => out, error: () => err }
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
      expect(process.stdout.toString() + process.stderr.toString()).toContain(args.includes("--socket") ? "local-only" : "daemon service")
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
