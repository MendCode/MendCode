import path from "path"
import { activeFocus } from "../config/project"
import { buildWorktreePreview } from "./preview"
import { createWorktreeRecord } from "./registry"
import type { WorktreePreview, WorktreeRecord } from "./types"

function branchName(prefix: string, name: string) {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
  return `${prefix}${normalized || "workspace"}`
}

export function planNativeWorktreeCreate(input: {
  repoRoot: string
  name: string
  branchPrefix: string
  branch?: string
  baseRef?: string | null
  directory?: string
  root?: string
}): { record: WorktreeRecord; preview: WorktreePreview } {
  const branch = input.branch || branchName(input.branchPrefix, input.name)
  const directory = input.directory || path.join(input.repoRoot, ".mendcode", "worktree", input.name)
  const record = createWorktreeRecord({
    creator: "mendcode",
    repoRoot: input.repoRoot,
    path: directory,
    branch,
    baseRef: input.baseRef || null,
    executor: "native",
    sessions: [],
    packages: [],
    mflowMode: "unknown",
    creationPlan: {
      commands: ["git worktree add --no-checkout -b <branch> <path>"],
      writes: [".mendcode/worktree/state.json"],
      note: `focus=${activeFocus(input.repoRoot)}`,
    },
    cleanupPolicy: "remove-when-clean",
  })
  const preview = buildWorktreePreview({
    action: "create",
    record,
    root: input.root || input.repoRoot,
    commands: [{
      tool: "git",
      argv: ["worktree", "add", "--no-checkout", "-b", branch, directory],
      cwd: input.repoRoot,
      destructive: false,
    }],
  })
  return { record, preview }
}

export function planNativeWorktreeRemove(record: WorktreeRecord, root?: string) {
  return buildWorktreePreview({
    action: "remove",
    record,
    root,
    commands: [
      { tool: "git", argv: ["worktree", "remove", "--force", record.path], cwd: record.repoRoot, destructive: true },
      ...(record.branch ? [{ tool: "git" as const, argv: ["branch", "-D", record.branch], cwd: record.repoRoot, destructive: true }] : []),
    ],
  })
}

export function planNativeWorktreeReset(record: WorktreeRecord, root?: string) {
  return buildWorktreePreview({
    action: "reset",
    record,
    root,
    commands: [
      { tool: "git", argv: ["reset", "--hard", record.baseRef || "default-branch"], cwd: record.path, destructive: true },
      { tool: "git", argv: ["clean", "-ffdx"], cwd: record.path, destructive: true },
    ],
  })
}
