import { spawn } from "node:child_process"
import { StringDecoder } from "node:string_decoder"
import { agentProcesses, agentShellLaunch } from "./agent-origin"
import { defaultShell, killProcessTree, shellArgv, shellSpawnOptions } from "./platform-shell"
import { sandboxCommand, type SandboxPolicy } from "./sandbox"
import { binaryOutputNote } from "./util"

/** What the agent and the user see of one background command. */
export type BackgroundTaskInfo = {
  id: string
  command: string
  cwd: string
  status: "running" | "exited" | "killed"
  exitCode?: number
  startedAt: number
  endedAt?: number
  /** Why a task was killed: by the agent (`shell_kill`), the user (`/ps`), its lifetime cap, or cleanup (session deleted, daemon stopping). */
  killedBy?: "agent" | "user" | "lifetime" | "cleanup"
}

/** New output since the last read. `dropped` counts characters that scrolled out of the bounded buffer unread. */
export type BackgroundRead = { task: BackgroundTaskInfo; output: string; dropped: number }

/** A look at one task that reads nothing: `tail` is the end of its output, `unread` how many characters `read` has not delivered yet. */
export type BackgroundPeek = { task: BackgroundTaskInfo; tail: string; unread: number }

/** A session's view of the registry: it only sees and controls the tasks it started. */
export type BackgroundPort = {
  /** Status and the end of the output without moving the read position (`task_status`); undefined for an unknown id. */
  peek(id: string, tailChars: number): BackgroundPeek | undefined
  start(input: { command: string; cwd: string; shell?: string; environment?: Readonly<NodeJS.ProcessEnv>; sandbox?: SandboxPolicy; policy?: import("./shell-policy").ShellPolicy }):{ ok: true; task: BackgroundTaskInfo } | { ok: false; error: string }
  /**
   * Push-style monitor: while the task runs, output lines containing any of `match` (every line when empty) reach the
   * session as notices, batched. `stop` ends the monitor. Undefined for an unknown id; `ok: false` when the task is not running.
   */
  watch(id: string, input: { match: string[]; stop?: boolean }): { ok: true; task: BackgroundTaskInfo; watching: boolean } | { ok: false; error: string } | undefined
  /**
   * Waits up to `waitMs` for new output or the exit, with `until: "exit"` for the exit alone (output does not end the wait); undefined
   * for an unknown id. A read that returns the end of a task marks its exit as shown to the model (see `exitShown`).
   */
  read(id: string, options: { waitMs: number; signal: AbortSignal; until?: "output" | "exit" }): Promise<BackgroundRead | undefined>
  kill(id: string): BackgroundTaskInfo | undefined
  list(): BackgroundTaskInfo[]
}

export const BACKGROUND_LIMITS = {
  /** Running tasks across all sessions (P5: a small machine must stay responsive). */
  maxRunning: 8,
  /** Output kept per task; older output scrolls out. */
  maxBufferChars: 256_000,
  /** A task still running after this long is stopped and reported. */
  maxLifetimeMs: 6 * 60 * 60 * 1_000,
  /** Finished tasks kept readable (P11); the oldest are forgotten first. */
  maxFinished: 32,
  /** Matching lines are batched this long before they reach the session. */
  watchBatchMs: 2_000,
  /** Lines per monitor notice, and notices per monitor; past the cap the monitor stops itself. */
  watchBatchLines: 20,
  watchMaxNotices: 30,
} as const

const KILL_GRACE_MS = 2_000
/** How long a task's pipes may stay open after its process exited. */
const EXIT_DRAIN_MS = 1_000

type Entry = {
  sessionId: string
  info: BackgroundTaskInfo
  pid?: number
  buffer: string
  /** Characters dropped from the front of `buffer` so far; `cursor` is an absolute offset. */
  base: number
  cursor: number
  waiters: Set<() => void>
  /** A read gave the model this task's end state and everything it printed: the exit notice would say it again. */
  exitShown?: true
  watch?: { match: string[]; carry: string; pending: string[]; notices: number; timer?: ReturnType<typeof setTimeout> }
  terminate(by: NonNullable<BackgroundTaskInfo["killedBy"]>): void
}

/**
 * Background commands (dev servers, watchers, long builds) owned by the daemon, one process group each.
 * Nothing runs until the first start (P6). `onExit` fires once per task that ended on its own or hit its
 * lifetime cap, never for tasks the agent or cleanup killed; `tail` is the end of its output.
 */
export function createBackgroundTasks(options: {
  onExit?(sessionId: string, task: BackgroundTaskInfo, tail: string): void
  /** A monitored task produced matching lines (`watch`); `final` is set on the last notice of a monitor that stopped itself. */
  onWatch?(sessionId: string, task: BackgroundTaskInfo, lines: string[], final: boolean): void
  now?(): number
  limits?: Partial<Record<keyof typeof BACKGROUND_LIMITS, number>>
}) {
  const limits = { ...BACKGROUND_LIMITS, ...options.limits }
  const now = options.now ?? Date.now
  const tasks = new Map<string, Entry>()
  let counter = 0

  const running = () => [...tasks.values()].filter((entry) => entry.info.status === "running").length
  const forgetOldFinished = () => {
    const finished = [...tasks.values()].filter((entry) => entry.info.status !== "running")
    for (const entry of finished.slice(0, Math.max(0, finished.length - limits.maxFinished))) tasks.delete(entry.info.id)
  }
  const wake = (entry: Entry) => {
    for (const resolve of entry.waiters) resolve()
    entry.waiters.clear()
  }

  function flushWatch(entry: Entry) {
    const watch = entry.watch
    if (!watch) return
    if (watch.timer) clearTimeout(watch.timer)
    delete watch.timer
    if (watch.pending.length === 0) return
    const lines = watch.pending.slice(0, limits.watchBatchLines)
    const more = watch.pending.length - lines.length
    watch.pending.length = 0
    watch.notices++
    const final = watch.notices >= limits.watchMaxNotices
    if (final) delete entry.watch
    options.onWatch?.(entry.sessionId, { ...entry.info }, more > 0 ? [...lines, `… ${more} more matching lines (shell_output reads them)`] : lines, final)
  }

  function scanWatch(entry: Entry, text: string) {
    const watch = entry.watch
    if (!watch) return
    const parts = (watch.carry + text).split("\n")
    watch.carry = (parts.pop() ?? "").slice(-2_000)
    for (const raw of parts) {
      const line = raw.replace(/\r$/, "")
      if (!line.trim() || watch.pending.length >= 200 || binaryOutputNote({ text: line })) continue
      if (watch.match.length === 0 || watch.match.some((needle) => line.toLowerCase().includes(needle))) watch.pending.push(line.slice(0, 300))
    }
    if (watch.pending.length > 0 && !watch.timer) {
      watch.timer = setTimeout(() => flushWatch(entry), limits.watchBatchMs)
      watch.timer.unref?.()
    }
  }

  function watchTask(sessionId: string, id: string, input: { match: string[]; stop?: boolean }): ReturnType<BackgroundPort["watch"]> {
    const entry = tasks.get(id)
    if (!entry || entry.sessionId !== sessionId) return undefined
    if (entry.watch?.timer) clearTimeout(entry.watch.timer)
    if (input.stop) {
      delete entry.watch
      return { ok: true, task: { ...entry.info }, watching: false }
    }
    if (entry.info.status !== "running") return { ok: false, error: `${id} is not running; read what it printed with shell_output` }
    entry.watch = { match: input.match.map((needle) => needle.toLowerCase()), carry: "", pending: [], notices: entry.watch?.notices ?? 0 }
    return { ok: true, task: { ...entry.info }, watching: true }
  }

  function start(sessionId: string, input: Parameters<BackgroundPort["start"]>[0]): ReturnType<BackgroundPort["start"]> {
    if (running() >= limits.maxRunning) return { ok: false, error: `too many background tasks running (${limits.maxRunning}); stop one with shell_kill` }
    const shellFile = input.shell ?? defaultShell()
    const launch = agentShellLaunch({ shell: shellFile, policy: input.policy, environment: input.environment })
    const wrapped = sandboxCommand({ argv: shellArgv({ shell: shellFile, command: input.command, policy: launch.policy }), policy: input.sandbox })
    if (!wrapped.ok) return { ok: false, error: wrapped.error }
    const id = `bg_${(++counter).toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const [binary, ...binaryArguments] = wrapped.argv as [string, ...string[]]
    const child = spawn(binary, binaryArguments, {
      cwd: input.cwd,
      ...shellSpawnOptions({ shell: shellFile }),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...launch.environment, PAGER: "cat", GIT_PAGER: "cat", TERM: "dumb" },
    })
    const tracked = agentProcesses.agent(child.pid, sessionId)
    child.once("exit", () => tracked.exited())
    child.once("error", () => tracked.exited())
    const killGroup = (signal: NodeJS.Signals) => killProcessTree({ pid: child.pid, signal, fallback: (name) => { try { child.kill(name) } catch { /* already gone */ } } })
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const entry: Entry = {
      sessionId,
      info: { id, command: input.command, cwd: input.cwd, status: "running", startedAt: now() },
      ...(child.pid !== undefined ? { pid: child.pid } : {}),
      buffer: "",
      base: 0,
      cursor: 0,
      waiters: new Set(),
      terminate(by) {
        if (entry.info.status !== "running" || entry.info.killedBy) return
        entry.info.killedBy = by
        killGroup("SIGTERM")
        killTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS)
      },
    }
    tasks.set(id, entry)
    const lifetime = setTimeout(() => entry.terminate("lifetime"), limits.maxLifetimeMs)
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") }
    // A binary chunk can end in half a character; the decoder then opens the next, textual chunk with a replacement mark.
    let afterBinary = false
    const append = (chunk: string) => {
      const text = afterBinary ? chunk.replace(/^�+/, "") : chunk
      if (chunk) afterBinary = !!binaryOutputNote({ text: chunk })
      if (!text) return
      entry.buffer += text
      const over = entry.buffer.length - limits.maxBufferChars
      if (over > 0) {
        entry.buffer = entry.buffer.slice(over)
        entry.base += over
      }
      scanWatch(entry, text)
      wake(entry)
    }
    child.stdout?.on("data", (chunk: Buffer) => append(decoders.stdout.write(chunk)))
    child.stderr?.on("data", (chunk: Buffer) => append(decoders.stderr.write(chunk)))
    let ended = false
    const end = (code: number | null, error?: string) => {
      if (ended) return
      ended = true
      clearTimeout(lifetime)
      if (killTimer) clearTimeout(killTimer)
      // Stragglers left in the group die with the task.
      killGroup("SIGKILL")
      append(decoders.stdout.end() + decoders.stderr.end())
      if (error) append(`${entry.buffer ? "\n" : ""}${error}`)
      entry.info.status = entry.info.killedBy ? "killed" : "exited"
      entry.info.exitCode = code ?? -1
      entry.info.endedAt = now()
      // Lines still waiting go out before the exit notice; a task the agent or cleanup stopped sends nothing more.
      if (!entry.info.killedBy || entry.info.killedBy === "lifetime") flushWatch(entry)
      else if (entry.watch?.timer) clearTimeout(entry.watch.timer)
      delete entry.watch
      wake(entry)
      forgetOldFinished()
      // The tail reaches the model in the exit notice: binary output is one line there too.
      const tail = entry.buffer.slice(-2_000)
      if (!entry.info.killedBy || entry.info.killedBy === "lifetime") options.onExit?.(sessionId, { ...entry.info }, binaryOutputNote({ text: tail }) ?? tail)
    }
    child.on("error", (error) => end(-1, `cannot run command: ${error.message}`))
    // A descendant that inherited the pipes keeps them open after the command exits: the task ends a moment after the exit
    // (late output still comes in) instead of holding its slot until the lifetime limit; the sweep in `end` stops the descendant.
    child.on("exit", (code) => {
      const drain = setTimeout(() => end(code), EXIT_DRAIN_MS)
      drain.unref?.()
    })
    child.on("close", (code) => end(code))
    return { ok: true, task: { ...entry.info } }
  }

  async function read(sessionId: string, id: string, input: Parameters<BackgroundPort["read"]>[1]): Promise<BackgroundRead | undefined> {
    const entry = tasks.get(id)
    if (!entry || entry.sessionId !== sessionId) return undefined
    const ended = () => entry.info.status !== "running"
    const hasNews = () => ended() || (input.until !== "exit" && entry.cursor < entry.base + entry.buffer.length)
    const deadline = Date.now() + input.waitMs
    // Output wakes every waiter; one that waits for the exit goes back to waiting with the time it has left.
    while (!hasNews() && !input.signal.aborted && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          input.signal.removeEventListener("abort", done)
          entry.waiters.delete(done)
          resolve()
        }
        const timer = setTimeout(done, Math.max(1, deadline - Date.now()))
        input.signal.addEventListener("abort", done, { once: true })
        entry.waiters.add(done)
      })
    }
    const dropped = Math.max(0, entry.base - entry.cursor)
    const output = entry.buffer.slice(Math.max(0, entry.cursor - entry.base))
    entry.cursor = entry.base + entry.buffer.length
    // A cancelled call's result never reaches the model, so its exit is not counted as shown.
    if (ended() && !input.signal.aborted) entry.exitShown = true
    return { task: { ...entry.info }, output, dropped }
  }

  function peek(sessionId: string, id: string, tailChars: number): BackgroundPeek | undefined {
    const entry = tasks.get(id)
    if (!entry || entry.sessionId !== sessionId) return undefined
    const end = entry.base + entry.buffer.length
    return { task: { ...entry.info }, tail: tailChars > 0 ? entry.buffer.slice(-tailChars) : "", unread: end - Math.max(entry.cursor, entry.base) }
  }

  function kill(sessionId: string, id: string, by: "agent" | "user" = "agent") {
    const entry = tasks.get(id)
    if (!entry || entry.sessionId !== sessionId) return undefined
    entry.terminate(by)
    return { ...entry.info }
  }

  return {
    forSession(sessionId: string): BackgroundPort {
      return {
        start: (input) => start(sessionId, input),
        peek: (id, tailChars) => peek(sessionId, id, tailChars),
        watch: (id, input) => watchTask(sessionId, id, input),
        read: (id, input) => read(sessionId, id, input),
        kill: (id) => kill(sessionId, id),
        list: () => [...tasks.values()].filter((entry) => entry.sessionId === sessionId).map((entry) => ({ ...entry.info })),
      }
    },
    /** Every task with its owning session, running ones first; read-only (the agent view). */
    listAll(sessionId?: string): Array<BackgroundTaskInfo & { sessionId: string }> {
      const all = [...tasks.values()].filter((entry) => !sessionId || entry.sessionId === sessionId).map((entry) => ({ ...entry.info, sessionId: entry.sessionId }))
      return [...all.filter((t) => t.status === "running"), ...all.filter((t) => t.status !== "running")]
    },
    /** True once `read` gave this session's model the task's end state and its last output; false for a task still running, only partly read, or forgotten. */
    exitShown(sessionId: string, id: string): boolean {
      const entry = tasks.get(id)
      return entry?.sessionId === sessionId && entry.exitShown === true
    },
    /** The user stopped a task from the terminal (`/ps`): the model's next read says `killed (user)`; no notice wakes it. */
    stopByUser(sessionId: string, id: string): BackgroundTaskInfo | undefined {
      return kill(sessionId, id, "user")
    },
    /** Stops a session's tasks (the session was deleted); no notices. */
    killSession(sessionId: string) {
      for (const entry of tasks.values()) if (entry.sessionId === sessionId) entry.terminate("cleanup")
    },
    /** Stops every task (daemon shutdown); no notices. */
    stop() {
      for (const entry of tasks.values()) entry.terminate("cleanup")
    },
    running,
  }
}
export type BackgroundTasks = ReturnType<typeof createBackgroundTasks>
