import type { ChangedFile, ChangesReport, SessionId } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"

/** Patch text kept per file / per message when a diff rides inside a message or session record (the diff route returns whole patches). */
const EMBEDDED_PATCH_BYTES = 4_000
const EMBEDDED_TOTAL_BYTES = 16_000

export type RestFileDiff = { file: string; patch: string; additions: number; deletions: number; status: "added" | "deleted" | "modified"; truncated?: true }

/** v1's `SnapshotFileDiff` carries a git-style patch with its header; v2 keeps hunks only, so the header is rebuilt. */
function patchOf(file: ChangedFile) {
  if (!file.diff) return ""
  const from = file.status === "added" || file.status === "untracked" ? "/dev/null" : `a/${file.oldPath ?? file.path}`
  const to = file.status === "deleted" ? "/dev/null" : `b/${file.path}`
  return `diff --git a/${file.oldPath ?? file.path} b/${file.path}\n${file.status === "added" || file.status === "untracked" ? "new file mode 100644\n" : file.status === "deleted" ? "deleted file mode 100644\n" : ""}--- ${from}\n+++ ${to}\n${file.diff}`
}

/** A session or message change report as v1 file diffs. `embedded` cuts patches so the records they ride in stay small. */
export function restFileDiffs(report: ChangesReport, options: { embedded?: boolean } = {}): RestFileDiff[] {
  let left = EMBEDDED_TOTAL_BYTES
  return report.files.map((file) => {
    let patch = patchOf(file)
    let truncated = file.truncated
    if (options.embedded) {
      const budget = Math.min(EMBEDDED_PATCH_BYTES, left)
      if (Buffer.byteLength(patch) > budget) {
        patch = patch.slice(0, Math.max(0, budget))
        patch = patch.slice(0, patch.lastIndexOf("\n") + 1)
        truncated = true
      }
      left -= Buffer.byteLength(patch)
    }
    return { file: file.path, patch, additions: file.additions, deletions: file.deletions, status: file.status === "untracked" || file.status === "renamed" ? "added" : file.status, ...(truncated ? { truncated: true as const } : {}) }
  })
}

/**
 * The cheap session total v1 keeps in `session.summary`: persisted per-turn summaries of the turns that are not undone,
 * added up by path (a path touched twice counts once for `files`). Reads no file bytes and runs no git.
 */
export function restSessionSummary({ store, sessionId }: { store: Store; sessionId: SessionId }) {
  let additions = 0
  let deletions = 0
  const paths = new Set<string>()
  for (const turn of store.turns.list(sessionId)) {
    if (turn.reverted) continue
    for (const file of store.turns.snapshots.get(sessionId, turn.turnId)?.summary?.files ?? []) {
      additions += file.additions
      deletions += file.deletions
      paths.add(file.path)
    }
  }
  return paths.size ? { additions, deletions, files: paths.size } : undefined
}

/** v1's `session.revert`: where the newest waiting undo cut (the message, and the part for a part-level revert). */
export function restRevert({ store, sessionId }: { store: Store; sessionId: SessionId }): { messageID: string; partID?: string } | undefined {
  const top = store.turns.undoTop(sessionId)
  if (!top) return undefined
  if (top.partial) {
    const messageID = store.turns.get(sessionId, top.partial.turnId)?.itemId ?? top.partial.itemId
    return { messageID, partID: top.partial.itemId }
  }
  const messageID = top.turnIds.map((turnId) => store.turns.get(sessionId, turnId)?.itemId).find((itemId) => itemId !== undefined)
  return messageID ? { messageID } : undefined
}

/** The persisted summary of one user message (its turn), as v1's `message.summary.diffs`; undefined when none was recorded. */
export function restMessageSummary({ store, sessionId, itemId }: { store: Store; sessionId: SessionId; itemId: string }) {
  const turn = store.turns.byItem(sessionId, itemId)
  const summary = turn ? store.turns.snapshots.get(sessionId, turn.turnId)?.summary : undefined
  return summary?.files.length ? { diffs: restFileDiffs(summary, { embedded: true }) } : undefined
}
