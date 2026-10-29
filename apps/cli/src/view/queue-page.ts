import type { Line } from "../ui/theme"
import { clip, panelGrid } from "./deck"
import { pickerFrame } from "./picker-frame"
import { wrap } from "./wrap"

export type QueueRowKind = "message" | "shell" | "compact" | "notice"
export type QueueRow = { queueId: string; kind: QueueRowKind; text: string; displayText?: string; attachments: number; editable: boolean; delivery?: "queue" | "steer" | "restart" }
export type QueueEdit = { queueId: string; text: string; cursor: number }
export type QueuePageState = {
  selected: number
  rows: QueueRow[]
  held: boolean
  paused: boolean
  /** The session's queue policy, shown in the header. */
  mode: string
  edit?: QueueEdit | undefined
  /** The row armed for removal: a second `x` drops it. */
  deleting?: string | undefined
  error?: string | undefined
  loaded: boolean
}

export const createQueuePageState = (mode: string): QueuePageState => ({ selected: 0, rows: [], held: false, paused: false, mode, loaded: false })

const label = (row: QueueRow) => row.kind === "compact" ? "compact context" : (row.displayText ?? row.text).replace(/\s+/g, " ").trim() || "(empty)"
const chip = (row: QueueRow) => (row.delivery === "steer" ? "STEER" : row.delivery === "queue" ? "WAIT" : row.delivery === "restart" ? "NEXT" : "")

/** The session's queue as a manageable list: order, delivery and the full text of the selected message. */
export function renderQueuePage(state: QueuePageState, width: number, height: number): Line[] {
  const rows = state.rows
  const selected = rows[state.selected]
  const edit = state.edit
  const hints = edit
    ? "↵ save · ctrl+j newline · esc cancel"
    : state.deleting !== undefined ? "x confirm drop · esc cancel" : "↑↓ select · K/J move · e edit · s steer · p send now · x drop · esc back"
  const list = {
    title: `Queued · ${rows.length}`,
    active: !edit,
    scroll: Math.max(0, state.selected - height + 10),
    body: (w: number): Line[] => rows.length
      ? rows.map((row, index): Line => clip([
        { text: index === state.selected ? "› " : "  ", fg: "primary" },
        { text: `${index + 1}  `, fg: "muted" },
        ...(chip(row) ? [{ text: `${chip(row)} `, fg: "accent" as const, bold: true }] : []),
        ...(row.kind === "shell" ? [{ text: "$ ", fg: "muted" as const }] : []),
        { text: label(row), fg: index === state.selected ? "text" : "body" },
      ], w))
      : [[{ text: state.loaded ? "Nothing queued" : "Reading queue…", fg: "muted" }]],
  }
  const preview = {
    title: edit ? "Edit" : "Message",
    active: Boolean(edit),
    scroll: 0,
    body: (w: number): Line[] => {
      if (edit) {
        const shown = `${edit.text.slice(0, edit.cursor)}▏${edit.text.slice(edit.cursor)}`
        return shown.split("\n").flatMap((part) => wrap(part, Math.max(1, w)).map((text): Line => [{ text, fg: "text" }]))
      }
      if (!selected) return []
      const text = selected.kind === "compact" ? "Compacts the context before the next message." : selected.text
      const notes = [
        ...(selected.attachments ? [`${selected.attachments} attached`] : []),
        ...(selected.delivery === "steer" ? ["Joins the running turn after its next tool result"] : selected.delivery === "queue" ? ["Waits for the response to finish"] : selected.delivery === "restart" ? ["Interrupts the running turn"] : []),
        ...(!selected.editable && selected.kind !== "compact" ? [selected.kind === "notice" ? "System notice: not editable" : "Expanded by a command or mention: not editable"] : []),
      ]
      return [
        ...text.split("\n").flatMap((part) => wrap(part, Math.max(1, w)).map((line): Line => [{ text: line, fg: "body" }])),
        ...(notes.length ? [[] as Line, ...notes.map((note): Line => [{ text: note, fg: "muted" }])] : []),
      ]
    },
  }
  const panels = width >= 70 ? [list, preview] : edit ? [preview] : [list]
  const body = panelGrid({ width, padding: true, compact: false, maxColumns: width < 70 ? 1 : 2, heights: [Math.max(3, height - 2)], rows: [panels] })
  const summary = state.error ? state.error : `queue: ${state.mode}${state.paused ? " · paused" : state.held ? " · held, p sends" : ""}`
  return pickerFrame("Queue", hints, width, height, body, summary)
}
