import { DAEMON_HELP } from "./help-text"
import path from "node:path"
import { sameDir } from "@mendcode/program/data-dir"
import type { CommandInput, CommandReply } from "@mendcode/client"
import type { DaemonStatusReport, DaemonLogsReport } from "@mendcode/protocol"
import { redactSecrets } from "@mendcode/protocol/wire"
import type { ServiceAction, ServiceOptions, ServiceResult } from "../../../packages/daemon/src/user-service"
import { PROGRAM_NAME } from "@mendcode/program"

export const DAEMON_USAGE = `${DAEMON_HELP}\n`

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
  /** `restart --force`: how long to wait for running commands and background work before the stop kills them (seconds). */
  grace?: number
}

/** How long `restart --force` waits for a running command, background task or agent before the stop kills it. */
export const RESTART_GRACE_S = 120

/** The sessions a restart waits on, one per line, with what runs in each. */
export function heldLines(held: ReadonlyArray<{ sessionId: string; title: string; items: string[] }>) {
  return held.map((entry) => `  ${entry.sessionId} ${JSON.stringify(entry.title)}: ${entry.items.join("; ")}`).join("\n")
}

/** Lifecycle commands run before automatic launch; observations never start a stopped daemon. */
export function parseDaemonService(argv: string[]): DaemonServiceCommand | undefined {
  const words: string[] = []
  const flags: Record<string, string | boolean> = {}
  const values = new Set(["dir", "data-dir", "cwd", "engine", "service-dir", "lines", "limit", "format", "interval-ms", "grace"])
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
  const grace = flags.grace === undefined ? undefined : Number(flags.grace)
  if (grace !== undefined && (action !== "restart" || !Number.isInteger(grace) || grace < 0 || grace > 3600)) throw new Error("--grace needs restart and 0–3600 seconds")
  return {
    action: action === "remove" ? "uninstall" : action as DaemonServiceCommand["action"], service,
    ...(scheduler ? { scheduler } : {}), ...(flags.dir || flags["data-dir"] ? { dir: String(flags["data-dir"] ?? flags.dir) } : {}),
    ...(flags.cwd ? { cwd: String(flags.cwd) } : {}), ...(flags.engine ? { engine: String(flags.engine) } : {}), ...(flags["service-dir"] ? { serviceDir: String(flags["service-dir"]) } : {}),
    json: Boolean(flags.json || flags.format === "json"), force: Boolean(flags.force), execute: Boolean(flags.execute),
    lines: number("lines", 100, 1000), limit: number("limit", 10, 100), help: Boolean(flags.help),
    ...(grace !== undefined ? { grace } : {}),
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
  /** The live process holding the data directory's writer lock: a daemon that runs even when it does not answer. */
  lockOwner?(): number | undefined
  /** On while `restart` stops the daemon and starts the next: terminals that lost theirs wait for it instead of starting one (restart-mark.ts). */
  restarting?(on: boolean): void
}

/** No daemon answered; `unanswered` is the pid of one that still holds the data directory. */
type NotAnswering = { running: false; dataDir: string; unanswered?: number }

type Working = NonNullable<DaemonStatusReport["work"]>

/** What runs, for whoever restarts: the turns' sessions, and who started each from its shell. */
export function workText(report: Pick<DaemonStatusReport, "activeTurns" | "work">) {
  const shown = (report.work ?? []).map((entry) => `${entry.sessionId} ${JSON.stringify(entry.title)}${entry.launcher ? ` started by ${entry.launcher} ${JSON.stringify(entry.launcherTitle ?? "")}` : ""}`)
  const more = report.activeTurns - shown.length
  return `${report.activeTurns} turn${report.activeTurns === 1 ? "" : "s"} running${shown.length ? `: ${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}` : ""}`
}

export function daemonStatusText(report: DaemonStatusReport | NotAnswering, service?: ServiceResult) {
  const state = report.running ? "running" : report.unanswered ? `not answering · process ${report.unanswered} holds the data directory` : "stopped"
  const lines = [`Daemon: ${state}`, `Data: ${report.dataDir}`]
  if (report.running) lines.push(`PID: ${report.pid}`, `Engine: ${report.engine}${report.buildId ? ` · ${report.buildId}` : ""}`, `Work: ${report.activeTurns} turns · ${report.backgroundJobs} jobs`, `Loops: ${report.loops.active} active · ${report.loops.running} running · ${report.loops.total} total`, `Dream: ${report.dream.configured ? report.dream.enabled ? report.dream.at : "off" : "unconfigured"}`)
  if (service) lines.push(`Service: ${service.backend} · ${service.installed ? "installed" : "not installed"} · ${service.loaded ? "loaded" : "stopped"}`, `Definition: ${service.definitionPath}`, ...(service.drift?.length ? [`Drift: ${service.drift.join(", ")}`] : []))
  return lines.join("\n") + "\n"
}

/** Ports keep host lifecycle work out of the client and make service commands testable without an OS manager. */
export function createDaemonServiceCli(deps: DaemonServiceDeps) {
  return async (command: DaemonServiceCommand): Promise<number> => {
    let peer: Peer | undefined
    const name = `daemon.${command.service ? "service." : ""}${command.action}`
    /** Set when `--force` stops a daemon with turns running: they are reported, and the next start resumes them. */
    let interrupted: (Working & { count: number }) | undefined
    const result = (data: unknown, text: string) => deps.out.write(command.json ? JSON.stringify({ schema: "mendcode-next.cli.v1", kind: "result", command: name, data: interrupted ? { ...(data as object), interrupted: { turns: interrupted.count, sessions: interrupted } } : data }) + "\n" : (interrupted ? `Interrupted ${workText({ activeTurns: interrupted.count, work: interrupted })}. They resume when the daemon starts again (resumeAfterRestart in the settings).\n` : "") + text)
    try {
      if (command.help) { deps.out.write(DAEMON_USAGE); return 0 }
      const readStatus = async (): Promise<DaemonStatusReport | NotAnswering> => {
        peer ??= await deps.connect()
        if (!peer) {
          const owner = deps.lockOwner?.()
          return { running: false as const, dataDir: deps.dir, ...(owner ? { unanswered: owner } : {}) }
        }
        const reply = await peer.send({ type: "daemon.status" })
        if (!reply.ok) throw new Error(reply.error.message)
        const report = reply.result as unknown as DaemonStatusReport
        // Followed through links: a daemon an older terminal started on `~/.mendcode-v2` serves `~/.mendcode` after the move.
        if (!sameDir(report.dataDir, deps.dir)) throw new Error("Daemon data directory mismatch")
        return report
      }
      // The socket is gone before the process is: the next start waits for the writer lock to be released, or it would find a daemon that "does not answer".
      const stopped = async () => {
        await deps.waitStopped()
        const deadline = deps.now() + 5000
        while (deps.lockOwner?.() && deps.now() < deadline) await deps.sleep(20)
      }
      const busy = async () => {
        const report = await readStatus()
        if (!report.running || !(report.activeTurns || report.backgroundJobs || report.loops.running)) return
        if (!command.force) throw new Error(`Daemon is busy: ${report.activeTurns ? workText(report) : `${report.backgroundJobs} jobs · ${report.loops.running} loops running`}; retry with --force to interrupt work. Turns it interrupts resume when the daemon starts again`)
        if (report.activeTurns) interrupted = Object.assign([...(report.work ?? [])], { count: report.activeTurns })
        if (command.action === "restart") await drain()
      }
      let drained = false
      /** The daemon stops by itself after its wait: this command only waits for it to go and starts the next one. */
      let stopping = false
      /**
       * A forced restart first waits, up to `--grace`, for the commands, background tasks and agents that run: the daemon holds every
       * session, interrupts nothing, and then stops by itself; that stop kills only what still runs. This command must stay until
       * then: if it goes away first, the daemon lets the wait go and nothing restarts. A daemon that predates the wait refuses the
       * field and restarts as before.
       */
      const drain = async () => {
        if (drained || !peer) return
        drained = true
        const graceS = command.grace ?? RESTART_GRACE_S
        if (graceS <= 0) return
        // The daemon may stop by itself at the end of the wait: the terminals that lose it wait for this command's start (below).
        const mark = () => { if (!command.service) deps.restarting?.(true) }
        mark()
        const reply = await peer.send({ type: "daemon.shutdown", force: true, drainMs: graceS * 1000 }).catch((error: unknown) => ({ ok: false as const, error }))
        if (!reply.ok) return
        const say = (text: string) => { if (!command.json) deps.out.write(text) }
        let shown = heldLines((reply.result as { waiting?: Parameters<typeof heldLines>[0] } | undefined)?.waiting ?? [])
        if (shown) say(`Waiting up to ${graceS} s for work that a restart would kill (--grace); keep this command running:\n${shown}\n`)
        let told = false
        let marked = deps.now()
        for (;;) {
          // The restart mark lasts seconds; the wait can last minutes.
          if (deps.now() - marked >= 5000) { marked = deps.now(); mark() }
          // The daemon closes this connection as it stops.
          const status = await readStatus().catch(() => undefined)
          if (!status?.running) { stopping = true; return }
          // Let go without a stop (it failed): the forced stop below restarts as before.
          if (!status.drain) return
          const now = heldLines(status.drain.waiting)
          if (status.drain.done && !told) {
            told = true
            if (now) say(`Still running after ${graceS} s; the restart stops it now:\n${now}\nEach session is told what was stopped when the daemon starts again.\n`)
            else if (shown) say("The work ended; restarting.\n")
          } else if (!status.drain.done && now !== shown && now) say(`Still waiting on:\n${now}\n`)
          shown = now
          await deps.sleep(250)
        }
      }
      // A daemon that holds the data directory but does not answer: a new one could only fail on the lock, and stop cannot reach it.
      const unanswered = (report: DaemonStatusReport | NotAnswering) => {
        if (!report.running && report.unanswered) throw new Error(`Daemon process ${report.unanswered} holds ${deps.dir} but does not answer; stop it (kill ${report.unanswered}) and retry`)
      }
      const started = async () => {
        const before = await readStatus()
        if (before.running) return
        unanswered(before)
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
            if (!stopping) {
              const reply = await peer.send({ type: "daemon.shutdown", ...(command.force ? { force: true } : {}) })
              if (!reply.ok) throw new Error(reply.error.message)
            }
            peer.close(); peer = undefined
            await stopped()
          }
          if (command.action === "restart" && service.loaded) {
            await deps.host.control("stop")
            peer?.close(); peer = undefined
            await stopped()
          }
        }
        const service = await deps.host.control(command.action === "restart" ? "start" : command.action)
        if (["start", "restart"].includes(command.action)) await started()
        if (["stop", "uninstall"].includes(command.action)) {
          peer?.close(); peer = undefined
          await stopped()
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
        await stopped()
        const report = await readStatus()
        if (report.running) throw new Error("Daemon is still running")
        unanswered(report)
        result(report, daemonStatusText(report))
      } else if (command.action === "restart") {
        // Same refusal as stop: work in progress is never interrupted without --force.
        await busy()
        // This command starts the next daemon, with the environment it was given; the terminals that lose theirs wait for it.
        deps.restarting?.(true)
        try {
          const service = await deps.host.status()
          if (service.loaded && path.resolve(service.dataDir) === path.resolve(deps.dir)) await deps.host.control("stop")
          else if (peer && !stopping) {
            const reply = await peer.send({ type: "daemon.shutdown", ...(command.force ? { force: true } : {}) })
            if (!reply.ok) throw new Error(reply.error.message)
          }
          peer?.close(); peer = undefined
          await stopped()
          await started()
        } finally { deps.restarting?.(false) }
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
