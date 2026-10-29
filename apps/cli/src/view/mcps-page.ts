import type { McpServerState, McpServerStatus, McpStatusReport } from "@mendcode/protocol"
import { glyphs as defaultGlyphs, type ColorName, type Glyphs, type Line } from "../ui/theme"
import type { DeckStatus } from "./deck"
import { clip, fit, panelGrid, spread, type GridPanel } from "./deck"
import { shortenMiddle, truncateEnd } from "./session-list"
import { textWidth, wrap } from "./wrap"
import { catalogEntries, catalogTabs, renderMcpCatalog, type McpCatalogState } from "./mcps-catalog"

export type McpsPageState = McpCatalogState & { selected: number; detailScroll?: number; authUrls?: Record<string, string>; authCopied?: string }

export type McpsPageAction = { type: "none" } | { type: "close" } | { type: "restart" | "auth" | "copyAuth" | "approve" | "reject"; server: string } | { type: "catalog" } | { type: "readResource"; server: string; uri: string; id: string } | { type: "use"; token: string }

const NONE: McpsPageAction = { type: "none" }
const UP = new Set(["\x1b[A", "\x1bOA", "\x10", "k"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "\x0e", "j"])
const MAX_ERROR_LINES = 3

const STATE_COLOR: Record<McpServerState, ColorName> = { running: "success", starting: "warning", failed: "error", stopped: "muted" }

const EXAMPLE = ["{", '  "servers": {', '    "name": { "command": "npx", "args": ["-y", "pkg"] }', "  }", "}"]

export function createMcpsPageState(): McpsPageState {
  return { selected: 0 }
}

const clamp = (value: number, length: number) => Math.max(0, Math.min(value, length - 1))

/** Handles one raw key. Returns the same state object when nothing changed. */
export function mcpsPageKey(state: McpsPageState, key: string, servers: McpServerStatus[]): { state: McpsPageState; action: McpsPageAction } {
  if (state.catalogOpen) {
    const entries = catalogEntries(state)
    const index = clamp(state.catalogSelected ?? 0, entries.length)
    if (key === "\x1b" || key === "q" || key === "x") return { state: { ...state, catalogOpen: false }, action: NONE }
    if (key === "\t") return { state: { ...state, catalogTab: catalogTabs[(catalogTabs.indexOf(state.catalogTab ?? "resources") + 1) % catalogTabs.length]!, catalogSelected: 0, catalogScroll: 0 }, action: NONE }
    if (UP.has(key) || DOWN.has(key)) return { state: { ...state, catalogSelected: clamp(index + (UP.has(key) ? -1 : 1), entries.length), catalogScroll: 0 }, action: NONE }
    if (key === "\x1b[5~" || key === "\x1b[6~") return { state: { ...state, catalogScroll: Math.max(0, (state.catalogScroll ?? 0) + (key === "\x1b[5~" ? -8 : 8)) }, action: NONE }
    if (key === "l") return { state, action: { type: "catalog" } }
    const entry = entries[index]
    if (entry && key === "r" && "uri" in entry) return { state, action: { type: "readResource", server: entry.server, uri: entry.uri, id: entry.id } }
    if (entry && (key === "\r" || key === "\n") && state.catalogTab !== "templates") return { state, action: { type: "use", token: `${state.catalogTab === "prompts" ? "/" : "@"}${state.catalogTab === "prompts" ? entry.id.toLowerCase() : entry.id} ` } }
    return { state, action: NONE }
  }
  const selected = clamp(state.selected, servers.length)
  const target = servers[selected]
  if (target?.pending && (key === "a" || key === "x")) return { state, action: { type: key === "a" ? "approve" : "reject", server: target.name } }
  if (target?.pending && (key === "\x1b[5~" || key === "\x1b[6~")) return { state: { ...state, detailScroll: Math.max(0, (state.detailScroll ?? 0) + (key === "\x1b[5~" ? -5 : 5)) }, action: NONE }
  if (key === "x") return { state: { ...state, catalogOpen: true }, action: { type: "catalog" } }
  const go = (index: number) => {
    const next = clamp(index, servers.length)
    return next === state.selected ? { state, action: NONE } : { state: { ...state, selected: next, detailScroll: 0 }, action: NONE }
  }
  if (key === "\x1b" || key === "q") return { state, action: { type: "close" } }
  if (UP.has(key)) return go(selected - 1)
  if (DOWN.has(key)) return go(selected + 1)
  if (key === "a" && target?.enabled && target.auth === "needs_auth") return { state, action: { type: "auth", server: target.name } }
  if (key === "c" && target && state.authUrls?.[target.name]) return { state, action: { type: "copyAuth", server: target.name } }
  if (key === "r") {
    const target = servers[selected]
    return target?.enabled ? { state, action: { type: "restart", server: target.name } } : { state, action: NONE }
  }
  return { state, action: NONE }
}

function stateLabel(server: McpServerStatus): string {
  if (server.pending) return "pending approval"
  if (server.needsTrust) return "needs trust"
  if (!server.enabled) return "off"
  return server.state === "running" ? `${server.tools} ${server.tools === 1 ? "tool" : "tools"}` : server.state
}

function serverRow({ server, selected, width, nameWidth, glyphs }: { server: McpServerStatus; selected: boolean; width: number; nameWidth: number; glyphs: Glyphs }): Line {
  const color = server.enabled ? STATE_COLOR[server.state] : "muted"
  const label = stateLabel(server)
  const pid = server.pid !== undefined ? `pid ${server.pid}` : ""
  const labelWidth = Math.max(textWidth(label), 8)
  const fixed = 2 + 2 + nameWidth + 1
  const withPid = pid && width - fixed - 1 - labelWidth - 1 - textWidth(pid) >= 8
  const commandWidth = Math.max(0, width - fixed - 1 - (labelWidth + 1) - (withPid ? textWidth(pid) + 1 : 0))
  const command = !server.pending && commandWidth >= 6 ? shortenMiddle(server.command, commandWidth) : ""
  const line: Line = [
    selected ? { text: `${glyphs.user} `, fg: "primary", bold: true } : { text: "  " },
    { text: "● ", fg: color },
    { text: truncateEnd(server.name, nameWidth).padEnd(nameWidth), fg: selected ? "primary" : "text", bold: selected },
    { text: " " },
  ]
  if (command) line.push({ text: command.padEnd(commandWidth), fg: "muted" }, { text: " " })
  line.push({ text: label.padStart(labelWidth), fg: color === "muted" ? "muted" : color })
  if (withPid) line.push({ text: ` ${pid}`, fg: "muted", dim: true })
  return fit(line, width)
}

function detailLines({ server, width, height, url, scroll = 0 }: { server: McpServerStatus; width: number; height: number; url?: string; scroll?: number }): Line[] {
  if (height <= 0) return []
  const lines: Line[] = []
  const inner = Math.max(1, width)
  if (server.pending) {
    const text = ["pending approval", ...server.pending.details, `expires: ${new Date(server.pending.expiresAt).toISOString()}`, "a approve · x reject · pgup/pgdn details"]
    const rows = text.flatMap((value) => wrap(value, inner).map((text): Line => [{ text, fg: "body" }]))
    const start = Math.min(scroll, Math.max(0, rows.length - height))
    return rows.slice(start, start + height)
  }
  lines.push(fit([{ text: truncateEnd(server.name, inner), fg: "text", bold: true }, { text: ` · ${server.enabled ? server.state : "disabled"}`, fg: server.enabled ? STATE_COLOR[server.state] : "muted" }], inner))
  if (server.needsTrust) {
    for (const text of wrap("needs trust: it starts after you trust this project (/trust on, or /tools then t)", inner)) lines.push([{ text, fg: "warning" }])
    return lines.slice(0, height)
  }
  if (server.auth) lines.push(fit([{ text: `auth: ${server.auth}`, fg: "muted" }], inner))
  if (url) {
    lines.push([{ text: "Authorization URL", fg: "primary" }])
    for (const text of wrap(url, inner)) lines.push([{ text, fg: "body" }])
    return lines.slice(0, height)
  }
  if (server.lastError) {
    const wrapped = wrap(server.lastError.replace(/\s+/g, " ").trim(), inner)
    const shown = wrapped.slice(0, MAX_ERROR_LINES)
    if (wrapped.length > MAX_ERROR_LINES) shown[MAX_ERROR_LINES - 1] = truncateEnd(`${shown[MAX_ERROR_LINES - 1]}…`, inner)
    for (const text of shown) lines.push(fit([{ text: truncateEnd(text, inner), fg: "error" }], inner))
  }
  if (server.stderr.length > 0) {
    lines.push([{ text: "stderr", fg: "muted" }])
    const room = Math.max(0, height - lines.length)
    for (const text of server.stderr.slice(-room)) lines.push(fit([{ text: truncateEnd(text, inner), fg: "body", dim: true }], inner))
  } else if (!server.lastError && server.enabled && server.state === "stopped") {
    lines.push(fit([{ text: "starts on first MCP request", fg: "muted" }], inner))
  }
  return lines.slice(0, height)
}

const issueLine = (issue: McpStatusReport["issues"][number], width: number): Line => {
  const prefix = issue.server ? `${issue.server}: ` : ""
  return clip([{ text: `${prefix}${truncateEnd(issue.message, Math.max(1, width - textWidth(prefix)))}`, fg: "warning" }], width)
}

/** The status on the right of the title row: failed servers are an error, starting ones a warning, otherwise nothing. */
function statusOf(servers: McpServerStatus[]): DeckStatus | undefined {
  const failed = servers.filter((s) => s.enabled && s.state === "failed").length
  if (failed > 0) return { label: `${failed} failed`, tone: "error" }
  const starting = servers.filter((s) => s.enabled && s.state === "starting").length
  return starting > 0 ? { label: `${starting} starting`, tone: "warn" } : undefined
}

/** Renders exactly `height` lines of at most `width` cells. */
export function renderMcpsPage(input: { report: McpStatusReport; state: McpsPageState; width: number; height: number; glyphs?: Glyphs }): Line[] {
  const { report, state, width } = input
  const height = Math.max(0, input.height)
  if (state.catalogOpen) return renderMcpCatalog(state, width, height)
  const glyphs = input.glyphs ?? defaultGlyphs()
  const servers = report.servers
  const target = servers[clamp(state.selected, servers.length)]
  const compact = width < 70
  const hints = target?.pending ? "↑↓ · a approve · x reject · pgup/pgdn · esc" : compact ? `↑↓ · r${target?.auth === "needs_auth" ? " · a auth" : ""}${target && state.authUrls?.[target.name] ? " · c copy" : ""} · x catalog · esc` : `↑↓ select · r restart${target?.enabled && target.auth === "needs_auth" ? " · a auth" : ""}${target && state.authUrls?.[target.name] ? " · c copy URL" : ""} · x catalog · esc back`
  const status = statusOf(servers)
  const room = Math.max(0, height - 3)
  const listHeight = compact ? Math.min(9, Math.max(5, Math.min(servers.length + 4, Math.floor(room / 2)))) : room
  const selected = clamp(state.selected, servers.length)
  const count = Math.max(1, Math.min(servers.length, listHeight - 4))
  const start = selected < count ? 0 : selected - count + 1
  const shown = servers.slice(start, start + count)
  const running = servers.filter((server) => server.enabled && server.state === "running").length
  const summary: Line = [{ text: `${running} of ${servers.length} running${shown.length < servers.length ? ` · ${start + 1}-${start + shown.length} shown` : ""}`, fg: "muted" }]
  if (status) summary.push({ text: " · " }, { text: status.label, fg: status.tone === "error" ? "error" : "warning", bold: true })
  if (target && state.authCopied === target.name) summary.push({ text: " · auth URL copied", fg: "success" })
  const rows: Line[] = [spread([{ text: "MCPs · servers", fg: "primary", bold: true }], [{ text: hints, fg: "muted" }], width), spread([], summary, width), []]
  const list: GridPanel = {
    title: "Servers",
    active: true,
    body: (inner) => shown.map((server, offset) => serverRow({ server, selected: start + offset === selected, width: inner, nameWidth: Math.max(4, Math.min(20, Math.floor(inner / 4), Math.max(...servers.map((entry) => textWidth(entry.name))))), glyphs })),
  }
  const detail: GridPanel = {
    title: target ? "Server details" : "Configuration",
    body: (inner) => {
      const lines: Line[] = target ? detailLines({ server: target, width: inner, height: compact ? Math.max(0, room - listHeight - 5) : Math.max(0, room - 4), scroll: state.detailScroll ?? 0, ...(state.authUrls?.[target.name] ? { url: state.authUrls[target.name]! } : {}) }) : [
        ...wrap("no MCP servers · add .mendcode/mcp.json", inner).map((text): Line => [{ text, fg: "muted" }]),
        [],
        ...EXAMPLE.flatMap((value) => wrap(value, inner).map((text): Line => [{ text, fg: "code" }])),
      ]
      for (const issue of report.issues) lines.push(issueLine(issue, inner))
      return lines
    },
  }
  if (!servers.length) rows.push(...panelGrid({ rows: [[detail]], width, heights: [room], compact: false, maxColumns: 1, padding: true }))
  else if (compact) rows.push(...panelGrid({ rows: [[list], [detail]], width, heights: [listHeight, Math.max(0, room - listHeight - 1)], compact: false, maxColumns: 1, padding: true }))
  else rows.push(...panelGrid({ rows: [[list, detail]], width, heights: [room], compact: false, padding: true }))
  return [...rows, ...Array.from({ length: Math.max(0, height - rows.length) }, (): Line => [])].slice(0, height).map((row) => fit(row, width))
}
