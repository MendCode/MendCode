import type { TimelineEntry } from "@mendcode/protocol"
import { TREE_FILTERS, isMessage, labelOf, startIndex, treeRows, type TreeFilter, type TreeModel, type TreeNode, type TreeRow } from "./session-tree"

/**
 * The keys of /tree. Typing searches (like /sessions), so every command is an arrow, enter, tab or a control key: `ctrl+f`
 * forks at the message, `ctrl+l` bookmarks it, `ctrl+y` copies the node, `ctrl+r` summarises a branch, `ctrl+b` merges a
 * fork back, `ctrl+a` opens the message's actions. The page only reports what the user asked for; the app does it.
 */
export type TreeSummary = { sessionId: string; text?: string; error?: string }
export type TreeState = {
  selected: number
  /** The key of the selected row, so a reload, a fold or a filter keeps the user's place. Unset until the first `settle`. */
  key?: string
  filter: TreeFilter
  query: string
  folded: readonly string[]
  /** The bookmark being typed (`ctrl+l`); undefined when not editing. */
  label?: string
  summary?: TreeSummary
  loading?: string
}

export type TreeAction =
  | { type: "none" }
  | { type: "close" }
  | { type: "warn"; text: string }
  | { type: "jump"; entry: TimelineEntry }
  | { type: "fork"; entry: TimelineEntry }
  | { type: "open"; node: TreeNode }
  | { type: "label"; node: TreeNode; text: string }
  | { type: "copy"; node: TreeNode }
  | { type: "summary"; node: TreeNode }
  | { type: "merge"; node: TreeNode }
  | { type: "actions"; entry: TimelineEntry }

const NONE: TreeAction = { type: "none" }
const UP = new Set(["\x1b[A", "\x1bOA", "\x10"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "\x0e"])
const LEFT = new Set(["\x1b[D", "\x1bOD"])
const RIGHT = new Set(["\x1b[C", "\x1bOC"])
const TOP = new Set(["\x1b[H", "\x1bOH", "\x1b[1~"])
const BOTTOM = new Set(["\x1b[F", "\x1bOF", "\x1b[4~"])
const PAGE_UP = "\x1b[5~"
const PAGE_DOWN = "\x1b[6~"
const PAGE_STEP = 8
const QUERY_LIMIT = 100
const LABEL_LIMIT = 80

export function createTreeState(filter: TreeFilter = "all"): TreeState {
  return { selected: 0, filter, query: "", folded: [] }
}

const clamp = (value: number, length: number) => Math.max(0, Math.min(value, length - 1))
const printable = (key: string) => key.length > 0 && !/[\x00-\x1f\x7f]/.test(key)
const dropLast = (text: string) => Array.from(text).slice(0, -1).join("")

/** `state` on the row `index` of `rows`: the selection and the key that follows it. */
const at = (state: TreeState, rows: readonly TreeRow[], index: number): TreeState => {
  const selected = clamp(index, rows.length)
  const key = rows[selected]?.key
  return selected === state.selected && key === state.key ? state : { ...state, selected, ...(key ? { key } : {}) }
}

/** After the rows changed (a load, a search, a filter, a fold): back on the same node when it is still there, else on the first match or the open session's place. */
export function settle(state: TreeState, model: TreeModel): TreeState {
  const rows = treeRows(model, state)
  const kept = state.key ? rows.findIndex((row) => row.key === state.key) : -1
  const selected = kept >= 0 ? kept : state.query ? Math.max(0, rows.findIndex((row) => row.match)) : startIndex(rows)
  return at({ ...state, selected: -1 }, rows, selected)
}

/** Handles one raw key (or a pasted run of text). Returns the same state object when nothing changed. */
export function treeKey(state: TreeState, key: string, model: TreeModel): { state: TreeState; action: TreeAction } {
  const rows = treeRows(model, state)
  const selected = clamp(state.selected, rows.length)
  const row = rows[selected]
  const stay = { state, action: NONE }
  const to = (next: TreeState) => ({ state: settle(next, model), action: NONE })

  if (state.label !== undefined) {
    const { label: _done, ...rest } = state
    if (key === "\x1b") return { state: rest, action: NONE }
    if (key === "\r") return { state: rest, action: row ? { type: "label", node: row.node, text: state.label } : NONE }
    if (key === "\x7f" || key === "\b") return { state: { ...state, label: dropLast(state.label) }, action: NONE }
    return printable(key) ? { state: { ...state, label: (state.label + key).slice(0, LABEL_LIMIT) }, action: NONE } : stay
  }

  if (key === "\x1b") return state.query ? to({ ...state, query: "" }) : { state, action: { type: "close" } }
  // A new search starts on its first match, not where the cursor was.
  const searched = (query: string) => { const { key: _moved, ...rest } = state; return to({ ...rest, query }) }
  if (UP.has(key)) return { state: at(state, rows, selected - 1), action: NONE }
  if (DOWN.has(key)) return { state: at(state, rows, selected + 1), action: NONE }
  if (TOP.has(key)) return { state: at(state, rows, 0), action: NONE }
  if (BOTTOM.has(key)) return { state: at(state, rows, rows.length - 1), action: NONE }
  if (key === PAGE_UP) return { state: at(state, rows, selected - PAGE_STEP), action: NONE }
  if (key === PAGE_DOWN) return { state: at(state, rows, selected + PAGE_STEP), action: NONE }
  if (key === "\t" || key === "\x1b[Z") {
    const step = key === "\t" ? 1 : TREE_FILTERS.length - 1
    return to({ ...state, filter: TREE_FILTERS[(TREE_FILTERS.indexOf(state.filter) + step) % TREE_FILTERS.length]! })
  }
  if (key === "\x7f" || key === "\b" || key === "\x15") return state.query ? searched(key === "\x15" ? "" : dropLast(state.query)) : stay
  if (printable(key)) return searched((state.query + key).slice(0, QUERY_LIMIT))
  if (!row) return stay

  if (LEFT.has(key)) {
    if (row.foldable && !row.folded) return to({ ...state, key: row.key, folded: [...state.folded, row.key] })
    const parent = row.parent ? rows.findIndex((other) => other.key === row.parent) : -1
    return parent >= 0 ? { state: at(state, rows, parent), action: NONE } : stay
  }
  if (RIGHT.has(key)) {
    if (row.folded) return to({ ...state, key: row.key, folded: state.folded.filter((folded) => folded !== row.key) })
    return row.foldable ? { state: at(state, rows, selected + 1), action: NONE } : stay
  }
  const node = row.node
  if (key === "\r") {
    if (node.kind === "message") return { state, action: { type: "jump", entry: node.entry! } }
    return { state, action: { type: "open", node } }
  }
  if (key === "\x06") return node.kind === "message" ? { state, action: { type: "fork", entry: node.entry! } } : { state, action: { type: "warn", text: "select a message to fork at" } }
  if (key === "\x0c") return isMessage(node) ? { state: { ...state, label: labelOf(node) ?? "" }, action: NONE } : { state, action: { type: "warn", text: "select a message to bookmark" } }
  if (key === "\x19") return { state, action: { type: "copy", node } }
  if (key === "\x12") return { state, action: { type: "summary", node } }
  if (key === "\x02") return { state, action: { type: "merge", node } }
  if (key === "\x01") return node.kind === "message" ? { state, action: { type: "actions", entry: node.entry! } } : { state, action: { type: "warn", text: "select a message for its actions" } }
  return stay
}
