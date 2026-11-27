import { z } from "zod"
import { SessionId } from "./ids"
import { lazySchema } from "./lazy"
import { SyncBlobPutInput, SyncBlobReadInput } from "./project-rest"

/**
 * Daemon-to-daemon session sync (docs/sync.md). The hub (an always-on daemon) owns its sessions; a device daemon mirrors them
 * and may take one over with a lease. A `sync`-scoped token may send only `hello` and `sync.peer`.
 */

/** Events in one history page or one push, and the bytes of one page (well inside a 256 KiB frame). */
export const SYNC_PAGE_EVENTS = 2000
export const SYNC_PAGE_BYTES = 160_000
/** Sessions one `tail` may follow, and the longest it waits for news. */
export const SYNC_TAIL_SESSIONS = 16
export const SYNC_TAIL_MAX_WAIT_MS = 25_000
/** Session changes listed per `changes` page. */
export const SYNC_CHANGES_PAGE = 200
/** Memory rows per `memories` page and per `memories-put`. */
export const SYNC_MEMORY_PAGE = 200

const seq = z.number().int().nonnegative()
const text = (max: number) => z.string().max(max)
/** A project as both machines can name it: the normalized git remote and the path inside the repository. */
export const SyncProjectRef = lazySchema(() => z.strictObject({ id: text(500).min(1), rel: text(4096) }))
export type SyncProjectRef = z.infer<typeof SyncProjectRef>

export const SyncMemoryRow = lazySchema(() => z.strictObject({
  id: text(100).min(1),
  deleted: z.boolean().optional(),
  updatedAt: seq,
  scope: z.enum(["user", "project"]).optional(),
  directory: text(4096).optional(),
  project: SyncProjectRef.optional(),
  text: text(20_000).optional(),
  category: text(200).optional(),
  status: text(40).optional(),
  source: text(40).optional(),
  createdAt: seq.optional(),
  kind: text(40).optional(),
  targetId: text(100).optional(),
  reason: text(2000).optional(),
  profile: text(200).optional(),
  pinned: z.boolean().optional(),
  details: text(20_000).optional(),
}))
export type SyncMemoryRow = z.infer<typeof SyncMemoryRow>

export const SyncPeerInput = lazySchema(() => z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("hello") }),
  /** Root sessions that changed after the hub's change cursor `after`. */
  z.strictObject({ op: z.literal("changes"), after: seq }),
  /** One session's stored events after native seq `after`. */
  z.strictObject({ op: z.literal("history"), sessionId: SessionId, after: seq }),
  /**
   * Long poll for live chats: answers as soon as any listed session has events after its `after` (or empty after `waitMs`), so a
   * device follows a chat running on the hub at the hub's own pace. Each session's events come as in `history`.
   */
  z.strictObject({ op: z.literal("tail"), sessions: z.array(z.strictObject({ sessionId: SessionId, after: seq })).min(1).max(SYNC_TAIL_SESSIONS), waitMs: z.number().int().min(0).max(SYNC_TAIL_MAX_WAIT_MS) }),
  /**
   * New settled events of a session this device holds the lease of (`epoch`), or of a new session it hands to the hub
   * (`create`). `base` is the hub's last seq as the device last saw it; anything else is a conflict.
   */
  z.strictObject({
    op: z.literal("push"), sessionId: SessionId, base: seq, epoch: seq, lastSeq: seq,
    create: z.strictObject({ title: text(500), createdAt: seq, directory: text(4096).min(1), project: SyncProjectRef.optional() }).optional(),
    events: z.array(z.record(z.string(), z.unknown())).min(1).max(SYNC_PAGE_EVENTS),
  }),
  z.strictObject({ op: z.literal("lease"), action: z.enum(["acquire", "renew", "release"]), sessionId: SessionId, epoch: seq.optional() }),
  z.strictObject({ op: z.literal("meta"), sessionId: SessionId, title: text(500).optional(), archived: z.boolean().optional(), pinned: z.boolean().optional() }),
  z.strictObject({ op: z.literal("blob-put"), input: SyncBlobPutInput }),
  z.strictObject({ op: z.literal("blob-read"), input: SyncBlobReadInput }),
  z.strictObject({ op: z.literal("memories"), after: seq }),
  z.strictObject({ op: z.literal("memories-put"), rows: z.array(SyncMemoryRow).min(1).max(SYNC_MEMORY_PAGE) }),
  z.strictObject({ op: z.literal("settings") }),
  z.strictObject({ op: z.literal("settings-put"), patch: z.record(z.string(), z.unknown()) }),
]))
export type SyncPeerInput = z.infer<typeof SyncPeerInput>

/** This machine's own sync, local clients only: status, reload of `sync.json`, and moving a session's lease. */
export const SyncControlInput = lazySchema(() => z.discriminatedUnion("action", [
  z.strictObject({ action: z.enum(["status", "reload", "now", "hub-off"]) }),
  z.strictObject({ action: z.enum(["take", "release", "handoff"]), sessionId: SessionId }),
]))
export type SyncControlInput = z.infer<typeof SyncControlInput>
