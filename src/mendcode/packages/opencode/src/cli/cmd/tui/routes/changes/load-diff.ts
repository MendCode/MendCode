import { spawnSync } from "child_process"
import fs from "fs"
import path from "path"

const MAX_UNTRACKED_BYTES = 200_000
const MAX_GIT_PATCH_BYTES = 16 * 1024 * 1024

export type LoadedWorkspaceDiff = {
  diff: string
  untracked: string[]
  skipped: string[]
  error?: string
}

type GitResult =
  | { ok: true; stdout: string }
  | { ok: false; stdout: string; error: string; code?: string }

type GitRunner = (cwd: string, args: string[]) => GitResult

export function loadWorkspaceDiff(root: string): LoadedWorkspaceDiff {
  return loadWorkspaceDiffWithGit(root, runGit)
}

export function loadWorkspaceDiffWithGit(root: string, git: GitRunner): LoadedWorkspaceDiff {
  const tracked = git(root, ["diff", "--name-only", "-z", "HEAD", "--"])
  if (!tracked.ok) return { diff: "", untracked: [], skipped: [], error: tracked.error }

  const patchParts: string[] = []
  const skipped: string[] = []
  for (const file of parseGitPathList(tracked.stdout)) {
    const diff = git(root, ["diff", "--no-ext-diff", "--patch", "HEAD", "--", file])
    if (diff.ok) {
      if (diff.stdout.trim()) patchParts.push(diff.stdout.trimEnd())
      continue
    }
    if (!isBufferOverflow(diff)) return { diff: patchParts.join("\n"), untracked: [], skipped, error: diff.error }
    skipped.push(file)
    patchParts.push(metadataOnlyPatch(file))
  }

  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"])
  const untrackedFiles = untracked.ok ? parseGitPathList(untracked.stdout) : []

  for (const file of untrackedFiles) {
    const full = path.join(root, file)
    const stat = safeStat(full)
    if (!stat || !stat.isFile() || stat.size > MAX_UNTRACKED_BYTES || isLikelyBinary(full)) {
      skipped.push(file)
      continue
    }
    const diff = git(root, ["diff", "--no-index", "--patch", "--", "/dev/null", file])
    if (diff.stdout.trim()) patchParts.push(normalizeNoIndexPatch(diff.stdout, file))
  }

  return {
    diff: patchParts.join("\n"),
    untracked: untrackedFiles,
    skipped,
  }
}

function runGit(cwd: string, args: string[]): GitResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_GIT_PATCH_BYTES,
  })
  const stdout = result.stdout ?? ""
  const stderr = result.stderr ?? ""
  if (result.error) {
    const error = result.error as Error & { code?: string }
    return { ok: false as const, stdout, error: error.message, code: error.code }
  }
  if ((result.status ?? 0) > 1)
    return { ok: false as const, stdout, error: stderr.trim() || `git ${args.join(" ")} failed` }
  return { ok: true as const, stdout }
}

export function parseGitPathList(stdout: string) {
  return stdout.split("\0").filter(Boolean)
}

function isBufferOverflow(result: GitResult) {
  return !result.ok && (result.code === "ENOBUFS" || result.error.includes("ENOBUFS") || result.error.includes("maxBuffer"))
}

function metadataOnlyPatch(file: string) {
  const escaped = file.replace(/\\/g, "/")
  return [`diff --git a/${escaped} b/${escaped}`, `--- a/${escaped}`, `+++ b/${escaped}`].join("\n")
}

function safeStat(file: string) {
  try {
    return fs.statSync(file)
  } catch {
    return undefined
  }
}

function isLikelyBinary(file: string) {
  try {
    const buffer = fs.readFileSync(file)
    const sample = buffer.subarray(0, Math.min(buffer.length, 8000))
    return sample.includes(0)
  } catch {
    return true
  }
}

export function normalizeNoIndexPatch(diff: string, file: string) {
  const escaped = file.replace(/\\/g, "/")
  return diff
    .replace(/^diff --git a\/dev\/null b\/(.+)$/m, `diff --git a/${escaped} b/${escaped}`)
    .replace(/^\+\+\+ b\/(.+)$/m, `+++ b/${escaped}`)
}
