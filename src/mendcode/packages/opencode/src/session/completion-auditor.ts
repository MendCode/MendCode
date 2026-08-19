import { createHash } from "node:crypto"
import { lstat, readFile, readdir } from "node:fs/promises"
import path from "node:path"

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_FILES = 10_000
const DEFAULT_TIMEOUT_MS = 20_000
const ignoredFallbackDirectories = new Set([".git", ".mendcode", "node_modules"])

export type WorkspaceFingerprintResult =
  | { readonly status: "ok"; readonly value: string; readonly summary: string }
  | { readonly status: "blocked" | "unavailable"; readonly summary: string }

const boundedProcessOutput = async (input: {
  readonly command: readonly string[]
  readonly cwd: string
  readonly maxBytes: number
  readonly timeoutMs: number
}) => {
  const child = Bun.spawn([...input.command], {
    cwd: input.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CI: process.env.CI ?? "1",
      NO_COLOR: "1",
      TERM: "dumb",
    },
  })
  const timer = setTimeout(() => child.kill(), input.timeoutMs)
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > input.maxBytes) {
        child.kill()
        throw new Error(`output exceeded ${input.maxBytes} bytes`)
      }
      chunks.push(next.value)
    }
    const output = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      output.set(chunk, offset)
      offset += chunk.byteLength
    }
    return output
  }
  try {
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, read(child.stdout), read(child.stderr)])
    return { exitCode, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

const fingerprintFiles = async (
  directory: string,
  relativePaths: readonly string[],
  maxFiles: number,
  maxBytes: number,
) => {
  if (relativePaths.length > maxFiles) throw new Error(`workspace contains more than ${maxFiles} files`)
  const root = path.resolve(directory)
  const hash = createHash("sha256")
  let total = 0
  for (const relativePath of [...new Set(relativePaths)].sort()) {
    const absolute = path.resolve(root, relativePath)
    const relative = path.relative(root, absolute)
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`workspace path escapes the fingerprint root: ${relativePath}`)
    }
    const info = await lstat(absolute)
    if (!info.isFile()) continue
    const content = await readFile(absolute)
    total += content.byteLength
    if (total > maxBytes) throw new Error(`workspace file content exceeded ${maxBytes} bytes`)
    hash.update(relative)
    hash.update("\0")
    hash.update(content)
    hash.update("\0")
  }
  return hash.digest("hex")
}

const fallbackFingerprint = async (directory: string, maxFiles: number, maxBytes: number) => {
  const entries: string[] = []
  const pending = [directory]
  while (pending.length) {
    const current = pending.pop()!
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoredFallbackDirectories.has(entry.name)) continue
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) {
        pending.push(absolute)
        continue
      }
      if (!entry.isFile()) continue
      entries.push(path.relative(directory, absolute))
      if (entries.length > maxFiles) throw new Error(`workspace contains more than ${maxFiles} files`)
    }
  }
  return fingerprintFiles(directory, entries, maxFiles, maxBytes)
}

export const fingerprintWorkspace = async (
  directory: string,
  options?: { readonly maxBytes?: number; readonly maxFiles?: number; readonly timeoutMs?: number },
): Promise<WorkspaceFingerprintResult> => {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  try {
    const root = await boundedProcessOutput({
      command: ["git", "rev-parse", "--show-toplevel"],
      cwd: directory,
      maxBytes: 16 * 1024,
      timeoutMs,
    })
    if (root.exitCode === 0) {
      try {
        const hash = createHash("sha256")
        const commands = [
          ["git", "rev-parse", "HEAD"],
          ["git", "status", "--porcelain=v2", "-z", "--untracked-files=all"],
          ["git", "diff", "--no-ext-diff", "--binary", "HEAD", "--"],
        ] as const
        for (const command of commands) {
          const result = await boundedProcessOutput({ command, cwd: directory, maxBytes, timeoutMs })
          if (result.exitCode !== 0) {
            const error = new TextDecoder().decode(result.stderr).trim()
            return { status: "blocked", summary: `Workspace fingerprint command failed: ${error || command.join(" ")}` }
          }
          hash.update(command.join(" "))
          hash.update(result.stdout)
        }
        const untracked = await boundedProcessOutput({
          command: ["git", "ls-files", "--full-name", "--others", "--exclude-standard", "-z"],
          cwd: directory,
          maxBytes,
          timeoutMs,
        })
        if (untracked.exitCode !== 0) {
          const error = new TextDecoder().decode(untracked.stderr).trim()
          return { status: "blocked", summary: `Workspace fingerprint command failed: ${error || "git ls-files"}` }
        }
        const repositoryRoot = new TextDecoder().decode(root.stdout).trim()
        const untrackedPaths = new TextDecoder().decode(untracked.stdout).split("\0").filter(Boolean)
        hash.update("untracked-content")
        hash.update(await fingerprintFiles(repositoryRoot, untrackedPaths, options?.maxFiles ?? DEFAULT_MAX_FILES, maxBytes))
        return { status: "ok", value: hash.digest("hex"), summary: "Git workspace fingerprint recorded." }
      } catch (error) {
        return {
          status: "blocked",
          summary: `Workspace fingerprint failed: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }
  } catch (error) {
    if (String(error).includes("exceeded")) {
      return { status: "blocked", summary: `Workspace fingerprint exceeded the ${maxBytes}-byte safety limit.` }
    }
  }

  try {
    const value = await fallbackFingerprint(directory, options?.maxFiles ?? DEFAULT_MAX_FILES, maxBytes)
    return { status: "ok", value, summary: "Filesystem content fingerprint recorded for a non-Git workspace." }
  } catch (error) {
    return { status: "unavailable", summary: `Workspace fingerprint unavailable: ${error instanceof Error ? error.message : String(error)}` }
  }
}
