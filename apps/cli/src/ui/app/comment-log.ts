import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** Where a comment chip came from: the session's saved draft, a stashed draft, or a queued message taken back to edit. */
export type CommentOrigin = "draft" | "stash" | "queue"
const MAX_BYTES = 64 * 1024

/**
 * One line per comment event in `<dataDir>/logs/comments.log`: the time, what happened (sent, or restored from where), the session and how
 * many comments. Never the comment or quote text. It lets a comment that came back after it was sent be traced to its path. Written only
 * when comments are sent or restored, so it costs nothing at rest; past 64 KB it starts over.
 */
export function logCommentEvent(dataDir: string | undefined, event: { kind: "sent" | CommentOrigin; sessionId: string; count: number; parked?: boolean }) {
  if (!dataDir) return
  try {
    const dir = join(dataDir, "logs")
    const file = join(dir, "comments.log")
    mkdirSync(dir, { recursive: true })
    try { if (statSync(file).size > MAX_BYTES) writeFileSync(file, "") } catch {}
    appendFileSync(file, `${new Date().toISOString()} ${event.kind === "sent" ? "sent" : `restored-from-${event.kind}`} ${event.sessionId} ${event.count}${event.parked ? " parked" : ""}\n`)
  } catch {}
}
