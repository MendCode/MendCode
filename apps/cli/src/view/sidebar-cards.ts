import type { ForegroundState } from "@mendcode/protocol"
import type { ColorName, Glyphs, Line, Span } from "../ui/theme"
import type { TodoItem } from "./dock"
import { compact } from "./format"
import { formatCost, formatSpeed, formatTtft } from "./footer"
import { truncateEnd } from "./session-list"
import { resetClock, resetIn } from "./usage-limit"
import type { SessionUsage } from "./usage-notes"
import { cacheHitPercent } from "./usage-notes"
import { lineWidth as widthOf, textWidth } from "./wrap"
import { facts } from "./panel-card"

/**
 * Session panel card bodies: pure functions from plain data to coloured rows. Every row is at most
 * `width` cells, so the bar never re-wraps (and so never flattens) the colours. Glyphs come from the theme, so the
 * plain set and the Nerd Font set both draw.
 */

const LABEL_WIDTH = 9

/** Cuts a row to `width` cells; the span that crosses the edge gets an ellipsis. */
function clip(line: Line, width: number): Line {
  const out: Line = []
  let used = 0
  for (const span of line) {
    const room = width - used
    if (room <= 0) break
    const cells = textWidth(span.text)
    if (cells <= room) {
      out.push(span)
      used += cells
      continue
    }
    out.push({ ...span, text: truncateEnd(span.text, room) })
    break
  }
  return out
}

/** `Label   value`: a muted label in a fixed column and a value that takes the colour of its role. */
export function kv({ label, value, role = "text", width }: { label: string; value: string | readonly Span[]; role?: ColorName; width: number }): Line {
  const head: Span = { text: label.padEnd(LABEL_WIDTH), fg: "muted" }
  const body: Span[] = typeof value === "string" ? [{ text: value, fg: role }] : [...value]
  return clip([head, ...body], width)
}

/** A bar with its percent, coloured by pressure: `warnAt` and above warns, `dangerAt` and above is an error. */
export function gauge({ percent, width, glyphs, warnAt = 75, dangerAt = 90 }: { percent: number; width: number; glyphs: Glyphs; warnAt?: number; dangerAt?: number }): Line {
  const label = ` ${Math.round(percent)}%`
  const cells = Math.max(1, width - label.length)
  const filled = Math.min(cells, Math.max(0, Math.round(Math.min(100, Math.max(0, percent)) / 100 * cells)))
  const color: ColorName = percent >= dangerAt ? "error" : percent >= warnAt ? "warning" : "success"
  return [{ text: glyphs.barFull.repeat(filled), fg: color }, { text: glyphs.barEmpty.repeat(cells - filled), fg: "border" }, { text: label, fg: color }]
}

export const formatDuration = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${String(Math.floor(ms % 60_000 / 1000)).padStart(2, "0")}s`)

export type ToolEntry = { status: "running" | "ok" | "error"; name: string; summary?: string; durationMs?: number }

/** `✓ name summary 1.2s`: the status glyph, the name, what it did (cut first) and how long it took (kept). */
export function toolRow({ tool, width, glyphs }: { tool: ToolEntry; width: number; glyphs: Glyphs }): Line {
  const [glyph, color]: [string, ColorName] = tool.status === "running" ? [glyphs.running, "primary"] : tool.status === "error" ? [glyphs.fail, "error"] : [glyphs.ok, "success"]
  const time = tool.durationMs === undefined ? "" : ` ${formatDuration(tool.durationMs)}`
  const lead: Span[] = [{ text: `${glyph} `, fg: color }, { text: tool.name, fg: "text" }]
  const room = width - widthOf(lead) - time.length - 1
  const summary = tool.summary && room > 3 ? [{ text: ` ${truncateEnd(tool.summary, room)}`, fg: "muted" as const }] : []
  const used = widthOf(lead) + widthOf(summary)
  const stamp = time.trimStart()
  return clip([...lead, ...summary, ...(stamp ? [{ text: " ".repeat(Math.max(1, width - used - stamp.length)) + stamp, fg: "muted" as const }] : [])], width)
}

const BUSY = new Set<ForegroundState>(["generating", "tool", "compacting", "cancelling"])

/** A usage-limit pause as the cards show it: `Limited · resets 2:10 AM (in 3h 12m)`, or `Limited · reset unknown` when the provider gave no time. */
export function limitedText(limit: { resetsAt?: number; now: number; countdown?: boolean }): string {
  if (limit.resetsAt === undefined || limit.resetsAt <= limit.now) return "Limited · reset unknown"
  return `Limited · resets ${resetClock(limit.resetsAt, limit.now)}${limit.countdown ? ` (in ${resetIn(limit.resetsAt, limit.now)})` : ""}`
}
/** The usage card's first row while a turn is paused by the limit; the text is cut to the bar. */
export const limitedRow = (limit: { resetsAt?: number; now: number }, width: number): Line => clip([{ text: limitedText({ ...limit, countdown: true }), fg: "warning", bold: true }], width)

export type AgentCard = { stateLabel: string; state: ForegroundState; model?: string; provider?: string; effort?: string; billing: "Subscription" | "Metered"; permission: string; limited?: { resetsAt?: number; now: number } }
export function agentCard(data: AgentCard, width: number, glyphs: Glyphs): Line[] {
  const stateColor: ColorName = data.state === "error" ? "error" : BUSY.has(data.state) ? "primary" : data.state === "idle" ? "success" : "warning"
  const label = data.stateLabel.charAt(0).toUpperCase() + data.stateLabel.slice(1)
  return [
    kv({ label: "State", value: data.limited ? [{ text: `${glyphs.dot} `, fg: "warning" }, { text: limitedText(data.limited), fg: "warning", bold: true }] : [{ text: BUSY.has(data.state) ? `${glyphs.running} ` : `${glyphs.dot} `, fg: stateColor }, { text: label, fg: stateColor, bold: true }], width }),
    // Model, provider and effort always take their row (a dash until the model report answers), so the card keeps its height.
    kv({ label: "Model", value: data.model ?? "—", role: data.model ? "text" : "muted", width }),
    kv({ label: "Provider", value: data.provider ?? "—", role: data.provider ? "text" : "muted", width }),
    kv({ label: "Effort", value: data.effort ?? "—", role: data.effort ? "text" : "muted", width }),
    kv({ label: "Billing", value: data.billing, width }),
    kv({ label: "Access", value: data.permission, width }),
  ]
}

export type ContextCard = { tokens?: number; compactAt: number; window?: number; cacheMiss?: string }
export function contextCard(data: ContextCard, width: number, glyphs: Glyphs): Line[] {
  if (data.tokens === undefined || data.compactAt <= 0) return [clip([{ text: "Context usage unavailable", fg: "muted" }], width)]
  const percent = Math.max(0, data.tokens / data.compactAt * 100)
  // Three rows whatever is known: a cache miss takes the window row's place while it lasts, an unknown window stays a quiet dash.
  const third = data.cacheMiss ? kv({ label: "Cache", value: data.cacheMiss, role: "warning", width }) : kv({ label: "Window", value: data.window ? `${Math.round(data.tokens / data.window * 100)}% · ${compact(data.window)}` : "—", role: "muted", width })
  return [
    gauge({ percent, width, glyphs }),
    clip([{ text: `${data.tokens.toLocaleString()} / ${data.compactAt.toLocaleString()} compact`, fg: "text" }], width),
    third,
  ]
}

export type ActivityCard = { running: boolean; turnMs?: number; firstTokenMs?: number | null; speed?: number; speedEstimated?: boolean; tools: ToolEntry[]; done: number; failed: number }
export function activityCard(data: ActivityCard, width: number, glyphs: Glyphs): Line[] {
  const rows: Line[] = []
  if (data.turnMs !== undefined) rows.push(kv({ label: data.running ? "Running" : "Last run", value: formatDuration(data.turnMs), width }))
  if (data.firstTokenMs != null) rows.push(kv({ label: "First", value: formatTtft(data.firstTokenMs), role: data.firstTokenMs > 8_000 ? "warning" : "text", width }))
  if (data.speed !== undefined) rows.push(kv({ label: "Output", value: `${data.speedEstimated ? "~" : ""}${formatSpeed(data.speed)}`, width }))
  if (!rows.length && !data.tools.length) return [[{ text: "No activity yet", fg: "muted" }]]
  rows.push(...data.tools.map((tool) => toolRow({ tool, width, glyphs })))
  if (data.done + data.failed > 0) rows.push([{ text: `${data.done} done`, fg: "muted" }, ...(data.failed ? [{ text: ` · ${data.failed} failed`, fg: "error" as const }] : [])])
  return rows
}

export type WorkspaceCard = { project?: string; branch?: string; ahead?: number; behind?: number; conflicts?: number; dirty?: number; files: number; added: number; removed: number; untracked?: number; changesKnown: boolean; turns: number; storageBytes?: number; error?: string; checking?: boolean }
const bytes = (value: number) => (value >= 1_048_576 ? `${(value / 1_048_576).toFixed(1)} MB` : value >= 1024 ? `${Math.round(value / 1024)} KB` : `${value} B`)
export function workspaceCard(data: WorkspaceCard, width: number): Line[] {
  const state: [string, ColorName] = data.conflicts ? ["Conflicts", "error"] : (data.dirty ?? data.files) > 0 ? ["Modified", "warning"] : ["Clean", "success"]
  const rows: Line[] = []
  if (data.project) rows.push(kv({ label: "Repo", value: data.project, width }))
  if (data.branch) {
    rows.push(kv({ label: "Branch", value: data.branch, width }))
    rows.push(kv({ label: "State", value: state[0], role: state[1], width }))
    if (data.ahead !== undefined && data.behind !== undefined && data.ahead + data.behind > 0) rows.push(kv({ label: "Remote", value: `${data.ahead} ahead · ${data.behind} behind`, width }))
  } else rows.push(kv({ label: "Git", value: data.checking ? "checking…" : data.error ?? "No Git repository", role: "muted", width }))
  if (data.changesKnown) rows.push(kv({ label: "Changes", value: data.files > 0 ? [{ text: `${data.files} file${data.files === 1 ? "" : "s"} `, fg: "text" }, { text: `+${data.added}`, fg: "success" }, { text: ` -${data.removed}`, fg: "error" }] : "none", role: data.files ? "text" : "muted", width }))
  if (data.untracked) rows.push(kv({ label: "New", value: `${data.untracked} untracked`, role: "muted", width }))
  rows.push(kv({ label: "History", value: `${data.turns} turn${data.turns === 1 ? "" : "s"}`, width }))
  if (data.storageBytes !== undefined) rows.push(kv({ label: "Storage", value: bytes(data.storageBytes), width }))
  return rows
}

export type TokensCard = { usage: SessionUsage; costMicros?: number; subscription: boolean; model?: string }
export function tokensCard(data: TokensCard, width: number): Line[] {
  const { usage } = data
  if (usage.calls === 0) return [[{ text: "No model calls yet", fg: "muted" }]]
  const hit = cacheHitPercent(usage)
  const cost: Span[] = data.costMicros === undefined ? [{ text: "unpriced", fg: "muted" }] : [{ text: formatCost(data.costMicros), fg: "text" }, ...(data.subscription ? [{ text: " (sub)", fg: "muted" as const }] : [])]
  return [
    facts(`Input ${compact(usage.input + usage.cacheRead + usage.cacheWrite)}`, `Output ${compact(usage.output + usage.reasoning)}`, width),
    facts(`Cache ${compact(usage.cacheRead)}`, `Hit ${hit === undefined ? "n/a" : `${hit}%`}`, width),
    kv({ label: "Cost", value: cost, width }),
    ...(data.model ? [kv({ label: "Model", value: data.model, role: "muted", width })] : []),
  ]
}

export type ToolsCard = { enabled?: number; total?: number; names?: string[]; error?: string }
export function toolsCard(data: ToolsCard, width: number): Line[] {
  if (data.enabled === undefined || data.total === undefined) return [[{ text: data.error ?? "Tool list unavailable", fg: "muted" }]]
  const rows: Line[] = [kv({ label: "Enabled", value: `${data.enabled} / ${data.total}`, width })]
  const names = data.names ?? []
  const column = Math.floor((width - 1) / 2)
  for (let index = 0; index < names.length; index += 2) {
    const left = truncateEnd(names[index]!, column).padEnd(column)
    rows.push(clip([{ text: left, fg: "muted" }, { text: " " }, { text: names[index + 1] ? truncateEnd(names[index + 1]!, column) : "", fg: "muted" }], width))
  }
  return rows
}

const TODO_ROWS = 6

/** `3/5` then one row per item, whether or not a turn is running, so the card never changes height when a turn starts. Past six, finished items leave first and a count line says how many are not shown. */
export function todosCard({ items, width, glyphs }: { items: readonly TodoItem[]; width: number; glyphs: Glyphs }): Line[] {
  if (!items.length) return [[{ text: "No todos", fg: "muted" }]]
  const done = items.filter((item) => item.status === "done").length
  let shown = [...items]
  for (let at = 0; shown.length > TODO_ROWS && at < shown.length;) {
    if (shown[at]!.status === "done") shown.splice(at, 1)
    else at++
  }
  shown = shown.slice(0, TODO_ROWS)
  const mark: Record<TodoItem["status"], [string, ColorName]> = { done: [glyphs.ok, "success"], in_progress: ["▸", "warning"], cancelled: ["×", "error"], pending: ["□", "text"] }
  return [
    [{ text: `${done}/${items.length}`, fg: done === items.length ? "success" : "text", bold: true }, { text: " done", fg: "muted" }],
    ...shown.map((item): Line => clip([{ text: `${mark[item.status][0]} `, fg: mark[item.status][1] }, ...(item.priority ? [{ text: `${item.priority} · `, fg: "muted" as const }] : []), { text: item.text, fg: item.status === "done" ? "muted" : "text" }], width)),
    ...(items.length > shown.length ? [[{ text: `+${items.length - shown.length} more`, fg: "muted" as const }] as Line] : []),
  ]
}

export type AgentEntry = { title: string; status: ToolEntry["status"]; durationMs?: number }
/** Sub-agent task cards: a status glyph, the task title and its time, with a count line when there is more than one. */
export function agentsCard(entries: readonly AgentEntry[], width: number, glyphs: Glyphs): Line[] {
  if (!entries.length) return [[{ text: "No sub-agents", fg: "muted" }]]
  const running = entries.filter((entry) => entry.status === "running").length
  const failed = entries.filter((entry) => entry.status === "error").length
  const rows = entries.map((entry) => toolRow({ tool: { status: entry.status, name: entry.title, ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }) }, width, glyphs }))
  return entries.length > 1 ? [[{ text: `${running} running`, fg: running ? "primary" : "muted" }, { text: ` · ${entries.length - running - failed} done`, fg: "muted" }, ...(failed ? [{ text: ` · ${failed} failed`, fg: "error" as const }] : [])], ...rows] : rows
}

/** One session of the lineage the agents card draws: a sub-agent (`task`) or a fork, with the model it runs on and its state. */
export type AgentNode = { sessionId: string; parentId?: string | undefined; kind: "fork" | "task"; title: string; model?: string | undefined; state?: string | undefined; agent?: string | undefined; headline?: string | undefined; unmerged?: number | undefined }

const AGENT_LIVE = new Set(["running", "queued", "needs_input"])
const AGENT_STATE_WORD: Record<string, string> = { running: "running", queued: "queued", needs_input: "needs input", completed: "done", failed: "failed", cancelled: "cancelled", interrupted: "interrupted", idle: "idle" }
const AGENT_NODE_ROWS = 8

/**
 * The agents card as a tree: the sub-agents and forks below the open session, each with its state, the model it runs on
 * and, for a finished sub-agent, the first line of its result. A count line leads (`2 running · 1 done`); long trees show
 * the first rows and `+N more` (the full tree is `/tree`). Every row is at most `width` cells.
 */
export function agentsTreeCard({ nodes, rootId, width, glyphs, maxNodes = AGENT_NODE_ROWS, compact = false }: { nodes: readonly AgentNode[]; rootId: string; width: number; glyphs: Glyphs; maxNodes?: number; compact?: boolean }): Line[] {
  const children = new Map<string, AgentNode[]>()
  for (const node of nodes) if (node.parentId) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node])
  const below: Array<{ node: AgentNode; prefix: string; rail: string }> = []
  const seen = new Set<string>([rootId])
  const walk = (parent: string, indent: string) => {
    const kids = (children.get(parent) ?? []).filter((kid) => !seen.has(kid.sessionId))
    kids.forEach((node, index) => {
      if (seen.has(node.sessionId)) return
      seen.add(node.sessionId)
      const last = index === kids.length - 1
      below.push({ node, prefix: `${indent}${last ? "└─ " : "├─ "}`, rail: `${indent}${last ? "   " : "│  "}` })
      walk(node.sessionId, `${indent}${last ? "   " : "│  "}`)
    })
  }
  walk(rootId, "")
  if (!below.length) return [[{ text: "No sub-agents", fg: "muted" }]]
  const working = below.filter(({ node }) => AGENT_LIVE.has(node.state ?? "") || (node.kind === "fork" && node.state === "running")).length
  const failed = below.filter(({ node }) => node.state === "failed").length
  const done = below.filter(({ node }) => node.state === "completed").length
  const rows: Line[] = [[{ text: `${working} running`, fg: working ? "primary" : "muted" }, { text: ` · ${done} done`, fg: "muted" }, ...(failed ? [{ text: ` · ${failed} failed`, fg: "error" as const }] : [])]]
  const mark = (node: AgentNode): [string, ColorName] => {
    if (node.state === "completed") return [glyphs.ok, "success"]
    if (node.state === "failed") return [glyphs.fail, "error"]
    if (node.state === "needs_input") return [glyphs.ask, "warning"]
    if (node.state === "running" || node.state === "queued") return [glyphs.running, "primary"]
    return [node.kind === "task" ? "◇" : "○", "muted"]
  }
  for (const { node, prefix, rail } of below.slice(0, maxNodes)) {
    const [glyph, color] = mark(node)
    rows.push(clip([{ text: prefix, fg: "border" }, { text: `${glyph} `, fg: color }, { text: truncateEnd(node.title || "untitled", Math.max(4, width - prefix.length - 2)), fg: "text" }], width))
    const detail = [node.kind === "fork" ? "fork" : node.agent, node.model, node.state ? AGENT_STATE_WORD[node.state] ?? node.state : undefined, node.unmerged ? `+${node.unmerged} unmerged` : undefined].filter(Boolean).join(" · ")
    if (detail && !compact) rows.push(clip([{ text: `${rail}  ${detail}`, fg: "muted" }], width))
    if (!compact && node.kind === "task" && node.headline && !AGENT_LIVE.has(node.state ?? "")) rows.push(clip([{ text: `${rail}  `, fg: "muted" }, { text: truncateEnd(node.headline, Math.max(4, width - rail.length - 2)), fg: node.state === "failed" ? "error" : "text" }], width))
  }
  if (below.length > maxNodes) rows.push([{ text: `+${below.length - maxNodes} more · /tree`, fg: "muted" }])
  return rows
}

/** How long ago a reading was taken, in the largest whole unit: `just now`, `12m ago`, `11h ago`, `3d ago`. */
export function observedAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}h ago`
  return `${Math.floor(minutes / 1_440)}d ago`
}

/** Quota windows as `provider window: 23% · 40m reset`, the percent coloured by pressure. */
export function quotaRow({ provider, label, usedPercent, resetMinutes }: { provider: string; label: string; usedPercent: number; resetMinutes?: number }): Line {
  const color: ColorName = usedPercent >= 90 ? "error" : usedPercent >= 70 ? "warning" : "success"
  return [{ text: `${provider} ${label}: `, fg: "text" }, { text: `${usedPercent}%`, fg: color }, ...(resetMinutes === undefined ? [] : [{ text: ` · ${resetMinutes}m reset`, fg: "muted" as const }])]
}

export type Alert ={ level: "warning" | "error"; text: string }
export function alertsCard(alerts: readonly Alert[], width: number, glyphs: Glyphs): Line[] {
  if (!alerts.length) return [[{ text: "No alerts", fg: "muted" }]]
  return alerts.map((alert) => clip([{ text: `${alert.level === "error" ? glyphs.fail : glyphs.ask} `, fg: alert.level }, { text: alert.text, fg: "text" }], width))
}
