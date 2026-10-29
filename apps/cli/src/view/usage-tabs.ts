import type { UsageActivityDay, UsageDay, UsageReport, UsageSession, UsageTool, UsageWasteReport, UsageWeatherReport } from "@mendcode/protocol"
import type { UsageWidgetId } from "@mendcode/protocol/wire"
import type { ColorName, Glyphs, Line, Span } from "../ui/theme"
import { beside, boxPanel, columns, panelGrid, clip, fit, lineWidth, type GridPanel } from "./deck"
import { compact, thousands } from "./format"
import { center, kpiRow, kvList, section, twoColumns } from "./page"
import { activityGrid, dayTokens, legendRow, type Bounds, type HeatMode } from "./usage-heatmap"
import { clockRows } from "./usage-clock"
import { textWidth, wrap } from "./wrap"
import { usageWeatherRows } from "./usage-widgets"
import { wasteTab } from "./usage-waste-tab"

/**
 * The /usage tabs as pure row builders over a UsageReport: Overview (dashboard, heatmap, insights),
 * Limits (quota left per window), Tokens, Models, Tools and Sessions; Waste reads its own report (usage-waste-tab.ts). Each returns the body for a content
 * grid of `width` cells; the page scrolls it.
 */

export type UsageView = {
  report: UsageReport
  days: Map<string, UsageDay>
  activity: Map<string, UsageActivityDay> | undefined
  bounds: Bounds
  range: 30 | 90 | 365
  mode: HeatMode
  selectedDay: string
  sessionIndex: number
  width: number
  now: number
  height: number
  clock?: boolean
  widgets?: readonly UsageWidgetId[]
  weather?: UsageWeatherReport
  weatherLoading?: boolean
  glyphs: Glyphs
  /** The Waste tab's report (`usage.waste`), asked for when the tab opens; `wasteLoading` false means the ask failed. */
  waste?: UsageWasteReport
  wasteLoading?: boolean
  wasteIndex?: number
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const BAR_WIDTH = 24
const STALE_MS = 3_600_000

const muted = (text: string): Span => ({ text, fg: "muted" })
const strong = (text: string, fg: ColorName = "text"): Span => ({ text, fg, bold: true })

/** 0 → "0s", <1s → "<1s", then "12s", "4m 12s", "2h 5m". */
export function duration(ms: number) {
  if (ms <= 0) return "0s"
  if (ms < 1_000) return "<1s"
  const seconds = Math.round(ms / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function money(micros: number) {
  const dollars = micros / 1e6
  if (dollars > 0 && dollars < 0.01) return "<$0.01"
  return `$${dollars >= 1000 ? thousands(dollars) : dollars.toFixed(2)}`
}

/** "Sep 29, 2026" in local time. */
export function longDate(at: number) {
  const date = new Date(at)
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`
}

export function percent(part: number, whole: number) {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "0%"
}

function ago(ms: number) {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 1_440) return `${Math.round(minutes / 60)}h ago`
  return `${Math.round(minutes / 1_440)}d ago`
}

/** Reset time: "18:40" today, "Oct 2 18:40" later. */
function resetAt(at: number, now: number) {
  const date = new Date(at)
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
  return new Date(now).toDateString() === date.toDateString() ? time : `${MONTHS[date.getMonth()]} ${date.getDate()} ${time}`
}

function sums(view: UsageView) {
  const out = { tokens: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, calls: 0, costMicros: 0, unpriced: 0 }
  for (const day of view.days.values()) {
    out.tokens += dayTokens(day)
    out.input += day.input
    out.output += day.output
    out.reasoning += day.reasoning
    out.cacheRead += day.cacheRead
    out.cacheWrite += day.cacheWrite
    out.calls += day.calls
    out.costMicros += day.costMicros
    out.unpriced += day.costUnknownCalls
  }
  return out
}

function activitySums(view: UsageView) {
  if (!view.activity) return undefined
  const out = { prompts: 0, words: 0, aiMs: 0, toolMs: 0 }
  for (const entry of view.activity.values()) {
    out.prompts += entry.prompts
    out.words += entry.words
    out.aiMs += entry.aiMs
    out.toolMs += entry.toolMs
  }
  return out
}

function rangeLabel(range: UsageView["range"]) {
  return range === 365 ? "Last 12 months" : `Last ${range} days`
}

export function empty(text: string): Line[] {
  return [[muted(text)]]
}

/** A name column that takes what is left, then right-aligned numeric columns. */
export function table(input: { head: string[]; rows: Array<Array<string | Span>>; widths: number[]; width: number }): Line[] {
  const nameWidth = Math.max(8, input.width - input.widths.reduce((sum, w) => sum + w, 0))
  const cell = (value: string | Span, index: number): Span => {
    const span = typeof value === "string" ? { text: value, fg: (index === 0 ? "text" : "text") as ColorName } : value
    if (index === 0) return { ...span, text: fitText(span.text, nameWidth) }
    return { ...span, text: span.text.padStart(input.widths[index - 1]!) }
  }
  const head: Line = input.head.map((text, index) => ({ ...cell(text, index), fg: "muted" as const, bold: false }))
  return [head, ...input.rows.map((row) => row.map(cell))].map((line) => clip(line, input.width))
}

export function fitText(text: string, width: number) {
  if (textWidth(text) <= width) return text + " ".repeat(width - textWidth(text))
  return `${[...text].slice(0, Math.max(0, width - 1)).join("")}…`
}

// ── 1 Overview ──────────────────────────────────────────────────────────────

export function overviewTab(view: UsageView): Line[] {
  const { report, width } = view
  const sum = sums(view)
  const acts = activitySums(view)
  const peak = [...view.days.values()].sort((a, b) => dayTokens(b) - dayTokens(a))[0]
  const activeDays = new Set([...view.days.values()].filter((day) => dayTokens(day) > 0).map((day) => day.day))
  for (const day of view.activity?.values() ?? []) if (day.prompts || day.aiMs || day.toolMs) activeDays.add(day.day)
  const longest = view.activity ? Math.max(0, ...[...view.activity.values()].map((day) => day.longestAiMs ?? 0)) : undefined
  const hasLongest = [...view.activity?.values() ?? []].some((day) => day.longestAiMs !== undefined)
  const cache = sum.cacheRead + sum.cacheWrite
  const line = (text: string): Line => [strong(text)]
  const note = (text: string): Line => [muted(text)]
  const tiles = [
    { title: "Tokens", body: [line(`${compact(sum.tokens)} · ${percent(cache, sum.tokens)} cache`), note(peak ? `Peak ${peak.day} · ${compact(dayTokens(peak))}` : "No token activity")] },
    { title: "Sessions", body: [line(report.sessions === undefined ? "Unavailable" : thousands(report.sessions)), note(`${activeDays.size} active days`)] },
    { title: "AI time", body: [line(acts ? duration(acts.aiMs) : "Unavailable"), note(hasLongest ? `${duration(longest ?? 0)} longest recorded` : "Longest response unavailable")] },
    { title: "Prompts / words", body: [line(acts ? `${thousands(acts.prompts)} prompts` : "Unavailable"), note(acts ? `${thousands(acts.words)} words` : "No activity report")] },
  ]
  const activity = (room: number): Line[] => {
    const selected = view.days.get(view.selectedDay)
    const act = view.activity?.get(view.selectedDay)
    const detail: Line[] = width < 108 ? [
      [{ text: `${view.selectedDay} · ${compact(selected ? dayTokens(selected) : 0)} tok · ${selected?.sessions ?? 0} sessions`, fg: "primary", bold: true }],
      note(`In ${compact(selected?.input ?? 0)} / Out ${compact(selected?.output ?? 0)} / Reas ${compact(selected?.reasoning ?? 0)} / Cache ${compact(selected?.cacheRead ?? 0)}+${compact(selected?.cacheWrite ?? 0)}`),
      note(view.activity ? `${act?.prompts ?? 0} prompts · ${act?.words ?? 0} words · files unavailable` : "Prompts / words / files unavailable"),
      note(view.activity ? `AI ${duration(act?.aiMs ?? 0)} · Tools ${duration(act?.toolMs ?? 0)}` : "AI / tool time unavailable"),
    ] : [
      [{ text: `Selected day · ${view.selectedDay}`, fg: "primary", bold: true }],
      note(selected ? `${compact(dayTokens(selected))} tokens · ${selected.calls} calls · ${selected.sessions} sessions` : "No token usage"),
      note(`In ${compact(selected?.input ?? 0)} · Out ${compact(selected?.output ?? 0)} · Reasoning ${compact(selected?.reasoning ?? 0)}`),
      note(`Cache read ${compact(selected?.cacheRead ?? 0)} · write ${compact(selected?.cacheWrite ?? 0)}`),
      note(view.activity ? `${act?.prompts ?? 0} prompts · ${act?.words ?? 0} words · changed files unavailable` : "Activity / changed files unavailable"),
      note(view.activity ? `AI ${duration(act?.aiMs ?? 0)} · Tools ${duration(act?.toolMs ?? 0)}` : "AI / tool time unavailable"),
    ]
    const grid = activityGrid({ days: view.days, mode: view.mode, selectedDay: view.selectedDay, bounds: view.bounds, width: room })
    const gridWidth = Math.max(...grid.map(lineWidth))
    const inset = Math.max(0, Math.floor((room - gridWidth) / 2))
    return [
      ...[...grid, legendRow()].map((row) => [{ text: " ".repeat(inset) }, ...row]),
      ...(view.widgets !== undefined && width < 68 ? [detail[0]!, detail.at(-1)!] : detail),
    ]
  }
  const streak = report.insights?.streak
  const status: Line[] = [note(`Window ${view.range} days · ${activeDays.size} active days`), note(streak ? `Streak ${streak.current}d · ${streak.longest}d longest` : "Streaks unavailable"), note(`Cache ${compact(cache)} · ${percent(sum.cacheRead, sum.input + sum.cacheRead)} hit`)]
  const quota = (room: number): Line[] => report.quotas.length ? report.quotas.flatMap((quota) => [
    ...quota.windows.map((window): Line => [strong(`${quota.provider} ${windowName(window)} `), { text: `${Math.max(0, Math.round(100 - window.usedPercent))}% left`, fg: leftColor(100 - window.usedPercent) }, ...(window.resetsAt ? [muted(` · ${resetAt(window.resetsAt, view.now)}`)] : [])]),
    [muted(`updated ${ago(view.now - quota.fetchedAt)}`)],
  ]).map((row) => clip(row, room)) : empty("No quota data")
  const clock = (room: number): Line[] => {
    const at = new Date(view.now)
    const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`
    return [...clockRows(time, room), center(note(longDate(view.now)), room)]
  }
  const rows: Line[] = []
  // Compact gives the selected day priority; PgUp/PgDn reveals the rest of the dashboard.
  if (width >= 68) rows.push(...panelGrid({ rows: [tiles], width, padding: width >= 108 }), [])
  if (width >= 108) {
    const [main, side] = columns(width, [3, 1])
    const sidePanels = [{ title: "Limits & status", body: (room: number) => [...quota(room), status[1]!] }, ...(view.clock === false ? [] : [{ title: "Clock", body: clock }])]
    const middleHeight = Math.max(19, panelGrid({ rows: sidePanels.map((panel) => [panel]), width: side!, padding: true, compact: false }).length)
    const sideRows = panelGrid({ rows: sidePanels.map((panel) => [panel]), width: side!, ...(view.clock === false ? { heights: [middleHeight] } : { heights: [middleHeight - 11, 10] }), padding: true, compact: false })
    const mainRows = boxPanel({ title: `Token activity · ${view.mode} · ${view.range}d`, body: activity(main! - 4), width: main!, height: middleHeight, borderTitle: true })
    rows.push(...beside([{ lines: mainRows, width: main! }, { lines: sideRows, width: side! }]), [])
  } else {
    rows.push(...panelGrid({ rows: [[{ title: `Token activity · ${view.mode}`, body: activity }]], width }), [])
    if (width < 68) rows.push(...panelGrid({ rows: [tiles], width }), [])
  }
  const today = view.days.get(view.bounds.to)
  const pressure = peak && dayTokens(peak) ? dayTokens(today ?? { ...peak, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }) / dayTokens(peak) : 0
  const tools = report.tools ?? []
  const skills = report.insights?.skills ?? []
  const models = report.models
  const topSessions = report.insights?.topSessions ?? []
  const mix = (room: number) => kvList([
    { label: "Input", value: compact(sum.input) }, { label: "Output", value: compact(sum.output) }, { label: "Reasoning", value: compact(sum.reasoning) }, { label: "Cache read / write", value: `${compact(sum.cacheRead)} / ${compact(sum.cacheWrite)}` },
  ], room)
  const remaining = Math.max(0, view.height - rows.length)
  const lowerCount = remaining >= 26 ? 3 : 2
  const lowerHeight = width >= 108 ? Math.max(5, Math.floor((remaining - lowerCount + 1) / lowerCount)) : undefined
  const daily = (room: number): Line[] => {
    const days = [...view.days.values()].sort((a, b) => b.day.localeCompare(a.day)).slice(0, Math.max(3, (lowerHeight ?? 8) - 4))
    const max = Math.max(1, ...days.map(dayTokens))
    return days.length ? days.map((day) => {
      const cells = Math.max(1, room - 20)
      return [muted(`${day.day} `), { text: view.glyphs.barFull.repeat(Math.round(dayTokens(day) / max * cells)).padEnd(cells), fg: "primary" }, strong(` ${compact(dayTokens(day))}`)]
    }) : empty("No token activity")
  }
  const lowerRows: GridPanel[][] = [
    [
      { title: "Token mix", body: mix },
      { title: "Response load", body: acts ? [note(`${duration(acts.aiMs)} AI generating`), note(`${duration(acts.toolMs)} tool runtime`), note(`${sum.calls} model calls`), note(`${compact(cache)} cache tokens`)] : empty("No activity report") },
      { title: "Peak pressure", body: (room) => [note(`${compact(today ? dayTokens(today) : 0)} today / ${compact(peak ? dayTokens(peak) : 0)} peak`), [{ text: view.glyphs.barFull.repeat(Math.round(Math.min(1, pressure) * Math.max(1, room))) + view.glyphs.barEmpty.repeat(Math.max(0, room - Math.round(Math.min(1, pressure) * room))), fg: "primary" }], note(peak ? `Peak day ${peak.day}` : "No token activity")] },
    ],
    [
      { title: "Per-day tokens", body: daily },
      { title: "Most used tools & skills", body: (room) => tools.length || skills.length ? kvList([...tools.map((tool) => ({ label: tool.tool, value: `${thousands(tool.calls)} calls`, count: tool.calls })), ...skills.map((skill) => ({ label: skill.skill, value: `${thousands(skill.runs)} runs`, count: skill.runs }))].sort((a, b) => b.count - a.count).slice(0, 5), room) : empty("No tools or skills in this range") },
      { title: "Models", body: (room) => models.length ? models.slice(0, 4).flatMap((model) => [...kvList([{ label: `${model.provider}/${model.model}`, value: `${compact(model.input + model.output)} · ${percent(model.input + model.output, models.reduce((sum, model) => sum + model.input + model.output, 0))}` }], room), note(`${model.calls} calls · in ${compact(model.input)} / out ${compact(model.output)}`)]) : empty("No model usage in this range") },
    ],
    [
      { title: "Cost per model", body: (room) => models.length ? models.flatMap((model) => [...kvList([{ label: `${model.provider}/${model.model}`, value: model.costMicros > 0 || model.costUnknownCalls === 0 ? `${money(model.costMicros)}${model.costUnknownCalls ? " partial" : ""}` : "Pricing unavailable" }], room), note(`${model.calls} calls · ${model.costUnknownCalls ?? "unknown"} unpriced`)]) : empty("No model usage in this range") },
      { title: "Top sessions", body: (room) => topSessions.length ? topSessions.slice(0, 4).flatMap((session) => [...kvList([{ label: session.title || "untitled", value: `${compact(session.tokens)} · ${duration(session.ms)}` }], room), note(`${session.turns} turns · ${session.turns ? compact(Math.round(session.tokens / session.turns)) : "0"} tokens/turn`), note(session.directory), note(session.sessionId)]) : empty("No sessions in this range") },
    ],
  ]
  if (view.widgets !== undefined) {
    const enabled = new Set(view.widgets)
    const outcomes = report.outcomes
    const optional: Array<{ id: UsageWidgetId; panel: GridPanel }> = [
      { id: "token-mix", panel: lowerRows[0]![0]! },
      { id: "response-load", panel: lowerRows[0]![1]! },
      { id: "peak-pressure", panel: lowerRows[0]![2]! },
      { id: "outcome-signals", panel: { title: "Outcome signals", body: outcomes ? [line(`${outcomes.changedFiles} changed files`), note(`${outcomes.sessionsWithCodeChanges} sessions with changes`), note("Retained snapshots only")] : empty("Code change evidence unavailable") } },
      { id: "tools", panel: lowerRows[1]![1]! },
      { id: "agents-models", panel: { title: "Agents & models", body: (room) => [
        ...(report.agents?.length ? kvList(report.agents.slice(0, 2).map((agent) => ({ label: agent.name, value: `${agent.turns} turns` })), room) : empty(report.agents ? "No agent activity" : "Agent activity unavailable")),
        ...(models.length ? kvList(models.slice(0, 2).map((model) => ({ label: `${model.provider}/${model.model}`, value: `${compact(model.input + model.output)} · ${model.costMicros > 0 || model.costUnknownCalls === 0 ? `${money(model.costMicros)}${model.costUnknownCalls ? " partial" : ""}` : "unpriced"}` })), room) : empty("No model usage")),
      ] } },
    ]
    const rail: GridPanel[] = [
      ...(enabled.has("subscription-usage") ? [{ title: "Subscription usage", body: quota }] : []),
      ...(enabled.has("clock") && view.clock !== false ? [{ title: "Clock", body: clock }] : []),
      ...(enabled.has("weather") ? [{ title: "Weather", body: (room: number) => usageWeatherRows(view.weather, view.weatherLoading === true, room) }] : []),
      ...(enabled.has("status") ? [{ title: "Status", body: [note(`Scope ${report.scope?.kind ?? "global"}`), ...status.slice(0, 2)] }] : []),
    ]
    const statTiles: GridPanel[] = tiles.map((tile, index) => index === 0 ? { ...tile, body: (room: number) => [tile.body[0]!, room < 26 && peak ? note(`Peak ${compact(dayTokens(peak))} tokens`) : tile.body[1]!] } : tile)
    const result: Line[] = width >= 68 ? [...panelGrid({ rows: [statTiles], width, padding: true, maxColumns: width >= 90 ? 4 : 2 }), []] : []
    const wide = width >= 108
    const [main, side] = wide && rail.length ? columns(width, [3, 1]) : [width]
    const panels = [...optional.filter(({ id }) => enabled.has(id)).map(({ panel }) => panel), lowerRows[1]![0]!, lowerRows[2]![1]!]
    const groups: GridPanel[][] = []
    const count = wide ? 4 : width >= 68 ? 2 : 1
    for (let i = 0; i < panels.length; i += count) groups.push(panels.slice(i, i + count))
    const room = Math.max(0, view.height - result.length)
    const mainActivity = boxPanel({ title: `Token activity · ${view.mode} · ${view.range}d`, body: activity(main! - 4), width: main!, borderTitle: true, compact: false })
    const lowerRoom = Math.max(groups.length * 5 + groups.length - 1, room - mainActivity.length - 1)
    const perRow = Math.floor((lowerRoom - groups.length + 1) / groups.length)
    const heights = groups.map((_, index) => index === groups.length - 1 ? lowerRoom - (groups.length - 1) * (perRow + 1) : perRow)
    const mainRows = [...mainActivity, [], ...panelGrid({ width: main!, rows: groups, ...(wide ? { heights } : {}), padding: true, compact: false, maxColumns: count })]
    if (wide && side) {
      const base = rail.map((panel) => panel.title === "Clock" || panel.title === "Weather" ? 10 : 7)
      let extra = Math.max(0, Math.max(room, mainRows.length) - base.reduce((sum, n) => sum + n, 0) - rail.length + 1)
      const heights = base.map((height, index) => {
        const more = Math.ceil(extra / (base.length - index))
        extra -= more
        return height + more
      })
      result.push(...beside([{ lines: mainRows, width: main! }, { lines: panelGrid({ width: side, rows: rail.map((panel) => [panel]), heights, padding: true, compact: false, maxColumns: 1 }), width: side }]))
    } else {
      result.push(...mainRows)
      if (width < 68) result.push([], ...panelGrid({ rows: [tiles], width, padding: true, compact: false, maxColumns: 1 }))
      if (rail.length) result.push([], ...panelGrid({ width, rows: rail.map((panel) => [panel]), padding: true, compact: false, maxColumns: width < 68 ? 1 : 2 }))
    }
    return result
  }
  if (width >= 108 && lowerCount === 2) {
    const costs = lowerRows.pop()!
    lowerRows[1]![2] = { title: "Models & cost", body: (room) => models.length ? models.flatMap((model) => [...kvList([{ label: `${model.provider}/${model.model}`, value: `${compact(model.input + model.output)} · ${model.costUnknownCalls === 0 || model.costMicros > 0 ? `${money(model.costMicros)}${model.costUnknownCalls ? " partial" : ""}` : "unpriced"}` }], room), note(`${model.calls} calls · in ${compact(model.input)} / out ${compact(model.output)}`)]) : empty("No model usage in this range") }
    lowerRows[1]!.push(costs[1]!)
  }
  const heights = lowerHeight === undefined ? undefined : lowerCount === 3 ? [lowerHeight, lowerHeight, Math.max(5, remaining - 2 - lowerHeight * 2)] : [lowerHeight, Math.max(5, remaining - 1 - lowerHeight)]
  rows.push(...panelGrid({ width, padding: true, ...(heights ? { heights } : {}), rows: lowerRows }))
  if (width < 108) rows.push([], ...panelGrid({ width, rows: [[{ title: "Limits", body: quota }, { title: "Status", body: status }]] }))
  return rows
}

/** Each of the two columns, or the full width when `twoColumns` would stack them. */
export function columnWidth(width: number) {
  const column = Math.floor((width - 4) / 2)
  return column >= 36 ? column : width
}

// ── 2 Limits ────────────────────────────────────────────────────────────────

/** "5-hour", "Weekly", "Daily" from the window length; the provider's label otherwise. */
function windowName(window: { label: string; windowMinutes?: number | undefined }) {
  const minutes = window.windowMinutes
  if (minutes === 10_080) return "Weekly"
  if (minutes === 1_440) return "Daily"
  if (minutes && minutes < 1_440 && minutes % 60 === 0) return `${minutes / 60}-hour`
  return window.label
}

function leftColor(left: number): ColorName {
  return left <= 5 ? "error" : left <= 20 ? "warning" : "success"
}

export function limitsTab(view: UsageView): Line[] {
  const { report, width, now, glyphs } = view
  const rows: Line[] = []
  for (const quota of report.quotas) {
    const age = now - quota.fetchedAt
    const title = quota.plan ? `${quota.provider} · ${quota.plan}` : quota.provider
    const body: Line[] = []
    for (const window of quota.windows) {
      const left = Math.max(0, Math.round(100 - window.usedPercent))
      // The filled part is what is left, so a full bar reads as a fresh window.
      const barWidth = Math.min(BAR_WIDTH, Math.max(3, width - 20))
      const filled = Math.round((left / 100) * barWidth)
      body.push([
        muted(fitText(windowName(window), Math.min(10, Math.max(5, width - barWidth - 10)))),
        { text: glyphs.barFull.repeat(filled), fg: leftColor(left) },
        { text: glyphs.barEmpty.repeat(barWidth - filled), fg: "border" },
        strong(` ${left}% left`, leftColor(left)),
      ])
      if (window.resetsAt) body.push([muted(`resets ${resetAt(window.resetsAt, now)}`)])
    }
    if (!quota.windows.length) body.push([muted("No windows reported")])
    body.push([{ text: `updated ${ago(age)}`, fg: age > STALE_MS ? "warning" : "muted" }])
    rows.push(...section({ title, body, width }), [])
  }
  if (!rows.length) return section({ title: "No quota data", body: wrap("Limits appear after the first response from a provider that reports them.", width).map((text) => [muted(text)]), width })
  return rows
}

// ── 3 Tokens ────────────────────────────────────────────────────────────────

export function tokensTab(view: UsageView): Line[] {
  const { width } = view
  const sum = sums(view)
  const cacheBase = sum.input + sum.cacheRead
  const rows: Line[] = [
    ...kpiRow(
      [
        { value: compact(sum.tokens), label: "Total" },
        { value: compact(sum.input), label: "Input" },
        { value: compact(sum.output), label: "Output" },
        { value: compact(sum.reasoning), label: "Reasoning" },
        { value: percent(sum.cacheRead, cacheBase), label: "Cache hit" },
      ],
      width,
    ),
    [],
  ]
  const mix = kvList(
    [
      { label: "Input", value: `${compact(sum.input)} · ${percent(sum.input, sum.tokens)}` },
      { label: "Output", value: `${compact(sum.output)} · ${percent(sum.output, sum.tokens)}` },
      { label: "Reasoning", value: `${compact(sum.reasoning)} · ${percent(sum.reasoning, sum.tokens)}` },
      { label: "Cache read", value: `${compact(sum.cacheRead)} · ${percent(sum.cacheRead, sum.tokens)}` },
      { label: "Cache write", value: `${compact(sum.cacheWrite)} · ${percent(sum.cacheWrite, sum.tokens)}` },
    ],
    columnWidth(width),
  )
  const cost = kvList(
    [
      { label: "Estimated cost", value: sum.costMicros > 0 ? money(sum.costMicros) : sum.unpriced > 0 ? "n/a" : money(0) },
      { label: "Unpriced calls", value: thousands(sum.unpriced) },
      { label: "Model calls", value: thousands(sum.calls) },
      { label: "Tokens per call", value: sum.calls ? compact(Math.round(sum.tokens / sum.calls)) : "—" },
    ],
    columnWidth(width),
  )
  rows.push(...twoColumns(section({ title: "Token mix", body: mix, width: columnWidth(width) }), section({ title: "Calls and cost", body: cost, width: columnWidth(width) }), width), [])
  const mode: HeatMode = view.mode === "daily" ? "weekly" : view.mode
  rows.push(...section({ title: mode === "cumulative" ? "Running total" : "Weekly tokens", subtitle: rangeLabel(view.range), body: activityGrid({ days: view.days, mode, selectedDay: view.selectedDay, bounds: view.bounds, width }), width }))
  return rows
}

// ── 4 Models ────────────────────────────────────────────────────────────────

export function modelsTab(view: UsageView): Line[] {
  const { report, width } = view
  const models = [...report.models].sort((a, b) => b.input + b.output - (a.input + a.output))
  const rows: Line[] = [
    ...section({
      title: "Models",
      subtitle: rangeLabel(view.range),
      body: models.length
        ? table({
            head: ["model", "tokens", "calls", "cost"],
            rows: models.map((model) => [`${model.provider}/${model.model}`, compact(model.input + model.output), compact(model.calls), model.costMicros > 0 ? money(model.costMicros) : "—"]),
            widths: [9, 8, 10],
            width,
          })
        : empty("No model usage in this range"),
      width,
    }),
    [],
  ]
  const efforts = report.insights?.efforts ?? []
  const turns = efforts.reduce((total, effort) => total + effort.turns, 0)
  rows.push(
    ...section({
      title: "Reasoning effort",
      subtitle: "Turns per effort",
      body: efforts.length ? kvList(efforts.map((effort) => ({ label: effort.effort, value: `${thousands(effort.turns)} · ${percent(effort.turns, turns)}` })), columnWidth(width)) : empty("No turns recorded yet"),
      width,
    }),
  )
  return rows
}

// ── 5 Tools ─────────────────────────────────────────────────────────────────

export function toolsTab(view: UsageView): Line[] {
  const { report, width } = view
  const tools: UsageTool[] = report.tools ?? []
  const totals = tools.reduce((acc, tool) => ({ calls: acc.calls + tool.calls, ms: acc.ms + tool.ms, errors: acc.errors + tool.errors }), { calls: 0, ms: 0, errors: 0 })
  const rows: Line[] = [
    ...kpiRow(
      [
        { value: compact(totals.calls), label: "Tool calls" },
        { value: duration(totals.ms), label: "Tool time" },
        { value: compact(totals.errors), label: "Errors", ...(totals.errors > 0 ? { tone: "error" as const } : {}) },
      ],
      width,
    ),
    [],
    ...section({
      title: "Tools",
      subtitle: "Top 10 by calls",
      body: tools.length
        ? table({
            head: ["tool", "calls", "time", "errors"],
            rows: tools.map((tool) => [tool.tool, compact(tool.calls), duration(tool.ms), tool.errors > 0 ? { text: compact(tool.errors), fg: "error", bold: true } : { text: "0", fg: "muted" }]),
            widths: [8, 10, 8],
            width,
          })
        : empty("No tool calls in this range"),
      width,
    }),
    [],
  ]
  // Command output filters (tier balanced and up): an estimate of what stayed out of the context, the full text is still on disk.
  const savings = report.savings ?? []
  if (savings.length) {
    const total = savings.reduce((sum, entry) => sum + entry.tokens, 0)
    rows.push(...section({ title: "Tokens saved", subtitle: `~${thousands(total)} tokens kept out of context · estimate`, body: kvList(savings.map((entry) => ({ label: entry.source, value: `~${thousands(entry.tokens)} tok · ${thousands(entry.calls)} ${entry.calls === 1 ? "call" : "calls"}` })), columnWidth(width)), width }), [])
  }
  const skills = report.insights?.skills ?? []
  rows.push(...section({ title: "Skills", subtitle: "Runs per skill", body: skills.length ? kvList(skills.map((skill) => ({ label: skill.skill, value: `${thousands(skill.runs)} runs` })), columnWidth(width)) : empty("No skills loaded in this range"), width }))
  return rows
}

// ── 6 Sessions ──────────────────────────────────────────────────────────────

/** Top sessions of the range; the selected one is marked and opens with enter. */
export function sessionsTab(view: UsageView): Line[] {
  const { report, width } = view
  const sessions: UsageSession[] = report.insights?.topSessions ?? []
  const rows: Line[] = []
  const longest = report.insights?.longestSession
  if (longest) {
    const longestRow = { label: "Longest chat (all time)", value: `${longest.title || "untitled"} · ${duration(longest.ms)}` }
    // Too narrow for both on one row, the label takes its own row rather than being cut to a stub.
    rows.push(...(textWidth(longestRow.label) + 1 + textWidth(longestRow.value) <= width ? kvList([longestRow], width) : [[muted(longestRow.label)], [{ text: fitText(longestRow.value, width), fg: "text" }]] as Line[]), [])
  }
  if (!sessions.length) return [...rows, ...section({ title: "Top sessions", subtitle: rangeLabel(view.range), body: empty("No sessions in this range"), width })]
  // The numbers drop from the right (turns, then time) before the title would go under 8 columns.
  const layouts = [
    (session: UsageSession) => `${compact(session.tokens)} tok  ${duration(session.ms).padStart(7)}  ${String(session.turns).padStart(4)} turns`,
    (session: UsageSession) => `${compact(session.tokens)} tok  ${duration(session.ms).padStart(7)}`,
    (session: UsageSession) => `${compact(session.tokens)} tok`,
  ]
  const widthOf = (layout: (session: UsageSession) => string) => Math.max(...sessions.map((session) => textWidth(layout(session))))
  const numbers = layouts.find((layout) => width - 4 - widthOf(layout) >= 8) ?? layouts.at(-1)!
  const numbersWidth = widthOf(numbers)
  const body: Line[] = []
  sessions.forEach((session, index) => {
    const selected = index === view.sessionIndex
    const marker: Span = selected ? { text: "› ", fg: "primary", bold: true } : { text: "  " }
    const nameWidth = Math.max(8, width - 2 - numbersWidth - 2)
    body.push([marker, { text: fitText(session.title || "untitled", nameWidth), fg: selected ? "primary" : "text", bold: selected }, { text: "  " }, muted(numbers(session).padStart(numbersWidth))])
    body.push([{ text: "  " }, muted(fitText(session.directory, width - 2))])
  })
  rows.push(...section({ title: "Top sessions", subtitle: `${rangeLabel(view.range)} · by tokens`, body: body.map((line) => fit(line, width)), width }))
  return rows
}

/** Deeper reports keep their data and keys; sections form full-width weighted rows. */
export function reportGrid(render: (view: UsageView) => Line[], view: UsageView): Line[] {
  const source = render({ ...view, width: view.width < 68 ? view.width : view.width - 4 })
  const groups: Array<{ title: string; body: Line[] }> = []
  let current = { title: "Summary", body: [] as Line[] }
  for (const row of source) {
    const title = row.length === 1 && row[0]?.bold && row[0].fg === "text" ? row[0].text : undefined
    if (title) {
      if (current.body.length) groups.push(current)
      current = { title, body: [] }
    } else current.body.push(row)
  }
  if (current.body.length) groups.push(current)
  if (!groups.length) groups.push({ title: "Report", body: source })
  const rows = groups.map((group) => ({ ...group, body: group.body.filter((row, i) => row.length || i > 0 && i < group.body.length - 1) }))
  // Tables retain their numeric columns; use a full-width panel if the row cannot fit a half.
  return panelGrid({ width: view.width, rows: rows.map((group) => [group]) })
}

export const USAGE_TABS = [
  { key: "1", label: "Overview", short: "Ov", render: overviewTab },
  { key: "2", label: "Limits", short: "Li", render: (view: UsageView) => reportGrid(limitsTab, view) },
  { key: "3", label: "Tokens", short: "To", render: (view: UsageView) => reportGrid(tokensTab, view) },
  { key: "4", label: "Models", short: "Mo", render: (view: UsageView) => reportGrid(modelsTab, view) },
  { key: "5", label: "Tools", short: "Tl", render: (view: UsageView) => reportGrid(toolsTab, view) },
  { key: "6", label: "Sessions", short: "Se", render: (view: UsageView) => reportGrid(sessionsTab, view) },
  { key: "7", label: "Waste", short: "Wa", render: (view: UsageView) => reportGrid((inner) => wasteTab({ report: inner.waste, ...(inner.wasteLoading !== undefined ? { loading: inner.wasteLoading } : {}), index: inner.wasteIndex ?? 0, width: inner.width, glyphs: inner.glyphs }), view) },
] as const
