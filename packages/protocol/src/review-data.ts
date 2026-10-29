/** Shared diff anchors and bounded comments, independent of UI and schemas. */
export type CommentKind = "line" | "hunk" | "file"
export type LineRange = { from: number; to: number }

export type ReviewComment = {
  id: string
  path: string
  kind: CommentKind
  /** Index of the hunk the comment was made in (-1 for a file comment). */
  hunk: number
  /** The hunk's `@@ … @@` header, to find the comment again after the diff changed. */
  header: string
  /** The diff rows the comment is about, raw (`+`, `-`, space prefix); kept so the comment survives a refreshed diff. */
  excerpt: string[]
  /** New-file lines covered (added and context rows). */
  newRange?: LineRange | undefined
  /** Old-file lines covered by removed rows. */
  oldRange?: LineRange | undefined
  author?: "user" | "agent" | "assistant" | undefined
  side?: "old" | "new" | "both" | undefined
  stale?: boolean | undefined
  body: string
  createdAt: number
}

export const MAX_COMMENTS = 60
export const MAX_BODY = 800
export const MAX_EXCERPT_ROWS = 40
const MAX_EXCERPT_COLUMNS = 240
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

export type DiffRowKind = "hunk" | "add" | "del" | "context" | "note"
export type DiffRow = { text: string; kind: DiffRowKind; hunk: number; old?: number; new?: number }

/** The rows of a file's diff with their hunk index and line numbers (from the `@@` headers). Rows before the first header are notes. */
export function parseDiffRows(lines: readonly string[]): DiffRow[] {
  const rows: DiffRow[] = []
  let hunk = -1
  let oldN = 0
  let newN = 0
  for (const text of lines) {
    if (text.startsWith("@@")) {
      const match = HUNK.exec(text)
      hunk++
      if (match) {
        oldN = Number(match[1])
        newN = Number(match[3])
      }
      rows.push({ text, kind: "hunk", hunk })
    } else if (hunk < 0 || text.startsWith("\\")) rows.push({ text, kind: "note", hunk })
    else if (text.startsWith("+")) rows.push({ text, kind: "add", hunk, new: newN++ })
    else if (text.startsWith("-")) rows.push({ text, kind: "del", hunk, old: oldN++ })
    else rows.push({ text, kind: "context", hunk, old: oldN++, new: newN++ })
  }
  return rows
}

/** `@@ -40,2 +41,2 @@` without the function context some diffs append. */
export function hunkLabel(header: string) {
  const end = header.indexOf("@@", 2)
  return end < 0 ? header : header.slice(0, end + 2)
}

function range(values: number[]): LineRange | undefined {
  return values.length === 0 ? undefined : { from: Math.min(...values), to: Math.max(...values) }
}

function commentId(seed: string) {
  let hash = 2166136261
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `rc_${(hash >>> 0).toString(36)}`
}

/** What a comment is about, before it has a body. */
export type ReviewTarget = Omit<ReviewComment, "id" | "body" | "createdAt">

const clipRow = (text: string) => Array.from(text).slice(0, MAX_EXCERPT_COLUMNS).join("")

/**
 * The target of rows `from..to` (inclusive, any order) of a file's diff. A lone hunk header, or `hunk: true`, comments the
 * whole hunk; a file without rows is commented as a file.
 */
export function reviewTarget(input: { path: string; rows: readonly DiffRow[]; from: number; to: number; hunk?: boolean }): ReviewTarget {
  const { rows } = input
  if (rows.length === 0) return { path: input.path, kind: "file", hunk: -1, header: "", excerpt: [] }
  const last = rows.length - 1
  const lo = Math.max(0, Math.min(input.from, input.to, last))
  const hi = Math.min(last, Math.max(input.from, input.to, 0))
  const anchor = rows[lo]!
  const wholeHunk = input.hunk === true || (lo === hi && anchor.kind === "hunk")
  if (wholeHunk && anchor.hunk >= 0) {
    const inHunk = rows.filter((row) => row.hunk === anchor.hunk)
    const header = (inHunk[0]?.text ?? "").slice(0, 400)
    const newRange = range(inHunk.flatMap((row) => (row.new !== undefined ? [row.new] : [])))
    const oldRange = range(inHunk.flatMap((row) => (row.kind === "del" && row.old !== undefined ? [row.old] : [])))
    return {
      path: input.path,
      kind: "hunk",
      hunk: anchor.hunk,
      header,
      excerpt: inHunk.slice(0, MAX_EXCERPT_ROWS).map((row) => clipRow(row.text)),
      ...(newRange ? { newRange } : {}),
      ...(oldRange ? { oldRange } : {}),
    }
  }
  const picked = rows.slice(lo, hi + 1)
  const lines = picked.filter((row) => row.kind !== "hunk")
  const covered = lines.length > 0 ? lines : picked
  const header = (rows.slice(0, hi + 1).reverse().find((row) => row.kind === "hunk")?.text ?? "").slice(0, 400)
  const newRange = range(covered.flatMap((row) => (row.new !== undefined ? [row.new] : [])))
  const oldRange = range(covered.flatMap((row) => (row.kind === "del" && row.old !== undefined ? [row.old] : [])))
  return {
    path: input.path,
    kind: "line",
    hunk: anchor.hunk,
    header,
    excerpt: covered.slice(0, MAX_EXCERPT_ROWS).map((row) => clipRow(row.text)),
    ...(newRange ? { newRange } : {}),
    ...(oldRange ? { oldRange } : {}),
  }
}

export function createComment(input: { target: ReviewTarget; body: string; now: number; existing?: readonly ReviewComment[] }): ReviewComment {
  const body = input.body.trim().slice(0, MAX_BODY)
  const taken = new Set((input.existing ?? []).map((comment) => comment.id))
  let id = commentId([input.target.path, input.target.kind, input.target.hunk, input.target.excerpt.join("\n"), body, input.now].join(":"))
  for (let attempt = 1; taken.has(id); attempt++) id = commentId(`${id}:${attempt}`)
  return { ...input.target, id, body, createdAt: input.now }
}

/** `11-12`, `11`, `old 10-11`, `11-12, old 11`; empty for a hunk or file comment. */
export function lineLabel(comment: Pick<ReviewComment, "newRange" | "oldRange" | "kind">): string {
  if (comment.kind !== "line") return ""
  const span = (r: LineRange) => (r.from === r.to ? String(r.from) : `${r.from}-${r.to}`)
  const parts: string[] = []
  if (comment.newRange) parts.push(span(comment.newRange))
  if (comment.oldRange) parts.push(`old ${span(comment.oldRange)}`)
  return parts.join(", ")
}

/** `src/a.ts:11-12`, `src/a.ts hunk @@ -40,2 +41,2 @@`, or the bare path. */
export function locationLabel(comment: ReviewComment): string {
  if (comment.kind === "hunk") return `${comment.path} hunk ${hunkLabel(comment.header)}`
  const lines = lineLabel(comment)
  return lines ? `${comment.path}:${lines}` : comment.path
}

/** Where a comment sits in the file's current diff rows: the first row and the last, or undefined when the diff no longer has that code. */
export function locateComment(comment: ReviewComment, rows: readonly DiffRow[]): { start: number; end: number } | undefined {
  if (comment.kind === "file") return { start: 0, end: 0 }
  const size = comment.excerpt.length
  if (size === 0) return undefined
  const matches: number[] = []
  for (let index = 0; index + size <= rows.length; index++) {
    let same = true
    for (let offset = 0; offset < size; offset++) {
      if (clipRow(rows[index + offset]!.text) !== comment.excerpt[offset]) {
        same = false
        break
      }
    }
    if (same) matches.push(index)
  }
  if (matches.length === 0) return undefined
  const headerOf = (index: number) => rows.slice(0, index + 1).reverse().find((row) => row.kind === "hunk")?.text
  const start = matches.find((index) => headerOf(index) === comment.header) ?? matches[0]!
  return { start, end: start + size - 1 }
}

function numberRange(value: unknown): LineRange | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const { from, to } = value as Record<string, unknown>
  return Number.isInteger(from) && Number.isInteger(to) && (from as number) >= 0 && (to as number) >= (from as number) ? { from: from as number, to: to as number } : undefined
}

function normalizeComment(raw: unknown): ReviewComment | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
  const source = raw as Record<string, unknown>
  const { id, path: file, kind, hunk, header, excerpt, body, createdAt } = source
  if (typeof id !== "string" || !id || typeof file !== "string" || !file || typeof body !== "string" || !body.trim()) return undefined
  if (kind !== "line" && kind !== "hunk" && kind !== "file") return undefined
  if (!Number.isInteger(hunk) || typeof header !== "string" || !Array.isArray(excerpt) || !excerpt.every((row) => typeof row === "string")) return undefined
  const newRange = numberRange(source.newRange)
  const oldRange = numberRange(source.oldRange)
  return {
    id: id.slice(0, 40),
    path: file.slice(0, 1024),
    kind,
    hunk: hunk as number,
    header: header.slice(0, 400),
    excerpt: (excerpt as string[]).slice(0, MAX_EXCERPT_ROWS).map(clipRow),
    ...(newRange ? { newRange } : {}),
    ...(oldRange ? { oldRange } : {}),
    ...(source.author === "user" || source.author === "agent" || source.author === "assistant" ? { author: source.author } : {}),
    ...(source.side === "old" || source.side === "new" || source.side === "both" ? { side: source.side } : {}),
    ...(typeof source.stale === "boolean" ? { stale: source.stale } : {}),
    body: body.slice(0, MAX_BODY),
    createdAt: typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : 0,
  }
}

/** Any parsed JSON as comments: bad entries are dropped and the list is capped. */
export function normalizeComments(raw: unknown): ReviewComment[] {
  const list = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>).comments : undefined
  if (!Array.isArray(list)) return []
  const out: ReviewComment[] = []
  for (const entry of list) {
    const comment = normalizeComment(entry)
    if (comment && !out.some((known) => known.id === comment.id)) out.push(comment)
  }
  return out.slice(0, MAX_COMMENTS)
}

