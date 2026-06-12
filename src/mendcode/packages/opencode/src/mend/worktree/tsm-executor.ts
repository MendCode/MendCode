import { tsmStatus } from "../config/tsm"
import { buildWorktreePreview } from "./preview"
import type { WorktreeExecutorPlan } from "./executor"
import type { WorktreeRecord } from "./types"

function reasonsFromStatus(status: Awaited<ReturnType<typeof tsmStatus>>) {
  const reasons: string[] = []
  if (!status.enabled) reasons.push("TSM integration is not active")
  if (status.lifecycle !== "active") reasons.push(`TSM lifecycle is ${status.lifecycle}`)
  if (!status.worktreeCapable) reasons.push("TSM binary does not advertise worktree capabilities")
  return reasons
}

export async function planTsmWorktreeOpen(record: WorktreeRecord, root?: string): Promise<WorktreeExecutorPlan> {
  const status = await tsmStatus(root || record.repoRoot)
  const reasons = reasonsFromStatus(status)
  const preview = buildWorktreePreview({
    action: "open",
    record: { ...record, executor: "tsm" },
    root: root || record.repoRoot,
    commands: [{
      tool: "tsm",
      argv: ["wt", record.branch || record.path],
      cwd: record.repoRoot,
      destructive: false,
    }],
  })
  return { executor: "tsm", preview: { ...preview, blocked: preview.blocked || reasons.length > 0, blockReasons: [...preview.blockReasons, ...reasons] }, allowed: reasons.length === 0, reasons }
}

export async function planTsmWorktreeCreate(record: WorktreeRecord, root?: string): Promise<WorktreeExecutorPlan> {
  const status = await tsmStatus(root || record.repoRoot)
  const reasons = reasonsFromStatus(status)
  const preview = buildWorktreePreview({
    action: "create",
    record: { ...record, executor: "tsm" },
    root: root || record.repoRoot,
    commands: [{
      tool: "tsm",
      argv: ["wt", "add", record.branch || record.path],
      cwd: record.repoRoot,
      destructive: false,
    }],
  })
  return { executor: "tsm", preview: { ...preview, blocked: preview.blocked || reasons.length > 0, blockReasons: [...preview.blockReasons, ...reasons] }, allowed: reasons.length === 0, reasons }
}
