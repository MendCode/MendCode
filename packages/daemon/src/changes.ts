import { lstat } from "node:fs/promises"
import type { ChangedFile, ChangesReport } from "@mendcode/protocol"

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
const MAX_FILES = 300
const MAX_FILE_DIFF_BYTES = 60_000
/** Keeps the whole report well under the 256 KB protocol frame (JSON escaping inflates diffs). */
const MAX_TOTAL_DIFF_BYTES = 120_000
/** A single file fetched on demand (`changes.file`) may use more of the frame. */
const MAX_SINGLE_FILE_DIFF_BYTES = 180_000
const MAX_UNTRACKED_BYTES = 200_000

export class NotGitError extends Error {
  constructor(directory: string) {
    super(`[CHANGES]: ${directory} is not inside a git repository`)
    this.name = "NotGitError"
  }
}

async function git(cwd: string, args: string[]) {
  const proc = Bun.spawn(["git", "-C", cwd, "--no-pager", ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" } })
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return { stdout, ok: code === 0 }
}

/** Size inside the JSON frame: quotes, backslashes, tabs and control characters are escaped. */
function jsonBytes(text: string) {
  return Buffer.byteLength(JSON.stringify(text))
}

/** Cuts at a line boundary so the escaped size fits `max`. */
function clip(text: string, max: number) {
  if (jsonBytes(text) <= max) return { text, truncated: false }
  if (max <= 0) return { text: "", truncated: text.length > 0 }
  let cut = text.slice(0, max)
  while (cut && jsonBytes(cut) > max) cut = cut.slice(0, Math.floor(cut.length * 0.9))
  return { text: cut.slice(0, cut.lastIndexOf("\n") + 1), truncated: true }
}

/** Splits `git diff` output into per-file hunks keyed by new path. */
function splitDiff(output: string) {
  const byPath = new Map<string, string>()
  for (const chunk of output.split(/^diff --git /m).slice(1)) {
    const header = chunk.slice(0, chunk.indexOf("\n"))
    const plusPath = /^\+\+\+ b\/(.*)$/m.exec(chunk)?.[1]
    const renameTo = /^rename to (.*)$/m.exec(chunk)?.[1]
    const path = plusPath ?? renameTo ?? /^a\/.* b\/(.*)$/.exec(header)?.[1] ?? header
    const hunkStart = chunk.search(/^@@/m)
    byPath.set(path, hunkStart >= 0 ? chunk.slice(hunkStart) : "")
  }
  return byPath
}

function parseStatus(code: string): ChangedFile["status"] {
  if (code.startsWith("A")) return "added"
  if (code.startsWith("D")) return "deleted"
  if (code.startsWith("R")) return "renamed"
  return "modified"
}

/**
 * Working tree vs HEAD for the repository containing `directory`, including untracked files.
 * Read-only (GIT_OPTIONAL_LOCKS=0 so it never takes the index lock) and bounded in files and bytes.
 */
export async function readChanges(directory: string, options: { only?: string } = {}): Promise<ChangesReport> {
  const perFile = options.only ? MAX_SINGLE_FILE_DIFF_BYTES : MAX_FILE_DIFF_BYTES
  const total = options.only ? MAX_SINGLE_FILE_DIFF_BYTES : MAX_TOTAL_DIFF_BYTES
  const wanted = (path: string) => !options.only || options.only === path
  const top = await git(directory, ["rev-parse", "--show-toplevel"])
  if (!top.ok) throw new NotGitError(directory)
  const root = top.stdout.trim()
  const branch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim()
  const base = (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"])).ok ? "HEAD" : EMPTY_TREE

  const [nameStatus, numstat, patch, untracked] = await Promise.all([
    git(root, ["diff", base, "-M", "--name-status", "-z"]),
    git(root, ["diff", base, "-M", "--numstat", "-z"]),
    git(root, ["diff", base, "-M", "--no-color", "--no-ext-diff", "--unified=3"]),
    git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ])

  const counts = new Map<string, { additions: number; deletions: number; binary: boolean }>()
  const numTokens = numstat.stdout.split("\0")
  for (let i = 0; i < numTokens.length; i++) {
    const token = numTokens[i]!
    if (!token) continue
    const [add, del, path] = token.split("\t")
    // Renames in -z numstat: "add\tdel\t" followed by old and new path tokens.
    const target = path ? path : (i += 2, numTokens[i]!)
    counts.set(target, { additions: add === "-" ? 0 : Number(add), deletions: del === "-" ? 0 : Number(del), binary: add === "-" })
  }

  const diffs = splitDiff(patch.stdout)
  const files: ChangedFile[] = []
  let totalBytes = 0
  const statusTokens = nameStatus.stdout.split("\0").filter(Boolean)
  for (let i = 0; i < statusTokens.length; ) {
    const code = statusTokens[i++]!
    const status = parseStatus(code)
    const oldPath = status === "renamed" ? statusTokens[i++] : undefined
    const path = statusTokens[i++]!
    if (!wanted(path)) continue
    const count = counts.get(path) ?? { additions: 0, deletions: 0, binary: false }
    const { text, truncated } = clip(diffs.get(path) ?? "", Math.max(0, Math.min(perFile, total - totalBytes)))
    totalBytes += jsonBytes(text)
    files.push({ path, ...(oldPath ? { oldPath } : {}), status, ...count, diff: text, truncated })
  }

  for (const path of untracked.stdout.split("\0").filter(Boolean)) {
    if (!wanted(path)) continue
    const file = Bun.file(`${root}/${path}`)
    // A symlink or special file is listed but never read: its target can lie outside the repository.
    const regular = await lstat(`${root}/${path}`).then((info) => info.isFile(), () => false)
    const size = regular ? file.size : 0
    let content = ""
    let binary = false
    if (regular && size <= MAX_UNTRACKED_BYTES) {
      const bytes = new Uint8Array(await file.arrayBuffer())
      binary = bytes.subarray(0, 8_000).includes(0)
      if (!binary) content = new TextDecoder().decode(bytes)
    }
    const lines = content ? content.replace(/\n$/, "").split("\n") : []
    const budget = Math.max(0, Math.min(perFile, total - totalBytes))
    const hunk = lines.length && budget > 0 ? `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n` : ""
    const { text, truncated } = clip(hunk, budget)
    totalBytes += jsonBytes(text)
    files.push({ path, status: "untracked", additions: lines.length, deletions: 0, binary, diff: text, truncated: truncated || (lines.length > 0 && !text) || size > MAX_UNTRACKED_BYTES })
  }

  files.sort((a, b) => a.path.localeCompare(b.path))
  return { root, ...(branch && branch !== "HEAD" ? { branch } : {}), files: files.slice(0, MAX_FILES), omittedFiles: Math.max(0, files.length - MAX_FILES) }
}
