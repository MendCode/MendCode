import type { BlobRef, ItemId, RewindReport } from "@mendcode/protocol"
import type { ColorName, Line, Span } from "../ui/theme"
import { fit, panelGrid } from "./deck"
import { truncateEnd } from "./session-list"
import { textWidth, wrap } from "./wrap"

/**
 * The card `/undo` and `/redo` leave over the transcript: what the daemon's `RewindReport` says was put back, what it
 * could not track, and, when the daemon refused because files changed after the turn, the files in question and the
 * one key that overrides it.
 */
export type RewindKind = "undo" | "redo"
export type RewindCard = { kind: RewindKind; state: "done"; report: RewindReport } | { kind: RewindKind; state: "conflict"; message: string; atItemId?: ItemId; prompt?: string; images?: BlobRef[] }

export type RewindCardView = { rows: Line[]; top: number; left: number }

const CARD: ColorName = "panel"
const PADDING = 2
const MAX_WIDTH = 100
const MAX_PATHS = 4
/** `send force to do it anyway`: the daemon's refusal for files changed after the turn (docs/sessions.md, Conflicts). */
const CONFLICT_MARK = /send force/

/** True for the refusal that `force: true` would override. */
export function isRewindConflict(error: { code: string; message: string }): boolean {
  return error.code === "target_mismatch" && CONFLICT_MARK.test(error.message)
}

/** Notes the shell and history rows already say. */
const SAID_ABOVE = /external engine|not tracked: files a command changed|Only captured worktree files/

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

function pathList(paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_PATHS).join(", ")
  return paths.length > MAX_PATHS ? `${shown} +${paths.length - MAX_PATHS} more` : shown
}

type Row = { label: string; text: string; fg: ColorName }

/** The report as labelled rows, in the order a reader needs them: files, what is not covered, the model's history, notes. */
export function rewindRows(kind: RewindKind, report: RewindReport): Row[] {
  const rows: Row[] = []
  const { restored, removed, skipped } = report.files
  const backToward = kind === "undo" ? "restored" : "re-applied"
  if (restored.length) rows.push({ label: backToward, text: `${plural(restored.length, "file")}: ${pathList(restored)}`, fg: "text" })
  if (removed.length) rows.push({ label: "removed", text: `${plural(removed.length, "file")}: ${pathList(removed)}`, fg: "text" })
  if (skipped.length) rows.push({ label: "skipped", text: skipped.slice(0, MAX_PATHS).map((entry) => `${entry.path} (${entry.reason.replace("_", " ")})`).join(", ") + (skipped.length > MAX_PATHS ? ` +${skipped.length - MAX_PATHS} more` : ""), fg: "warning" })
  if (!restored.length && !removed.length && !skipped.length) rows.push({ label: "files", text: "none changed", fg: "muted" })
  if (report.changes?.length) rows.push({ label: "diff", text: pathList(report.changes.map((file) => `${file.path} +${file.additions} −${file.deletions}`)), fg: "text" })
  if (report.shellUntracked) rows.push({ label: "shell", text: report.worktreeTracked ? "worktree files captured; other shell effects remain" : "the turn ran shell commands: what they changed is not tracked and stays as it is", fg: "warning" })
  rows.push(
    report.history.tracked
      ? { label: "history", text: `${plural(report.history.messages, "model message")} ${kind === "undo" ? "taken out" : "put back"}`, fg: "muted" }
      : { label: "history", text: "the engine still remembers this turn", fg: "warning" },
  )
  // The daemon's notes repeat the shell and history rows above for clients that draw only notes; here each fact is said once.
  for (const note of report.notes) if (!SAID_ABOVE.test(note)) rows.push({ label: "note", text: note, fg: "muted" })
  return rows
}

/** The title, body lines and hint of a card. */
function content(card: RewindCard, inner: number): { title: string; body: Array<{ text: string; fg: ColorName; label?: string }>; hint: string } {
  if (card.state === "conflict") {
    const message = card.message.replace(/; send force to do it anyway$/, "")
    const split = message.indexOf(" to ")
    const parts = split >= 0 ? [message.slice(0, split + 3), message.slice(split + 4)] : [message]
    const body = parts.flatMap((part) => wrap(part, inner)).map((text) => ({ text, fg: "warning" as const }))
    return { title: `${card.kind}: files changed since`, body, hint: `y overwrite them and ${card.kind} · esc cancel` }
  }
  const turns = plural(card.report.turnIds.length, "turn")
  return { title: card.kind === "undo" ? `undone · ${turns}` : `redone · ${turns}`, body: rewindRows(card.kind, card.report).map((row) => ({ text: row.text, fg: row.fg, label: row.label })), hint: card.kind === "undo" ? "/redo brings it back until something new is sent" : "esc closes" }
}

/** A card's content: a title, rows (labelled ones keep their text in a column) and the one line of keys under them. */
export type InfoCard = { title: string; body: Array<{ text: string; fg: ColorName; label?: string }>; hint: string }

/** The undo/redo card floating over the transcript with its bottom at `bottom`; undefined when there is no room for it. */
export function renderRewindCard(input: { card: RewindCard; width: number; bottom: number }): RewindCardView | undefined {
  const width = input.width - 4
  if (width < 30 || input.bottom < 6) return undefined
  const card = content(input.card, Math.max(8, width - 14))
  const hint = input.card.state === "conflict" ? `y overwrite · esc cancel` : input.card.kind === "undo" || input.card.report.canRedo ? "/redo restore · esc close" : "esc close"
  const title = input.card.state === "conflict" ? `${input.card.kind}: files changed since` : card.title
  const room = Math.max(0, width - textWidth(title) - textWidth(hint) - 1)
  const head = fit([{ text: title, fg: "accent", bold: true }, { text: " ".repeat(room) }, { text: hint, fg: "muted" }], width)
  const body: Line[] = card.body.flatMap((row) => {
    const label = row.label ? row.label.padEnd(Math.max(10, row.label.length + 1)) : ""
    return wrap(row.text, Math.max(8, width - 4 - label.length)).map((piece, index) => [{ text: index === 0 ? label : " ".repeat(label.length), fg: "accent" as const }, { text: piece, fg: row.fg }])
  })
  const height = Math.min(input.bottom - 1, body.length + 2)
  const rows = [head, ...panelGrid({ width, rows: [[{ title: "Files & history", body }]], heights: [height], padding: false, compact: false })]
  return { rows, top: Math.max(0, input.bottom - rows.length), left: 2 }
}

/** Any `InfoCard` in the same frame as the undo card (`/goal` uses it for its summary and its questions). */
export function renderInfoCard(input: { card: InfoCard; width: number; bottom: number }): RewindCardView | undefined {
  const cardWidth = Math.min(MAX_WIDTH, input.width - 4)
  if (cardWidth < 30 || input.bottom < 6) return undefined
  const inner = cardWidth - PADDING * 2
  const painted = (spans: Span[]): Line => [{ text: " ".repeat(PADDING), bg: CARD }, ...fit(spans, inner).map((span) => ({ ...span, bg: span.bg ?? CARD })), { text: " ".repeat(PADDING), bg: CARD }]
  const blank = painted([])
  const { title, body, hint } = input.card
  const lines: Line[] = body.flatMap((row): Line[] => {
    const { label } = row
    if (!label) return wrap(row.text, inner).map((piece) => painted([{ text: piece, fg: row.fg }]))
    const pieces = wrap(row.text, Math.max(8, inner - 10))
    return pieces.map((piece, index) => painted([{ text: (index === 0 ? label : "").padEnd(10), fg: "muted" }, { text: piece, fg: row.fg }]))
  })
  const head = painted([{ text: truncateEnd(title, inner - 6), fg: "accent", bold: true }, { text: " ".repeat(Math.max(1, inner - title.length - 3)) }, { text: "esc", fg: "muted" }])
  const rows = [blank, head, blank, ...lines.slice(0, Math.max(1, input.bottom - 6)), blank, painted([{ text: hint, fg: "muted" }]), blank]
  return { rows, top: Math.max(0, input.bottom - rows.length), left: Math.max(0, Math.floor((input.width - cardWidth) / 2)) }
}
