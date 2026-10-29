import path from "node:path"
import type { CommandInput, CommandReply } from "@mendcode/client"
import type { DaemonStatusReport, DaemonLogsReport } from "@mendcode/protocol"
import { redactSecrets } from "@mendcode/protocol/wire"
import type { ServiceAction, ServiceOptions, ServiceResult } from "../../../packages/daemon/src/user-service"
import { PROGRAM_NAME } from "@mendcode/program"

export const DAEMON_USAGE = `usage: ${PROGRAM_NAME} daemon <start|run|status|logs|stop|restart> [--dir D] [--json]
  daemon service <plan|install|start|stop|restart|status|logs|uninstall> (macOS/Linux)
    [--service-dir D] [--cwd PROJECT] [--engine ENGINE]
  [control-plane] loops daemon [--once [--execute]] | service <action> (macOS/Linux)
  [control-plane] memory dream daemon [--once [--execute]] | service <action> (macOS/Linux)
  --lines N (1–1000)   --force (interrupt active work)
`

export type DaemonServiceCommand = {
  action: ServiceAction | "run" | "tick"
  service: boolean
  scheduler?: "loops" | "dream"
  dir?: string
  cwd?: string
  engine?: string
  serviceDir?: string
  json: boolean
  force: boolean
  execute: boolean
  lines: number
  limit: number
  help: boolean
}

/** Lifecycle commands run before automatic launch; observations never start a stopped daemon. */
export function parseDaemonService(argv: string[]): DaemonServiceCommand | undefined {
  const words: string[] = []
  const flags: Record<string, string | boolean> = {}
  const values = new Set(["dir", "data-dir", "cwd", "engine", "service-dir", "lines", "limit", "format", "interval-ms"])
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (!token.startsWith("--")) { words.push(token); continue }
    const equal = token.indexOf("=")
    const name = token.slice(2, equal < 0 ? undefined : equal)
    const inline = equal < 0 ? undefined : token.slice(equal + 1)
    flags[name!] = inline ?? (values.has(name!) ? argv[++i] ?? "" : true)
  }
  if (words[0] === "control-plane") words.shift()
  let scheduler: "loops" | "dream" | undefined
  if (["loops", "loop"].includes(words[0] ?? "") && ["daemon", "service"].includes(words[1] ?? "")) { words.shift(); scheduler = "loops" }
  else if (words[0] === "memory" && words[1] === "dream" && ["daemon", "service"].includes(words[2] ?? "")) { words.splice(0, 2); scheduler = "dream" }
  if (!["daemon", "service"].includes(words[0] ?? "") || words[0] === "service" && !scheduler) return undefined
  const service = words[0] === "service" || words[1] === "service"
  if (words[0] === "daemon" && words[1] === "service") words.shift()
  words.shift()
  const action = flags.once ? "tick" : words.shift() ?? (service ? "status" : scheduler ? "run" : "start")
  const allowed = service ? ["plan", "install", "start", "stop", "restart", "status", "logs", "uninstall", "remove"] : ["start", "run", "status", "logs", "stop", "restart", "tick"]
  if (!allowed.includes(action) || words.length) throw new Error("Invalid daemon service action")
  const booleans = ["json", "help", "force", "once", "execute", "quiet"]
  for (const [name, value] of Object.entries(flags)) {
    if (!values.has(name) && !booleans.includes(name)) throw new Error(`Unsupported daemon service flag --${name}`)
    if (values.has(name) && (typeof value !== "string" || !value || value.startsWith("--"))) throw new Error(`--${name} needs a value`)
    if (booleans.includes(name) && value !== true) throw new Error(`--${name} takes no value`)
  }
  if (flags["interval-ms"]) throw new Error("The daemon owns scheduler timers; configure loop triggers and dreamAt instead of --interval-ms")
  if (flags.format && flags.format !== "json" && flags.format !== "default") throw new Error("--format needs default|json")
  const number = (name: string, fallback: number, max: number) => {
    const value = flags[name] === undefined ? fallback : Number(flags[name])
    if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`--${name} needs 1–${max}`)
    return value
  }
  if (action === "tick" && (!scheduler || service)) throw new Error("--once needs a loops or Dream daemon alias")
  if (flags.execute && action !== "tick") throw new Error("--execute needs --once")
  return {
    action: action === "remove" ? "uninstall" : action as DaemonServiceCommand["action"], service,
    ...(scheduler ? { scheduler } : {}), ...(flags.dir || flags["data-dir"] ? { dir: String(flags["data-dir"] ?? flags.dir) } : {}),
    ...(flags.cwd ? { cwd: String(flags.cwd) } : {}), ...(flags.engine ? { engine: String(flags.engine) } : {}), ...(flags["service-dir"] ? { serviceDir: String(flags["service-dir"]) } : {}),
    json: Boolean(flags.json || flags.format === "json"), force: Boolean(flags.force), execute: Boolean(flags.execute),
    lines: number("lines", 100, 1000), limit: number("limit", 10, 100), help: Boolean(flags.help),
  }
}

type Peer = { send(command: CommandInput): Promise<CommandReply>; close(): void }
export type DaemonServiceDeps = {
  dir: string
  cwd: string
  connect(): Promise<Peer | undefined>
  launch(): Promise<void>
  foreground(): Promise<void>
  host: { control(action: ServiceAction): Promise<ServiceResult>; status(): Promise<ServiceResult>; logs(lines: number): Promise<DaemonLogsReport> }
  out: { write(text: string): unknown }
  err: { write(text: string): unknown }
  waitStopped(): Promise<void>
  sleep(ms: number): Promise<void>
  now(): number
}

export function daemonStatusText(report: DaemonStatusReport | { running: false; dataDir: string }, service?: ServiceResult) {
  const lines = [`Daemon: ${report.running ? "running" : "stopped"}`, `Data: ${report.dataDir}`]
  if (report.running) lines.push(`PID: ${report.pid}`, `Engine: ${report.engine}${report.buildId ? ` · ${report.buildId}` : ""}`, `Work: ${report.activeTurns} turns · ${report.backgroundJobs} jobs`, `Loops: ${report.loops.active} active · ${report.loops.running} running · ${report.loops.total} total`, `Dream: ${report.dream.configured ? report.dream.enabled ? report.dream.at : "off" : "unconfigured"}`)
  if (service) lines.push(`Service: ${service.backend} · ${service.installed ? "installed" : "not installed"} · ${service.loaded ? "loaded" : "stopped"}`, `Definition: ${service.definitionPath}`, ...(service.drift?.length ? [`Drift: ${service.drift.join(", ")}`] : []))
  return lines.join("\n") + "\n"
}

/** Ports keep host lifecycle work out of the client and make service commands testable without an OS manager. */
export function createDaemonServiceCli(deps: DaemonServiceDeps) {
  return async (command: DaemonServiceCommand): Promise<number> => {
    let peer: Peer | undefined
    const name = `daemon.${command.service ? "service." : ""}${command.action}`
    const result = (data: unknown, text: string) => deps.out.write(command.json ? JSON.stringify({ schema: "mendcode-next.cli.v1", kind: "result", command: name, data }) + "\n" : text)
    try {
      if (command.help) { deps.out.write(DAEMON_USAGE); return 0 }
      const readStatus = async () => {
        peer ??= await deps.connect()
        if (!peer) return { running: false as const, dataDir: deps.dir }
        const reply = await peer.send({ type: "daemon.status" })
        if (!reply.ok) throw new Error(reply.error.message)
        const report = reply.result as unknown as DaemonStatusReport
        if (path.resolve(report.dataDir) !== path.resolve(deps.dir)) throw new Error("Daemon data directory mismatch")
        return report
      }
      const busy = async () => {
        const report = await readStatus()
        if (!command.force && report.running && (report.activeTurns || report.backgroundJobs || report.loops.running)) throw new Error("Daemon is busy; retry with --force to interrupt work")
      }
      const started = async () => {
        if ((await readStatus()).running) return
        const service = await deps.host.status()
        if (service.installed && path.resolve(service.dataDir) === path.resolve(deps.dir)) await deps.host.control("start")
        else await deps.launch()
        const deadline = deps.now() + 5000
        while (deps.now() < deadline) {
          if ((await readStatus()).running) return
          await deps.sleep(20)
        }
        throw new Error("Daemon did not start within 5000 ms; inspect daemon logs")
      }
      if (command.action === "logs") {
        const logs = await deps.host.logs(command.lines)
        result(logs, logs.logs.map((log) => `${log.stream}: ${log.path}${log.truncated ? " (tail truncated)" : ""}\n${log.missing ? "No log file" : log.text || "Empty log"}`).join("\n\n") + "\n")
      } else if (command.service && command.action !== "tick" && command.action !== "run") {
        if (["stop", "restart", "uninstall"].includes(command.action)) await busy()
        // An unmanaged daemon must release the writer lock before the OS starts its replacement.
        if (["start", "restart"].includes(command.action)) {
          const service = await deps.host.status()
          if (!service.installed || service.drift?.length) throw new Error("Install a matching user service definition first")
          if (command.action === "restart" || !service.loaded) await busy()
          if (peer && !service.loaded) {
            const reply = await peer.send({ type: "daemon.shutdown", ...(command.force ? { force: true } : {}) })
            if (!reply.ok) throw new Error(reply.error.message)
            peer.close(); peer = undefined
            await deps.waitStopped()
          }
          if (command.action === "restart" && service.loaded) {
            await deps.host.control("stop")
            peer?.close(); peer = undefined
            await deps.waitStopped()
          }
        }
        const service = await deps.host.control(command.action === "restart" ? "start" : command.action)
        if (["start", "restart"].includes(command.action)) await started()
        if (["stop", "uninstall"].includes(command.action)) {
          peer?.close(); peer = undefined
          await deps.waitStopped()
        }
        const report = await readStatus()
        result({ ...service, daemon: report }, command.action === "plan" ? `Service: ${service.backend}\nDefinition: ${service.definitionPath}\nCommand: ${service.programArguments.join(" ")}\nstdout: ${service.stdoutPath}\nstderr: ${service.stderrPath}\n` : daemonStatusText(report, service))
      } else if (command.action === "status") {
        const report = await readStatus()
        result(report, daemonStatusText(report))
      } else if (command.action === "stop") {
        await busy()
        const service = await deps.host.status()
        if (service.loaded && path.resolve(service.dataDir) === path.resolve(deps.dir)) await deps.host.control("stop")
        else if (peer) {
          const reply = await peer.send({ type: "daemon.shutdown", ...(command.force ? { force: true } : {}) })
          if (!reply.ok) throw new Error(reply.error.message)
        }
        peer?.close(); peer = undefined
        await deps.waitStopped()
        const report = await readStatus()
        if (report.running) throw new Error("Daemon is still running")
        result(report, daemonStatusText(report))
      } else if (command.action === "restart") {
        // Same refusal as stop: work in progress is never interrupted without --force.
        await busy()
        const service = await deps.host.status()
        if (service.loaded && path.resolve(service.dataDir) === path.resolve(deps.dir)) await deps.host.control("stop")
        else if (peer) {
          const reply = await peer.send({ type: "daemon.shutdown", ...(command.force ? { force: true } : {}) })
          if (!reply.ok) throw new Error(reply.error.message)
        }
        peer?.close(); peer = undefined
        await deps.waitStopped()
        await started()
        const report = await readStatus()
        result(report, daemonStatusText(report))
      } else if (command.action === "run") {
        if ((await readStatus()).running) throw new Error("Daemon is already running; use daemon status")
        await deps.foreground()
      } else {
        await started()
        if (command.action === "tick") {
          const reply = await peer!.send({ type: "daemon.tick", scheduler: command.scheduler!, execute: command.execute, limit: command.limit })
          if (!reply.ok) throw new Error(reply.error.message)
          result(reply.result, JSON.stringify(reply.result, null, 2) + "\n")
        } else {
          const report = await readStatus()
          result(report, daemonStatusText(report))
        }
      }
      return 0
    } catch (error) {
      const message = redactSecrets(error instanceof Error ? error.message : String(error)).text
      if (command.json) deps.out.write(JSON.stringify({ schema: "mendcode-next.cli.v1", kind: "error", command: name, error: { code: "failed", message } }) + "\n")
      else deps.err.write(`error: ${message}\n`)
      return 1
    } finally { peer?.close() }
  }
}

export type { ServiceOptions }
