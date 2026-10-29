import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { ReviewChange, ReviewRead, ReviewSnapshot, type ChangesReport, type SessionId } from "@mendcode/protocol"
import { createComment, locateComment, MAX_COMMENTS, normalizeComments, parseDiffRows, reviewTarget } from "@mendcode/protocol/wire"
import { readChanges } from "./changes"

const rowsOf = (diff: string) => parseDiffRows(diff.replace(/\n$/, "").split("\n").filter((_, i, rows) => rows.length > 1 || rows[i] !== ""))
const clamp = (n: number, length: number) => Math.max(0, Math.min(n, length - 1))
export const reviewFile = (dir: string, sessionId: SessionId) => path.join(dir, "reviews", `${sessionId}.json`)

/** Session-owned state; diffs are read on demand, only selection/comments are persisted. */
export function createReviews(input: {
  dir: string
  directory(sessionId: SessionId): string | undefined
  now(): number
  changed(sessionId: SessionId, review: ReviewSnapshot, reload: boolean): void
}) {
  const pending = new Map<SessionId, Promise<unknown>>()

  function snapshot(sessionId: SessionId): ReviewSnapshot {
    try {
      const saved = ReviewSnapshot.safeParse(JSON.parse(readFileSync(reviewFile(input.dir, sessionId), "utf8")))
      if (saved.success) return saved.data
    } catch {}
    // Import v2's former client-only review once, on the first update.
    let comments: ReviewSnapshot["comments"] = []
    try { comments = normalizeComments(JSON.parse(readFileSync(path.join(input.dir, "tui", "reviews", `${sessionId}.json`), "utf8"))) } catch {}
    return { revision: 0, selection: {}, comments }
  }

  function selected(report: ChangesReport, review: ReviewSnapshot) {
    return report.files.find((f) => f.path === review.selection.filePath) ?? report.files[0]
  }

  function reconcile(report: ChangesReport, review: ReviewSnapshot): ReviewSnapshot {
    const file = selected(report, review)
    const rows = rowsOf(file?.diff ?? "")
    const row = clamp(review.selection.row ?? 0, rows.length)
    return {
      ...review,
      selection: file ? { filePath: file.path, ...(rows[row]?.hunk !== undefined && rows[row]!.hunk >= 0 ? { blockIndex: rows[row]!.hunk } : {}), row } : {},
      comments: review.comments.map((comment) => {
        const target = report.files.find((f) => f.path === comment.path || f.oldPath === comment.path)
        return { ...comment, ...(target ? { path: target.path } : {}), stale: !target || !locateComment(comment, rowsOf(target.diff)) }
      }),
    }
  }

  async function reportFor(sessionId: SessionId, filePath?: string) {
    const directory = input.directory(sessionId)
    if (!directory) throw new Error("[REVIEW]: session not found")
    return readChanges(directory, filePath ? { only: filePath } : {})
  }

  async function reconcileFull(sessionId: SessionId, report: ChangesReport, review: ReviewSnapshot) {
    const files = await Promise.all(report.files.map(async (file) => {
      if (!file.truncated || !review.comments.some((c) => c.path === file.path || c.path === file.oldPath) && review.selection.filePath !== file.path) return file
      const full = await reportFor(sessionId, file.path)
      return full.files[0] ?? file
    }))
    return reconcile({ ...report, files }, review)
  }

  async function completeFile(sessionId: SessionId, file: ChangesReport["files"][number] | undefined) {
    if (!file?.truncated) return file
    return (await reportFor(sessionId, file.path)).files[0] ?? file
  }

  async function read(sessionId: SessionId, raw: unknown) {
    const query = ReviewRead.parse(raw)
    const report = await reportFor(sessionId)
    const review = await reconcileFull(sessionId, report, snapshot(sessionId))
    if (query.action === "file") {
      const filePath = query.filePath ?? review.selection.filePath
      const full = await reportFor(sessionId, filePath)
      const file = full.files.find((f) => f.path === filePath)
      if (!file) throw new Error("[REVIEW]: file not found")
      const { diff, ...info } = file
      const rows = rowsOf(diff)
      let bytes = 0
      let count = 0
      const blocks = rows.filter((r) => r.kind === "hunk").slice(0, 12).map((r) => ({ index: r.hunk, header: r.text.slice(0, 400), lines: rows.filter((line) => {
        if (line.hunk !== r.hunk || line.kind === "hunk") return false
        const size = Buffer.byteLength(JSON.stringify(line))
        if (count >= 600 || bytes + size > 30_000) return false
        bytes += size
        count++
        return true
      }) }))
      const patch = Buffer.byteLength(JSON.stringify(diff)) <= 30_000 ? diff : diff.slice(0, 7_000)
      const result = { review, file: { ...info, truncated: info.truncated || count < rows.filter((r) => r.kind !== "hunk").length || (query.includePatch === true && patch !== diff), blocks, ...(query.includePatch ? { rawPatch: patch } : {}) } }
      if (Buffer.byteLength(JSON.stringify(result)) > 200_000) throw new Error("[REVIEW]: result exceeds the protocol byte limit")
      return result
    }
    if (query.action === "comment_list") return { review, comments: review.comments }
    const result = { review, report }
    if (Buffer.byteLength(JSON.stringify(result)) > 200_000) throw new Error("[REVIEW]: result exceeds the protocol byte limit")
    return result
  }

  async function update(sessionId: SessionId, raw: unknown) {
    const change = ReviewChange.parse(raw)
    const report = await reportFor(sessionId)
    const previous = snapshot(sessionId)
    let review = await reconcileFull(sessionId, report, previous)
    if (change.action === "navigate") {
      let file = await completeFile(sessionId, selected(report, review))
      let block = review.selection.blockIndex ?? 0
      const direction = change.direction?.startsWith("next") ? 1 : -1
      const adjacentFile = async () => {
        const at = report.files.findIndex((f) => f.path === file?.path)
        return completeFile(sessionId, report.files[(at + direction + report.files.length) % report.files.length])
      }
      if (change.direction?.endsWith("file")) {
        file = await adjacentFile()
        block = 0
      } else {
        if (change.filePath) {
          file = await completeFile(sessionId, report.files.find((f) => f.path === change.filePath))
          if (!file) throw new Error("[REVIEW]: file not found")
        }
        const rows = rowsOf(file?.diff ?? "")
        const headers = rows.filter((r) => r.kind === "hunk")
        block = change.direction ? block + direction : (change.blockIndex ?? (change.filePath ? 0 : block))
        if (change.direction && headers.length && !headers.some((r) => r.hunk === block)) {
          file = await adjacentFile()
          block = direction > 0 ? 0 : rowsOf(file?.diff ?? "").filter((r) => r.kind === "hunk").at(-1)?.hunk ?? 0
        } else if (headers.length && !headers.some((r) => r.hunk === block)) throw new Error("[REVIEW]: block not found")
      }
      const rows = rowsOf(file?.diff ?? "")
      const hasBlock = rows.some((r) => r.hunk === block)
      review = { ...review, selection: file ? { filePath: file.path, ...(hasBlock ? { blockIndex: block } : {}), row: Math.max(0, rows.findIndex((r) => r.hunk === block && r.kind !== "hunk")) } : {} }
    }
    if (change.action === "comment_add") {
      if (!change.filePath || change.blockIndex === undefined || !change.body) throw new Error("[REVIEW]: filePath, blockIndex and body are required")
      const full = await reportFor(sessionId, change.filePath)
      const file = full.files.find((f) => f.path === change.filePath)
      if (!file) throw new Error("[REVIEW]: file not found")
      const rows = rowsOf(file.diff)
      const at = rows.findIndex((r) => r.hunk === change.blockIndex && (change.line === undefined ? r.kind === "hunk" : change.side === "old" ? r.old === change.line : change.side === "new" ? r.new === change.line : r.new === change.line || r.old === change.line))
      if (at < 0) throw new Error("[REVIEW]: block or line not found")
      const target = reviewTarget({ path: file.path, rows, from: at, to: at })
      if (change.line !== undefined && change.side === "old") {
        delete target.newRange
        target.oldRange = { from: change.line, to: change.line }
      }
      if (change.line !== undefined && change.side === "new") delete target.oldRange
      const comment = createComment({ target, body: change.body, now: input.now(), existing: review.comments })
      review = { ...review, comments: [...review.comments, { ...comment, author: change.author ?? "assistant", side: change.side ?? "both", stale: false }] }
    }
    if (change.action === "comment_clear") review = { ...review, comments: review.comments.filter((c) => (change.filePath && c.path !== change.filePath) || (change.staleOnly && !c.stale)) }
    if (change.action === "sync") {
      const comments = new Map(review.comments.filter((c) => !change.remove?.includes(c.id)).map((c) => [c.id, c]))
      for (const comment of change.upsert ?? []) comments.set(comment.id, comment)
      review = { ...review, comments: [...comments.values()], ...(change.selection ? { selection: change.selection } : {}) }
    }
    review = await reconcileFull(sessionId, report, review)
    if (review.comments.length > MAX_COMMENTS) throw new Error(`[REVIEW]: maximum ${MAX_COMMENTS} comments`)
    review = ReviewSnapshot.parse({ ...review, revision: previous.revision + 1 })
    if (Buffer.byteLength(JSON.stringify(review)) > 100_000) throw new Error("[REVIEW]: comments exceed the review byte limit")
    const file = reviewFile(input.dir, sessionId)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(`${file}.tmp`, JSON.stringify(review))
    renameSync(`${file}.tmp`, file)
    input.changed(sessionId, review, change.action === "reload")
    return { review }
  }

  function serialized<T>(sessionId: SessionId, run: () => Promise<T>): Promise<T> {
    const next = (pending.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(run)
    pending.set(sessionId, next)
    void next.finally(() => { if (pending.get(sessionId) === next) pending.delete(sessionId) }).catch(() => {})
    return next
  }

  return {
    read: (sessionId: SessionId, query: unknown) => serialized(sessionId, () => read(sessionId, query)),
    update: (sessionId: SessionId, change: unknown) => serialized(sessionId, () => update(sessionId, change)),
    port: (sessionId: SessionId) => ({
      async run(raw: Record<string, unknown>) {
        const { path: legacy, ...args } = raw
        const action = args.action ?? (legacy ? "file" : "summary")
        const request = { ...args, action, ...(legacy && !args.filePath ? { filePath: legacy, includePatch: true } : {}) }
        const reads = ["current", "summary", "file", "comment_list"]
        const result = reads.includes(String(action)) ? await serialized(sessionId, () => read(sessionId, request)) : await serialized(sessionId, () => update(sessionId, request))
        const report = "report" in result ? result.report as ChangesReport : await reportFor(sessionId)
        const review = result.review
        const summary = { workspaceRoot: report.root, stats: { files: report.files.length, additions: report.files.reduce((n, f) => n + f.additions, 0), deletions: report.files.reduce((n, f) => n + f.deletions, 0), blocks: report.files.reduce((n, f) => n + rowsOf(f.diff).filter((r) => r.kind === "hunk").length, 0) }, selection: review.selection, files: report.files.slice(0, 60).map((file) => ({ path: file.path, status: file.status, additions: file.additions, deletions: file.deletions, binary: file.binary, truncated: file.truncated, blocks: rowsOf(file.diff).filter((row) => row.kind === "hunk").slice(0, 12).map((row) => ({ index: row.hunk, header: row.text })) })), omittedFiles: report.omittedFiles + Math.max(0, report.files.length - 60), comments: review.comments }
        return { output: JSON.stringify("file" in result ? result.file : action === "comment_list" || String(action).startsWith("comment_") ? review.comments : summary, null, 2), meta: { action: String(action), files: report.files.length, comments: review.comments.length, ...(review.selection.filePath ? { selectedFile: review.selection.filePath } : {}), ...(review.selection.blockIndex !== undefined ? { selectedBlock: review.selection.blockIndex } : {}) } }
      },
    }),
  }
}
