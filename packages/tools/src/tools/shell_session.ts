import { stat } from "node:fs/promises"
import { z } from "zod"
import { ownerCommandRefusal } from "../agent-origin"
import { INTERACTIVE_LIMITS, type InteractiveInfo, type InteractivePort } from "../interactive"
import { defineTool } from "../tool"
import { displayPath, errorMessage, fail, resolvePath, truncateHeadTail } from "../util"

const MAX_WAIT_MS = 30_000
const ACTIONS = ["start", "write", "read", "resize", "signal", "kill", "list"] as const
type Action = (typeof ACTIONS)[number]

/** A bare interactive shell would let the model type commands that never went through the shell approval rules. */
const BARE_SHELL = /(^|[;&|\n(]\s*)(?:(?:exec|sudo|env|command|nohup)(?:\s+-[-\w=]+)*\s+)*(?:\/\S*\/)?(?:sh|bash|zsh|dash|ksh|fish|csh|tcsh)(?:\s+-[a-zA-Z]+)*\s*(?=$|[;&|\n)])/

export function isBareShell(command: string): boolean {
  return BARE_SHELL.test(command)
}

/** "pty_1 running 42s 80x24" / "pty_1 exited 0 after 3m 5s" / "pty_1 killed (idle) after 15m 0s". */
export function describeSession(session: InteractiveInfo, now = Date.now()) {
  const seconds = Math.round(((session.endedAt ?? now) - session.startedAt) / 1_000)
  const duration = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`
  if (session.status === "running") return `${session.id} running ${duration} ${session.cols}x${session.rows}`
  if (session.status === "killed") return `${session.id} killed${session.killedBy && session.killedBy !== "agent" ? ` (${session.killedBy})` : ""} after ${duration}`
  return `${session.id} exited ${session.exitCode ?? -1} after ${duration}`
}

function titleFor({ action, command, id }: { action: Action; command?: string | undefined; id?: string | undefined }) {
  const first = (command?.split("\n")[0] ?? "").trim()
  const clipped = first.length > 60 ? `${first.slice(0, 59)}…` : first
  return `${action}${id ? ` ${id}` : ""}${clipped ? ` ${clipped}` : ""}`
}

export default defineTool({
  name: "shell_session",
  description:
    "Run a command on a pseudo-terminal and keep talking to it: installers and scaffolders that ask questions, REPLs, debuggers, TUIs, ssh, anything that needs stdin or a TTY. " +
    "Actions: start (command, optional workdir, cols, rows, waitMs; returns an id and the first output), write (id, input; include \\n to press enter; waits waitMs for the reply), " +
    "read (id, waitMs, maxChars: output since the last read), resize (id, cols, rows), signal (id, INT is ctrl-c, EOF is ctrl-d, or TERM/HUP/QUIT/KILL), kill (id), list. " +
    "Output has terminal escape codes removed. Starting a command asks for the same approval as shell; the other actions only touch sessions you started. " +
    "A bare shell (bash, sh, zsh...) is refused: give each command to shell instead. Sessions stop after 15 minutes without a call, when the chat session ends, and at 2 hours. For plain commands that just run and finish, use shell.",
  permission: "execute",
  permissionFor: ({ action }) => (action === "start" ? "execute" : "read"),
  args: z.object({
    action: z.enum(ACTIONS).describe("What to do"),
    command: z.string().min(1).optional().describe("start: command line, run with /bin/sh -c on a TTY"),
    workdir: z.string().optional().describe("start: working directory (default: project root)"),
    id: z.string().min(1).optional().describe("write, read, resize, signal, kill: session id from start"),
    input: z.string().max(INTERACTIVE_LIMITS.maxWriteChars).optional().describe("write: text typed into the terminal"),
    waitMs: z.number().int().min(0).max(MAX_WAIT_MS).optional().describe("start/write/read: wait up to this long for output to arrive and settle (defaults: start 1000, write 500, read 0)"),
    maxChars: z.number().int().min(1).max(INTERACTIVE_LIMITS.maxReadChars).optional().describe(`start/write/read: most output characters returned (default ${INTERACTIVE_LIMITS.defaultReadChars}); the rest comes with the next read`),
    cols: z.number().int().min(INTERACTIVE_LIMITS.minSize).max(INTERACTIVE_LIMITS.maxSize).optional().describe("start/resize: terminal columns (default 80)"),
    rows: z.number().int().min(INTERACTIVE_LIMITS.minSize).max(INTERACTIVE_LIMITS.maxSize).optional().describe("start/resize: terminal rows (default 24)"),
    signal: z.enum(["INT", "TERM", "HUP", "QUIT", "KILL", "EOF"]).optional().describe("signal: INT is ctrl-c, EOF is ctrl-d; the others signal the process"),
  }),
  async execute(args, context) {
    const { action, command, workdir, id, input, waitMs, maxChars, cols, rows, signal } = args
    const title = titleFor({ action, command, id })
    const port: InteractivePort | undefined = context.interactive
    if (!port) return fail({ title, message: "interactive sessions are not available here; use shell" })
    if (context.signal.aborted) return fail({ title, message: "cancelled" })

    const unknown = (target: string) => fail({ title, message: `unknown session ${target}; start one with action start` })
    const needId = () => (id ? undefined : fail({ title, message: `${action} needs an id` }))
    const readNow = async (target: string, wait: number, header?: string) => {
      const read = await port.read(target, { waitMs: wait, maxChars: maxChars ?? INTERACTIVE_LIMITS.defaultReadChars, signal: context.signal })
      if (!read) return unknown(target)
      const capped = truncateHeadTail({ text: read.output, ...(context.outputLimits ? { limits: { maxBytes: 8 * 1024 * 1024, maxLines: 100000 } } : {}) })
      const lines = [
        ...(header ? [header] : []),
        describeSession(read.session),
        ...(read.dropped ? [`[${read.dropped} earlier characters scrolled out unread]`] : []),
        capped.text || "(no new output)",
        ...(read.remaining ? [`[${read.remaining} more characters waiting; read again]`] : []),
      ]
      return {
        output: lines.join("\n"),
        truncated: capped.truncated || read.remaining > 0,
        title: `${read.session.id} · ${read.session.status}`,
        isError: false,
        meta: { sessionId: read.session.id, status: read.session.status, ...(read.session.exitCode !== undefined ? { exitCode: read.session.exitCode } : {}) },
      }
    }

    if (action === "list") {
      const sessions = port.list()
      return { output: sessions.length ? sessions.map((session) => `${describeSession(session)} · ${session.command}`).join("\n") : "no interactive sessions", truncated: false, title: "interactive sessions", isError: false }
    }

    if (action === "start") {
      if (!command) return fail({ title, message: "start needs a command" })
      if (isBareShell(command)) return fail({ title, message: "a bare interactive shell is refused: its commands would skip the shell approval rules. Run each command with shell, or start the program you need to talk to (python, node, ssh, a scaffolder)" })
      const cwd = workdir ? resolvePath({ cwd: context.cwd, path: workdir }) : context.cwd
      try {
        if (!(await stat(cwd)).isDirectory()) return fail({ title, message: `${displayPath({ cwd: context.cwd, path: cwd })} is not a directory` })
      } catch (error) {
        return fail({ title, message: `workdir ${displayPath({ cwd: context.cwd, path: cwd })}: ${errorMessage(error)}` })
      }
      const refusal = ownerCommandRefusal({ command, cwd, environment: context.environment })
      if (refusal) return fail({ title, message: refusal })
      const started = port.start({ command, cwd, ...(context.shell ? { shell: context.shell } : {}), ...(context.environment ? { environment: context.environment } : {}), ...(context.sandbox ? { sandbox: context.sandbox } : {}), ...(context.shellPolicy ? { policy: context.shellPolicy } : {}), ...(cols ?{ cols } : {}), ...(rows ? { rows } : {}) })
      if (!started.ok) return fail({ title, message: started.error })
      return readNow(started.session.id, waitMs ?? 1_000, `started ${started.session.id}. Talk to it with write and read, end it with kill.`)
    }

    const missing = needId()
    if (missing) return missing
    const target = id!

    if (action === "write") {
      if (input === undefined || input === "") return fail({ title, message: "write needs input" })
      const written = port.write(target, input)
      if (!written.ok) return fail({ title, message: written.error })
      return readNow(target, waitMs ?? 500)
    }
    if (action === "read") return readNow(target, waitMs ?? 0)
    if (action === "resize") {
      if (!cols || !rows) return fail({ title, message: "resize needs cols and rows" })
      const resized = port.resize(target, cols, rows)
      if (!resized.ok) return fail({ title, message: resized.error })
      return { output: `${describeSession(resized.session)}`, truncated: false, title: `${target} resized`, isError: false, meta: { sessionId: target, cols, rows } }
    }
    if (action === "signal") {
      if (!signal) return fail({ title, message: "signal needs a signal" })
      const sent = port.signal(target, signal)
      if (!sent.ok) return fail({ title, message: sent.error })
      return readNow(target, waitMs ?? 300, `sent ${signal}`)
    }
    const killed = port.kill(target)
    if (!killed) return unknown(target)
    return { output: killed.status === "running" ? `stopping ${target}` : `${target} had already ${killed.status === "killed" ? "been stopped" : `exited ${killed.exitCode ?? -1}`}`, truncated: false, title: `kill ${target}`, isError: false, meta: { sessionId: target } }
  },
})
