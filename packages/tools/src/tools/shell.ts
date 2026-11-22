import { spawn } from "node:child_process"
import { fstatSync } from "node:fs"
import { stat } from "node:fs/promises"
import { StringDecoder } from "node:string_decoder"
import { z } from "zod"
import { agentProcesses, agentShellLaunch, ownerCommandRefusal } from "../agent-origin"
import { blastRadiusPreview } from "../blast-radius"
import { discardFiles, followFile, open, temporary, WATCH_MS } from "../capture-output"
import { defaultShell,killProcessTree, shellArgv, shellSpawnOptions } from "../platform-shell"
import { sandboxCommand, sandboxHint } from "../sandbox"
import { defineTool } from "../tool"
import { exitOneMeaning } from "../exit-meaning"
import { binaryNote, countBinaryChars, displayPath, errorMessage, fail, isBinaryShare, missingPathMessage, resolvePath, truncateHeadTail } from "../util"

const DEFAULT_TIMEOUT_MS = 120_000
/**
 * A command still running after this long moves to the background: the model gets its output so far and control back, and can
 * work on, wait for it (shell_output until exit) or stop it (shell_kill). It still ends at its timeout.
 */
export const SHELL_YIELD_MS = 15_000
const MAX_TIMEOUT_MS = 600_000
/** How long a command that moved to the background may run (a toolchain download, a full build) before it is stopped. */
export const YIELDED_TIMEOUT_MS = 30 * 60_000
const KILL_GRACE_MS = 2_000
/**
 * A command that writes this much to one stream is stopped: a file has no backpressure the way a pipe had, so a runaway command (`yes`)
 * would fill the temporary directory until its timeout. Far above anything the model reads (head and tail are kept).
 */
const MAX_STREAM_BYTES = 256 * 1024 * 1024
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

    let limit = timeoutMs ?? DEFAULT_TIMEOUT_MS
    const started = Date.now()
    const shellFile = context.shell ?? defaultShell()
    const launch = owner ? { policy: context.shellPolicy, environment: context.environment ?? process.env } : agentShellLaunch({ shell: shellFile, policy: context.shellPolicy, environment: context.environment })
    const wrapped = sandboxCommand({ argv: shellArgv({ shell: shellFile, command, policy: launch.policy }), policy: context.sandbox })
    if (!wrapped.ok) return fail({ title, message: wrapped.error })
    const [binary, ...binaryArguments] = wrapped.argv as [string, ...string[]]

    // Output goes to two private files, not pipes: Bun keeps native buffer for every piped child that the system never takes back.
    const files = { stdout: temporary(), stderr: temporary() }
    const fds: { stdout?: number; stderr?: number } = {}
    try {
      fds.stdout = open(files.stdout)
      fds.stderr = open(files.stderr)
    } catch (error) {
      discardFiles({ fds: [fds.stdout, fds.stderr], files: [files.stdout, files.stderr] })
      return fail({ title, message: `cannot run command: ${errorMessage(error)}` })
    }
    const outputFds = fds as { stdout: number; stderr: number }

    return new Promise((resolve) => {
      const child = spawn(binary, binaryArguments, {
        cwd,
        ...shellSpawnOptions({ shell: shellFile }),
        stdio: ["ignore", outputFds.stdout, outputFds.stderr],
        env: { ...launch.environment, PAGER: "cat", GIT_PAGER: "cat", TERM: "dumb" },
      })
      // The child holds its own descriptors: the names go now, so no exit path can leave a file behind (Windows removes them at the end).
      discardFiles({ fds: [], files: [files.stdout, files.stderr] })
      const pid = child.pid
      const tracked = owner ? agentProcesses.user(pid) : agentProcesses.agent(pid, context.environment?.MENDCODE_SESSION_ID)
      child.once("exit", () => tracked.exited())
      child.once("error", () => tracked.exited())
      let head = ""
      let tail = ""
      let dropped = 0
      let timedOut = false
      let wasCancelled = false
      let tooMuch = false
      let settled = false
      let killTimer: ReturnType<typeof setTimeout> | undefined
      let poll: ReturnType<typeof setInterval> | undefined
      /** Set once the command moved to the background: its output and exit go to the task from then on. */
      let adopted: { taskId: string; feed: import("../background").AdoptedFeed } | undefined

      const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") }
      /** Counted over everything the command printed, also what the retention below drops. */
      const seen = { bytes: 0, chars: 0, binaryChars: 0, stderr: false, liveNoted: false }
      const followers = { stdout: followFile({ fd: outputFds.stdout }), stderr: followFile({ fd: outputFds.stderr }) }
      const append = (text: string) => {
        if (text === "") return
        if (adopted) return adopted.feed.append(text)
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

      /** Takes the bytes each file gained since the last call; `all` keeps going until both are caught up. */
      const drain = (all: boolean) => {
        for (const name of ["stdout", "stderr"] as const) {
          for (let reads = 0; all || reads < 16; reads++) {
            let chunk: Buffer | undefined
            try { chunk = followers[name].next() } catch { break }
            if (!chunk) break
            seen.bytes += chunk.length
            if (name === "stderr") seen.stderr = true
            append(decoders[name].write(chunk))
          }
        }
      }
      const overLimit = () => {
        try { return fstatSync(outputFds.stdout).size > MAX_STREAM_BYTES || fstatSync(outputFds.stderr).size > MAX_STREAM_BYTES } catch { return false }
      }

      const killGroup = (signal: NodeJS.Signals) => killProcessTree({ pid, signal, fallback: (name) => { try { child.kill(name) } catch { /* already gone */ } } })
      const terminate = () => {
        killGroup("SIGTERM")
        killTimer ??= setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS)
      }

      const onTimeout = () => {
        timedOut = true
        terminate()
      }
      let timeout = setTimeout(onTimeout, limit)
      const onAbort = () => {
        wasCancelled = true
        // A command that moved to the background is still this turn's: a cancel stops it like any other, and no exit notice follows.
        if (adopted) context.background?.kill(adopted.taskId)
        else terminate()
      }
      context.signal.addEventListener("abort", onAbort, { once: true })
      if (context.signal.aborted) onAbort()

      /** What the command printed so far, as the model reads it. Binary output (an executable, an archive) is one line, never the bytes. */
      const printed = () => {
        const full = dropped > 0 ? `${head}\n… output omitted …\n${tail}` : head + tail
        const capped = truncateHeadTail({ text: full, ...(context.outputLimits ? { limits: { maxBytes: 8 * 1024 * 1024, maxLines: 100000 } } : {}) })
        const binary = isBinaryShare({ bad: seen.binaryChars, total: seen.chars })
        return { text: binary ? binaryNote(`${seen.bytes.toLocaleString("en-US")} bytes`) : capped.text, truncated: binary ? false : capped.truncated, binary }
      }

      // Only where the host keeps the turn open until a moved command ends (`onYield`), and only for the model's own commands.
      const yieldMs = context.shellYieldMs ?? SHELL_YIELD_MS
      const canYield = !owner && yieldMs > 0 && yieldMs < limit && !!context.background?.adopt && !!context.onYield
      const yielder = canYield ? setTimeout(() => {
        if (settled || timedOut || wasCancelled || tooMuch) return
        drain(false)
        const shown = printed()
        const taken = context.background!.adopt!({ command, cwd, startedAt: started, shown: head + tail, stop: terminate })
        if (!taken.ok) return
        settled = true
        adopted = { taskId: taken.task.id, feed: taken.feed }
        context.onYield!(taken.task.id)
        // A build or install that moved to the background gets the background ceiling, unless the model asked for a shorter bound.
        if (timeoutMs === undefined || timeoutMs >= MAX_TIMEOUT_MS) {
          clearTimeout(timeout)
          limit = YIELDED_TIMEOUT_MS
          timeout = setTimeout(onTimeout, Math.max(1, limit - (Date.now() - started)))
        }
        const seconds = Math.round((Date.now() - started) / 1_000)
        const note = `[still running after ${seconds} s: moved to the background as ${taken.task.id}. Keep working; when you need its result, shell_output with id ${taken.task.id} and until "exit" waits for it; shell_kill stops it if it is stuck. It stops at its ${limit} ms timeout. Your turn does not end before it does.]`
        resolve({
          output: `${shown.text}${shown.text ? "\n" : ""}${note}`,
          truncated: shown.truncated,
          title: `${title} &`,
          isError: false,
          meta: { taskId: taken.task.id, background: true, yielded: true, durationMs: Date.now() - started },
        })
      }, yieldMs) : undefined

      const finish = (exitCode: number, spawnError?: string, exitSignal?: NodeJS.Signals | null) => {
        if (settled && !adopted) return
        const moved = adopted
        settled = true
        adopted = undefined
        clearTimeout(timeout)
        clearTimeout(yielder)
        if (poll) clearInterval(poll)
        context.signal.removeEventListener("abort", onAbort)
        // Sweep stragglers left in the group (background children of a finished command).
        if (killTimer) clearTimeout(killTimer)
        killGroup("SIGKILL")
        if (moved) {
          // The rest of the output and the exit belong to the background task now.
          adopted = moved
          drain(true)
          append(decoders.stdout.end())
          append(decoders.stderr.end())
          adopted = undefined
          discardFiles({ fds: [outputFds.stdout, outputFds.stderr], files: [files.stdout, files.stderr] })
          const note = spawnError ?? (timedOut ? `[timed out after ${limit} ms]` : tooMuch ? `[stopped: more than ${MAX_STREAM_BYTES / 1024 ** 2} MB of output]` : exitSignal ? `[killed by ${exitSignal}]` : exitCode !== 0 ? `[exit ${exitCode}]` : undefined)
          moved.feed.end(timedOut || tooMuch ? -1 : exitCode, note)
          return
        }
        drain(true)
        discardFiles({ fds: [outputFds.stdout, outputFds.stderr], files: [files.stdout, files.stderr] })
        append(decoders.stdout.end())
        append(decoders.stderr.end())
        const shown = printed()
        const binary = shown.binary
        const capped = { truncated: shown.truncated }
        let output = shown.text
        const line = (text: string) => `${output && !output.endsWith("\n") ? "\n" : ""}${text}`
        // The status follows the exit code; the text says when exit 1 is the answer of a search or a comparison, not a crash.
        let expectedExit: string | undefined
        if (spawnError) output = spawnError
        else if (timedOut) output += `${output ? "\n" : ""}[timed out after ${limit} ms]`
        else if (tooMuch) output += `${output ? "\n" : ""}[stopped: more than ${MAX_STREAM_BYTES / 1024 ** 2} MB of output]`
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
          isError: exitCode !== 0 || timedOut || wasCancelled || tooMuch,
          meta: { exitCode, timedOut, cancelled: wasCancelled, durationMs: Date.now() - started, ...(binary ? { binary: true, outputBytes: seen.bytes } : {}), ...(expectedExit ? { expectedExit } : {}) },
        })
      }

      // A file has no backpressure and no event: its new bytes are read on a short poll while the command runs.
      poll = setInterval(() => {
        drain(false)
        if (!tooMuch && !wasCancelled && !timedOut && overLimit()) { tooMuch = true; terminate() }
      }, WATCH_MS)
      child.on("error", (error) => finish(-1, `cannot run command: ${errorMessage(error)}`))
      // Nothing is held open by a background process any more: the files are read to their end when the command exits.
      child.on("exit", (code, signal) => finish(code ?? -1, undefined, signal))
    })
  },
  /** Blast radius of a risky command (`rm`, `git clean`, `git reset --hard`, `find -delete`…): read-only, shown in the approval. */
  async preview({ command, workdir }, context) {
    const cwd = workdir ? resolvePath({ cwd: context.cwd, path: workdir }) : context.cwd
    return blastRadiusPreview({ command, cwd, signal: context.signal, environment: context.environment })
  },
})
