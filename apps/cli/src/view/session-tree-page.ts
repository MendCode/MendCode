import type { SessionTreeNode } from "@mendcode/protocol"
import { isCompact } from "../ui/breakpoints"
import { glyphs as defaultGlyphs, type ColorName, type Glyphs, type Line, type Span } from "../ui/theme"
import { fit, panelGrid } from "./deck"
import { compact } from "./format"
import { modelLabel } from "./model-label"
import { kvList } from "./page"
import { pickerFrame } from "./picker-frame"
import { FILTER_NAME, isMessage, labelOf, previewOf, treeCounts, treeRows, type TreeMark, type TreeModel, type TreeNode, type TreeRow } from "./session-tree"
import type { TreeState } from "./session-tree-keys"
import { formatDuration, todayTimeOrDateTime } from "./time"
import { textWidth, truncateEnd, wrap } from "./wrap"

/**
 * /tree and /timeline: the open session's messages, its forks and its sub-agents as one tree (the model is `session-tree.ts`,
 * the keys `session-tree-keys.ts`). The page is the sessions page's frame: keys in the header, one summary line, the list with
 * the selected node's detail beside it (below it on a narrow screen).
 */
export type BranchStats = { input: number; output: number; cacheRead: number; ms: number; turns: number }

const STATE_COLOR: Record<string, ColorName> = { running: "primary", queued: "muted", needs_input: "warning", completed: "success", failed: "error", cancelled: "muted", interrupted: "warning", idle: "muted" }
const TASK_LIVE = new Set(["queued", "running", "needs_input"])
const isTask = (session: SessionTreeNode) => session.kind === "task"
/** On a narrow screen the selected node's detail sits under the list when the list keeps at least this many rows. */
const STACK_LIST_MIN = 8
const DETAIL_ROWS = 5

/** What a session row says after its title: a sub-agent's agent, model and state, a fork's activity and merge debt. */
export function nodeSuffix(session: SessionTreeNode, label: (id: string) => string = (id) => modelLabel(id)): string {
  if (isTask(session)) return [session.agent, session.model ? label(session.model) : undefined, session.state].filter(Boolean).join(" · ")
  return [session.state === "running" ? "running" : "", session.unmerged ? `+${session.unmerged} unmerged` : ""].filter(Boolean).join(" · ")
}

/** `12K tok · 3m 12s`: what the branch cost so far; nothing for a session that has not worked yet. */
export function statsText(stats: BranchStats | undefined): string {
  if (!stats) return ""
  const tokens = stats.input + stats.output
  return [tokens > 0 ? `${compact(tokens)} tok` : "", stats.ms > 0 ? formatDuration(stats.ms) : ""].filter(Boolean).join(" · ")
}

/** The header's keys, for what is selected: only keys that work on it. */
export function treeHints(row: TreeRow | undefined, state: TreeState, pick: boolean, narrow = false): string {
  if (state.label !== undefined) return narrow ? "type a label · enter · esc" : "type a label · enter save · empty clears · esc cancel"
  const node = row?.node
  // A narrow header keeps the first keys that fit, so the ones every row has come first and the words are short.
  const parts = [narrow ? "↑↓" : "↑↓ move"]
  if (node?.kind === "message") parts.push(pick ? "enter fork here" : narrow ? "enter" : "enter jump")
  else if (node) parts.push(narrow ? "enter" : "enter open")
  parts.push("tab filter", narrow ? "type search" : "type to search")
  if (node?.kind === "message" && !pick) parts.push("^F fork")
  if (node && isMessage(node)) parts.push(narrow ? "^L mark" : "^L bookmark")
  if (row?.foldable) parts.push("←→ fold")
  if (node) parts.push("^Y copy")
  if (node?.kind === "session") parts.push("^R recap")
  if (node?.kind === "session" && node.session.parentId && !isTask(node.session)) parts.push("^B merge")
  if (node?.kind === "message") parts.push("^A actions")
  parts.push(state.query ? "esc clear" : narrow ? "esc" : "esc back")
  return parts.join(" · ")
}

type Piece = { text: string; fg?: ColorName; bold?: boolean; strike?: boolean }

/** `fixed` always shows; `title` takes what is left; each optional piece shows only when the title keeps room to read. */
function compose(fixed: Span[], title: Piece, optional: Piece[], width: number): Line {
  const used = fixed.reduce((sum, span) => sum + textWidth(span.text), 0)
  const floor = Math.min(textWidth(title.text), 14)
  let extra = 0
  const shown: Piece[] = []
  for (const piece of optional) {
    if (!piece.text) continue
    const cost = textWidth(piece.text) + 2
    if (used + floor + extra + cost > width) continue
    shown.push(piece)
    extra += cost
  }
  const room = Math.max(1, width - used - extra)
  return fit([...fixed, { ...title, text: truncateEnd(title.text, room) }, ...shown.flatMap((piece): Span[] => [{ text: "  " }, piece])], width)
}

type Look = { width: number; selected: boolean; now: number; glyphs: Glyphs; label: (id: string) => string; stats: ReadonlyMap<string, BranchStats>; filter: TreeState["filter"]; numberWidth: number; timeWidth: number }

function sessionLine(row: TreeRow, look: Look): Line {
  const node = row.node
  const session = node.session
  const task = isTask(session)
  const on = look.selected
  const color = STATE_COLOR[session.state ?? ""] ?? "muted"
  const lead: Span = on ? { text: `${look.glyphs.user} `, fg: "primary", bold: true } : { text: "  " }
  const fold: Span = { text: row.foldable ? (row.folded ? "▸" : "▾") : " ", fg: "muted" }
  const mark: Span = row.here ? { text: "●", fg: "success" } : { text: task ? "◇" : "○", fg: task ? color : session.current ? "primary" : "muted" }
  const stateText = nodeSuffix(session, look.label)
  const at = !task && session.parentId && session.atPreview && (!node.anchored || look.filter === "branches") ? `⑂ "${session.atPreview}"` : ""
  return compose(
    [lead, { text: row.prefix, fg: "border" }, fold, mark, { text: " " }],
    { text: session.title || "untitled", fg: on || session.current ? "primary" : "body", bold: on || session.current },
    [
      { text: session.archived ? "archived" : "", fg: "muted" },
      { text: stateText, fg: task || session.state === "running" ? color : "muted" },
      // With the messages hidden the cut message is the only place that says where a branch left, so it comes before the cost.
      ...(look.filter === "branches" ? [{ text: at, fg: "muted" as const }] : []),
      { text: statsText(look.stats.get(session.sessionId)), fg: "muted" },
      ...(look.filter === "branches" ? [] : [{ text: at, fg: "muted" as const }]),
    ],
    look.width,
  )
}

function messageLine(row: TreeRow, look: Look): Line {
  const node = row.node
  const entry = node.entry!
  const on = look.selected
  const lead: Span = on ? { text: `${look.glyphs.user} `, fg: "primary", bold: true } : { text: "  " }
  const fold: Span = { text: row.foldable ? (row.folded ? "▸" : "▾") : " ", fg: "muted" }
  const mark: Span = row.here ? { text: "●", fg: "success" } : { text: " " }
  const time = look.timeWidth > 0 ? [{ text: todayTimeOrDateTime(entry.at, look.now).padEnd(look.timeWidth), fg: "muted" as const }, { text: "  " }] : []
  const label = entry.label ? [{ text: `◆ ${truncateEnd(entry.label, Math.max(8, Math.floor(look.width / 4)))}  `, fg: "warning" as const }] : []
  return compose(
    [lead, { text: row.prefix, fg: "border" }, fold, mark, { text: " " }, { text: String(node.number).padStart(look.numberWidth), fg: "muted" }, { text: "  " }, ...time, ...label],
    { text: previewOf(node) || "(no text)", fg: entry.reverted ? "muted" : on ? "primary" : "body", bold: on, ...(entry.reverted ? { strike: true } : {}) },
    [{ text: entry.reverted ? "undone" : "", fg: "warning" }],
    look.width,
  )
}

function markLine(row: TreeRow, look: Look): Line {
  const mark = row.node.mark!
  const on = look.selected
  const lead: Span = on ? { text: `${look.glyphs.user} `, fg: "primary", bold: true } : { text: "  " }
  return compose(
    [lead, { text: row.prefix, fg: "border" }, { text: "  " }, { text: `◆ ${truncateEnd(mark.label, Math.max(8, Math.floor(look.width / 3)))}  `, fg: "warning", bold: on }],
    { text: readable(mark), fg: "muted" },
    [],
    look.width,
  )
}

const readable = (mark: TreeMark) => mark.preview.replace(/\s+/g, " ")

function sessionDetails(node: TreeNode, state: TreeState, look: Look, w: number): Line[] {
  const session = node.session
  const stats = look.stats.get(session.sessionId)
  const loaded = state.summary?.sessionId === session.sessionId ? state.summary : undefined
  const facts = [
    ...(session.model ? [{ label: "model", value: truncateEnd(look.label(session.model), Math.max(4, w - 8)) }] : []),
    ...(session.state ? [{ label: "state", value: session.state.replace("_", " "), tone: STATE_COLOR[session.state] ?? ("text" as ColorName) }] : []),
    ...(isTask(session) && session.agent ? [{ label: "agent", value: session.agent }] : []),
    ...(stats && stats.input + stats.output > 0 ? [{ label: "tokens", value: `${compact(stats.input)} in · ${compact(stats.output)} out` }] : []),
    ...(stats && stats.cacheRead > 0 ? [{ label: "cache read", value: compact(stats.cacheRead) }] : []),
    ...(stats && stats.ms > 0 ? [{ label: "active", value: formatDuration(stats.ms) }] : []),
    ...(stats && stats.turns > 0 ? [{ label: "turns", value: String(stats.turns) }] : []),
    ...(session.unmerged ? [{ label: "unmerged", value: `${session.unmerged} ${session.unmerged === 1 ? "turn" : "turns"}`, tone: "warning" as ColorName }] : []),
    { label: "updated", value: todayTimeOrDateTime(session.updatedAt, look.now) || "unknown" },
    { label: "created", value: todayTimeOrDateTime(session.createdAt, look.now) || "unknown" },
  ]
  return [
    [{ text: truncateEnd(session.title || "untitled", w), fg: "primary", bold: true }],
    [{ text: session.current ? "open session" : isTask(session) ? "sub-agent" : session.parentId ? "branch" : "root session", fg: session.current ? "success" : "muted" }],
    [],
    ...kvList(facts, w),
    ...(session.parentId && !isTask(session) ? [[{ text: "forked at ", fg: "muted" }, { text: session.atPreview ? `"${truncateEnd(session.atPreview, Math.max(4, w - 10))}"` : "the end of its parent", fg: "text" }] as Line] : []),
    ...(isTask(session) && session.headline ? [[], [{ text: "Result", fg: "heading", bold: true }] as Line, ...wrap(session.headline, w).map((text): Line => [{ text, fg: "text" }])] : []),
    [],
    [{ text: "Summary", fg: "heading", bold: true }],
    ...(state.loading === session.sessionId ? [[{ text: "summarizing…", fg: "muted" }] as Line] : loaded?.error ? wrap(loaded.error, w).map((text): Line => [{ text, fg: "warning" }]) : loaded?.text ? loaded.text.split("\n").flatMap((text) => (text ? wrap(text, w) : [""]).map((part): Line => [{ text: part, fg: "text" }])) : [[{ text: "^R summarizes this branch", fg: "muted" }] as Line]),
  ]
}

function messageDetails(node: TreeNode, look: Look, w: number): Line[] {
  if (node.kind === "mark") {
    const mark = node.mark!
    return [
      [{ text: "Bookmark", fg: "warning", bold: true }],
      ...wrap(mark.label, w).map((text): Line => [{ text, fg: "warning" }]),
      [],
      ...wrap(readable(mark), w).map((text): Line => [{ text, fg: "text" }]),
      [],
      [{ text: "in ", fg: "muted" }, { text: truncateEnd(node.session.title || "untitled", Math.max(4, w - 3)), fg: "text" }],
    ]
  }
  const entry = node.entry!
  const label = labelOf(node)
  const branches = node.children.filter((child) => child.kind === "session")
  return [
    [{ text: `Message ${node.number} · ${todayTimeOrDateTime(entry.at, look.now)}`, fg: "primary", bold: true }],
    [{ text: entry.reverted ? "Undone" : "In history", fg: entry.reverted ? "warning" : "muted" }],
    ...(label ? [[{ text: `◆ ${label}`, fg: "warning", bold: true }] as Line] : []),
    [],
    ...wrap(previewOf(node) || "(no text)", w).map((text): Line => [{ text, fg: "text" }]),
    ...(branches.length ? [[], [{ text: "Branches from here", fg: "heading", bold: true }] as Line, ...branches.slice(0, 6).map((child): Line => [{ text: isTask(child.session) ? "◇ " : "○ ", fg: "muted" }, { text: truncateEnd(child.session.title || "untitled", Math.max(4, w - 2)), fg: "text" }])] : []),
  ]
}

/** The few lines a narrow screen has under the list: what the node is, what it cost, and its summary or text. */
function compactDetails(node: TreeNode, state: TreeState, look: Look, w: number): Line[] {
  if (node.kind !== "session") {
    const text = node.kind === "mark" ? readable(node.mark!) : previewOf(node) || "(no text)"
    const head = node.kind === "mark" ? `Bookmark · ${node.mark!.label}` : `Message ${node.number} · ${node.entry!.reverted ? "undone" : "in history"}${labelOf(node) ? ` · ◆ ${labelOf(node)}` : ""}`
    return [[{ text: truncateEnd(head, w), fg: "primary", bold: true }], ...wrap(text, w).map((line): Line => [{ text: line, fg: "text" }])]
  }
  const session = node.session
  const loaded = state.summary?.sessionId === session.sessionId ? state.summary : undefined
  const kind = session.current ? "open session" : isTask(session) ? "sub-agent" : session.parentId ? "branch" : "root session"
  const facts = [kind, session.state?.replace("_", " "), statsText(look.stats.get(session.sessionId))].filter(Boolean).join(" · ")
  const body = state.loading === session.sessionId ? "summarizing…" : loaded?.error ?? loaded?.text ?? (isTask(session) && session.headline ? session.headline : "^R summarizes this branch")
  return [[{ text: truncateEnd(session.title || "untitled", w), fg: "primary", bold: true }], [{ text: truncateEnd(facts, w), fg: "muted" }], ...wrap(body.replace(/\n+/g, " "), w).map((line): Line => [{ text: line, fg: loaded?.error ? "warning" : "text" }])]
}

function emptyText(state: TreeState): string {
  if (state.query) return `no match for "${state.query}"`
  if (state.filter === "labeled") return "no bookmarks yet · ^L bookmarks a message"
  if (state.filter === "messages") return "no messages in this session yet"
  return "nothing to show"
}

/** Renders exactly `height` lines of at most `width` cells. */
export function renderTreePage(input: { model: TreeModel | undefined; error?: string; state: TreeState; stats?: ReadonlyMap<string, BranchStats>; width: number; height: number; now: number; pick?: boolean; glyphs?: Glyphs; /** How a model id reads; the app passes the catalog's names. */ label?: (id: string) => string }): Line[] {
  const { model, state, width, now } = input
  const height = Math.max(0, input.height)
  const room = Math.max(0, height - 2)
  const glyphs = input.glyphs ?? defaultGlyphs()
  const pick = input.pick ?? false
  const frame = (hints: string, body: Line[], summary = "") => pickerFrame("Tree", hints, width, height, body, summary)
  if (!model) return frame(treeHints(undefined, state, pick, isCompact(width)), panelGrid({ width, heights: [room], padding: true, rows: [[{ title: "Tree", body: [[{ text: input.error || "loading tree…", fg: input.error ? "warning" : "muted" }]] }]] }))

  const rows = treeRows(model, state)
  const selected = Math.max(0, Math.min(state.selected, rows.length - 1))
  const row = rows[selected]
  const counts = treeCounts(model)
  const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
  const summary = state.label !== undefined
    ? `label: ${state.label}▏`
    : [
      ...(state.query ? [`search: ${state.query}▏`] : []),
      ...(state.filter !== "all" ? [FILTER_NAME[state.filter]] : []),
      plural(counts.messages, "message"),
      ...(counts.branches ? [plural(counts.branches, "branch", "branches")] : []),
      ...(counts.agents ? [plural(counts.agents, "agent")] : []),
      ...(counts.running ? [`${counts.running} running`] : []),
      ...(counts.bookmarked ? [`${counts.bookmarked} bookmarked`] : []),
    ].join(" · ")

  const messages = rows.flatMap((candidate) => (candidate.node.kind === "message" ? [candidate.node] : []))
  const numberWidth = String(Math.max(1, ...messages.map((node) => node.number ?? 0))).length
  const narrow = isCompact(width)
  const timeWidth = narrow ? 0 : Math.max(0, ...messages.map((node) => textWidth(todayTimeOrDateTime(node.entry!.at, now))))
  const look = (inner: number, on: boolean): Look => ({ width: inner, selected: on, now, glyphs, label: input.label ?? ((id) => modelLabel(id)), stats: input.stats ?? new Map(), filter: state.filter, numberWidth, timeWidth })

  const stacked = narrow && row !== undefined && room - DETAIL_ROWS - 1 >= STACK_LIST_MIN
  const listHeight = stacked ? room - DETAIL_ROWS - 1 : room
  // The window of the list: the box draws a rule and a title (or padding) around it.
  const capacity = Math.max(1, listHeight - (narrow ? 2 : 4))
  const list = {
    title: "Tree",
    weight: 3,
    active: true,
    scroll: Math.max(0, selected + 1 - capacity),
    body: (inner: number): Line[] => rows.length === 0
      ? [[{ text: emptyText(state), fg: "muted" }]]
      : rows.map((candidate, index): Line => {
        const cell = look(inner, index === selected)
        return candidate.node.kind === "session" ? sessionLine(candidate, cell) : candidate.node.kind === "message" ? messageLine(candidate, cell) : markLine(candidate, cell)
      }),
  }
  const detail = {
    title: row?.node.kind === "session" ? "Branch" : row?.node.kind === "mark" ? "Bookmark" : "Message",
    weight: 2,
    body: (inner: number): Line[] => !row ? [] : row.node.kind === "session" ? sessionDetails(row.node, state, look(inner, false), inner) : messageDetails(row.node, look(inner, false), inner),
  }
  const hints = treeHints(row, state, pick, narrow)
  if (!row) return frame(hints, panelGrid({ width, heights: [room], padding: true, rows: [[list]] }), summary)
  if (stacked) return frame(hints, panelGrid({ width, gap: 1, compact: true, heights: [listHeight, DETAIL_ROWS], rows: [[list], [{ ...detail, body: (inner: number) => compactDetails(row.node, state, look(inner, false), inner).slice(0, DETAIL_ROWS - 2) }]] }), summary)
  if (narrow) return frame(hints, panelGrid({ width, heights: [room], padding: true, rows: [[list]] }), summary)
  return frame(hints, panelGrid({ width, heights: [room], padding: true, rows: [[list, detail]] }), summary)
}

// The app reaches the model and the keys through this one lazy module (ui/lazy-pages.ts).
export { buildTree, treeRows } from "./session-tree"
export { createTreeState, settle, treeKey } from "./session-tree-keys"
