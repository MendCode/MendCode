import { USAGE_WIDGET_IDS, type UsageWidgetId } from "@mendcode/protocol/wire"
import type { UsageWeatherReport } from "@mendcode/protocol"
import type { Line } from "../ui/theme"
import { fit, panelGrid, spread } from "./deck"
import { center } from "./page"
import { textWidth } from "./wrap"
import type { TuiProfile } from "./tui-profile"
import type { UsagePageState } from "./usage-page"

export const USAGE_WIDGET_META: Record<UsageWidgetId, { title: string; description: string }> = {
  "token-mix": { title: "Token mix", description: "Input, output, reasoning and cache" },
  "response-load": { title: "Response load", description: "Recorded AI and tool runtime" },
  "subscription-usage": { title: "Subscription usage", description: "Account quota windows and reset times" },
  "peak-pressure": { title: "Peak pressure", description: "Today compared with the peak day" },
  clock: { title: "Clock", description: "Local time and date" },
  weather: { title: "Weather", description: "Opt-in weather adapter; W sets the region" },
  status: { title: "Status", description: "Report scope, window and activity streak" },
  "outcome-signals": { title: "Outcome signals", description: "Code changes from retained file snapshots" },
  tools: { title: "Most used tools", description: "Tool call and skill frequency" },
  "agents-models": { title: "Agents & models", description: "Saved agent labels, model tokens and costs" },
}

export function usageWeatherRows(report: UsageWeatherReport | undefined, loading: boolean, width: number): Line[] {
  if (loading) return [[{ text: "Loading weather…", fg: "muted" }]]
  if (!report || report.status === "off") return [[{ text: "Weather is off", fg: "muted" }]]
  if (report.status !== "ready") return [[{ text: report.status === "unavailable" ? "Service unavailable" : "Weather unavailable", fg: "warning" }]]
  const { reading } = report
  const art = reading.code === 0 ? ["\\ | /", "- O -", "/ | \\"] : reading.code !== undefined && reading.code >= 51 ? [" .--. ", "(____)", " ' ' '"] : [" .--. ", "(    )", " `--' "]
  return [
    ...art.map((text): Line => center([{ text, fg: "primary" }], width)),
    center([{ text: `${reading.label} · ${Math.round(reading.temperatureC)}°C`, fg: "text", bold: true }], width),
    center([{ text: reading.location, fg: "muted" }], width),
    ...(reading.windKmh === undefined ? [] : [center([{ text: `Wind ${Math.round(reading.windKmh)} km/h`, fg: "muted" }], width)]),
  ]
}

export function renderUsageWidgetSettings(input: { state: UsagePageState; profile: TuiProfile; width: number; height: number }): Line[] {
  const { state, profile, width, height } = input
  const inner = Math.max(1, width - 2)
  const weather = state.weatherInput !== undefined
  const hints = weather ? "Enter Save · Ctrl+U Clear · Esc Cancel" : inner < 68 ? "↑↓ · Enter Toggle · Esc Back" : "↑↓ Select · Enter/Space Toggle · D Reset · Esc Back"
  const rows: Line[] = [spread([{ text: weather ? "Weather region" : "Usage widgets", fg: "primary", bold: true }], [{ text: hints, fg: "muted" }], inner), []]
  if (weather) {
    const chars = [...state.weatherInput!]
    const cursor = state.weatherCursor ?? chars.length
    const room = Math.max(1, inner - 4)
    let start = cursor
    while (start > 0 && textWidth(chars.slice(start - 1, cursor).join("")) < room - 1) start--
    const edit: Line = [{ text: chars.slice(start, cursor).join(""), fg: "text" }, { text: chars[cursor] ?? " ", fg: "background", bg: "text" }, { text: chars.slice(cursor + 1).join(""), fg: "text" }]
    rows.push(...panelGrid({ width: inner, padding: true, compact: false, maxColumns: 1, rows: [
      [{ title: "Region · blank disables weather", body: [edit] }],
      [{ title: "Service", body: [[{ text: profile.usageWeatherEnabled ? profile.usageWeatherRegion : "Off", fg: "text" }], [{ text: "Requires an explicit daemon adapter", fg: "muted" }]] }],
    ] }))
  } else {
    const index = state.widgetIndex ?? 0
    const id = USAGE_WIDGET_IDS[index] ?? USAGE_WIDGET_IDS[0]
    const visible = Math.max(1, height - 7)
    const start = Math.max(0, Math.min(index - visible + 1, USAGE_WIDGET_IDS.length - visible))
    const list = USAGE_WIDGET_IDS.slice(start, start + visible).map((id, i): Line => [{ text: start + i === index ? "› " : "  ", fg: "primary" }, { text: profile.usageWidgets.includes(id) ? "[x] " : "[ ] ", fg: "primary" }, { text: USAGE_WIDGET_META[id].title, fg: "text", bold: start + i === index }])
    const detail: Line[] = [[{ text: USAGE_WIDGET_META[id].description, fg: "text" }], [], [{ text: profile.usageWidgets.includes(id) ? "Enabled" : "Off", fg: "primary" }]]
    if (id === "weather") detail.push([{ text: profile.usageWeatherEnabled ? `Region: ${profile.usageWeatherRegion}` : "Weather is off", fg: "muted" }])
    const groups = inner < 68 ? [[{ title: "Widgets", body: list }]] : [[{ title: "Widgets", body: list }, { title: USAGE_WIDGET_META[id].title, body: detail }]]
    rows.push(...panelGrid({ width: inner, padding: true, compact: false, maxColumns: inner < 68 ? 1 : 2, heights: [Math.max(5, height - 2)], rows: groups }))
  }
  while (rows.length < height) rows.push([])
  return rows.slice(0, height).map((row) => [{ text: " " }, ...fit(row, inner), { text: " " }])
}
