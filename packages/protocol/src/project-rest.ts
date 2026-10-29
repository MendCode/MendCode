import { z } from "zod"
import { SessionId } from "./ids"
import { lazySchema } from "./lazy"

const text = z.string().max(4096).refine((value) => !/[\x00-\x1f\x7f]/.test(value), "control characters are not allowed")
export const ProjectRestPatch = lazySchema(() => z.strictObject({
  name: text.max(200).optional(),
  icon: z.strictObject({ url: z.string().max(8192).optional(), override: z.string().max(8192).optional(), color: text.max(100).optional() }).optional(),
  commands: z.strictObject({ start: z.string().max(8000).optional() }).optional(),
}))
export const ProjectRestInfo = lazySchema(() => z.strictObject({
  id: text.min(1), worktree: text.min(1), vcs: z.literal("git").optional(),
  ...ProjectRestPatch.shape,
  time: z.strictObject({ created: z.number().int().nonnegative(), updated: z.number().int().nonnegative(), initialized: z.number().int().nonnegative().optional() }),
  sandboxes: z.array(text).max(500),
}))
export type ProjectRestInfo = z.infer<typeof ProjectRestInfo>
export const RestWorktreeCreate = lazySchema(() => z.strictObject({ name: text.max(100).optional(), startCommand: z.string().max(8000).optional(), runStartup: z.boolean().default(false) }))
export const RestWorktreeTarget = lazySchema(() => z.strictObject({ directory: text.min(1) }))
export const RestWorkspaceCreate = lazySchema(() => z.strictObject({
  id: z.string().regex(/^ws_[a-f0-9]{24}$/).optional(), type: z.enum(["local", "worktree"]), branch: text.max(200).nullable(),
  extra: z.strictObject({ directory: text.min(1).optional(), name: text.min(1).max(100).optional(), runStartup: z.boolean().optional(), branchName: text.min(1).max(200).optional(), base: text.min(1).max(200).optional() }).nullable().optional(),
}))
export const RestWorkspaceInfo = lazySchema(() => z.strictObject({ id: z.string(), type: z.enum(["local", "worktree"]), name: text, branch: text.nullable(), directory: text, extra: z.unknown().nullable(), projectID: text.min(1) }))
export type RestWorkspaceInfo = z.infer<typeof RestWorkspaceInfo>
/** Native events carry a v2 session ID; donor v1 histories (versioned types such as `message.updated.1`) carry the donor's own aggregate ID. */
export const SyncReplayEvent = lazySchema(() => z.strictObject({ id: z.string().min(1).max(200), aggregateID: z.string().min(1).max(200), seq: z.number().int().nonnegative(), type: z.string().min(1).max(100), data: z.record(z.string(), z.unknown()) }))
export const SyncReplayInput = lazySchema(() => z.strictObject({ directory: text.min(1), events: z.array(SyncReplayEvent).min(1).max(2000) }))
/** Largest blob a sync transfer carries, and the largest chunk of one request. */
export const MAX_SYNC_BLOB_BYTES = 8 * 1024 * 1024
export const MAX_SYNC_BLOB_CHUNK_BYTES = 128 * 1024
const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
/** Uploads one blob a replayed event references, in order, `data` being base64 of at most 128 KiB; the last chunk verifies the hash. */
export const SyncBlobPutInput = lazySchema(() => z.strictObject({ sha256, bytes: z.number().int().positive().max(MAX_SYNC_BLOB_BYTES), mime: z.string().min(1).max(255), offset: z.number().int().nonnegative(), data: z.string().min(1).max(Math.ceil(MAX_SYNC_BLOB_CHUNK_BYTES / 3) * 4) }))
/** Reads one blob a session of the project references, `offset` onwards, in chunks of at most 128 KiB. */
export const SyncBlobReadInput = lazySchema(() => z.strictObject({ sha256, offset: z.number().int().nonnegative().default(0) }))
export const SyncHistoryInput = lazySchema(() => z.record(SessionId, z.number().int().nonnegative()).refine((value) => Object.keys(value).length <= 1000, "too many cursors"))
export const WorkspaceWarpInput = lazySchema(() => z.strictObject({ id: z.string().regex(/^ws_[a-f0-9]{24}$/).nullable(), sessionID: SessionId }))
export const ProjectRestInput = lazySchema(() => z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.enum(["list", "current", "init-git", "path", "vcs", "worktree-list", "workspace-adapters", "workspace-list", "workspace-status", "sync-start"]) }),
  z.strictObject({ operation: z.literal("update"), projectID: text.min(1), patch: ProjectRestPatch }),
  z.strictObject({ operation: z.literal("vcs-diff"), mode: z.enum(["git", "branch"]) }),
  z.strictObject({ operation: z.literal("worktree-create"), input: RestWorktreeCreate }),
  z.strictObject({ operation: z.enum(["worktree-remove", "worktree-reset"]), input: RestWorktreeTarget }),
  z.strictObject({ operation: z.literal("workspace-create"), input: RestWorkspaceCreate }),
  z.strictObject({ operation: z.literal("workspace-remove"), id: z.string().regex(/^ws_[a-f0-9]{24}$/) }),
  z.strictObject({ operation: z.literal("workspace-warp"), input: WorkspaceWarpInput }),
  z.strictObject({ operation: z.literal("sync-steal"), sessionID: SessionId }),
  z.strictObject({ operation: z.literal("sync-replay"), input: SyncReplayInput }),
  z.strictObject({ operation: z.literal("sync-history"), cursors: SyncHistoryInput }),
  z.strictObject({ operation: z.literal("sync-blob-put"), input: SyncBlobPutInput }),
  z.strictObject({ operation: z.literal("sync-blob-read"), input: SyncBlobReadInput }),
]))
export type ProjectRestInput = z.infer<typeof ProjectRestInput>
