import type { UsageReport, UsageWasteReport, UsageWeatherReport } from "@mendcode/protocol"
import type { UsageWidgetId } from "@mendcode/protocol/wire"
import { glyphs, type Glyphs, type Line } from "../ui/theme"
import { fit, spread } from "./deck"
import { compact } from "./format"
import { tabsRow, type PageTab } from "./page"
import { addDays, clampDay, dayTokens, indexDays, type HeatMode } from "./usage-heatmap"
import { duration, USAGE_TABS, type UsageView } from "./usage-tabs"
import { renderUsageWidgetSettings } from "./usage-widgets"
import { wasteActions, type WasteAction } from "./usage-waste-tab"
import type { TuiProfile } from "./tui-profile"

/**
 * /usage in the page standard: seven tabs (Overview, Limits, Tokens, Models, Tools, Sessions over one
 * UsageReport; Waste over its own `usage.waste` report), a granularity mode for the activity charts, a date range, and a responsive panel dashboard. Pure: state in, rows out.
 */

export type UsageRange = 30 | 90 | 365
export type { HeatMode }
export type UsagePageState = { range: UsageRange; selectedDay: string; mode: HeatMode; tab: number; scroll: number; sessionIndex: number; /** The Waste tab's selected action (a finding to apply, a change to undo). */ wasteIndex?: number; scope: "global" | "project" | "directory"; project?: string; widgetIndex?: number; weatherInput?: string; weatherCursor?: number; weather?: UsageWeatherReport; weatherLoading?: boolean }

const RANGE_TIERS: UsageRange[] = [30, 90, 365]
const MODES: HeatMode[] = ["daily", "weekly", "cumulative"]
const TABS: PageTab[] = USAGE_TABS.map(({ key, label, short }) => ({ key, label, short }))
const OVERVIEW = 0
const TOKENS = 2
const SESSIONS = 5
const WASTE = 6
const DAY_STEPS: Record<string, number> = { "\x1b[D": -1, h: -1, "\x1b[C": 1, l: 1, "\x1b[A": -7, k: -7, "\x1b[B": 7, j: 7 }
const SCROLL_STEPS: Record<string, number> = { "\x1b[A": -1, k: -1, "\x1b[B": 1, j: 1, "\x1b[5~": -10, "\x1b[6~": 10 }
const MAX_SCROLL = 500

export function createUsagePageState(today: string): UsagePageState {
  return { range: 365, selectedDay: today, mode: "daily", tab: OVERVIEW, scroll: 0, sessionIndex: 0, scope: "global" }
}

export function rangeBounds(range: UsageRange, today: string): { from: string; to: string } {
  return { from: addDays(today, -(range - 1)), to: today }
}

function withTab(state: UsagePageState, tab: number): UsagePageState {
  return tab === state.tab ? state : { ...state, tab, scroll: 0 }
}

/**
 * A new state for a known key, the same object for an unknown one. `tab`/shift-tab and 1-6 pick the tab,
 * `g`/`m` cycle the chart granularity, `[`/`]` step the range; arrows move the selected day in Overview,
 * select a session in Sessions, and scroll elsewhere. `report` bounds the session selection.
 */
export function usagePageKey(state: UsagePageState, key: string, today: string, report?: UsageReport, waste?: UsageWasteReport): UsagePageState {
  if (key === "s" || key === "S") {
    const scopes = ["global", "project", "directory"] as const
    const { project, ...rest } = state
    return { ...rest, scope: scopes[(scopes.indexOf(state.scope) + 1) % scopes.length]!, scroll: 0, sessionIndex: 0 }
  }
  if ((key === "p" || key === "P") && report?.projects?.length) {
    const projects = report.projects
    const index = projects.findIndex((p) => p.id === (state.project ?? report.scope?.project))
    return { ...state, scope: "project", project: projects[(index + 1) % projects.length]!.id, scroll: 0, sessionIndex: 0 }
  }
  if (key === "\t") return withTab(state, (state.tab + 1) % TABS.length)
  if (key === "\x1b[Z") return withTab(state, (state.tab + TABS.length - 1) % TABS.length)
  const digit = Number(key)
  if (key.length === 1 && Number.isInteger(digit) && digit >= 1 && digit <= TABS.length) return withTab(state, digit - 1)
  if (key === "g" || key === "G" || key === "m" || key === "M") return { ...state, mode: MODES[(MODES.indexOf(state.mode) + 1) % MODES.length]! }
  if (key === "[" || key === "]") {
    const index = RANGE_TIERS.indexOf(state.range)
    const range = RANGE_TIERS[key === "[" ? Math.max(0, index - 1) : Math.min(RANGE_TIERS.length - 1, index + 1)]!
    if (range === state.range) return state
    const bounds = rangeBounds(range, today)
    return { ...state, range, selectedDay: clampDay(state.selectedDay, bounds), sessionIndex: 0, scroll: 0 }
  }
  if (state.tab === OVERVIEW) {
    const bounds = rangeBounds(state.range, today)
    if (["\x1b[H", "\x1bOH", "\x1b[1~"].includes(key)) return { ...state, selectedDay: bounds.from, scroll: 0 }
    if (["\x1b[F", "\x1bOF", "\x1b[4~"].includes(key)) return { ...state, selectedDay: bounds.to, scroll: 0 }
    const step = DAY_STEPS[key]
    if (step !== undefined) return { ...state, selectedDay: clampDay(addDays(clampDay(state.selectedDay, bounds), step), bounds), scroll: 0 }
  }
  const scroll = SCROLL_STEPS[key]
  if (scroll === undefined) return state
  // Waste: the arrows pick an action and the page follows it; PgUp/PgDn move the view from there.
  const actions = state.tab === WASTE ? wasteActions(waste).length : 0
  if (actions && (key === "\x1b[5~" || key === "\x1b[6~")) return { ...state, scroll: Math.max(-MAX_SCROLL, Math.min(MAX_SCROLL, state.scroll + scroll)) }
  if (actions) {
    const wasteIndex = Math.max(0, Math.min(actions - 1, (state.wasteIndex ?? 0) + Math.sign(scroll)))
    return wasteIndex === (state.wasteIndex ?? 0) ? state : { ...state, wasteIndex, scroll: 0 }
  }
  if (state.tab === SESSIONS) {
    const count = report?.insights?.topSessions.length ?? 0
    const sessionIndex = Math.max(0, Math.min(Math.max(0, count - 1), state.sessionIndex + Math.sign(scroll)))
    return sessionIndex === state.sessionIndex ? state : { ...state, sessionIndex }
  }
  const next = Math.max(0, Math.min(MAX_SCROLL, state.scroll + scroll))
  return next === state.scroll ? state : { ...state, scroll: next }
}

/** The session enter opens on the Sessions tab, if any. */
export function usageSelectedSession(state: UsagePageState, report: UsageReport | undefined): string | undefined {
  return state.tab === SESSIONS ? report?.insights?.topSessions[state.sessionIndex]?.sessionId : undefined
}

/** What Enter does on the Waste tab: the selected finding's fix or change's revert. */
export function usageWasteAction(state: UsagePageState, waste: UsageWasteReport | undefined): WasteAction | undefined {
  if (state.tab !== WASTE) return undefined
  const actions = wasteActions(waste)
  return actions[Math.min(state.wasteIndex ?? 0, actions.length - 1)]
}

/** The Waste tab is open: its report is asked for then, not with every /usage. */
export const usageWasteOpen = (state: UsagePageState) => state.tab === WASTE

export { compact, duration }

function hintsFor(tab: number) {
  const common = "s Scope   p Project   tab/1-7 Report   [ ] Range   R Refresh   Esc Back"
  if (tab === OVERVIEW) return "s Scope   p Project   tab/1-7 Report   ←→ Day   ↑↓ Week   PgUp/PgDn Scroll   g Granularity   [ ] Range   Home/End Edges   R Refresh   Esc Back"
  if (tab === SESSIONS) return "s Scope   p Project   tab/1-7 Report   ↑↓ Select   Enter Open   [ ] Range   R Refresh   Esc Back"
  if (tab === WASTE) return "s Scope   p Project   tab/1-7 Report   ↑↓ Select   Enter Apply/Undo   PgUp/PgDn Scroll   [ ] Range   R Refresh   Esc Back"
  if (tab === TOKENS) return "s Scope   p Project   tab/1-7 Report   g Granularity   ↑↓ Scroll   [ ] Range   R Refresh   Esc Back"
  return common.replace("[ ] Range", "↑↓ Scroll   [ ] Range")
}

export function renderUsagePage(input: { report: UsageReport; state: UsagePageState; today: string; width: number; height: number; now: number; clock?: boolean; widgets?: readonly UsageWidgetId[]; profile?: TuiProfile; glyphs?: Glyphs; waste?: UsageWasteReport; wasteLoading?: boolean }): Line[] {
  const { report, state, today, width, height, now } = input
  if (input.profile && (state.widgetIndex !== undefined || state.weatherInput !== undefined)) return renderUsageWidgetSettings({ state, profile: input.profile, width, height })
  const bounds = rangeBounds(state.range, today)
  const days = indexDays(report.days, bounds)
  const activity = report.activity ? new Map(report.activity.filter((entry) => entry.day >= bounds.from && entry.day <= bounds.to).map((entry) => [entry.day, entry])) : undefined
  const inner = Math.max(1, width - 2)
  const compactScreen = inner < 68
  const room = Math.max(0, height - (compactScreen ? 3 : 4))
  const tab = USAGE_TABS[state.tab] ?? USAGE_TABS[0]
  const weatherEnabled = !input.profile || input.profile.usageWeatherEnabled && !!input.profile.usageWeatherRegion
  const weather = weatherEnabled ? state.weather : { status: "off" as const }
  const view: UsageView = { report, days, activity, bounds, range: state.range, mode: state.mode, selectedDay: clampDay(state.selectedDay, bounds), sessionIndex: state.sessionIndex, width: inner, height: room, now, ...(input.clock === undefined ? {} : { clock: input.clock }), ...(input.widgets ? { widgets: input.widgets } : {}), ...(weather ? { weather } : {}), weatherLoading: weatherEnabled && state.weatherLoading === true, glyphs: input.glyphs ?? glyphs(),
    ...(input.waste ? { waste: input.waste } : {}), ...(input.wasteLoading !== undefined ? { wasteLoading: input.wasteLoading } : {}), wasteIndex: state.wasteIndex ?? 0 }
  const body = tab.render(view)
  const scroll = state.tab === SESSIONS ? Math.max(0, state.sessionIndex * 2 + 7 - room) : state.tab === WASTE ? wasteScroll(body, state, room) : state.scroll
  const start = Math.max(0, Math.min(scroll, Math.max(0, body.length - room)))
  const hints = (compactScreen ? "s Scope   p Project   C Widgets   W Weather   PgDn   Esc Back" : `s Scope   p Project   C Widgets   W Weather   ${hintsFor(state.tab).replace("s Scope   p Project   ", "")}`).split("   ")
  const title: Line = [{ text: compactScreen ? `Usage · ${state.scope}` : "Usage Insights", fg: "primary", bold: true }]
  let shown = hints.join(" · ")
  while (shown.length > inner - 18 && hints.length > 1) {
    hints.splice(hints.length - 2, 1)
    shown = hints.join(" · ")
  }
  const rows: Line[] = [
    spread(title, [{ text: shown, fg: "muted" }], inner),
    ...(compactScreen ? [] : [spread([{ text: `MendCode · ${state.scope} stats · ${state.mode} · ${state.range}d${state.scope === "global" || !report.scope?.directory ? "" : ` · ${report.scope.directory}`}`, fg: "muted" }], [{ text: `${compact([...days.values()].reduce((sum, day) => sum + dayTokens(day), 0))} tokens`, fg: "text" }], inner)]),
    tabsRow(TABS, state.tab, inner),
    [{ text: "─".repeat(inner), fg: "border" }],
    ...body.slice(start, start + room),
  ]
  while (rows.length < height) rows.push([])
  return rows.slice(0, height).map((row) => [{ text: " " }, ...fit(row, inner), { text: " " }])
}

/** The Waste tab's first row: the selected action a third of the way down (when there is one), moved by PgUp/PgDn. */
function wasteScroll(body: Line[], state: UsagePageState, room: number): number {
  const selected = body.findIndex((line) => line.some((span) => span.text === "› " && span.fg === "primary"))
  const base = selected < 0 ? 0 : Math.max(0, selected - Math.floor(room / 3))
  return Math.max(0, base + state.scroll)
}
