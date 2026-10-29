import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs"
import path from "node:path"
import type { LoopbackAttach } from "@mendcode/client"

/**
 * Solo mode (docs/design/memory-single-process.md): a terminal that finds no daemon runs the daemon inside its own
 * process instead of starting a second one. The host still listens on the normal socket and holds the normal lock, so a
 * second terminal, the web UI, REST, a remote or a peer attaches to it exactly as to a separate daemon; only this
 * terminal's own client skips the socket (an in-memory loopback). When the terminal closes, the process either exits
 * (nothing needs a daemon) or hands the data directory to a separate detached daemon (something does).
 */

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM" }
}

export const HOST_CLAIM_FILE = "mendd.host"

/**
 * Two terminals starting at once: exactly one creates the claim (`wx` is atomic) and becomes the host; the other sees a
 * live owner and attaches. The claim is held only while the daemon starts, and a claim whose owner died is replaced.
 */
export function claimHost(dir: string, pid = process.pid): { claimed: true; release(): void } | { claimed: false; owner: number } {
  const file = path.join(dir, HOST_CLAIM_FILE)
  mkdirSync(dir, { recursive: true })
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600)
      writeSync(fd, String(pid))
      closeSync(fd)
      let released = false
      return {
        claimed: true,
        release() {
          if (released) return
          released = true
          try { if (readFileSync(file, "utf8") === String(pid)) rmSync(file) } catch {}
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      let owner = 0
      try { owner = Number(readFileSync(file, "utf8")) } catch { continue }
      if (Number.isInteger(owner) && owner > 0 && owner !== pid && alive(owner)) return { claimed: false, owner }
      rmSync(file, { force: true })
    }
  }
  throw new Error("[SOLO]: could not claim the data directory")
}

export type SoloHost = {
  /** The in-memory end of the daemon: the terminal's own client connects through it. */
  attach: LoopbackAttach
  /** True once the daemon released the directory (`/daemon restart`, a forced shutdown, or this process handing it over). */
  readonly stopped: boolean
  /** Stops the daemon and everything it started (MCP servers, language servers, agent engines); running turns end as interrupted. */
  stop(): Promise<void>
  /** Appends to the daemon's own log (`<dir>/logs/daemon.stderr.log`): the terminal's screen is not a place for it. */
  log(level: "info" | "warn" | "error", message: string): void
}

export type HostOptions = {
  dir: string
  cwd: string
  engine?: string | undefined
  logLevel?: string | undefined
  pure?: boolean | undefined
  safeMode?: boolean | undefined
  timeoutMs?: number | undefined
  localTransport: string
  /** A daemon already listening on `dir`, or undefined. */
  live(): Promise<unknown>
}

/** Where the hosted daemon's log lines go: `<dir>/logs/daemon.stderr.log`, never the terminal. */
function daemonLog(dir: string) {
  const file = path.join(dir, "logs", "daemon.stderr.log")
  let ready = false
  return (level: "info" | "warn" | "error", message: string) => {
    try {
      if (!ready) { mkdirSync(path.dirname(file), { recursive: true }); ready = true }
      const fd = openSync(file, "a", 0o600)
      try { writeSync(fd, `${new Date().toISOString()} ${level.toUpperCase()} ${message}\n`) } finally { closeSync(fd) }
    } catch {}
  }
}

/**
 * Starts the daemon in this process. `{ host }` when it did, `{ attach: true }` when another process owns (or just
 * won) the directory and the caller should connect to its socket.
 */
export async function hostDaemon(options: HostOptions): Promise<{ host: SoloHost } | { attach: true }> {
  const deadline = Date.now() + (options.timeoutMs ?? 5_000)
  for (;;) {
    if (await options.live()) return { attach: true }
    const claim = claimHost(options.dir)
    if (claim.claimed) {
      try {
        if (await options.live()) return { attach: true }
        return { host: await startInProcess(options) }
      } catch (error) {
        // The writer lock is the final arbiter: a start that lost it attaches to the winner instead of failing.
        if (String((error as Error)?.message).includes("owned by running process")) return { attach: true }
        throw error
      } finally { claim.release() }
    }
    if (Date.now() > deadline) throw new Error(`[CLI]: daemon did not start within ${options.timeoutMs ?? 5_000} ms (dir ${options.dir})`)
    await Bun.sleep(20)
  }
}

async function startInProcess(options: HostOptions): Promise<SoloHost> {
  const { hosting } = await import("../../../packages/daemon/src/hosting")
  let stopped = false
  hosting.active = true
  hosting.argv = [process.execPath, "__daemon", "--dir", options.dir, "--cwd", options.cwd, "--local-transport", options.localTransport, ...(options.engine ? ["--engine", options.engine] : []), ...(options.logLevel ? ["--log-level", options.logLevel] : []), ...(options.pure || options.safeMode ? ["--pure"] : []), ...(options.safeMode ? ["--safe-mode"] : [])]
  const log = daemonLog(options.dir)
  hosting.log = log
  hosting.onStopped = () => { stopped = true }
  const main = await import("../../../packages/daemon/src/main")
  return {
    attach: main.daemon.attachLoopback,
    log,
    get stopped() { return stopped },
    async stop() {
      if (stopped) return
      stopped = true
      await Promise.race([main.stopDaemon(), Bun.sleep(5_000)])
    },
  }
}

/** What a daemon reports about work that a closing terminal must not drop (`daemon.status`'s `keepAlive`). */
export type SoloWork = { running: string[]; standing: string[]; others: number }

const names = (value: unknown) => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [])

/** `others` excludes this terminal's own connection. A daemon that predates `keepAlive` is judged by its counts. */
export function soloWork(status: Record<string, unknown> | undefined): SoloWork {
  if (!status) return { running: [], standing: [], others: 0 }
  const keep = status.keepAlive as { running?: unknown; standing?: unknown } | undefined
  const loops = status.loops as { active?: number; running?: number } | undefined
  const running = keep ? names(keep.running) : [...(Number(status.activeTurns ?? 0) > 0 ? ["turns"] : []), ...(Number(status.backgroundJobs ?? 0) > 0 ? ["jobs"] : [])]
  const standing = keep ? names(keep.standing) : Number(loops?.active ?? 0) + Number(loops?.running ?? 0) > 0 ? ["loops"] : []
  return { running, standing, others: Math.max(0, Number(status.clients ?? 1) - 1) }
}

export type LeaveInput = {
  host: Pick<SoloHost, "stop" | "stopped">
  status(): Promise<Record<string, unknown> | undefined>
  /** Drops this terminal's own connection (it must not be counted, and must not reconnect while the host stops). */
  closeClient(): void
  /** Starts the separate detached daemon that takes the directory over. */
  handOff(): Promise<unknown>
  /** Resolves when the user (or the system) asks to stop waiting. */
  interrupted: Promise<unknown>
  notify(message: string): void
  sleep(ms: number): Promise<unknown>
  pollMs?: number
  /** How long the daemon has to answer one `status` (default 2 s). */
  statusTimeoutMs?: number
  /** How long a daemon that answers no `status` is still waited for, as if busy (default 60 s). */
  unansweredMs?: number
}

export type LeaveOutcome = "exited" | "handed-off" | "interrupted"

/** Programs the model left running (a dev server, a shell tab): they never finish on their own, so they stop with the terminal instead of holding it. */
/** How often a terminal hosting its daemon in `auto` checks whether another client attached. */
export const HAND_OFF_CHECK_MS = 5_000

/**
 * `auto` hosts the daemon only while this terminal is alone with it. Once another client attaches (a second terminal, the
 * web UI, a peer) and nothing runs that would stop with the move, the daemon goes to a separate process, so a terminal that
 * is killed or crashes interrupts no other session's turn.
 */
export function handOffWanted(status: Record<string, unknown> | undefined): boolean {
  if (!status) return false
  const work = soloWork(status)
  return work.others > 0 && work.running.length === 0
}

const STOPS_WITH_TERMINAL = new Set(["background processes", "terminals"])

/**
 * The terminal has closed. Work that is running right now (a turn, a job, a verifying loop) finishes in this process:
 * it cannot move to another one mid-step, and a shell waits for its child, so the prompt returns when the work ends
 * (a closed terminal window has no prompt to hold, and the process carries on headless); programs the model left running
 * stop with the daemon instead (`STOPS_WITH_TERMINAL`). Then: nothing standing and
 * nobody else attached means the process exits and no daemon stays resident; otherwise the directory is handed to a
 * detached daemon, which restarts loops, workflows, channels and the schedule from their durable state.
 */
export async function leaveSolo(input: LeaveInput): Promise<LeaveOutcome> {
  // The daemon already stopped (a restart request): nothing is left to keep or to ask.
  if (input.host.stopped) {
    input.closeClient()
    return "exited"
  }
  /** Undefined when the daemon does not answer within the deadline. */
  const ask = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([input.status(), new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), input.statusTimeoutMs ?? 2_000) })]) } finally { clearTimeout(timer) }
  }
  // A daemon too busy to answer is not idle: its work is waited for like reported work, until it has not answered for `unansweredMs`.
  let unansweredSince: number | undefined
  let work = soloWork(undefined)
  const read = async () => {
    const report = await ask()
    if (report) {
      unansweredSince = undefined
      work = soloWork(report)
    } else unansweredSince ??= Date.now()
  }
  await read()
  const unanswered = () => unansweredSince !== undefined && Date.now() - unansweredSince < (input.unansweredMs ?? 60_000)
  const waited = () => work.running.filter((name) => !STOPS_WITH_TERMINAL.has(name))
  const programs = () => work.running.filter((name) => STOPS_WITH_TERMINAL.has(name))
  if (waited().length > 0 || unanswered()) {
    input.notify(`still running: ${waited().length ? waited().join(", ") : "work the daemon has not reported yet"} · this process stays until it finishes (ctrl+c stops it)`)
    const idle = (async () => {
      while (waited().length > 0 || unanswered()) {
        await input.sleep(input.pollMs ?? 500)
        await read()
      }
      return "idle" as const
    })()
    const first = await Promise.race([idle, input.interrupted.then(() => "interrupted" as const)])
    if (first === "interrupted") {
      input.closeClient()
      await input.host.stop()
      return "interrupted"
    }
  }
  input.closeClient()
  const keep = work.standing.length > 0 || work.others > 0
  await input.host.stop()
  if (programs().length > 0) input.notify(`stopped ${programs().join(" and ")}`)
  if (!keep) return "exited"
  input.notify(`daemon keeps running in the background for: ${[...work.standing, ...(work.others > 0 ? [`${work.others} other client${work.others === 1 ? "" : "s"}`] : [])].join(", ")}`)
  await input.handOff()
  return "handed-off"
}
