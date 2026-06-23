import { For, Match, Show, Switch, createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { routeReturnTarget, useRoute } from "@tui/context/route"
import { useSDK } from "@tui/context/sdk"
import { useTheme } from "@tui/context/theme"
import { useSync } from "@tui/context/sync"
import { useMendTuiProfile } from "@tui/context/mend"
import { useProject } from "@tui/context/project"
import { useKV } from "@tui/context/kv"
import { useDialog } from "@tui/ui/dialog"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { Locale } from "@/util/locale"
import path from "path"
import {
  buildUsageInsights,
  formatInsightDuration,
  normalizeUsageInsights,
  type DailyUsage,
  type SessionInsightInput,
  type UsageInsights,
} from "@tui/util/usage-insights"

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_DAYS = 365
const ADVANCED_DAYS = 365
const WEATHER_KV_KEY = "stats_weather"
export const STATS_CACHE_KEY = "stats_insights"
const HEATMAP_ROWS = 7
const HEATMAP_COLUMNS = Math.ceil(DEFAULT_DAYS / HEATMAP_ROWS)

type HeatMode = "daily" | "weekly" | "cumulative"
type StatsScope = "global" | "project" | "directory"
type SessionScopeQuery = { scope?: "project"; path?: string; directory?: string }
type SessionListQuery = SessionScopeQuery & { start: number; limit: number }
type StatsWeatherConfig = {
  enabled: boolean
  region?: string
  latitude?: number
  longitude?: number
  name?: string
  country?: string
}
type StatsWeather = {
  label: string
  detail: string
  ascii: string[]
  temperature?: number
  wind?: number
  code?: number
}
type StatsCachePayload = {
  updated: number
  data: UsageInsights
}

function sameWeatherConfig(left: StatsWeatherConfig, right: StatsWeatherConfig) {
  return (
    left.enabled === right.enabled &&
    left.region === right.region &&
    left.latitude === right.latitude &&
    left.longitude === right.longitude &&
    left.name === right.name &&
    left.country === right.country
  )
}

function intensity(value: number, peak: number) {
  if (value <= 0 || peak <= 0) return 0
  const ratio = value / peak
  if (ratio >= 0.75) return 4
  if (ratio >= 0.45) return 3
  if (ratio >= 0.2) return 2
  return 1
}

function heatGlyph(value: number, peak: number) {
  return ["■", "■", "■", "■", "■"][intensity(value, peak)]
}

function heatColor(theme: ReturnType<typeof useTheme>["theme"], value: number, peak: number) {
  return [theme.textMuted, theme.border, theme.accent, theme.primary, theme.success][intensity(value, peak)]
}

function stat(label: string, value: string, detail?: string) {
  return { label, value, detail }
}

function Panel(props: {
  title: string
  children: any
  width?: number | `${number}%` | "auto"
  grow?: boolean
  height?: number | `${number}%`
  onMouseUp?: () => void
}) {
  const { theme } = useTheme()
  return (
    <box
      flexDirection="column"
      width={props.width}
      height={props.height}
      flexGrow={props.grow ? 1 : 0}
      minWidth={0}
      minHeight={0}
      overflow="hidden"
      borderStyle="single"
      borderColor={theme.border}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
      gap={1}
      onMouseUp={props.onMouseUp}
    >
      <text fg={theme.primary} wrapMode="none">
        {props.title}
      </text>
      {props.children}
    </box>
  )
}

function MetricRows(props: {
  items: Array<{ label: string; value: string; detail?: string }>
  maxWidth?: number
  dense?: boolean
  gap?: number
}) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" gap={props.gap ?? 0}>
      <For each={props.items}>
        {(item) => {
          const line = props.dense
            ? `${item.value} ${item.label}${item.detail ? ` · ${item.detail}` : ""}`
            : `${item.label}: ${item.value}${item.detail ? ` · ${item.detail}` : ""}`
          return (
            <box height={1} overflow="hidden">
              <text fg={theme.text} wrapMode="none">
                {props.maxWidth ? Locale.truncate(line, props.maxWidth) : line}
              </text>
            </box>
          )
        }}
      </For>
    </box>
  )
}

function Header(props: { advanced: boolean; scope: StatsScope; narrow: boolean }) {
  const { theme } = useTheme()
  const mend = useMendTuiProfile()
  const view =
    props.scope === "global" ? "global stats" : props.scope === "project" ? "project stats" : "directory stats"
  const status = `${mend.profile.identity.productName} · ${view} · daily · 365d${props.advanced ? "" : " · compact"}`
  const shortcuts = "↑/↓ day · ←/→ week · a details · r refresh · w weather · esc"
  return (
    <Switch>
      <Match when={props.narrow}>
        <box flexDirection="column" height={3} overflow="hidden">
          <box height={1} overflow="hidden">
            <text fg={theme.text} wrapMode="none">
              Usage Insights
            </text>
          </box>
          <box height={1} overflow="hidden">
            <text fg={theme.textMuted} wrapMode="none">
              {status}
            </text>
          </box>
          <box height={1} overflow="hidden">
            <text fg={theme.textMuted} wrapMode="none">
              {shortcuts}
            </text>
          </box>
        </box>
      </Match>
      <Match when={!props.narrow}>
        <box flexDirection="row" justifyContent="space-between" height={2} overflow="hidden">
          <box flexDirection="column" height={2} overflow="hidden">
            <text fg={theme.text} wrapMode="none">
              Usage Insights
            </text>
            <text fg={theme.textMuted} wrapMode="none">
              {status}
            </text>
          </box>
          <text fg={theme.textMuted} wrapMode="none">
            {shortcuts}
          </text>
        </box>
      </Match>
    </Switch>
  )
}

type ThemeColorValue = ReturnType<typeof useTheme>["theme"]["text"]

function ListRows(props: {
  items: Array<{ name: string; right: string; color?: ThemeColorValue }>
  nameWidth: number
}) {
  const { theme } = useTheme()
  return (
    <For each={props.items}>
      {(item) => (
        <box flexDirection="row" justifyContent="space-between" height={1} overflow="hidden">
          <box overflow="hidden">
            <text fg={item.color ?? theme.text} wrapMode="none">
              {Locale.truncate(item.name, props.nameWidth)}
            </text>
          </box>
          <text fg={theme.textMuted} wrapMode="none">
            {item.right}
          </text>
        </box>
      )}
    </For>
  )
}

function BigNumber(props: { label: string; value: string; detail?: string; accent?: boolean; compact?: boolean }) {
  const { theme } = useTheme()
  return (
    <Panel title={props.label} grow>
      <text fg={props.accent ? theme.success : theme.text} wrapMode="none">
        {props.value}
      </text>
      <Show when={props.detail}>
        <text fg={theme.textMuted} wrapMode="none">
          {props.detail}
        </text>
      </Show>
    </Panel>
  )
}

const CLOCK_DIGITS: Record<string, string[]> = {
  "0": ["█████", "█   █", "█   █", "█   █", "█   █", "█   █", "█████"],
  "1": ["  █  ", " ██  ", "  █  ", "  █  ", "  █  ", "  █  ", "█████"],
  "2": ["█████", "    █", "    █", "█████", "█    ", "█    ", "█████"],
  "3": ["█████", "    █", "    █", "█████", "    █", "    █", "█████"],
  "4": ["█   █", "█   █", "█   █", "█████", "    █", "    █", "    █"],
  "5": ["█████", "█    ", "█    ", "█████", "    █", "    █", "█████"],
  "6": ["█████", "█    ", "█    ", "█████", "█   █", "█   █", "█████"],
  "7": ["█████", "    █", "    █", "   █ ", "  █  ", "  █  ", "  █  "],
  "8": ["█████", "█   █", "█   █", "█████", "█   █", "█   █", "█████"],
  "9": ["█████", "█   █", "█   █", "█████", "    █", "    █", "█████"],
  ":": ["     ", "  █  ", "  █  ", "     ", "  █  ", "  █  ", "     "],
}

function clockAscii(value: string) {
  const chars = value.replace(/\s[AP]M$/, "").split("")
  return Array.from({ length: 7 }, (_, row) => chars.map((char) => CLOCK_DIGITS[char]?.[row] ?? "     ").join(" "))
}

function ClockWidget(props: { tall?: boolean }) {
  const { theme } = useTheme()
  const [now, setNow] = createSignal(new Date())
  const timer = setInterval(() => setNow(new Date()), 30_000)
  onCleanup(() => clearInterval(timer))
  const time = createMemo(() => now().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))
  const date = createMemo(() =>
    now().toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" }),
  )
  return (
    <Panel title="Clock" height={props.tall ? 14 : 12}>
      <box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center" overflow="hidden" gap={0}>
        <For each={clockAscii(time())}>
          {(line) => (
            <text fg={theme.success} wrapMode="none">
              {line}
            </text>
          )}
        </For>
        <box height={1} overflow="hidden">
          <text fg={theme.textMuted} wrapMode="none">
            {date()}
          </text>
        </box>
      </box>
    </Panel>
  )
}

function weatherAscii(code: number | undefined) {
  if (code === undefined) return ["  .-.  ", " (   ) ", "  `-'  "]
  if (code === 0) return [" \\ | / ", "  .-.  ", "-(   )-", "  `-'  ", " / | \\ "]
  if ([1, 2, 3].includes(code)) return ["  .--. ", " (    ).", "(___.__)"]
  if ([45, 48].includes(code)) return [" _ - _ ", "  _ - _", " _ - _ "]
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return ["  .-.  ", " (   ).", "(__.__)", " ' ' ' "]
  if (code >= 71 && code <= 77) return ["  .-.  ", " (   ).", "(__.__)", " * * * "]
  if (code >= 95) return ["  .-.  ", " (   ).", "(__.__)", " ⚡ ⚡  "]
  return ["  .-.  ", " (   ) ", "  `-'  "]
}

function weatherLabel(code: number | undefined) {
  if (code === undefined) return "Unknown"
  if (code === 0) return "Clear"
  if ([1, 2, 3].includes(code)) return "Clouds"
  if ([45, 48].includes(code)) return "Fog"
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "Rain"
  if (code >= 71 && code <= 77) return "Snow"
  if (code >= 95) return "Storm"
  return "Weather"
}

async function fetchOpenMeteoWeather(region: string): Promise<{ config: StatsWeatherConfig; weather: StatsWeather }> {
  const geocodeURL = new URL("https://geocoding-api.open-meteo.com/v1/search")
  geocodeURL.searchParams.set("name", region)
  geocodeURL.searchParams.set("count", "1")
  geocodeURL.searchParams.set("language", "en")
  geocodeURL.searchParams.set("format", "json")
  const geocodeResponse = await fetch(geocodeURL)
  if (!geocodeResponse.ok) throw new Error(`geocoding failed: ${geocodeResponse.status}`)
  const geocode = (await geocodeResponse.json()) as {
    results?: Array<{ name: string; country?: string; latitude: number; longitude: number }>
  }
  const place = geocode.results?.[0]
  if (!place) throw new Error(`No weather location found for "${region}"`)

  const forecastURL = new URL("https://api.open-meteo.com/v1/forecast")
  forecastURL.searchParams.set("latitude", String(place.latitude))
  forecastURL.searchParams.set("longitude", String(place.longitude))
  forecastURL.searchParams.set("current", "temperature_2m,weather_code,wind_speed_10m")
  forecastURL.searchParams.set("timezone", "auto")
  const forecastResponse = await fetch(forecastURL)
  if (!forecastResponse.ok) throw new Error(`weather failed: ${forecastResponse.status}`)
  const forecast = (await forecastResponse.json()) as {
    current?: { temperature_2m?: number; weather_code?: number; wind_speed_10m?: number }
  }
  const code = forecast.current?.weather_code
  const temp = forecast.current?.temperature_2m
  const wind = forecast.current?.wind_speed_10m
  return {
    config: {
      enabled: true,
      region,
      latitude: place.latitude,
      longitude: place.longitude,
      name: place.name,
      country: place.country,
    },
    weather: {
      label: weatherLabel(code),
      detail: `${place.name}${place.country ? `, ${place.country}` : ""}`,
      ascii: weatherAscii(code),
      temperature: temp,
      wind,
      code,
    },
  }
}

function WeatherWidget(props: {
  config: StatsWeatherConfig
  weather: StatsWeather | undefined
  loading: boolean
  error?: string
  onConfigure: () => void
  height?: number | `${number}%`
  grow?: boolean
}) {
  const { theme } = useTheme()
  return (
    <Panel title="Weather" height={props.height ?? 10} grow={props.grow} onMouseUp={props.onConfigure}>
      <Show
        when={props.config.enabled && props.weather}
        fallback={
          <box
            flexDirection="column"
            flexGrow={1}
            justifyContent="center"
            alignItems="center"
            gap={1}
            overflow="hidden"
          >
            <text fg={props.error ? theme.error : theme.text} wrapMode="none">
              {props.loading ? "Loading weather..." : props.error ? Locale.truncate(props.error, 34) : "Weather is off"}
            </text>
            <text fg={theme.primary} wrapMode="none">
              click or press w to configure
            </text>
          </box>
        }
      >
        {(weather) => (
          <box flexDirection="row" gap={3} flexGrow={1} overflow="hidden" alignItems="center" justifyContent="center">
            <box flexDirection="column">
              <For each={weather().ascii.slice(0, 3)}>
                {(line) => (
                  <text fg={theme.warning} wrapMode="none">
                    {line}
                  </text>
                )}
              </For>
            </box>
            <box flexDirection="column" minWidth={0} overflow="hidden" gap={0}>
              <text fg={theme.text} wrapMode="none">
                {weather().label}{" "}
                {weather().temperature === undefined ? "" : `${Math.round(weather().temperature ?? 0)}°C`}
              </text>
              <text fg={theme.textMuted} wrapMode="none">
                {Locale.truncate(weather().detail, 22)}
              </text>
              <Show when={weather().wind !== undefined}>
                <text fg={theme.textMuted} wrapMode="none">
                  wind {Math.round(weather().wind ?? 0)} km/h
                </text>
              </Show>
            </box>
          </box>
        )}
      </Show>
    </Panel>
  )
}

function StatusSummary(props: {
  rows: Array<{ label: string; value: string; detail?: string }>
  width: number
  height?: number | `${number}%`
  grow?: boolean
  compact?: boolean
}) {
  return (
    <Panel title="Status" height={props.height} grow={props.grow}>
      <box flexDirection="column" flexGrow={1} justifyContent="flex-start" overflow="hidden">
        <MetricRows items={props.rows} maxWidth={props.width} gap={props.compact ? 0 : 1} />
      </box>
    </Panel>
  )
}

function LoadingStats(props: { tiny: boolean }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" minHeight={0} flexGrow={1} gap={1}>
      <Panel title="Activity" height={props.tiny ? 8 : 7}>
        <box flexDirection="column" flexGrow={1} justifyContent="center" overflow="hidden" gap={1}>
          <text fg={theme.text} wrapMode="none">
            Loading session metrics...
          </text>
          <text fg={theme.textMuted} wrapMode="none">
            Reading global cached stats first.
          </text>
        </box>
      </Panel>
      <Panel title="Token activity · daily · 365 days" grow>
        <box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center" overflow="hidden" gap={1}>
          <text fg={theme.textMuted} wrapMode="none">
            · · · · · · · · · · · · · · · · · · · · ·
          </text>
          <text fg={theme.primary} wrapMode="none">
            Preparing usage timeline
          </text>
        </box>
      </Panel>
    </box>
  )
}

function selectedDayRows(day: DailyUsage) {
  const number = (value: number | undefined) => Locale.number(value ?? 0)
  return [
    stat("tokens", number(day.tokens), `${number(day.cacheTokens)} cache`),
    stat(
      "mix",
      `${number(day.inputTokens)} in`,
      `${number(day.outputTokens)} out · ${number(day.reasoningTokens)} reasoning`,
    ),
    stat("sessions", number(day.sessions), `${number(day.userMessages)} prompts`),
    stat("words", number(day.userWords), `${number(day.changedFiles)} changed files`),
    stat("AI generating", formatInsightDuration(day.aiResponseMs), `${formatInsightDuration(day.toolMs)} tool runtime`),
  ]
}

function SelectedDayDetail(props: { day?: DailyUsage; width: number; compact?: boolean }) {
  const { theme } = useTheme()
  return (
    <Show when={props.day}>
      {(day) => (
        <box flexDirection="column" paddingTop={1} gap={0} overflow="hidden">
          <box height={1} overflow="hidden">
            <text fg={theme.primary} wrapMode="none">
              {Locale.truncate(`selected day · ${day().day}`, props.width)}
            </text>
          </box>
          <MetricRows items={selectedDayRows(day()).slice(0, props.compact ? 4 : 5)} maxWidth={props.width} dense />
        </box>
      )}
    </Show>
  )
}

function CompactStats(props: {
  headline: Array<{ label: string; value: string; detail?: string }>
  insights: UsageInsights
  mode: HeatMode
  columns: number
  contentWidth: number
  selectedDay?: DailyUsage
  selectedDayIndex?: number
  onSelectDay?: (index: number) => void
  tokenRows?: Array<{ label: string; value: string; detail?: string }>
  responseRows?: Array<{ label: string; value: string; detail?: string }>
  statusRows?: Array<{ label: string; value: string; detail?: string }>
  tall?: boolean
}) {
  return (
    <box flexDirection="column" minHeight={0} flexGrow={1} gap={1}>
      <Panel title="Activity" height={8}>
        <MetricRows items={props.headline.slice(0, 4)} maxWidth={props.contentWidth} />
      </Panel>
      <Panel title="Token activity · daily · 365 days" grow>
        <UsageHeatmap
          insights={props.insights}
          mode={props.mode}
          columns={props.columns}
          cellWidth={2}
          rows={7}
          labels={true}
          selectedIndex={props.selectedDayIndex}
          onSelectDay={props.onSelectDay}
        />
        <SelectedDayDetail day={props.selectedDay} width={props.contentWidth} compact />
      </Panel>
      <Show when={props.tall}>
        <box flexDirection="column" gap={1} height={20} minHeight={0}>
          <Panel title="Token Mix" grow>
            <MetricRows items={props.tokenRows ?? []} dense />
          </Panel>
          <Panel title="Response Load" grow>
            <MetricRows items={props.responseRows ?? []} dense />
          </Panel>
          <StatusSummary rows={props.statusRows ?? []} width={props.contentWidth} grow />
        </box>
      </Show>
    </box>
  )
}

function MainDashboard(props: {
  data: UsageInsights
  wide: boolean
  roomy: boolean
  details: boolean
  mode: HeatMode
  heatColumns: number
  heatCellWidth: number
  selectedDay?: DailyUsage
  selectedDayIndex?: number
  onSelectDay: (index: number) => void
  kpis: Array<{ label: string; value: string; detail?: string }>
  tokenRows: Array<{ label: string; value: string; detail?: string }>
  responseRows: Array<{ label: string; value: string; detail?: string }>
  outcomeRows: Array<{ label: string; value: string; detail?: string }>
  statusRows: Array<{ label: string; value: string; detail?: string }>
  contentWidth: number
  weatherConfig: StatsWeatherConfig
  weather: StatsWeather | undefined
  weatherLoading: boolean
  weatherError?: string
  onConfigureWeather: () => void
}) {
  const { theme } = useTheme()
  const peakWidth = createMemo(() => (props.roomy ? 18 : 14))
  return (
    <box flexDirection="column" minHeight={0} flexGrow={1} gap={1}>
      <box flexDirection="row" gap={1} height={props.roomy ? 8 : 7}>
        <For each={props.kpis}>
          {(item, index) => (
            <BigNumber label={item.label} value={item.value} detail={item.detail} accent={index() === 0} />
          )}
        </For>
      </box>

      <box flexDirection={props.wide ? "row" : "column"} flexGrow={1} minHeight={0} gap={1}>
        <box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0} gap={1}>
          <Panel title="Token activity · daily · 365 days" grow>
            <UsageHeatmap
              insights={props.data}
              mode={props.mode}
              columns={props.heatColumns}
              cellWidth={props.heatCellWidth}
              labels={props.roomy}
              selectedIndex={props.selectedDayIndex}
              onSelectDay={props.onSelectDay}
            />
            <SelectedDayDetail day={props.selectedDay} width={props.contentWidth} />
          </Panel>
          <box flexDirection="row" gap={1} height={props.roomy ? 8 : 6}>
            <Panel title="Token Mix" grow>
              <MetricRows items={props.tokenRows} dense />
            </Panel>
            <Panel title="Response Load" grow>
              <MetricRows items={props.responseRows} dense />
            </Panel>
            <Panel title="Peak Pressure" width={props.roomy ? 42 : 34}>
              <ProgressBar
                value={
                  props.data.totals.peakTokens > 0
                    ? (props.data.days.at(-1)?.tokens ?? 0) / props.data.totals.peakTokens
                    : 0
                }
                width={peakWidth()}
                color={theme.success}
              />
              <text fg={theme.textMuted} wrapMode="none">
                today vs peak day
              </text>
            </Panel>
          </box>
          <Show when={props.details}>
            <box flexDirection="row" gap={1} height={11} minHeight={0}>
              <Panel title="Outcome Signals" grow>
                <MetricRows items={props.outcomeRows} maxWidth={props.contentWidth} />
                <text fg={theme.textMuted} wrapMode="none">
                  Local evidence only; git/PR metrics pending.
                </text>
              </Panel>
              <Panel title="Most Used Tools" width={34}>
                <Switch>
                  <Match when={props.data.topTools.length === 0}>
                    <text fg={theme.textMuted}>No tool calls in this window</text>
                  </Match>
                  <Match when={props.data.topTools.length > 0}>
                    <ListRows
                      items={props.data.topTools.map((item) => ({ name: item.name, right: Locale.number(item.count) }))}
                      nameWidth={20}
                    />
                  </Match>
                </Switch>
              </Panel>
              <Panel title="Agents & Models" width={42}>
                <ListRows
                  items={props.data.topAgents
                    .slice(0, 3)
                    .map((item) => ({ name: item.name, right: Locale.number(item.count) }))}
                  nameWidth={22}
                />
                <ListRows
                  items={props.data.topModels
                    .slice(0, 2)
                    .map((item) => ({ name: item.name, right: Locale.number(item.tokens), color: theme.textMuted }))}
                  nameWidth={24}
                />
              </Panel>
            </box>
          </Show>
        </box>

        <Show when={props.wide}>
          <box flexDirection="column" width={44} height="100%" gap={1} minWidth={0}>
            <ClockWidget tall={props.roomy} />
            <WeatherWidget
              config={props.weatherConfig}
              weather={props.weather}
              loading={props.weatherLoading}
              error={props.weatherError}
              onConfigure={props.onConfigureWeather}
              height={props.roomy ? 11 : 10}
            />
            <StatusSummary rows={props.statusRows} width={38} grow compact />
          </box>
        </Show>
      </box>
    </box>
  )
}

function ProgressBar(props: { value: number; width: number; color?: ThemeColorValue }) {
  const { theme } = useTheme()
  const filled = createMemo(() => Math.max(0, Math.min(props.width, Math.round(props.value * props.width))))
  return (
    <text fg={props.color ?? theme.primary} wrapMode="none">
      {"██".repeat(filled())}
      <span style={{ fg: theme.border }}>{"□□".repeat(Math.max(0, props.width - filled()))}</span>
    </text>
  )
}

function timelineLabel(day: DailyUsage | undefined) {
  if (!day) return ""
  const date = new Date(day.time)
  const month = date.toLocaleDateString([], { month: "short" })
  return `${month} ${String(date.getFullYear()).slice(2)}`
}

function timelineLabels(days: DailyUsage[]) {
  if (days.length === 0) return []
  const positions = [0, 0.25, 0.5, 0.75, 1].map((value) =>
    Math.min(days.length - 1, Math.round((days.length - 1) * value)),
  )
  return [...new Set(positions)].map((index) => timelineLabel(days[index]))
}

function cacheAgeLabel(updated: number | undefined) {
  if (!updated) return "cold"
  const elapsed = Date.now() - updated
  if (elapsed < 60_000) return "fresh"
  return `${formatInsightDuration(elapsed)} old`
}

type HeatCell = {
  day?: DailyUsage
  index?: number
  value: number
}

function UsageHeatmap(props: {
  insights: UsageInsights
  mode: HeatMode
  columns: number
  cellWidth?: number
  rows?: number
  labels?: boolean
  selectedIndex?: number
  onSelectDay?: (index: number) => void
}) {
  const { theme } = useTheme()
  const rowCount = createMemo(() => props.rows ?? 7)
  const visible = createMemo(() => props.insights.days.slice(-props.columns * rowCount()))
  const visibleStart = createMemo(() => Math.max(0, props.insights.days.length - visible().length))
  const columnCount = createMemo(() => Math.max(1, Math.ceil(visible().length / rowCount())))
  const cellWidth = createMemo(() => Math.max(1, props.cellWidth ?? 2))
  const values = createMemo(() => {
    if (props.mode === "weekly") {
      const daily = visible().map((day) => day.tokens + day.userWords * 3 + day.sessions * 500)
      return daily.map((_, index) => {
        const column = Math.floor(index / rowCount())
        const start = column * rowCount()
        return daily.slice(start, start + rowCount()).reduce((sum, value) => sum + value, 0)
      })
    }
    let running = 0
    return visible().map((day) => {
      const value = day.tokens
      if (props.mode === "cumulative") {
        running += value
        return running
      }
      return value
    })
  })
  const peak = createMemo(() => Math.max(1, ...values()))
  const rows = createMemo<HeatCell[][]>(() => {
    const days = visible()
    const metrics = values()
    return Array.from({ length: rowCount() }, (_, row) => {
      return Array.from({ length: columnCount() }, (_, column) => {
        const localIndex = column * rowCount() + row
        const day = days[localIndex]
        if (!day) return { value: 0 }
        return {
          day,
          index: visibleStart() + localIndex,
          value: metrics[localIndex] ?? 0,
        }
      })
    })
  })
  const labels = createMemo(() => timelineLabels(visible()))
  const cellText = (cell: HeatCell) => {
    if (cell.index === undefined) return "".padEnd(cellWidth())
    if (cell.index === props.selectedIndex) return "▣".padEnd(cellWidth())
    return heatGlyph(cell.value, peak()).padEnd(cellWidth())
  }

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} gap={0}>
      <box flexDirection="column" flexGrow={1} justifyContent="center" gap={0}>
        <For each={rows()}>
          {(row) => (
            <box flexDirection="row" gap={0} height={1} justifyContent="space-between" width="100%">
              <For each={row}>
                {(cell) => (
                  <text
                    fg={cell.index === props.selectedIndex ? theme.warning : heatColor(theme, cell.value, peak())}
                    wrapMode="none"
                    onMouseOver={() => cell.index !== undefined && props.onSelectDay?.(cell.index)}
                    onMouseUp={() => cell.index !== undefined && props.onSelectDay?.(cell.index)}
                  >
                    {cellText(cell)}
                  </text>
                )}
              </For>
            </box>
          )}
        </For>
      </box>
      <Show when={props.labels ?? true}>
        <box flexDirection="row" justifyContent="space-between" paddingTop={1} overflow="hidden">
          <For each={labels()}>{(label) => <text fg={theme.textMuted}>{label}</text>}</For>
        </box>
      </Show>
    </box>
  )
}

function statsURL(
  sdk: ReturnType<typeof useSDK>,
  route: string,
  query: Record<string, string | number | boolean | undefined>,
) {
  const url = new URL(route, sdk.url)
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  return url
}

async function listGlobalSessions(sdk: ReturnType<typeof useSDK>, query: SessionListQuery) {
  const headers = new Headers(sdk.headers)
  if (sdk.directory) headers.set("x-mendcode-directory", encodeURIComponent(sdk.directory))
  try {
    const response = await sdk.fetch(statsURL(sdk, "/experimental/session", query), { headers })
    if (!response.ok) throw new Error(`global stats failed: ${response.status}`)
    return (await response.json()) as SessionInsightInput["session"][]
  } catch {
    const result = await sdk.client.experimental.session.list(query, { throwOnError: true })
    return (result.data ?? []) as SessionInsightInput["session"][]
  }
}

async function loadInsights(
  sdk: ReturnType<typeof useSDK>,
  options: { advanced: boolean; scope: StatsScope; query: SessionScopeQuery },
) {
  const days = options.advanced ? ADVANCED_DAYS : DEFAULT_DAYS
  const start = Date.now() - days * DAY_MS
  const query: SessionListQuery = {
    start,
    limit: options.advanced ? 1000 : 250,
    ...options.query,
  }
  const sessions =
    options.scope === "global"
      ? await listGlobalSessions(sdk, query)
      : ((await sdk.client.session.list(query, { throwOnError: true })).data ?? [])
  const items = await Promise.all(
    sessions.map(async (session) => {
      const result = await sdk.client.session.messages({ sessionID: session.id, limit: 500 })
      return { session, messages: result.data ?? [] } as SessionInsightInput
    }),
  )
  return buildUsageInsights(items, { start, end: Date.now() })
}

export function usageInsightsCacheKey(scope: StatsScope) {
  return `${STATS_CACHE_KEY}:${scope}`
}

export async function warmUsageInsightsCache(input: {
  sdk: ReturnType<typeof useSDK>
  kv: ReturnType<typeof useKV>
  scope?: StatsScope
  query?: SessionScopeQuery
}) {
  const scope = input.scope ?? "global"
  const next = await loadInsights(input.sdk, { advanced: true, scope, query: input.query ?? {} })
  input.kv.set(usageInsightsCacheKey(scope), { updated: Date.now(), data: next })
  return next
}

export function Stats() {
  const route = useRoute()
  const sdk = useSDK()
  const sync = useSync()
  const project = useProject()
  const kv = useKV()
  const dialog = useDialog()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [advanced, setAdvanced] = createSignal(true)
  const [scope] = createSignal<StatsScope>(route.data.type === "stats" ? (route.data.scope ?? "global") : "global")
  const mode = () => "daily" as const
  const [weatherConfig, setWeatherConfig] = createSignal<StatsWeatherConfig>({ enabled: false })
  const [weatherRefresh, setWeatherRefresh] = createSignal(0)
  const [weatherError, setWeatherError] = createSignal<string | undefined>()
  const [weatherReady, setWeatherReady] = createSignal(false)
  const [selectedDayIndex, setSelectedDayIndex] = createSignal<number | undefined>()
  const [cacheUpdated, setCacheUpdated] = createSignal<number | undefined>()
  const [cacheReady, setCacheReady] = createSignal(false)
  const [insightRefreshRequest, setInsightRefreshRequest] = createSignal(0)
  const [refreshingInsights, setRefreshingInsights] = createSignal(false)
  const tiny = createMemo(() => dimensions().width < 92 || dimensions().height < 26)
  const narrow = createMemo(() => !tiny() && dimensions().width < 124)
  const wide = createMemo(() => dimensions().width >= 142 && dimensions().height >= 34)
  const roomy = createMemo(() => dimensions().width >= 170 && dimensions().height >= 38)
  const compactTall = createMemo(() => dimensions().height >= 42)
  const showDetails = createMemo(() => advanced() && dimensions().height >= 38 && !tiny() && !narrow())
  const contentWidth = createMemo(() => Math.max(28, dimensions().width - 12))
  const heatColumns = createMemo(() => {
    return HEATMAP_COLUMNS
  })
  const heatCellWidth = createMemo(() => {
    const sideColumn = wide() ? 46 : 0
    const panelChrome = 8
    const available = Math.max(HEATMAP_COLUMNS, dimensions().width - sideColumn - panelChrome)
    return Math.max(2, Math.min(4, Math.floor(available / HEATMAP_COLUMNS)))
  })
  const scopeQuery = createMemo<SessionScopeQuery>(() => {
    if (scope() === "global") return {}
    if (scope() === "project") return { scope: "project" }
    const current = project.data.instance.path
    if (current.worktree && current.directory) {
      return {
        path: path.relative(path.resolve(current.worktree), current.directory).replaceAll("\\", "/"),
      }
    }
    if (current.directory) return { directory: current.directory }
    return { scope: "project" }
  })
  const statsCacheKey = createMemo(() => usageInsightsCacheKey(scope()))
  const [cachedInsights, setCachedInsights] = createSignal<UsageInsights | undefined>()
  createEffect(() => {
    if (!kv.ready) return
    setCacheReady(false)
    const cached = kv.get(statsCacheKey()) as StatsCachePayload | UsageInsights | undefined
    if (cached && typeof cached === "object" && "data" in cached) {
      setCachedInsights(normalizeUsageInsights(cached.data))
      setCacheUpdated(cached.updated)
      setCacheReady(true)
      return
    }
    setCachedInsights(normalizeUsageInsights(cached))
    setCacheUpdated(undefined)
    setCacheReady(true)
  })
  createEffect(() => {
    if (!kv.ready) return
    setWeatherConfig(kv.get(WEATHER_KV_KEY, { enabled: false }) as StatsWeatherConfig)
  })
  const [insights] = createResource(
    () => ({
      ready: kv.ready && cacheReady(),
      advanced: advanced(),
      scope: scope(),
      query: scopeQuery(),
      refresh: insightRefreshRequest(),
    }),
    async (input) => {
      if (!input.ready) return undefined
      const cached = cachedInsights()
      if (cached && input.refresh === 0) return cached
      setRefreshingInsights(true)
      try {
        const next = await loadInsights(sdk, input)
        const updated = Date.now()
        const normalized = normalizeUsageInsights(next)
        const payload = { updated, data: normalized ?? next }
        setCachedInsights(normalized)
        setCacheUpdated(updated)
        kv.set(statsCacheKey(), payload)
        return next
      } finally {
        setRefreshingInsights(false)
      }
    },
  )
  const [weather] = createResource(
    () => ({ config: weatherConfig(), refresh: weatherRefresh(), ready: weatherReady() }),
    async ({ config, ready }) => {
      setWeatherError(undefined)
      if (!ready || !config.enabled || !config.region) return undefined
      try {
        const result = await fetchOpenMeteoWeather(config.region)
        if (!sameWeatherConfig(config, result.config)) {
          setWeatherConfig(result.config)
          kv.set(WEATHER_KV_KEY, result.config)
        }
        return result.weather
      } catch (error) {
        setWeatherError(error instanceof Error ? error.message : "Weather failed")
        return undefined
      }
    },
  )

  const weatherStart = setTimeout(() => setWeatherReady(true), 1_500)
  const weatherPoll = setInterval(() => {
    if (weatherConfig().enabled) setWeatherRefresh((value) => value + 1)
  }, 30 * 60_000)
  onCleanup(() => {
    clearTimeout(weatherStart)
    clearInterval(weatherPoll)
  })

  async function configureWeather() {
    const current = weatherConfig()
    const value = await DialogPrompt.show(dialog, "Weather region", {
      value: current.region ?? "",
      placeholder: "City, region, or country",
      description: () => (
        <text fg={theme.textMuted}>
          Uses Open-Meteo geocoding and forecast. Leave blank to disable the weather widget.
        </text>
      ),
    })
    dialog.clear()
    if (value === null) return
    const region = value.trim()
    if (!region) {
      const next = { enabled: false } satisfies StatsWeatherConfig
      setWeatherConfig(next)
      kv.set(WEATHER_KV_KEY, next)
      setWeatherError(undefined)
      setWeatherRefresh((current) => current + 1)
      return
    }
    try {
      setWeatherError(undefined)
      setWeatherReady(true)
      const result = await fetchOpenMeteoWeather(region)
      setWeatherConfig(result.config)
      kv.set(WEATHER_KV_KEY, result.config)
      setWeatherRefresh((current) => current + 1)
    } catch (error) {
      setWeatherError(error instanceof Error ? error.message : "Weather failed")
    }
  }

  const visibleInsights = createMemo(() => cachedInsights() ?? insights())
  createEffect(() => {
    const data = visibleInsights()
    if (!data || data.days.length === 0) return
    const current = selectedDayIndex()
    if (current === undefined || current < 0 || current >= data.days.length) {
      setSelectedDayIndex(data.days.length - 1)
    }
  })

  function selectDay(index: number) {
    const data = visibleInsights()
    if (!data || data.days.length === 0) return
    setSelectedDayIndex(Math.max(0, Math.min(data.days.length - 1, index)))
  }

  function moveSelectedDay(delta: number) {
    const data = visibleInsights()
    if (!data || data.days.length === 0) return
    selectDay((selectedDayIndex() ?? data.days.length - 1) + delta)
  }

  function moveSelectedColumn(delta: number) {
    moveSelectedDay(delta * HEATMAP_ROWS)
  }

  useKeyboard((evt) => {
    if (evt.name === "escape") {
      route.navigate(routeReturnTarget(route.data))
      evt.preventDefault()
      evt.stopPropagation()
      return
    }
    if (evt.name === "a") {
      setAdvanced((value) => !value)
      return
    }
    if (evt.name === "r") {
      evt.preventDefault()
      evt.stopPropagation()
      setInsightRefreshRequest((value) => value + 1)
      return
    }
    if (evt.name === "w") {
      evt.preventDefault()
      evt.stopPropagation()
      configureWeather()
      return
    }
    if (evt.name === "left" || evt.name === "h") {
      evt.preventDefault()
      evt.stopPropagation()
      moveSelectedColumn(-1)
      return
    }
    if (evt.name === "right" || evt.name === "l") {
      evt.preventDefault()
      evt.stopPropagation()
      moveSelectedColumn(1)
      return
    }
    if (evt.name === "up" || evt.name === "k") {
      evt.preventDefault()
      evt.stopPropagation()
      moveSelectedDay(-1)
      return
    }
    if (evt.name === "down" || evt.name === "j") {
      evt.preventDefault()
      evt.stopPropagation()
      moveSelectedDay(1)
      return
    }
  })

  const selectedDay = createMemo(() => {
    const data = visibleInsights()
    const index = selectedDayIndex()
    if (!data || index === undefined) return undefined
    return data.days[index]
  })
  const totals = createMemo(() => visibleInsights()?.totals)
  const headline = createMemo(() => {
    const current = totals()
    if (!current) return []
    return [
      stat("tokens", Locale.number(current.tokens), `${Locale.number(current.peakTokens)} peak day`),
      stat("sessions", Locale.number(current.sessions), `${Locale.number(current.activeDays)} active days`),
      stat(
        "AI generating",
        formatInsightDuration(current.aiResponseMs),
        `${formatInsightDuration(current.longestTaskMs)} longest`,
      ),
      stat("user words", Locale.number(current.userWords), `${Locale.number(current.userMessages)} prompts`),
      stat("cache tokens", Locale.number(current.cacheTokens)),
      stat("streak", `${current.currentStreak} days`, `${current.longestStreak} longest`),
    ]
  })
  const kpis = createMemo(() => {
    const current = totals()
    if (!current) return []
    return [
      stat("tokens", Locale.number(current.tokens), `${Locale.number(current.peakTokens)} peak`),
      stat("sessions", Locale.number(current.sessions), `${Locale.number(current.activeDays)} days`),
      stat(
        "AI time",
        formatInsightDuration(current.aiResponseMs),
        `${formatInsightDuration(current.longestTaskMs)} longest`,
      ),
      stat("words", Locale.number(current.userWords), `${Locale.number(current.userMessages)} prompts`),
    ]
  })
  const tokenRows = createMemo(() => {
    const current = totals()
    if (!current) return []
    return [
      stat("input", Locale.number(current.inputTokens)),
      stat("output", Locale.number(current.outputTokens)),
      stat("reasoning", Locale.number(current.reasoningTokens)),
      stat("cache", Locale.number(current.cacheTokens)),
    ]
  })
  const outcomeRows = createMemo(() => {
    const current = totals()
    if (!current) return []
    return [
      stat("sessions with code changes", Locale.number(current.sessionsWithCodeChanges)),
      stat("changed files", Locale.number(current.changedFiles)),
      stat("tool runtime", formatInsightDuration(current.toolMs)),
      stat("loaded window", advanced() ? `${ADVANCED_DAYS} days` : `${DEFAULT_DAYS} days`),
    ]
  })

  const statusRows = createMemo(() => {
    const current = totals()
    if (!current) return []
    return [
      stat("window", advanced() ? `${ADVANCED_DAYS} days` : `${DEFAULT_DAYS} days`),
      stat("visible sync", Locale.number(sync.data.session.length)),
      stat("active days", Locale.number(current.activeDays)),
      stat("sessions", Locale.number(current.sessions)),
      stat("prompts", Locale.number(current.userMessages)),
      stat("streak", `${current.currentStreak}d`, `${current.longestStreak} longest`),
      stat("cache tokens", Locale.number(current.cacheTokens)),
      stat("cache age", cacheAgeLabel(cacheUpdated()), refreshingInsights() ? "refreshing" : "ready"),
      stat("changed files", Locale.number(current.changedFiles)),
      stat("code sessions", Locale.number(current.sessionsWithCodeChanges)),
    ]
  })
  const responseRows = createMemo(() => {
    const current = totals()
    if (!current) return []
    return [
      stat("AI generating", formatInsightDuration(current.aiResponseMs)),
      stat("tool runtime", formatInsightDuration(current.toolMs)),
      stat("cache", Locale.number(current.cacheTokens)),
    ]
  })
  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
      gap={1}
    >
      <Header advanced={showDetails()} scope={scope()} narrow={tiny()} />
      <Switch>
        <Match when={!visibleInsights()}>
          <LoadingStats tiny={tiny()} />
        </Match>
        <Match when={visibleInsights()}>
          {(data) => (
            <box flexDirection="column" minHeight={0} flexGrow={1} gap={1}>
              <Switch>
                <Match when={tiny()}>
                  <scrollbox
                    flexGrow={1}
                    minHeight={0}
                    horizontalScrollbarOptions={{ visible: false }}
                    verticalScrollbarOptions={{
                      visible: true,
                      trackOptions: {
                        backgroundColor: theme.backgroundPanel,
                        foregroundColor: theme.border,
                      },
                    }}
                  >
                    <CompactStats
                      headline={headline()}
                      insights={data()}
                      mode={mode()}
                      columns={heatColumns()}
                      contentWidth={contentWidth()}
                      selectedDay={selectedDay()}
                      selectedDayIndex={selectedDayIndex()}
                      onSelectDay={selectDay}
                      tokenRows={tokenRows()}
                      responseRows={responseRows()}
                      statusRows={statusRows()}
                      tall={true}
                    />
                  </scrollbox>
                </Match>
                <Match when={!tiny()}>
                  <MainDashboard
                    data={data()}
                    wide={wide()}
                    roomy={roomy()}
                    details={showDetails()}
                    mode={mode()}
                    heatColumns={heatColumns()}
                    heatCellWidth={heatCellWidth()}
                    selectedDay={selectedDay()}
                    selectedDayIndex={selectedDayIndex()}
                    onSelectDay={selectDay}
                    kpis={kpis()}
                    tokenRows={tokenRows()}
                    responseRows={responseRows()}
                    outcomeRows={outcomeRows()}
                    statusRows={statusRows()}
                    contentWidth={contentWidth()}
                    weatherConfig={weatherConfig()}
                    weather={weather()}
                    weatherLoading={weather.loading || (weatherConfig().enabled && !weatherReady())}
                    weatherError={weatherError()}
                    onConfigureWeather={configureWeather}
                  />
                </Match>
              </Switch>
            </box>
          )}
        </Match>
      </Switch>
    </box>
  )
}
