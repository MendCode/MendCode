import fs from "node:fs"
import path from "node:path"
import { normalizeComments, type ReviewComment } from "@mendcode/protocol/wire"

export { MAX_COMMENTS, MAX_BODY, MAX_EXCERPT_ROWS, parseDiffRows, hunkLabel, reviewTarget, createComment, lineLabel, locationLabel, locateComment, normalizeComments } from "@mendcode/protocol/wire"
export type { CommentKind, LineRange, ReviewComment, DiffRowKind, DiffRow, ReviewTarget } from "@mendcode/protocol/wire"

/** Local mirror and legacy import; the daemon owns the shared review. */
const safeName = (sessionId: string) => sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120) || "session"
export const reviewsPath = (dataDir: string, sessionId: string) => path.join(dataDir, "tui", "reviews", `${safeName(sessionId)}.json`)

/** The saved comments of a session; empty when the file is missing, unreadable or not JSON. */
export function readReviewComments(dataDir: string, sessionId: string): ReviewComment[] {
  try {
    const file = reviewsPath(dataDir, sessionId)
    if (!fs.existsSync(file)) return []
    return normalizeComments(JSON.parse(fs.readFileSync(file, "utf8")))
  } catch {
    return []
  }
}

/** Saves the comments of a session, written whole and renamed into place; an empty list removes the file (sent or cleared). */
export function writeReviewComments(dataDir: string, sessionId: string, comments: readonly ReviewComment[]): { ok: true } | { ok: false; error: string } {
  const file = reviewsPath(dataDir, sessionId)
  const temp = `${file}.${process.pid}.tmp`
  try {
    if (comments.length === 0) {
      fs.rmSync(file, { force: true })
      return { ok: true }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temp, `${JSON.stringify({ version: 1, sessionId, comments: normalizeComments({ comments }) }, null, 2)}\n`)
    fs.renameSync(temp, file)
    return { ok: true }
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true })
    } catch {
      // Nothing left to clean up.
    }
    return { ok: false, error: `[TUI]: could not save ${file}: ${error instanceof Error ? error.message : String(error)}` }
  }
}
