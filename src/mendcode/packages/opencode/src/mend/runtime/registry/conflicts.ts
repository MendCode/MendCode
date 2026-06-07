import { createHash } from "crypto"
import { existsSync } from "fs"
import { mkdir, readdir, readFile, writeFile } from "fs/promises"
import path from "path"
import { isApplyAllowed } from "./trust"
import type { RegistryConflict, RegistryConflictStatus } from "./types"

const ignoredBlockedRoots = new Set(["cache", "node_modules", "runs"])
const ignoredBlockedPrefixes = [
  ".mendcode/tui/backups/",
  ".mendcode/tui/proposals/",
  ".mendcode/tui/renders/",
  ".mendcode/tui/runtime/",
  ".mendcode/tui/surfaces/",
]
const ignoredBlockedFiles = new Set([
  ".mendcode/budget/spend-state.json",
  ".mendcode/tui/runtime-plan.json",
  ".mendcode/upstream.json",
  ".mendcode/worktree/flows.json",
  ".mendcode/worktree/locks.json",
  ".mendcode/worktree/mflow-plan.json",
  ".mendcode/worktree/tsm-plan.json",
])

async function listFilesRecursive(root: string) {
  const out: string[] = []
  async function walk(dir: string) {
    if (!existsSync(dir)) return
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else out.push(full)
    }
  }
  await walk(root)
  return out.sort()
}

async function fileSha256(file: string) {
  return createHash("sha256").update(await readFile(file)).digest("hex")
}

function emptySummary(): Record<RegistryConflictStatus, number> {
  return {
    missing: 0,
    same: 0,
    changed: 0,
    blocked: 0,
    unsupported: 0,
    destructive: 0,
  }
}

export async function detectRegistryConflicts(stageDir: string, root: string) {
  const sourceMend = path.join(stageDir, ".mendcode")
  const targetMend = path.join(root, ".mendcode")
  const sourceFiles = existsSync(sourceMend)
    ? (await listFilesRecursive(sourceMend)).map((file) => ({ file, rel: path.relative(stageDir, file).split(path.sep).join(path.posix.sep) }))
    : []
  const targetFiles = existsSync(targetMend)
    ? (await listFilesRecursive(targetMend)).map((file) => ({ file, rel: path.relative(root, file).split(path.sep).join(path.posix.sep) }))
    : []

  const conflicts: RegistryConflict[] = []
  const incomingAllowed = new Set<string>()
  const localAllowed = new Set(targetFiles.filter((item) => isApplyAllowed(item.rel)).map((item) => item.rel))

  for (const item of sourceFiles) {
    if (!item.rel.startsWith(".mendcode/")) {
      conflicts.push({ path: item.rel, status: "unsupported", source: "incoming", reason: "Source includes non-.mendcode content; registry apply ignores it." })
      continue
    }
    const blockedRoot = item.rel.split("/")[1] || ""
    if (ignoredBlockedRoots.has(blockedRoot)) continue
    if (ignoredBlockedFiles.has(item.rel)) continue
    if (ignoredBlockedPrefixes.some((prefix) => item.rel.startsWith(prefix))) continue
    if (!isApplyAllowed(item.rel)) {
      conflicts.push({ path: item.rel, status: "blocked", source: "incoming", reason: "Path is blocked from shared registry apply." })
      continue
    }
    incomingAllowed.add(item.rel)
    const target = path.join(root, item.rel)
    if (!existsSync(target)) {
      conflicts.push({ path: item.rel, status: "missing", source: "incoming", reason: "Incoming shared file does not exist locally and will be added." })
      continue
    }
    const [sourceHash, targetHash] = await Promise.all([fileSha256(item.file), fileSha256(target)])
    conflicts.push({
      path: item.rel,
      status: sourceHash === targetHash ? "same" : "changed",
      source: "incoming",
      reason: sourceHash === targetHash
        ? "Incoming shared file matches the local copy."
        : "Incoming shared file differs from the local copy and will overwrite it.",
    })
  }

  for (const rel of Array.from(localAllowed).sort()) {
    if (incomingAllowed.has(rel)) continue
    conflicts.push({
      path: rel,
      status: "destructive",
      source: "local",
      reason: "Local shared file is absent from the incoming pack; apply will keep the local file, so the resulting workspace is only a partial projection of the pack.",
    })
  }

  const summary = emptySummary()
  for (const conflict of conflicts) summary[conflict.status] += 1
  return {
    entries: conflicts.sort((a, b) => a.path.localeCompare(b.path) || a.status.localeCompare(b.status)),
    summary,
    requiresApproval: summary.changed > 0 || summary.destructive > 0,
  }
}

function reportFile(root: string) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(".", "")
  return path.join(root, ".mendcode", "runs", `registry-apply-${stamp}.json`)
}

export async function writeRegistryApplyReport(root: string, report: unknown) {
  const file = reportFile(root)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`)
  return path.relative(root, file)
}
