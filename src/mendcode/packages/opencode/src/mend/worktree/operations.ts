import { readWorktreeState, writeWorktreeState } from "./registry"
import type { WorktreeOperationKind, WorktreeOperationRecord, WorktreeOperationStatus, WorktreePreview } from "./types"

function operationID(kind: WorktreeOperationKind, target: string, now: string) {
  return Buffer.from(`${now}\0${kind}\0${target}`).toString("base64url")
}

export async function startWorktreeOperation(
  kind: WorktreeOperationKind,
  target: string,
  preview: WorktreePreview,
  root?: string,
) {
  const state = await readWorktreeState(root)
  const now = new Date().toISOString()
  const record: WorktreeOperationRecord = {
    id: operationID(kind, target, now),
    kind,
    target,
    status: "pending",
    preview,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    error: null,
    recovery: [],
  }
  state.operations[record.id] = record
  await writeWorktreeState(state, root)
  return record
}

export async function finishWorktreeOperation(
  id: string,
  status: Exclude<WorktreeOperationStatus, "pending">,
  input: { error?: string | null; recovery?: string[] } = {},
  root?: string,
) {
  const state = await readWorktreeState(root)
  const current = state.operations[id]
  if (!current) throw new Error(`Unknown worktree operation: ${id}`)
  const now = new Date().toISOString()
  state.operations[id] = {
    ...current,
    status,
    updatedAt: now,
    finishedAt: now,
    error: input.error || null,
    recovery: input.recovery || [],
  }
  await writeWorktreeState(state, root)
  return state.operations[id]!
}
