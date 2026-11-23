import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { MAX_FRAME_BYTES, redactSecrets, type ChangedFile, type ChangesReport } from "@mendcode/protocol"
import type { FileSnapshot, FileState } from "@mendcode/store"

const MAX_DIFF_BYTES = 120_000
const MAX_FILES = 300
const bytes = (state: FileState | undefined) => state?.state === "content" ? Buffer.from(state.content) : Buffer.alloc(0)

export function boundSnapshotReport(report: ChangesReport): ChangesReport {
  while (report.files.length && Buffer.byteLength(JSON.stringify(report)) > MAX_FRAME_BYTES - 2048) {
    report.files.pop()
    report.omittedFiles++
    report.complete = false
  }
  if (report.omittedFiles || report.files.some((file) => file.truncated)) report.complete = false
  return report
}

export function equalFileStates(a: FileState, b: FileState) {
  if (a.state !== b.state || a.state === "skipped" || b.state === "skipped") return false
  return a.state === "absent" || b.state === "content" && a.mode === b.mode && bytes(a).equals(bytes(b))
}

type FileDiff = Omit<ChangedFile, "path" | "status">
/** Diffs kept by content: at most this many, and this much diff text in all. */
const DIFF_MEMO_ENTRIES = 128
const DIFF_MEMO_CHARS = 1_000_000
const diffMemo = new Map<string, FileDiff>()
let diffMemoChars = 0

/**
 * `gitDiff` of a pair of contents seen before is the answer given then. A session's changes are asked for again on every chat
 * switch (the sidebar's file list) and the same pairs come back, and each `git diff` is a process started while the daemon waits:
 * a session with a few dozen edited files held every client for hundreds of milliseconds per request.
 */
function diffFile(snapshot: FileSnapshot): FileDiff {
  const before = bytes(snapshot.before)
  const after = bytes(snapshot.after)
  const key = `${before.length}:${Bun.hash(before)}:${after.length}:${Bun.hash(after)}`
  const known = diffMemo.get(key)
  if (known) {
    diffMemo.delete(key)
    diffMemo.set(key, known)
    return { ...known }
  }
  const diff = gitDiff(before, after)
  // A diff git did not finish (a timeout under load) is asked again next time.
  if (!diff.truncated && diff.diff.length <= DIFF_MEMO_CHARS / 8) {
    diffMemo.set(key, diff)
    diffMemoChars += diff.diff.length
    for (const [old, entry] of diffMemo) {
      if (diffMemo.size <= DIFF_MEMO_ENTRIES && diffMemoChars <= DIFF_MEMO_CHARS) break
      diffMemo.delete(old)
      diffMemoChars -= entry.diff.length
    }
  }
  return { ...diff }
}

/** Git's diff algorithm over temporary copies; never reads or writes the project's index. */
function gitDiff(before: Buffer, after: Buffer): FileDiff {
  const binary = before.subarray(0, 8192).includes(0) || after.subarray(0, 8192).includes(0)
  if (binary) return { binary: true, additions: 0, deletions: 0, diff: "", truncated: false }
  const dir = mkdtempSync(path.join(tmpdir(), "mend-snapshot-diff-"))
  try {
    const a = path.join(dir, "before")
    const b = path.join(dir, "after")
    writeFileSync(a, before, { mode: 0o600 })
    writeFileSync(b, after, { mode: 0o600 })
    let patch = ""
    try {
      patch = execFileSync("git", ["--no-pager", "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", "--", a, b], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 2000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: ["ignore", "pipe", "pipe"] })
    } catch (error) {
      const result = error as { status?: number; stdout?: string }
      if (result.status !== 1 || typeof result.stdout !== "string") return { binary: false, additions: 0, deletions: 0, diff: "", truncated: true }
      patch = result.stdout
    }
    const start = patch.search(/^@@/m)
    const diff = start < 0 ? "" : patch.slice(start)
    const lines = diff.split("\n")
    return { binary: false, additions: lines.filter((line) => line.startsWith("+")).length, deletions: lines.filter((line) => line.startsWith("-")).length, diff: redactSecrets(diff).text, truncated: false }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function summarizeSnapshots(root: string, snapshots: FileSnapshot[], complete: boolean): ChangesReport {
  const files: ChangedFile[] = []
  let remaining = MAX_DIFF_BYTES
  let omittedFiles = 0
  for (const snapshot of snapshots) {
    if (snapshot.before.state === "skipped" || !snapshot.after || snapshot.after.state === "skipped") {
      complete = false
      omittedFiles++
      continue
    }
    if (equalFileStates(snapshot.before, snapshot.after)) continue
    if (files.length >= MAX_FILES) { omittedFiles++; continue }
    const file = diffFile(snapshot)
    const status = snapshot.before.state === "absent" ? "added" : snapshot.after.state === "absent" ? "deleted" : "modified"
    let diff = file.diff
    const truncated = file.truncated || Buffer.byteLength(JSON.stringify(diff)) > remaining
    if (truncated) {
      diff = diff.slice(0, Math.max(0, Math.floor(remaining / 6)))
      diff = diff.slice(0, diff.lastIndexOf("\n") + 1)
    }
    remaining = Math.max(0, remaining - Buffer.byteLength(JSON.stringify(diff)))
    files.push({ ...file, path: path.relative(root, snapshot.path) || snapshot.path, status, diff, truncated })
  }
  return boundSnapshotReport({ root, files, omittedFiles, complete: complete && omittedFiles === 0 })
}
