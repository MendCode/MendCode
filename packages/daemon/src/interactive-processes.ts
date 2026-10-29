import { INTERACTIVE_LIMITS, agentProcesses, agentShellLaunch, defaultShell, sandboxCommand, shellArgv, type InteractiveInfo, type InteractivePort, type InteractiveRead, type InteractiveSignal } from "@mendcode/tools"
import { nativePtyDriver, type PtyDriver, type PtyProcess } from "./pty-native"

const SETTLE_MS = 120
const SWEEP_MS = 30_000
const KILL_GRACE_MS = 2_000
const CARRY_LIMIT = 256
/** An escape sequence cut by a chunk boundary; held back until the rest arrives. */
const INCOMPLETE_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*|\][^\u0007\u001b]*\u001b?|[()#]?)$/
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()#][0-9A-Za-z]|\u001b[@-Z\\-_=>]/g
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

/** Terminal bytes to plain text for the model: escape codes and control characters out, line endings normalized. */
export function createTerminalCleaner() {
  let carry = ""
  return {
    push(chunk: string) {
      let text = carry + chunk
      carry = ""
      const cut = INCOMPLETE_ESCAPE.exec(text)
      if (cut && text.length - cut.index <= CARRY_LIMIT) {
        carry = text.slice(cut.index)
        text = text.slice(0, cut.index)
      }
      return text.replace(ESCAPES, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(CONTROLS, "")
    },
  }
}

type Entry = {
  sessionId: string
  info: InteractiveInfo
  process: PtyProcess
  buffer: string
  /** Characters dropped from the front of `buffer` so far; `cursor` is an absolute offset. */
  base: number
  cursor: number
  /** Counts output chunks; `mark` is its value at the last write or read, so a wait means "something new since then". */
  seq: number
  mark: number
  leftover: boolean
  lastTouched: number
  waiters: Set<() => void>
  killTimer?: ReturnType<typeof setTimeout>
}

/**
 * Model-owned interactive processes (a command on a pseudo-terminal), one registry for the daemon and one port per chat
 * session. Deliberately separate from the PTY HTTP service: nothing here has a route, a ticket or a remote client, and
 * a session only ever sees the processes it started. Nothing runs, and no timer exists, until the first start.
 */
export function createInteractiveProcesses(options: { driver?: PtyDriver; now?: () => number; limits?: Partial<Record<keyof typeof INTERACTIVE_LIMITS, number>> } = {}) {
  const limits = { ...INTERACTIVE_LIMITS, ...options.limits }
  const driver = options.driver ?? nativePtyDriver()
  const now = options.now ?? Date.now
  const sessions = new Map<string, Entry>()
  let counter = 0
  let sweeper: ReturnType<typeof setInterval> | undefined

  const running = () => [...sessions.values()].filter((entry) => entry.info.status === "running")
  const wake = (entry: Entry) => {
    for (const resolve of [...entry.waiters]) resolve()
    entry.waiters.clear()
  }
  const unread = (entry: Entry) => entry.base + entry.buffer.length - Math.max(entry.cursor, entry.base)
  const view = (entry: Entry): InteractiveInfo => ({ ...entry.info })
  const owned = (sessionId: string, id: string) => {
    const entry = sessions.get(id)
    return entry && entry.sessionId === sessionId ? entry : undefined
  }
  const forgetOldFinished = () => {
    const finished = [...sessions.values()].filter((entry) => entry.info.status !== "running")
    for (const entry of finished.slice(0, Math.max(0, finished.length - limits.maxFinished))) sessions.delete(entry.info.id)
  }
  function stopSweeper() {
    if (sweeper && running().length === 0) {
      clearInterval(sweeper)
      sweeper = undefined
    }
  }
  function terminate(entry: Entry, by: NonNullable<InteractiveInfo["killedBy"]>) {
    if (entry.info.status !== "running" || entry.info.killedBy) return
    entry.info.killedBy = by
    if (by === "agent" && entry.process.signal) {
      try { entry.process.signal("SIGTERM") } catch {}
      entry.killTimer = setTimeout(() => hardKill(entry), KILL_GRACE_MS)
      return
    }
    hardKill(entry)
  }
  /** SIGKILL for the shell and the programs below it (a shell that stays as the parent leaves its child running when only it is killed), then the driver's own kill. */
  function hardKill(entry: Entry) {
    try { entry.process.signal?.("SIGKILL") } catch {}
    try { entry.process.kill() } catch {}
  }
  function sweep() {
    const time = now()
    for (const entry of running()) {
      if (time - entry.info.startedAt >= limits.maxLifetimeMs) terminate(entry, "lifetime")
      else if (time - entry.lastTouched >= limits.idleMs) terminate(entry, "idle")
    }
    stopSweeper()
  }

  function start(sessionId: string, input: Parameters<InteractivePort["start"]>[0]): ReturnType<InteractivePort["start"]> {
    const mine = running().filter((entry) => entry.sessionId === sessionId).length
    if (mine >= limits.maxPerSession) return { ok: false, error: `too many interactive sessions in this chat (${limits.maxPerSession}); stop one with kill` }
    if (running().length >= limits.maxRunning) return { ok: false, error: `too many interactive sessions running (${limits.maxRunning}); stop one with kill` }
    const id = `pty_${(++counter).toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const cols = input.cols ?? 80
    const rows = input.rows ?? 24
    const cleaner = createTerminalCleaner()
    const entry: Entry = {
      sessionId,
      info: { id, command: input.command, cwd: input.cwd, status: "running", startedAt: now(), cols, rows },
      process: undefined as unknown as PtyProcess,
      buffer: "",
      base: 0,
      cursor: 0,
      seq: 0,
      mark: 0,
      leftover: false,
      lastTouched: now(),
      waiters: new Set(),
    }
    sessions.set(id, entry)
    const append = (text: string) => {
      if (!text) return
      entry.buffer += text
      const over = entry.buffer.length - limits.maxBufferChars
      if (over > 0) {
        entry.buffer = entry.buffer.slice(over)
        entry.base += over
      }
      entry.seq++
      wake(entry)
    }
    // A program the session talks to is still the session's: marked and tracked like any command it starts (docs/permissions.md).
    const launch = agentShellLaunch({ shell: input.shell ?? defaultShell(), policy: input.policy, environment: input.environment })
    let tracked: ReturnType<typeof agentProcesses.agent> | undefined
    const wrapped = sandboxCommand({ argv: shellArgv({ shell: input.shell ?? defaultShell(), command: input.command, interactive: true, policy: launch.policy }), policy: input.sandbox, interactive: true })
    if (!wrapped.ok) {
      sessions.delete(id)
      return { ok: false, error: wrapped.error }
    }
    const [program, ...programArguments] = wrapped.argv as [string, ...string[]]
    try {
      entry.process = driver.spawn({
        command: program,
        args: programArguments,
        cwd: input.cwd,
        env: { ...launch.environment, PAGER: "cat", GIT_PAGER: "cat", TERM: "xterm-256color", MENDCODE_TERMINAL: "1" },
        cols,
        rows,
        data: (text) => append(cleaner.push(text)),
        exit: (code) => {
          tracked?.exited()
          if (entry.killTimer) clearTimeout(entry.killTimer)
          entry.info.status = entry.info.killedBy ? "killed" : "exited"
          entry.info.exitCode = code
          entry.info.endedAt = now()
          entry.seq++
          wake(entry)
          forgetOldFinished()
          stopSweeper()
        },
      })
      tracked = agentProcesses.agent(entry.process.pid, sessionId)
    } catch {
      sessions.delete(id)
      return { ok: false, error: "interactive sessions are unavailable on this system (no pseudo-terminal) or the command could not start; use shell" }
    }
    sweeper ??= (() => {
      const timer = setInterval(sweep, SWEEP_MS)
      timer.unref?.()
      return timer
    })()
    return { ok: true, session: view(entry) }
  }

  function live(sessionId: string, id: string): { entry: Entry } | { error: string } {
    const entry = owned(sessionId, id)
    if (!entry) return { error: `unknown session ${id}; start one with action start` }
    if (entry.info.status !== "running") return { error: `${id} is not running (${entry.info.status === "killed" ? "stopped" : `exited ${entry.info.exitCode ?? -1}`}); read it for what is left or start a new one` }
    entry.lastTouched = now()
    return { entry }
  }

  function write(sessionId: string, id: string, data: string): ReturnType<InteractivePort["write"]> {
    const found = live(sessionId, id)
    if ("error" in found) return { ok: false, error: found.error }
    if (data.length > limits.maxWriteChars) return { ok: false, error: `input is longer than ${limits.maxWriteChars} characters` }
    try {
      found.entry.process.write(data)
    } catch (error) {
      return { ok: false, error: `cannot write to ${id}: ${error instanceof Error ? error.message : "write failed"}` }
    }
    found.entry.mark = found.entry.seq
    return { ok: true, session: view(found.entry) }
  }

  async function read(sessionId: string, id: string, input: { waitMs: number; maxChars: number; signal: AbortSignal }): Promise<InteractiveRead | undefined> {
    const entry = owned(sessionId, id)
    if (!entry) return undefined
    entry.lastTouched = now()
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          input.signal.removeEventListener("abort", done)
          entry.waiters.delete(done)
          resolve()
        }
        const timer = setTimeout(done, ms)
        input.signal.addEventListener("abort", done, { once: true })
        entry.waiters.add(done)
      })
    const alive = () => entry.info.status === "running" && !input.signal.aborted
    const deadline = Date.now() + input.waitMs
    const hasNews = () => entry.seq > entry.mark || entry.leftover
    // Wait for something new, then until the output has been quiet for a moment (or the time is up).
    while (alive() && Date.now() < deadline && !(entry.leftover && hasNews())) {
      const remaining = deadline - Date.now()
      if (!hasNews()) {
        await sleep(remaining)
        continue
      }
      const before = entry.seq
      await sleep(Math.min(SETTLE_MS, remaining))
      if (entry.seq === before) break
    }
    const dropped = Math.max(0, entry.base - entry.cursor)
    const from = Math.max(0, entry.cursor - entry.base)
    const output = entry.buffer.slice(from, from + input.maxChars)
    entry.cursor = Math.max(entry.cursor, entry.base) + output.length
    entry.mark = entry.seq
    const remaining = unread(entry)
    entry.leftover = remaining > 0
    entry.lastTouched = now()
    return { session: view(entry), output, dropped, remaining }
  }

  function resize(sessionId: string, id: string, cols: number, rows: number): ReturnType<InteractivePort["resize"]> {
    const found = live(sessionId, id)
    if ("error" in found) return { ok: false, error: found.error }
    if (cols < limits.minSize || rows < limits.minSize || cols > limits.maxSize || rows > limits.maxSize) return { ok: false, error: `size must be ${limits.minSize}-${limits.maxSize}` }
    try {
      found.entry.process.resize(cols, rows)
    } catch {
      return { ok: false, error: `cannot resize ${id}` }
    }
    found.entry.info.cols = cols
    found.entry.info.rows = rows
    return { ok: true, session: view(found.entry) }
  }

  function signal(sessionId: string, id: string, name: InteractiveSignal): ReturnType<InteractivePort["signal"]> {
    const found = live(sessionId, id)
    if ("error" in found) return { ok: false, error: found.error }
    const { entry } = found
    try {
      // The terminal here has no foreground job to deliver a ctrl-c keypress to, so INT signals the process group; EOF is the line discipline's ctrl-d.
      if (name === "INT") {
        if (entry.process.signal) entry.process.signal("SIGINT")
        else entry.process.write("\u0003")
      } else if (name === "EOF") entry.process.write("\u0004")
      else if (name === "KILL") terminateNow(entry)
      else if (entry.process.signal) entry.process.signal(`SIG${name}` as NodeJS.Signals)
      else return { ok: false, error: `signal ${name} is not supported by this terminal driver; use kill` }
    } catch (error) {
      return { ok: false, error: `cannot signal ${id}: ${error instanceof Error ? error.message : "failed"}` }
    }
    entry.mark = entry.seq
    return { ok: true, session: view(entry) }
  }

  function terminateNow(entry: Entry) {
    if (entry.info.status !== "running") return
    entry.info.killedBy ??= "agent"
    hardKill(entry)
  }

  function kill(sessionId: string, id: string) {
    const entry = owned(sessionId, id)
    if (!entry) return undefined
    terminate(entry, "agent")
    return view(entry)
  }

  return {
    forSession(sessionId: string): InteractivePort {
      return {
        start: (input) => start(sessionId, input),
        write: (id, data) => write(sessionId, id, data),
        read: (id, input) => read(sessionId, id, input),
        resize: (id, cols, rows) => resize(sessionId, id, cols, rows),
        signal: (id, name) => signal(sessionId, id, name),
        kill: (id) => kill(sessionId, id),
        list: () => [...sessions.values()].filter((entry) => entry.sessionId === sessionId).map(view),
      }
    },
    /** Running sessions of one chat session (the daemon keeps a session with live terminals in memory). */
    running(sessionId: string) {
      return running().filter((entry) => entry.sessionId === sessionId).length
    },
    /** Running processes of every chat session: programs the model started that a closing terminal must not kill (apps/cli/src/solo.ts). */
    runningCount() {
      return running().length
    },
    /** Stops a chat session's processes (it was deleted or its project disposed). */
    killSession(sessionId: string) {
      for (const entry of sessions.values()) if (entry.sessionId === sessionId) terminate(entry, "cleanup")
    },
    /** Stops every process (daemon shutdown). */
    stop() {
      for (const entry of sessions.values()) terminate(entry, "cleanup")
      if (sweeper) clearInterval(sweeper)
      sweeper = undefined
    },
    /** One idle/lifetime pass; the interval calls it, tests call it with a fake clock. */
    sweep,
  }
}
export type InteractiveProcesses = ReturnType<typeof createInteractiveProcesses>
