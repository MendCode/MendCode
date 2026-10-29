import type { DaemonInfoReport, ExtensionsReport, McpStatusReport, ModelsReport, PermissionMode, StorageReport } from "@mendcode/protocol"
import type { ColorName, Line } from "../ui/theme"
import { panelGrid, clip, deck, deckChrome } from "./deck"
import { kvList, section, twoColumns } from "./page"
import { formatBytes } from "./storage-page"
import { truncateEnd } from "./session-list"
import { textWidth } from "./wrap"

/**
 * `/status`: one read-only page for "is everything up and what is it doing": the daemon, the engines, this session,
 * MCP servers, language servers, extensions, storage and versions. Every fact comes from a query the daemon already
 * answers; where none exists the row says `unknown` instead of guessing.
 */

export type StatusPageState = { scroll: number }
export type StatusPageAction = { type: "none" } | { type: "close" } | { type: "refresh" }

export type StatusInput = {
  state: StatusPageState
  width: number
  height: number
  connected: boolean
  cliVersion?: string
  /** Build id from the connection handshake; `info.buildId` wins when the daemon reports one. */
  buildId?: string
  info?: DaemonInfoReport
  infoError?: string
  models?: ModelsReport
  session: { model?: string; effort?: string; permission: PermissionMode; permissionLabel: string; state: string; context?: { tokens: number; threshold: number } }
  mcps?: McpStatusReport
  mcpsError?: string
  extensions?: ExtensionsReport
  extensionsError?: string
  /** Terminal-side extensions loaded by this terminal. */
  terminalExtensions: { loaded: number; problems: number }
  storage?: StorageReport
  storageError?: string
  dataDir?: string
}

const NONE: StatusPageAction = { type: "none" }
const UP = new Set(["\x1b[A", "\x1bOA", "\x10", "k"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "\x0e", "j"])
const PAGE_UP = "\x1b[5~"
const PAGE_DOWN = "\x1b[6~"
const HINTS = ["↑↓ scroll · r refresh · esc back", "↑↓ · r refresh · esc back", "esc back"]
const WIDE_WIDTH = 100
const UNKNOWN = "unknown"

export function createStatusPageState(): StatusPageState {
  return { scroll: 0 }
}

/** Handles one raw key. Returns the same state object when nothing changed. */
export function statusPageKey(state: StatusPageState, key: string): { state: StatusPageState; action: StatusPageAction } {
  if (key === "\x1b" || key === "q") return { state, action: { type: "close" } }
  if (key === "r" || key === "R") return { state, action: { type: "refresh" } }
  const scroll = (by: number) => ({ state: { scroll: Math.max(0, state.scroll + by) }, action: NONE })
  if (UP.has(key)) return scroll(-1)
  if (DOWN.has(key)) return scroll(1)
  if (key === PAGE_UP) return scroll(-10)
  if (key === PAGE_DOWN) return scroll(10)
  return { state, action: NONE }
}

type Fact = { label: string; value: string; tone?: ColorName }

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

const MCP_TONE: Record<McpStatusReport["servers"][number]["state"], ColorName> = { running: "success", starting: "warning", failed: "error", stopped: "muted" }

function tokens(count: number) {
  return count >= 1000 ? `${(count / 1000).toFixed(count >= 100_000 ? 0 : 1).replace(/\.0$/, "")}k` : String(count)
}

function daemonFacts(input: StatusInput): Fact[] {
  const build = input.info?.buildId ?? input.buildId
  return [
    { label: "connection", value: input.connected ? "connected" : "not connected", tone: input.connected ? "success" : "error" },
    { label: "build", value: build ? build.slice(0, 12) : UNKNOWN, ...(build ? {} : { tone: "muted" as const }) },
    { label: "uptime", value: UNKNOWN, tone: "muted" },
    { label: "pid", value: input.info ? String(input.info.pid) : UNKNOWN, ...(input.info ? {} : { tone: "muted" as const }) },
  ]
}

/** The daemon's engine, and whether Claude Code and Codex can run a session, from `daemon.info` and `models.list`. */
function engineFacts(input: StatusInput): Fact[] {
  const { info, models } = input
  const engine = info?.engine ?? models?.engine
  const claude = models ? models.models.filter((model) => model.engine === "claude").length : undefined
  const codexActive = engine === "codex"
  return [
    { label: "daemon engine", value: engine ? [engine, info?.model, info?.effort].filter(Boolean).join(" · ") : (input.infoError ?? UNKNOWN), ...(engine ? {} : { tone: input.infoError ? ("warning" as const) : ("muted" as const) }) },
    { label: "native", value: engine === undefined ? UNKNOWN : engine === "native" ? "active" : "not the active engine", tone: engine === "native" ? "success" : "muted" },
    { label: "claude code", value: claude === undefined ? UNKNOWN : claude > 0 ? `available · ${plural(claude, "model")}` : "not detected", tone: claude === undefined ? "muted" : claude > 0 ? "success" : "muted" },
    {
      label: "codex",
      value: engine === undefined ? UNKNOWN : codexActive ? (info?.login ? (info.login.ok ? "active · login ok" : `active · ${info.login.message ?? "no login"}`) : "active") : "not the active engine",
      tone: codexActive ? (info?.login && !info.login.ok ? "error" : "success") : "muted",
    },
  ]
}

function sessionFacts(input: StatusInput): Fact[] {
  const { session } = input
  const context = session.context
  const ratio = context && context.threshold > 0 ? context.tokens / context.threshold : undefined
  return [
    { label: "model", value: session.model ?? UNKNOWN, ...(session.model ? {} : { tone: "muted" as const }) },
    { label: "effort", value: session.effort ?? "default", ...(session.effort ? {} : { tone: "muted" as const }) },
    { label: "permission", value: session.permissionLabel, tone: session.permission === "full" ? "error" : session.permission === "edits" ? "warning" : "text" },
    { label: "state", value: session.state },
    { label: "context", value: context ? `${tokens(context.tokens)} of ${tokens(context.threshold)} · ${Math.round((ratio ?? 0) * 100)}%` : UNKNOWN, tone: ratio === undefined ? "muted" : ratio >= 0.9 ? "error" : ratio >= 0.7 ? "warning" : "text" },
  ]
}

function mcpFacts(input: StatusInput): Fact[] {
  if (!input.mcps) return [{ label: "servers", value: input.mcpsError ?? UNKNOWN, tone: input.mcpsError ? "warning" : "muted" }]
  const { servers, issues } = input.mcps
  if (servers.length === 0 && issues.length === 0) return [{ label: "servers", value: "none configured", tone: "muted" }]
  const rows: Fact[] = servers.map((server) => ({
    label: server.name,
    value: `${server.enabled ? server.state : "off"} · ${plural(server.tools, "tool")}${server.lastError && server.state === "failed" ? ` · ${server.lastError}` : ""}`,
    tone: server.enabled ? MCP_TONE[server.state] : "muted",
  }))
  if (issues.length > 0) rows.push({ label: "config issues", value: String(issues.length), tone: "warning" })
  return rows
}

function extensionFacts(input: StatusInput): Fact[] {
  const { extensions } = input
  const rows: Fact[] = []
  if (!extensions) rows.push({ label: "daemon", value: input.extensionsError ?? UNKNOWN, tone: input.extensionsError ? "warning" : "muted" })
  else {
    const errors = extensions.extensions.reduce((sum, extension) => sum + extension.errors.length, 0)
    const untrusted = extensions.extensions.filter((extension) => !extension.trusted).length
    rows.push({ label: "found", value: String(extensions.extensions.length), tone: extensions.extensions.length ? "text" : "muted" })
    rows.push({ label: "errors", value: String(errors), tone: errors ? "error" : "muted" })
    if (untrusted > 0) rows.push({ label: "not trusted", value: String(untrusted), tone: "warning" })
  }
  rows.push({ label: "terminal", value: `${input.terminalExtensions.loaded} loaded${input.terminalExtensions.problems ? ` · ${plural(input.terminalExtensions.problems, "problem")}` : ""}`, tone: input.terminalExtensions.problems ? "warning" : "text" })
  return rows
}

function storageFacts(input: StatusInput): Fact[] {
  const { storage } = input
  const dataDir: Fact = { label: "data dir", value: input.info?.dataDir ?? input.dataDir ?? UNKNOWN, ...(input.info?.dataDir ?? input.dataDir ? {} : { tone: "muted" as const }) }
  if (!storage) return [dataDir, { label: "size", value: input.storageError ?? UNKNOWN, tone: input.storageError ? "warning" : "muted" }]
  const total = storage.dbBytes + storage.walBytes + storage.blobBytes
  return [
    dataDir,
    { label: "size", value: formatBytes(total) },
    { label: "sessions", value: String(storage.sessions) },
    { label: "orphan blobs", value: storage.orphanBlobs ? `${storage.orphanBlobs} · ${formatBytes(storage.orphanBytes)}` : "none", tone: storage.orphanBlobs ? "warning" : "muted" },
  ]
}

function versionFacts(input: StatusInput): Fact[] {
  const build = input.info?.buildId ?? input.buildId
  return [
    { label: "terminal", value: input.cliVersion ? (input.cliVersion.startsWith("v") ? input.cliVersion : `v${input.cliVersion}`) : UNKNOWN, ...(input.cliVersion ? {} : { tone: "muted" as const }) },
    { label: "daemon build", value: build ? build.slice(0, 12) : UNKNOWN, ...(build ? {} : { tone: "muted" as const }) },
  ]
}

/** Facts as a titled section; values are cut (never the labels) so every row fits `width`. */
function block(title: string, facts: Fact[], width: number, tone?: ColorName): Line[] {
  const longest = Math.max(1, ...facts.map((fact) => textWidth(fact.label)))
  const rows = facts.map((fact) => ({ ...fact, value: truncateEnd(fact.value, Math.max(4, width - longest - 2)) }))
  return section({ title, body: kvList(rows, width), width, ...(tone ? { titleTone: tone } : {}) })
}

/** Renders exactly `height` lines of at most `width` cells. */
export function renderStatusPage(input: StatusInput): Line[] {
  const { width, height } = input
  if (height <= 0 || width <= 0) return []
  const inner = Math.max(1, width - 2)
  const wide = width >= WIDE_WIDTH
  const column = wide ? Math.floor((inner - 4) / 2) : inner
  const mcp = mcpFacts(input)
  const problems = (input.mcps?.servers.filter((server) => server.enabled && server.state === "failed").length ?? 0) + (input.extensions?.extensions.reduce((sum, extension) => sum + extension.errors.length, 0) ?? 0) + (input.connected ? 0 : 1)
  const left: Line[] = [
    ...block("Daemon", daemonFacts(input), column, input.connected ? "success" : "error"),
    [],
    ...block("Engines", engineFacts(input), column),
    [],
    ...block("This session", sessionFacts(input), column),
  ]
  const right: Line[] = [
    ...block("MCP servers", mcp, column),
    [],
    ...block("Language servers", [{ label: "LSP", value: UNKNOWN, tone: "muted" }], column),
    [],
    ...block("Extensions", extensionFacts(input), column),
    [],
    ...block("Storage", storageFacts(input), column),
    [],
    ...block("Versions", versionFacts(input), column),
  ]
  const body = wide ? panelGrid({ width: inner, rows: [
    [{ title: "Daemon", body: (w) => block("Daemon", daemonFacts(input), w, input.connected ? "success" : "error").slice(2) }, { title: "This session", body: (w) => block("This session", sessionFacts(input), w).slice(2) }],
    [{ title: "Engines", body: (w) => block("Engines", engineFacts(input), w).slice(2) }, { title: "MCP servers", body: (w) => block("MCP servers", mcp, w).slice(2) }],
    [{ title: "Extensions", body: (w) => block("Extensions", extensionFacts(input), w).slice(2) }, { title: "Storage", body: (w) => block("Storage", storageFacts(input), w).slice(2) }],
    [{ title: "Language servers", body: (w) => block("Language servers", [{ label: "LSP", value: UNKNOWN, tone: "muted" }], w).slice(2) }, { title: "Versions", body: (w) => block("Versions", versionFacts(input), w).slice(2) }],
  ] }) : [...left, [], ...right]
  const hints = HINTS.find((text) => textWidth(text) <= Math.max(20, width - 2))!
  const room = Math.max(0, height - deckChrome(hints, width))
  const scroll = Math.min(input.state.scroll, Math.max(0, body.length - room))
  return deck({
    page: "Status",
    subtitle: input.connected ? "daemon connected" : "daemon not connected",
    ...(problems > 0 ? { status: { label: plural(problems, "problem"), tone: "warn" as const } } : { summary: "all clear" }),
    body: body.map((line) => clip(line, inner)),
    scroll,
    hints,
    width,
    height,
  })
}
