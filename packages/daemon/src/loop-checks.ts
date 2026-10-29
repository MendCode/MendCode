import { createHash } from "node:crypto"
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import type { CheckRunner } from "@mendcode/loops"
import { killProcessTree } from "@mendcode/tools"

const DEFAULT_CHECK_TIMEOUT_SECONDS = 300
const OUTPUT_TAIL_CHARS = 64_000

/**
 * Runs one loop check as a plain program (argv, no shell) in its own process group, bounded in time and
 * output; a timeout (`timeoutSeconds`, default 300) or abort kills the whole group. A timed-out check keeps the
 * output collected so far and ends with `timed out after N s`.
 */
export const runLoopCheck: CheckRunner = async ({ argv, cwd, signal, timeoutSeconds = DEFAULT_CHECK_TIMEOUT_SECONDS }) => {
  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, CI: "1", TERM: "dumb" }, detached: true })
  } catch (error) {
    return { exitCode: -1, output: `cannot run ${argv[0]}: ${error instanceof Error ? error.message : String(error)}` }
  }
  const kill = () => killProcessTree({ pid: child.pid, signal: "SIGKILL", fallback: (name) => { try { child.kill(name) } catch { /* already gone */ } } })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    kill()
  }, timeoutSeconds * 1000)
  signal.addEventListener("abort", kill, { once: true })
  let output = ""
  const collect = async (stream: ReadableStream<Uint8Array> | undefined) => {
    if (!stream) return
    const decoder = new TextDecoder()
    for await (const chunk of stream) {
      output += decoder.decode(chunk, { stream: true })
      if (output.length > OUTPUT_TAIL_CHARS * 2) output = output.slice(-OUTPUT_TAIL_CHARS)
    }
  }
  await Promise.all([collect(child.stdout as ReadableStream<Uint8Array>), collect(child.stderr as ReadableStream<Uint8Array>)])
  const exitCode = await child.exited
  clearTimeout(timer)
  signal.removeEventListener("abort", kill)
  return { exitCode, output: output.slice(-OUTPUT_TAIL_CHARS) + (timedOut ? `\ntimed out after ${timeoutSeconds} s` : "") }
}

/** git's output, or undefined when it fails or cannot start (no git, or a directory that is gone). */
async function git(args: string[], cwd: string) {
  try {
    const child = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "ignore" })
    const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    return code === 0 ? text : undefined
  } catch {
    return undefined
  }
}

/** Bounds for the parts of the fingerprint that walk files: past them it records that it stopped, never hangs. */
const MAX_FINGERPRINT_FILES = 10_000
const SKIPPED_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", ".turbo", ".cache", "target", ".venv", "__pycache__"])

/** Path, size and modification time of each file: an edit changes at least one of them. */
function describeFiles(root: string, paths: Iterable<string>, hash: ReturnType<typeof createHash>) {
  let count = 0
  for (const relative of paths) {
    if (++count > MAX_FINGERPRINT_FILES) {
      hash.update("\0[truncated]")
      return
    }
    const info = statSync(join(root, relative), { throwIfNoEntry: false })
    hash.update(`\0${relative}\0${info ? `${info.size}:${Math.floor(info.mtimeMs)}` : "gone"}`)
  }
}

/** Every file under `root` (skipping VCS, dependency and build folders), sorted, at most MAX_FINGERPRINT_FILES + 1. */
function walk(root: string): string[] {
  const out: string[] = []
  const visit = (dir: string, prefix: string) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length > MAX_FINGERPRINT_FILES) return
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) visit(join(dir, entry.name), relative)
      } else if (entry.isFile()) out.push(relative)
    }
  }
  visit(root, "")
  return out
}

/**
 * A digest of the workspace an audit must not change. In a git work tree: status (untracked included), the diff
 * against HEAD, and the size and mtime of every untracked file (their content is not in the diff). Elsewhere: the
 * size and mtime of every file, bounded. Read-only: never refreshes the git index.
 */
export async function workspaceFingerprint(directory: string): Promise<string | undefined> {
  const hash = createHash("sha256")
  const status = await git(["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"], directory)
  if (status === undefined) {
    if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) return undefined
    hash.update("files")
    describeFiles(directory, walk(directory), hash)
    return hash.digest("hex")
  }
  const diff = (await git(["--no-optional-locks", "diff", "HEAD", "--binary"], directory)) ?? ""
  hash.update(status).update("\0").update(diff)
  const untracked = status
    .split("\n")
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3).replace(/^"(.*)"$/, "$1"))
  describeFiles(directory, untracked, hash)
  return hash.digest("hex")
}
