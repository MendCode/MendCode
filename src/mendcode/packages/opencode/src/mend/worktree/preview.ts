import path from "path"
import { worktreeStatePath } from "./registry"
import type { WorktreePreview, WorktreePreviewCommand, WorktreeRecord, WorktreeStateWrite } from "./types"

function isDestructiveAction(action: WorktreePreview["action"]) {
  return action === "remove" || action === "reset" || action === "prune"
}

function destructiveBlockReasons(input: { action: WorktreePreview["action"]; record: WorktreeRecord }) {
  const reasons: string[] = []
  if (!isDestructiveAction(input.action)) return reasons
  if (input.record.ownership !== "owned" && input.record.ownership !== "adopted") {
    reasons.push(`target is ${input.record.ownership}; adopt it before destructive actions`)
  }
  if (!input.record.dirty.clean) reasons.push(`target is dirty: ${input.record.dirty.summary}`)
  return reasons
}

export function worktreeForceConfirmation(record: WorktreeRecord) {
  return record.path || record.branch || record.id
}

export function buildWorktreePreview(input: {
  action: WorktreePreview["action"]
  record: WorktreeRecord
  commands?: WorktreePreviewCommand[]
  stateWrites?: WorktreeStateWrite[]
  root?: string
}): WorktreePreview {
  const blockReasons = destructiveBlockReasons(input)
  const stateFile = worktreeStatePath(input.root)
  return {
    action: input.action,
    target: {
      id: input.record.id,
      path: input.record.path,
      branch: input.record.branch,
      baseRef: input.record.baseRef,
    },
    ownership: input.record.ownership,
    executor: input.record.executor,
    dirty: input.record.dirty,
    sessions: input.record.sessions,
    commands: input.commands || [],
    stateWrites: input.stateWrites || [{ path: path.relative(input.record.repoRoot, stateFile), action: "update" }],
    recoveryRecordPath: path.relative(input.record.repoRoot, stateFile),
    blocked: blockReasons.length > 0,
    blockReasons,
    forceConfirmation: isDestructiveAction(input.action) ? worktreeForceConfirmation(input.record) : null,
  }
}

export function renderWorktreePreview(preview: WorktreePreview) {
  const commands = preview.commands.length
    ? preview.commands.map((command) => `- ${command.tool} ${command.argv.join(" ")}${command.cwd ? ` (cwd ${command.cwd})` : ""}`).join("\n")
    : "- none"
  const writes = preview.stateWrites.length
    ? preview.stateWrites.map((write) => `- ${write.action} ${write.path}`).join("\n")
    : "- none"
  const sessions = preview.sessions.length
    ? preview.sessions.map((session) => `- ${session.tool}:${session.id} last seen ${session.lastSeenAt}`).join("\n")
    : "- none"
  const blocks = preview.blocked ? preview.blockReasons.map((reason) => `- ${reason}`).join("\n") : "- none"
  return [
    `Action: ${preview.action}`,
    `Target: ${preview.target.path}`,
    `Branch: ${preview.target.branch || "none"}`,
    `Ownership: ${preview.ownership}`,
    `Executor: ${preview.executor}`,
    `Dirty: ${preview.dirty.clean ? "clean" : "dirty"} (${preview.dirty.summary})`,
    "",
    "Sessions:",
    sessions,
    "",
    "Commands:",
    commands,
    "",
    "State writes:",
    writes,
    "",
    "Blocks:",
    blocks,
    preview.forceConfirmation ? `Force confirmation: ${preview.forceConfirmation}` : "Force confirmation: not required",
    `Recovery record: ${preview.recoveryRecordPath}`,
  ].join("\n")
}
