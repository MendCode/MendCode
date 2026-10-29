import type { ColorName, Line } from "../ui/theme"
import { clip } from "./deck"
import { truncateEnd } from "./session-list"

const MIN_ROWS = 6
const SCREEN_SHARE = 0.4

/** Splits an approval detail into its first line (path or command) and the preview below the blank line. Undefined for one-line details. */
export function splitApprovalDetail(detail: string): { head: string; preview: string[] } | undefined {
  const parts = detail.split("\n")
  if (parts.length < 2) return undefined
  const rest = parts.slice(1)
  if (rest[0] === "") rest.shift()
  while (rest.length > 0 && rest[rest.length - 1] === "") rest.pop()
  return rest.length > 0 ? { head: parts[0] as string, preview: rest } : undefined
}

/** How many preview lines fit (the hint line included when the preview overflows) and how far it can scroll. */
export function approvalWindow({ total, screenHeight }: { total: number; screenHeight: number }): { rows: number; maxScroll: number; overflow: boolean } {
  const cap = Math.max(MIN_ROWS, Math.floor(screenHeight * SCREEN_SHARE))
  const overflow = total > cap
  const rows = overflow ? cap - 1 : total
  return { rows, maxScroll: Math.max(0, total - rows), overflow }
}

function color(line: string): { fg: ColorName; bold?: boolean; dim?: boolean } {
  if (line.startsWith("@@")) return { fg: "heading" }
  if (line.startsWith("***")) return { fg: "primary", bold: true }
  if (line.startsWith("+")) return { fg: "success" }
  if (line.startsWith("-")) return { fg: "error" }
  if (line.startsWith("… ")) return { fg: "muted", dim: true }
  return { fg: "body" }
}

/** The diff box shown under an approval title: `rows` are ready to draw, `scroll` is the clamped offset used. */
export function renderApprovalDiff({ detail, width, screenHeight, scroll }: { detail: string; width: number; screenHeight: number; scroll: number }): { head: string; rows: Line[]; scroll: number } | undefined {
  const split = splitApprovalDetail(detail)
  if (!split) return undefined
  const { rows: windowRows, maxScroll, overflow } = approvalWindow({ total: split.preview.length, screenHeight })
  const offset = Math.max(0, Math.min(scroll, maxScroll))
  const inner = Math.max(1, width - 2)
  const rows: Line[] = split.preview.slice(offset, offset + windowRows).map((text) => [{ text: "  " }, { text: truncateEnd(text, inner), ...color(text) }])
  if (overflow) {
    const above = offset
    const below = split.preview.length - offset - windowRows
    const parts = [...(above > 0 ? [`↑ ${above} above`] : []), ...(below > 0 ? [`… ${below} more lines`] : [])]
    rows.push([{ text: truncateEnd(`  ${parts.join(" · ")} · pgup/pgdn`, width), fg: "muted", dim: true }])
  }
  return { head: split.head, rows, scroll: offset }
}

export type ReviewerVerdict = "allow" | "ask" | "deny"
/** What smart mode appended to an approval's detail: the rule that asked and, when a reviewer model ran, its verdict and reason. */
export type ApprovalReview = { detail: string; why?: string; reviewer?: { verdict: ReviewerVerdict; reason: string; note?: string } }

const WHY_MARK = "\n\nWhy it asks: "
const REVIEWER_LINE = /^Reviewer: (allow|ask|deny)(?: — (.*?))?(?: \((this kind of call always asks)\))?$/

/**
 * Splits the trailer smart mode adds to an approval's detail ("Why it asks: <reason> (<rule>)" and, when a reviewer ran,
 * "Reviewer: <verdict> — <reason>") from the call itself. The daemon sends it as text in the detail (there is no separate
 * field); only the last such block, and only in its exact shape, is taken, so a file preview that mentions the words is left alone.
 */
export function parseApprovalReview(detail: string): ApprovalReview {
  const at = detail.lastIndexOf(WHY_MARK)
  if (at < 0) return { detail }
  const [why, reviewerLine, ...extra] = detail.slice(at + WHY_MARK.length).split("\n")
  if (!why || extra.length > 0 || why.trim() === "") return { detail }
  const match = reviewerLine === undefined ? undefined : REVIEWER_LINE.exec(reviewerLine)
  if (reviewerLine !== undefined && !match) return { detail }
  const reviewer = match ? { verdict: match[1] as ReviewerVerdict, reason: match[2] ?? "", ...(match[3] ? { note: match[3] } : {}) } : undefined
  return { detail: detail.slice(0, at), why, ...(reviewer ? { reviewer } : {}) }
}

const VERDICT_COLOR: Record<ReviewerVerdict, ColorName> = { allow: "success", ask: "warning", deny: "error" }

/** The rows under an approval's preview: why it asks, and the reviewer's verdict with its reason. Empty without either. */
export function approvalReviewRows(review: ApprovalReview, width: number): Line[] {
  const rows: Line[] = []
  const inner = Math.max(1, width - 2)
  if (review.why) rows.push(clip([{ text: "  " }, { text: truncateEnd(`asks: ${review.why}`, inner), fg: "muted" }], width))
  if (review.reviewer) {
    const { verdict, reason, note } = review.reviewer
    const head = `reviewer ${verdict}`
    const tail = `${reason ? ` — ${reason}` : ""}${note ? ` (${note})` : ""}`
    rows.push(clip([{ text: "  " }, { text: head, fg: VERDICT_COLOR[verdict], bold: true }, { text: truncateEnd(tail, Math.max(0, inner - head.length)), fg: "muted" }], width))
  }
  return rows
}
