import { spawnSync } from "child_process"
import fs from "fs"
import path from "path"

const MAX_UNTRACKED_BYTES = 200_000

export type LoadedWorkspaceDiff = {
  diff: string
  untracked: string[]
  skipped: string[]
  error?: string
}

export function loadWorkspaceDiff(root: string): LoadedWorkspaceDiff {
  const tracked = runGit(root, ["diff", "--no-ext-diff", "--patch", "HEAD", "--"])
  if (!tracked.ok) return { diff: "", untracked: [], skipped: [], error: tracked.error }

  const untracked = runGit(root, ["ls-files", "--others", "--exclude-standard"])
  const untrackedFiles = untracked.ok
    ? untracked.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    : []
  const patchParts = [tracked.stdout.trimEnd()].filter(Boolean)
  const skipped: string[] = []

  for (const file of untrackedFiles) {
    const full = path.join(root, file)
    const stat = safeStat(full)
    if (!stat || !stat.isFile() || stat.size > MAX_UNTRACKED_BYTES || isLikelyBinary(full)) {
      skipped.push(file)
      continue
    }
    const diff = runGit(root, ["diff", "--no-index", "--patch", "--", "/dev/null", file])
    if (diff.stdout.trim()) patchParts.push(normalizeNoIndexPatch(diff.stdout, file))
  }

  return {
    diff: patchParts.join("\n"),
    untracked: untrackedFiles,
    skipped,
  }
}

function runGit(cwd: string, args: string[]) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
  const stdout = result.stdout ?? ""
  const stderr = result.stderr ?? ""
  if (result.error) return { ok: false as const, stdout, error: result.error.message }
  if ((result.status ?? 0) > 1)
    return { ok: false as const, stdout, error: stderr.trim() || `git ${args.join(" ")} failed` }
  return { ok: true as const, stdout }
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
    .replace(/^--- \/dev\/null$/m, "--- /dev/null")
    .replace(/^\+\+\+ b\/(.+)$/m, `+++ b/${escaped}`)
}
