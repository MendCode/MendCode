import { spawn } from "node:child_process"
import { stat } from "node:fs/promises"
import { StringDecoder } from "node:string_decoder"
import { z } from "zod"
import { agentProcesses, agentShellLaunch, ownerCommandRefusal } from "../agent-origin"
import { blastRadiusPreview } from "../blast-radius"
import { defaultShell,killProcessTree, shellArgv, shellSpawnOptions } from "../platform-shell"
import { sandboxCommand, sandboxHint } from "../sandbox"
import { defineTool } from "../tool"
import { exitOneMeaning } from "../exit-meaning"
import { binaryNote, countBinaryChars, displayPath, errorMessage, fail, isBinaryShare, missingPathMessage, resolvePath, truncateHeadTail } from "../util"

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const KILL_GRACE_MS = 2_000
const EXIT_DRAIN_MS = 150
/** In-memory retention: beyond this the middle of the output is dropped before head/tail truncation. */
const KEEP_HEAD_CHARS = 1_000_000
const KEEP_TAIL_CHARS = 3_000_000

function titleFor(command: string): string {
  const first = (command.split("\n")[0] ?? "").trim()
  return first.length > 60 ? `${first.slice(0, 59)}…` : first || "shell"
}

export default defineTool({
  name: "shell",
  description:
    "Run a command with /bin/sh -c (Windows: PowerShell or the configured shell). stdout and stderr merged; long output keeps head and tail; a failure ends with [exit N]. Timeout 120000 ms by default, max 600000. " +
    "background: true returns a task id at once for servers, watchers and long builds (read with shell_output, stop with shell_kill); you are told when it exits; do not poll.",
  permission: "execute",
  args: z.object({
    command: z.string().min(1).describe("Command line to run"),
    timeoutMs: z.number().int().min(1).max(MAX_TIMEOUT_MS).optional().describe("Timeout in ms (ignored in background)"),
    workdir: z.string().optional().describe("Working directory (default: project root)"),
    background: z.boolean().optional().describe("Run without waiting for it to finish"),
  }),
  async execute({ command, timeoutMs, workdir, background }, context) {
    const title = titleFor(command)
    if (context.signal.aborted) return fail({ title, message: "cancelled" })
    const cwd = workdir ? resolvePath({ cwd: context.cwd, path: workdir }) : context.cwd
    try {
      if (!(await stat(cwd)).isDirectory()) {
        return fail({ title, message: `${displayPath({ cwd: context.cwd, path: cwd })} is not a directory` })
      }
    } catch (error) {
      return fail({ title, message: `workdir ${(await missingPathMessage({ cwd: context.cwd, path: cwd })) ?? `${displayPath({ cwd: context.cwd, path: cwd })}: ${errorMessage(error)}`}` })
    }

    // A session does not change the owner's configuration through this program, in any permission mode (docs/permissions.md).
    const owner = context.userInitiated === true
    const refusal = owner ? undefined : ownerCommandRefusal({ command, cwd, environment: context.environment })
    if (refusal) return fail({ title, message: refusal })
    // The checks above waited on the disk: a cancel that came meanwhile means nothing starts.
    if (context.signal.aborted) return fail({ title, message: "cancelled" })

    if (background) {
      if (!context.background) return fail({ title, message: "background tasks are not available here; run it without background" })
      const started = context.background.start({ command, cwd, ...(context.shell ? { shell: context.shell } : {}), ...(context.environment ? { environment: context.environment } : {}), ...(context.sandbox ? { sandbox: context.sandbox } : {}), ...(context.shellPolicy ? { policy: context.shellPolicy } : {}) })
      if (!started.ok) return fail({ title, message: started.error })
      return {
        output: `started ${started.task.id} in the background. When it exits you are told after your next tool result, or in a new turn if you have answered: do not poll or sleep for it. shell_output reads it now, shell_kill stops it.`,
        truncated: false,
        title: `${title} &`,
        isError: false,
        meta: { taskId: started.task.id, background: true },
      }
    }

    const limit = timeoutMs ?? DEFAULT_TIMEOUT_MS
    const started = Date.now()
    const shellFile = context.shell ?? defaultShell()
    const launch = owner ? { policy: context.shellPolicy, environment: context.environment ?? process.env } : agentShellLaunch({ shell: shellFile, policy: context.shellPolicy, environment: context.environment })
    const wrapped = sandboxCommand({ argv: shellArgv({ shell: shellFile, command, policy: launch.policy }), policy: context.sandbox })
    if (!wrapped.ok) return fail({ title, message: wrapped.error })
    const [binary, ...binaryArguments] = wrapped.argv as [string, ...string[]]

    return new Promise((resolve) => {
      const child = spawn(binary, binaryArguments, {
        cwd,
        ...shellSpawnOptions({ shell: shellFile }),
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...launch.environment, PAGER: "cat", GIT_PAGER: "cat", TERM: "dumb" },
      })
      const pid = child.pid
      const tracked = owner ? agentProcesses.user(pid) : agentProcesses.agent(pid, context.environment?.MENDCODE_SESSION_ID)
      child.once("exit", () => tracked.exited())
      child.once("error", () => tracked.exited())
      let head = ""
      let tail = ""
      let dropped = 0
      let timedOut = false
      let wasCancelled = false
      let settled = false
      let killTimer: ReturnType<typeof setTimeout> | undefined
      let drainTimer: ReturnType<typeof setTimeout> | undefined

      const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") }
      /** Counted over everything the command printed, also what the retention below drops. */
      const seen = { bytes: 0, chars: 0, binaryChars: 0, stderr: false, liveNoted: false }
      const append = (text: string) => {
        if (text === "") return
        const binaryChars = countBinaryChars(text)
        seen.chars += text.length
        seen.binaryChars += binaryChars
        // Live output is for watching progress: a binary chunk is one note, once.
        if (!isBinaryShare({ bad: binaryChars, total: text.length })) context.onOutput?.(text)
        else if (!seen.liveNoted) {
          seen.liveNoted = true
          context.onOutput?.("[binary output; not shown]\n")
        }
        if (head.length < KEEP_HEAD_CHARS) {
          const room = KEEP_HEAD_CHARS - head.length
          head += text.slice(0, room)
          text = text.slice(room)
        }
        if (text === "") return
        tail += text
        if (tail.length > KEEP_TAIL_CHARS) {
          dropped += tail.length - KEEP_TAIL_CHARS
          tail = tail.slice(tail.length - KEEP_TAIL_CHARS)
        }
      }

      const killGroup = (signal: NodeJS.Signals) => killProcessTree({ pid, signal, fallback: (name) => { try { child.kill(name) } catch { /* already gone */ } } })
      const terminate = () => {
        killGroup("SIGTERM")
        killTimer ??= setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS)
      }

      const timeout = setTimeout(() => {
        timedOut = true
        terminate()
      }, limit)
      const onAbort = () => {
        wasCancelled = true
        terminate()
      }
      context.signal.addEventListener("abort", onAbort, { once: true })
      if (context.signal.aborted) onAbort()

      const finish = (exitCode: number, spawnError?: string, exitSignal?: NodeJS.Signals | null) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (drainTimer) clearTimeout(drainTimer)
        context.signal.removeEventListener("abort", onAbort)
        // Sweep stragglers left in the group (background children of a finished command).
        if (killTimer) clearTimeout(killTimer)
        killGroup("SIGKILL")
        child.stdout?.destroy()
        child.stderr?.destroy()
        append(decoders.stdout.end())
        append(decoders.stderr.end())
        const full = dropped > 0 ? `${head}\n… output omitted …\n${tail}` : head + tail
        const capped = truncateHeadTail({ text: full, ...(context.outputLimits ? { limits: { maxBytes: 8 * 1024 * 1024, maxLines: 100000 } } : {}) })
        // Binary output (an executable, an archive, an image sent to stdout) is one line for the model, never the bytes.
        const binary = isBinaryShare({ bad: seen.binaryChars, total: seen.chars })
        let output = binary ? binaryNote(`${seen.bytes.toLocaleString("en-US")} bytes`) : capped.text
        const line = (text: string) => `${output && !output.endsWith("\n") ? "\n" : ""}${text}`
        // The status follows the exit code; the text says when exit 1 is the answer of a search or a comparison, not a crash.
        let expectedExit: string | undefined
        if (spawnError) output = spawnError
        else if (timedOut) output += `${output ? "\n" : ""}[timed out after ${limit} ms]`
        else if (wasCancelled) output += `${output ? "\n" : ""}[cancelled]`
        else if (exitCode !== 0) {
          const hint = context.sandbox ? sandboxHint({ output, policy: context.sandbox }) : undefined
          if (hint) output += `${output ? "\n" : ""}${hint}`
          if (exitCode === 1 && !seen.stderr) expectedExit = exitOneMeaning(command)
          output += line(exitSignal ? `[killed by ${exitSignal}]` : `[exit ${exitCode}${expectedExit ? `: ${expectedExit}` : ""}]`)
        }
        resolve({
          output,
          truncated: binary ? false : capped.truncated,
          title,
          isError: exitCode !== 0 || timedOut || wasCancelled,
          meta: { exitCode, timedOut, cancelled: wasCancelled, durationMs: Date.now() - started, ...(binary ? { binary: true, outputBytes: seen.bytes } : {}), ...(expectedExit ? { expectedExit } : {}) },
        })
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        seen.bytes += chunk.length
        append(decoders.stdout.write(chunk))
      })
      child.stderr?.on("data", (chunk: Buffer) => {
        seen.bytes += chunk.length
        seen.stderr = true
        append(decoders.stderr.write(chunk))
      })
      child.on("error", (error) => finish(-1, `cannot run command: ${errorMessage(error)}`))
      child.on("exit", (code, signal) => {
        // Pipes may stay open if a background process inherited them; do not wait forever.
        drainTimer = setTimeout(() => finish(code ?? -1, undefined, signal), EXIT_DRAIN_MS)
      })
      child.on("close", (code, signal) => finish(code ?? -1, undefined, signal))
    })
  },
  /** Blast radius of a risky command (`rm`, `git clean`, `git reset --hard`, `find -delete`…): read-only, shown in the approval. */
  async preview({ command, workdir }, context) {
    const cwd = workdir ? resolvePath({ cwd: context.cwd, path: workdir }) : context.cwd
    return blastRadiusPreview({ command, cwd, signal: context.signal, environment: context.environment })
  },
})
