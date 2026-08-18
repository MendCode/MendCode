import type { Message, Part } from "@mendcode/sdk/v2"

export type SessionHistoryView = "auto" | "timeline" | "tree" | "pages"
export type SessionHistoryLegacyView = "split" | "chapters"
export type SessionHistoryConfiguredView = SessionHistoryView | SessionHistoryLegacyView
export type SessionHistoryResolvedView = Exclude<SessionHistoryView, "auto">
export type SessionHistorySplit = boolean | "auto"
export type SessionHistoryToolDisplay = "hidden" | "count" | "tree"

export type SessionHistorySettings = {
  enabled?: boolean
  view?: SessionHistoryConfiguredView
  split?: SessionHistorySplit
  page_size?: number
  group_by?: "day" | "none"
  show_tools?: SessionHistoryToolDisplay
  show_subagents?: boolean
  search?: boolean
  remember_position?: boolean
  open_at?: "latest" | "oldest"
  preview_width?: number
  search_page_limit?: number
}

export type ResolvedSessionHistorySettings = {
  enabled: boolean
  view: SessionHistoryResolvedView
  configuredView: SessionHistoryConfiguredView
  split: boolean
  configuredSplit: SessionHistorySplit
  pageSize: number
  groupBy: "day" | "none"
  showTools: SessionHistoryToolDisplay
  showSubagents: boolean
  search: boolean
  rememberPosition: boolean
  openAt: "latest" | "oldest"
  previewWidth: number
  searchPageLimit: number
}

export type SessionHistoryItem = {
  info: Message
  parts: Part[]
  partsMore?: boolean
  partsCursor?: string
}

export type SessionHistoryRow = {
  id: string
  messageID: string
  turnID: string
  parentID?: string
  role: "user" | "assistant"
  kind: "turn" | "response"
  depth: number
  title: string
  preview: string
  searchable: string
  toolCount: number
  subagentCount: number
  created: number
  groupLabel?: string
  item: SessionHistoryItem
  turnItems: SessionHistoryItem[]
}

export const SESSION_HISTORY_DEFAULT_PAGE_SIZE = 50

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)))
}

export function resolveSessionHistorySettings(
  settings: SessionHistorySettings | undefined,
  terminalWidth: number,
  viewOverride?: SessionHistoryView,
  splitOverride?: boolean,
): ResolvedSessionHistorySettings {
  const configuredView = viewOverride ?? settings?.view ?? "auto"
  const legacySplit = configuredView === "split"
  const normalizedView = configuredView === "split" || configuredView === "chapters" ? "timeline" : configuredView
  const automaticView: SessionHistoryResolvedView = terminalWidth >= 76 ? "tree" : "timeline"
  const view = normalizedView === "auto" ? automaticView : normalizedView
  const configuredSplit = splitOverride ?? settings?.split ?? (legacySplit ? true : "auto")
  const split =
    terminalWidth >= 92 && (configuredSplit === true || (configuredSplit === "auto" && terminalWidth >= 118))
  return {
    enabled: settings?.enabled !== false,
    view,
    configuredView,
    split,
    configuredSplit,
    pageSize: clamp(settings?.page_size ?? SESSION_HISTORY_DEFAULT_PAGE_SIZE, 10, 200),
    groupBy: settings?.group_by ?? "day",
    showTools: settings?.show_tools ?? "count",
    showSubagents: settings?.show_subagents !== false,
    search: settings?.search !== false,
    rememberPosition: settings?.remember_position !== false,
    openAt: settings?.open_at ?? "latest",
    previewWidth: clamp(settings?.preview_width ?? 58, 40, 75),
    searchPageLimit: clamp(settings?.search_page_limit ?? 200, 1, 1000),
  }
}

export function sessionHistoryLayout(input: { terminalWidth: number; split: boolean; previewWidth: number }) {
  const paddingX = input.terminalWidth < 56 ? 0 : input.terminalWidth < 92 ? 1 : 2
  const width = Math.max(28, input.terminalWidth - paddingX * 2)
  if (!input.split) return { paddingX, width, listWidth: width, previewWidth: 0 }
  const previewWidth = Math.max(42, Math.floor((width * input.previewWidth) / 100))
  const listWidth = Math.max(32, width - previewWidth - 1)
  return { paddingX, width, listWidth, previewWidth: Math.max(36, width - listWidth - 1) }
}

function visibleText(parts: readonly Part[]) {
  return parts
    .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []))
    .join("\n\n")
    .trim()
}

function previewText(value: string, max = 220) {
  const compact = value.replace(/\s+/g, " ").trim()
  if (!compact) return ""
  return compact.length <= max ? compact : `${compact.slice(0, Math.max(1, max - 1))}…`
}

function toolNames(parts: readonly Part[]) {
  return parts.flatMap((part) => (part.type === "tool" ? [part.tool] : []))
}

function subagentDescriptions(parts: readonly Part[]) {
  return parts.flatMap((part) => (part.type === "subtask" ? [part.description || part.agent] : []))
}

function historyDay(input: number, now: number) {
  const date = new Date(input)
  const current = new Date(now)
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const today = new Date(current.getFullYear(), current.getMonth(), current.getDate()).getTime()
  const difference = Math.round((today - day) / 86_400_000)
  if (difference === 0) return "Today"
  if (difference === 1) return "Yesterday"
  return date.toLocaleDateString(undefined, {
    year: date.getFullYear() === current.getFullYear() ? undefined : "numeric",
    month: "short",
    day: "numeric",
  })
}

type SessionHistoryTurn = {
  id: string
  user?: SessionHistoryItem
  assistants: SessionHistoryItem[]
}

function historyTurns(items: readonly SessionHistoryItem[]) {
  const turns = new Map<string, SessionHistoryTurn>()
  for (const item of items) {
    const turnID = item.info.role === "user" ? item.info.id : item.info.parentID
    const turn = turns.get(turnID) ?? { id: turnID, assistants: [] }
    if (item.info.role === "user") turn.user = item
    else turn.assistants.push(item)
    turns.set(turnID, turn)
  }
  return [...turns.values()].sort((a, b) => {
    const aCreated = a.user?.info.time.created ?? a.assistants[0]?.info.time.created ?? 0
    const bCreated = b.user?.info.time.created ?? b.assistants[0]?.info.time.created ?? 0
    return aCreated - bCreated || a.id.localeCompare(b.id)
  })
}

export function sessionHistoryTurnCount(items: readonly SessionHistoryItem[]) {
  return historyTurns(items).length
}

function rowsFromTurn(turn: SessionHistoryTurn, tree: boolean): SessionHistoryRow[] {
  const items = [turn.user, ...turn.assistants].filter((item): item is SessionHistoryItem => !!item)
  const root = turn.user ?? turn.assistants[0]
  if (!root) return []
  const userText = turn.user ? visibleText(turn.user.parts) : ""
  const meaningfulAssistants = turn.assistants.filter((item) => visibleText(item.parts).length > 0)
  const response = meaningfulAssistants.at(-1)
  const responseText = response ? visibleText(response.parts) : ""
  const tools = items.flatMap((item) => toolNames(item.parts))
  const subagents = items.flatMap((item) => subagentDescriptions(item.parts))
  const searchable = [userText, responseText, ...tools, ...subagents].join(" ").toLocaleLowerCase()
  const turnRow: SessionHistoryRow = {
    id: `turn:${turn.id}`,
    messageID: root.info.id,
    turnID: turn.id,
    parentID: root.info.role === "assistant" ? turn.id : undefined,
    role: root.info.role,
    kind: "turn",
    depth: 0,
    title: previewText(userText, 120) || "Continuation of an earlier turn",
    preview:
      previewText(responseText) || (tools.length > 0 ? "Agent activity without a text response" : "No response text"),
    searchable,
    toolCount: tools.length,
    subagentCount: subagents.length,
    created: turn.user?.info.time.created ?? root.info.time.created,
    item: root,
    turnItems: items,
  }
  if (!tree || !response) return [turnRow]
  return [
    turnRow,
    {
      id: `response:${turn.id}`,
      messageID: response.info.id,
      turnID: turn.id,
      parentID: turn.id,
      role: "assistant",
      kind: "response",
      depth: 1,
      title: previewText(responseText, 120) || "Assistant response",
      preview: previewText(responseText),
      searchable: responseText.toLocaleLowerCase(),
      toolCount: 0,
      subagentCount: 0,
      created: response.info.time.created,
      item: response,
      turnItems: items,
    },
  ]
}

export function sessionHistoryRows(input: {
  items: readonly SessionHistoryItem[]
  view: SessionHistoryResolvedView
  groupBy: "day" | "none"
  query?: string
  collapsed?: ReadonlySet<string>
  now?: number
}) {
  const query = input.query?.trim().toLocaleLowerCase()
  const tree = input.view === "tree"
  const rows: SessionHistoryRow[] = []
  const turns = historyTurns(input.items)
  for (const turn of turns) {
    const turnRows = rowsFromTurn(turn, tree)
    const root = turnRows[0]
    if (!root || (query && !root.searchable.includes(query))) continue
    rows.push(root)
    if (input.collapsed?.has(turn.id)) continue
    rows.push(...turnRows.slice(1))
  }

  if (input.groupBy === "none") return rows
  const now = input.now ?? Date.now()
  let previous = ""
  return rows.map((row) => {
    if (row.kind === "response" || row.depth > 0) return row
    const group = historyDay(row.created, now)
    if (group === previous) return row
    previous = group
    return { ...row, groupLabel: group }
  })
}

const SESSION_HISTORY_VIEW_CYCLE: SessionHistoryResolvedView[] = ["timeline", "tree", "pages"]

export function nextSessionHistoryView(view: SessionHistoryResolvedView) {
  const index = SESSION_HISTORY_VIEW_CYCLE.indexOf(view)
  return SESSION_HISTORY_VIEW_CYCLE[(index + 1) % SESSION_HISTORY_VIEW_CYCLE.length]
}

export function sessionHistoryMissingParentIDs(items: readonly SessionHistoryItem[], limit = 8) {
  if (limit <= 0) return []
  const known = new Set(items.map((item) => item.info.id))
  const missing = new Set<string>()
  for (const item of items) {
    if (item.info.role !== "assistant" || known.has(item.info.parentID)) continue
    missing.add(item.info.parentID)
    if (missing.size >= limit) break
  }
  return [...missing]
}

export function sessionHistoryTurnItems(items: readonly SessionHistoryItem[], selectedMessageID: string | undefined) {
  const selected = items.find((item) => item.info.id === selectedMessageID)
  if (!selected) return []
  const parentID = selected.info.role === "assistant" ? selected.info.parentID : selected.info.id
  return items.filter(
    (item) => item.info.id === parentID || (item.info.role === "assistant" && item.info.parentID === parentID),
  )
}

export function sessionHistorySelectionOffset(key: string) {
  if (key === "j" || key === "down") return 1
  if (key === "k" || key === "up") return -1
  return 0
}

export function sessionHistoryBoundaryVisible(input: { enabled: boolean; hasMoreOlder: boolean }) {
  return input.enabled && input.hasMoreOlder
}
