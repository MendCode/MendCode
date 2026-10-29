import { redactSecrets } from "@mendcode/protocol"
import { killProcessTree } from "@mendcode/tools"

/**
 * How the daemon starts git and gh for the Git page (`git.commit`, `git.push`, `git.pr.*`; docs/git.md): an argument array and never a shell,
 * no standard input unless a body is given, a timeout, and at most `MAX_OUTPUT_BYTES` read from each pipe. Credentials are the user's own and are never read,
 * logged or echoed; what a failed command printed is shown redacted.
 */

export const TIMEOUT_MS = 120_000
export const READ_TIMEOUT_MS = 15_000
/** Bytes read from each pipe; the rest is drained and dropped. */
export const MAX_OUTPUT_BYTES = 16_384
/** What a failed command shows of its output: the redacted tail, at most this many lines and characters. */
const SHOWN_LINES = 20
const SHOWN_CHARS = 2000
/** Variables that would point git somewhere other than the repository we resolved. */
export const SCRUBBED = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_PREFIX", "GIT_NAMESPACE", "GIT_EXTERNAL_DIFF", "GIT_SEQUENCE_EDITOR"]
/** After the kill, how long a child that kept the pipes open is waited for. */
export const KILL_GRACE_MS = 2000

export type Run = { code: number; out: string; err: string; timedOut: boolean }

/** The environment every git child gets: no prompts, no editor, no pager, literal pathspecs, and none of the variables that relocate the repository. */
export function childEnv(base: NodeJS.ProcessEnv) {
  const env: Record<string, string | undefined> = { ...base, GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1", GIT_EDITOR: "true", GIT_PAGER: "cat", LC_ALL: "C" }
  for (const name of SCRUBBED) delete env[name]
  return env as Record<string, string>
}

/**
 * The environment of a child that talks to a remote: as `childEnv`, and nothing that could ask the user anything. A program that git or ssh would start to
 * ask for a password (`GIT_ASKPASS`, `core.askPass`, `SSH_ASKPASS`, a credential manager's window) is replaced by one that fails, so a push that needs a
 * password fails with git's own message instead of opening a window or waiting. The user's credential helpers still answer: nothing is read or changed here.
 */
export function networkEnv(base: NodeJS.ProcessEnv) {
  const env: Record<string, string | undefined> = { ...childEnv(base), GIT_ASKPASS: "false", SSH_ASKPASS_REQUIRE: "never", GCM_INTERACTIVE: "never", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_PAGER: "cat", NO_COLOR: "1" }
  delete env.SSH_ASKPASS
  return env as Record<string, string>
}

export async function drain(stream: ReadableStream<Uint8Array>, limit: number) {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of stream) {
    if (size >= limit) continue
    chunks.push(chunk.byteLength + size > limit ? chunk.subarray(0, limit - size) : chunk)
    size += chunk.byteLength
  }
  return Buffer.concat(chunks).toString("utf8")
}

/**
 * A program with an argument array, never a shell: `input` is its whole standard input (none when absent), a timeout, and at most `MAX_OUTPUT_BYTES` of each
 * pipe. `detached` puts it in a session of its own, so it has no terminal to ask on and a timeout can end the whole tree. A program that does not exist is
 * code 127, never a throw.
 */
export async function run(input: { program: string; cwd: string; args: string[]; env: Record<string, string>; timeoutMs?: number; stdin?: string; detached?: boolean }): Promise<Run> {
  const started = (() => {
    try { return { child: Bun.spawn([input.program, ...input.args], { cwd: input.cwd, env: input.env, stdin: input.stdin === undefined ? "ignore" : Buffer.from(input.stdin), stdout: "pipe", stderr: "pipe", ...(input.detached && process.platform !== "win32" ? { detached: true } : {}) }) } }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
  })()
  if (!("child" in started)) return { code: 127, out: "", err: started.error, timedOut: false }
  const { child } = started
  let timedOut = false
  const timeoutMs = input.timeoutMs ?? READ_TIMEOUT_MS
  const stop = () => {
    if (input.detached) killProcessTree({ pid: child.pid, signal: "SIGKILL", fallback: (name) => { try { child.kill(name) } catch { /* already gone */ } } })
    else child.kill()
  }
  const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
  let giveUp: ReturnType<typeof setTimeout> | undefined
  const gaveUp = new Promise<Run>((resolve) => { giveUp = setTimeout(() => resolve({ code: -1, out: "", err: "", timedOut: true }), timeoutMs + KILL_GRACE_MS) })
  try {
    const finished = Promise.all([drain(child.stdout as ReadableStream<Uint8Array>, MAX_OUTPUT_BYTES), drain(child.stderr as ReadableStream<Uint8Array>, MAX_OUTPUT_BYTES), child.exited]).then(([out, err, code]): Run => ({ code, out, err, timedOut }))
    return await Promise.race([finished, gaveUp])
  } finally { clearTimeout(timer); clearTimeout(giveUp) }
}

/** git with an argument array, in the environment `childEnv` makes. */
export const git = (input: { cwd: string; args: string[]; env: NodeJS.ProcessEnv; timeoutMs?: number }) => run({ program: "git", cwd: input.cwd, args: input.args, env: childEnv(input.env), ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}) })

/** What the user sees of a failed command: secrets masked, control characters gone, the last lines. */
export function shown(text: string) {
  const clean = redactSecrets(text).text.replace(/\r/g, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").trim()
  const tail = clean.split("\n").slice(-SHOWN_LINES).join("\n")
  return tail.length > SHOWN_CHARS ? `…${tail.slice(-SHOWN_CHARS)}` : tail
}

/** Repositories with a commit, push or pull request being made right now: one action at a time per repository. */
export const repoLocks = new Set<string>()
