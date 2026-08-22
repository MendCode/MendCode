import {
  For,
  Match,
  Show,
  Switch,
  batch,
  createEffect,
  createMemo,
  createResource,
  createSelector,
  createSignal,
  onCleanup,
} from "solid-js"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { routeReturnTarget, useRoute } from "@tui/context/route"
import { useSDK } from "@tui/context/sdk"
import { useTheme } from "@tui/context/theme"
import { useSync } from "@tui/context/sync"
import { useProject } from "@tui/context/project"
import { useKV } from "@tui/context/kv"
import { useDialog } from "@tui/ui/dialog"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { DialogSelect } from "@tui/ui/dialog-select"
import { Spinner } from "@tui/component/spinner"
import { CommandDeck, commandDeckLayout } from "@tui/component/command-deck"
import { Locale } from "@/util/locale"
import path from "path"
import { abortAfterAny } from "@/util/abort"
import {
  buildUsageInsights,
  formatInsightDuration,
  formatInsightNumber,
  normalizeUsageInsights,
  type DailyUsage,
  type SessionInsightInput,
  type UsageInsights,
} from "@tui/util/usage-insights"
import { loadSubscriptionUsage, type SubscriptionUsageSnapshot } from "@tui/routes/stats/subscription-usage"

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_DAYS = 365
const ADVANCED_DAYS = 365
const WEATHER_KV_KEY = "stats_weather"
const WIDGETS_KV_KEY = "stats_widgets_v1"
export const STATS_CACHE_KEY = "stats_insights_v2"
const STATS_CACHE_STALE_MS = 5 * 60 * 1000
const STATS_TODAY_CACHE_STALE_MS = 5 * 60 * 1000
const STATS_REQUEST_TIMEOUT_MS = 10 * 1000
const STATS_FALLBACK_SESSION_LIMIT = 100
const STATS_FALLBACK_MESSAGE_LIMIT = 100
const STATS_MESSAGE_FETCH_CONCURRENCY = 12
const STATS_NORMAL_SESSION_LIMIT = 100
const STATS_NORMAL_MESSAGE_LIMIT = 50
const STATS_ADVANCED_SESSION_LIMIT = 250
const STATS_ADVANCED_MESSAGE_LIMIT = 100
const HEATMAP_ROWS = 7
const HEATMAP_COLUMNS = Math.ceil(DEFAULT_DAYS / HEATMAP_ROWS)
const HEAT_MODES: HeatMode[] = ["daily", "weekly", "cumulative"]
const STATS_WIDGET_IDS = [
  "token-mix",
  "response-load",
  "subscription-usage",
  "peak-pressure",
  "clock",
  "weather",
  "status",
  "outcome-signals",
  "tools",
  "agents-models",
] as const
const DEFAULT_STATS_WIDGETS: StatsWidgetID[] = STATS_WIDGET_IDS.filter((id) => id !== "peak-pressure")

export function statsUsesScrollableLayout(width: number, height: number) {
  return width < 92 || height < 42
}

type HeatMode = "daily" | "weekly" | "cumulative"
type StatsWidgetID = (typeof STATS_WIDGET_IDS)[number]
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

const STATS_WIDGET_META: Record<StatsWidgetID, { title: string; description: string; category: string }> = {
  "token-mix": { title: "Token Mix", description: "Input, output, reasoning, and cache", category: "Activity" },
  "response-load": { title: "Response Load", description: "AI and tool runtime", category: "Activity" },
  "subscription-usage": {
    title: "Subscription Usage",
    description: "Real Codex plan windows from local telemetry",
    category: "Activity",
  },
  "peak-pressure": { title: "Peak Pressure", description: "Today compared with the peak day", category: "Activity" },
  clock: { title: "Clock", description: "Local time and date", category: "Side rail" },
  weather: { title: "Weather", description: "Configured Open-Meteo weather", category: "Side rail" },
  status: { title: "Status", description: "Cache and loaded-window diagnostics", category: "Side rail" },
  "outcome-signals": { title: "Outcome Signals", description: "Local code-change evidence", category: "Details" },
  tools: { title: "Most Used Tools", description: "Tool call frequency", category: "Details" },
  "agents-models": { title: "Agents & Models", description: "Most active agents and models", category: "Details" },
}

export function normalizeStatsWidgets(input: unknown): StatsWidgetID[] {
  if (!Array.isArray(input)) return [...DEFAULT_STATS_WIDGETS]
  const known = new Set<StatsWidgetID>(STATS_WIDGET_IDS)
  return [
    ...new Set(
      input.filter((item): item is StatsWidgetID => typeof item === "string" && known.has(item as StatsWidgetID)),
    ),
  ]
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
  return [theme.textMuted, theme.primary, theme.accent, theme.warning, theme.success][intensity(value, peak)]
}

export function statsDayTokenValue(
  day: Pick<DailyUsage, "tokens" | "inputTokens" | "outputTokens" | "reasoningTokens" | "cacheTokens">,
) {
  const components = day.inputTokens + day.outputTokens + day.reasoningTokens + day.cacheTokens
  return day.tokens > 0 || components <= 0 ? day.tokens : components
}

export function statsDayVisualValue(
  day: Pick<
    DailyUsage,
    | "tokens"
    | "inputTokens"
    | "outputTokens"
    | "reasoningTokens"
    | "cacheTokens"
    | "sessions"
    | "messages"
    | "userMessages"
    | "aiResponseMs"
    | "toolMs"
  >,
) {
  const tokens = statsDayTokenValue(day)
  if (tokens > 0) return tokens
  return day.messages > day.userMessages || day.sessions > 0 || day.aiResponseMs > 0 || day.toolMs > 0 ? 1 : 0
}

export function statsGraphSeries(input: {
  days: readonly DailyUsage[]
  mode: Exclude<HeatMode, "daily">
  rowCount?: number
}) {
  const rowCount = Math.max(1, input.rowCount ?? HEATMAP_ROWS)
  let running = 0
  return Array.from({ length: Math.ceil(input.days.length / rowCount) }, (_, column) => {
    const start = column * rowCount
    const slice = input.days.slice(start, start + rowCount)
    const weekly = slice.reduce((sum, day) => sum + statsDayTokenValue(day), 0)
    running += weekly
    return {
      index: start,
      endIndex: start + Math.max(0, slice.length - 1),
      value: input.mode === "cumulative" ? running : weekly,
      day: slice.at(-1)?.day,
    }
  })
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
  titlePaddingTop?: number
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
      paddingTop={props.titlePaddingTop ?? 1}
      paddingBottom={1}
      gap={1}
      onMouseUp={props.onMouseUp}
    >
      <box height={1} overflow="hidden">
        <text fg={theme.primary} wrapMode="none">
          {props.title}
        </text>
      </box>
      <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden" gap={1}>
        {props.children}
      </box>
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
      <box height={2} justifyContent="center" overflow="hidden">
        <text fg={props.accent ? theme.success : theme.primary} wrapMode="none">
          <span style={{ bold: true }}>{props.value}</span>
        </text>
      </box>
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

const CLOCK_WIDTH = 29

export function clockAscii(value: string) {
  const chars = value.replace(/\s[AP]M$/, "").split("")
  return Array.from({ length: 7 }, (_, row) =>
    chars
      .map((char) => CLOCK_DIGITS[char]?.[row] ?? "     ")
      .join(" ")
      .padEnd(CLOCK_WIDTH),
  )
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
    <Panel title="Clock" height={props.tall ? 15 : 14}>
      <box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center" overflow="hidden" gap={1}>
        <box flexDirection="column" width={CLOCK_WIDTH} height={7} overflow="hidden">
          <For each={clockAscii(time())}>
            {(line) => (
              <text fg={theme.success} wrapMode="none">
                {line}
              </text>
            )}
          </For>
        </box>
        <box flexDirection="row" width={CLOCK_WIDTH} height={1} justifyContent="center" overflow="hidden">
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

function LoadingStats(props: { tiny: boolean; error?: string }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" minHeight={0} flexGrow={1} gap={1}>
      <Panel title="Activity" height={props.tiny ? 8 : 7}>
        <box flexDirection="column" flexGrow={1} justifyContent="center" overflow="hidden" gap={1}>
          <text fg={theme.text} wrapMode="none">
            {props.error ? "Usage insights unavailable" : "Loading session metrics..."}
          </text>
          <text fg={theme.textMuted} wrapMode="none">
            {props.error ? "Press r to retry." : "Reading global cached stats first."}
          </text>
        </box>
      </Panel>
      <Panel title="Token activity · daily · 365 days" titlePaddingTop={0} grow>
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
  const number = (value: number | undefined) => formatInsightNumber(value ?? 0)
  return [
    stat("tokens", number(statsDayTokenValue(day)), `${number(day.cacheTokens)} cache included`),
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
  cellWidth: number
  contentWidth: number
  selectedDay?: DailyUsage
  selectedDayIndex?: number
  tokenRows?: Array<{ label: string; value: string; detail?: string }>
  responseRows?: Array<{ label: string; value: string; detail?: string }>
  statusRows?: Array<{ label: string; value: string; detail?: string }>
  widgets: ReadonlySet<StatsWidgetID>
  subscriptionUsage?: SubscriptionUsageSnapshot
  subscriptionLoading: boolean
  subscriptionError?: string
  tall?: boolean
}) {
  return (
    <box flexDirection="column" minHeight={0} flexGrow={1} gap={1}>
      <Panel title="Activity" height={8}>
        <MetricRows items={props.headline.slice(0, 4)} maxWidth={props.contentWidth} />
      </Panel>
      <Panel title={`Token activity · ${props.mode} · 365 days`} titlePaddingTop={0} grow>
        <TokenActivityView
          insights={props.insights}
          mode={props.mode}
          columns={props.columns}
          cellWidth={props.cellWidth}
          rows={7}
          labels={true}
          selectedIndex={props.selectedDayIndex}
        />
        <SelectedDayDetail day={props.selectedDay} width={props.contentWidth} compact />
      </Panel>
      <Show when={props.tall}>
        <box flexDirection="column" gap={1} height={20} minHeight={0}>
          <Show when={props.widgets.has("token-mix")}>
            <Panel title="Token Mix" grow>
              <MetricRows items={props.tokenRows ?? []} dense />
            </Panel>
          </Show>
          <Show when={props.widgets.has("response-load")}>
            <Panel title="Response Load" grow>
              <MetricRows items={props.responseRows ?? []} dense />
            </Panel>
          </Show>
          <Show when={props.widgets.has("subscription-usage")}>
            <SubscriptionUsageWidget
              usage={props.subscriptionUsage}
              loading={props.subscriptionLoading}
              error={props.subscriptionError}
              grow
            />
          </Show>
          <Show when={props.widgets.has("status")}>
            <StatusSummary rows={props.statusRows ?? []} width={props.contentWidth} grow />
          </Show>
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
  widgets: ReadonlySet<StatsWidgetID>
  subscriptionUsage?: SubscriptionUsageSnapshot
  subscriptionLoading: boolean
  subscriptionError?: string
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
          <Panel title={`Token activity · ${props.mode} · 365 days`} titlePaddingTop={0} grow>
            <TokenActivityView
              insights={props.data}
              mode={props.mode}
              columns={props.heatColumns}
              cellWidth={props.heatCellWidth}
              labels={true}
              selectedIndex={props.selectedDayIndex}
            />
            <SelectedDayDetail day={props.selectedDay} width={props.contentWidth} />
          </Panel>
          <Show
            when={
              props.widgets.has("token-mix") ||
              props.widgets.has("response-load") ||
              props.widgets.has("subscription-usage") ||
              props.widgets.has("peak-pressure")
            }
          >
            <box flexDirection="row" gap={1} height={props.roomy ? 9 : 7}>
              <Show when={props.widgets.has("token-mix")}>
                <Panel title="Token Mix" grow>
                  <MetricRows items={props.tokenRows} dense />
                </Panel>
              </Show>
              <Show when={props.widgets.has("response-load")}>
                <Panel title="Response Load" grow>
                  <MetricRows items={props.responseRows} dense />
                </Panel>
              </Show>
              <Show when={props.widgets.has("subscription-usage")}>
                <SubscriptionUsageWidget
                  usage={props.subscriptionUsage}
                  loading={props.subscriptionLoading}
                  error={props.subscriptionError}
                  width={props.roomy ? 48 : 40}
                />
              </Show>
              <Show when={props.widgets.has("peak-pressure")}>
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
              </Show>
            </box>
          </Show>
          <Show when={props.details}>
            <box flexDirection="row" gap={1} height={11} minHeight={0}>
              <Show when={props.widgets.has("outcome-signals")}>
                <Panel title="Outcome Signals" grow>
                  <MetricRows items={props.outcomeRows} maxWidth={props.contentWidth} />
                  <text fg={theme.textMuted} wrapMode="none">
                    Local evidence only; git/PR metrics pending.
                  </text>
                </Panel>
              </Show>
              <Show when={props.widgets.has("tools")}>
                <Panel title="Most Used Tools" width={34}>
                  <Switch>
                    <Match when={props.data.topTools.length === 0}>
                      <text fg={theme.textMuted}>No tool calls in this window</text>
                    </Match>
                    <Match when={props.data.topTools.length > 0}>
                      <ListRows
                        items={props.data.topTools.map((item) => ({
                          name: item.name,
                          right: formatInsightNumber(item.count),
                        }))}
                        nameWidth={20}
                      />
                    </Match>
                  </Switch>
                </Panel>
              </Show>
              <Show when={props.widgets.has("agents-models")}>
                <Panel title="Agents & Models" width={42}>
                  <ListRows
                    items={props.data.topAgents
                      .slice(0, 3)
                      .map((item) => ({ name: item.name, right: formatInsightNumber(item.count) }))}
                    nameWidth={22}
                  />
                  <ListRows
                    items={props.data.topModels.slice(0, 2).map((item) => ({
                      name: item.name,
                      right: formatInsightNumber(item.tokens),
                      color: theme.textMuted,
                    }))}
                    nameWidth={24}
                  />
                </Panel>
              </Show>
            </box>
          </Show>
        </box>

        <Show
          when={
            props.wide && (props.widgets.has("clock") || props.widgets.has("weather") || props.widgets.has("status"))
          }
        >
          <box flexDirection="column" width={44} height="100%" gap={1} minWidth={0}>
            <Show when={props.widgets.has("clock")}>
              <ClockWidget tall={props.roomy} />
            </Show>
            <Show when={props.widgets.has("weather")}>
              <WeatherWidget
                config={props.weatherConfig}
                weather={props.weather}
                loading={props.weatherLoading}
                error={props.weatherError}
                onConfigure={props.onConfigureWeather}
                height={props.roomy ? 11 : 10}
              />
            </Show>
            <Show when={props.widgets.has("status")}>
              <StatusSummary rows={props.statusRows} width={38} grow compact />
            </Show>
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

function resetLabel(timestamp: number | undefined) {
  if (!timestamp) return "reset unknown"
  const remaining = Math.max(0, timestamp - Date.now())
  if (remaining < 60_000) return "resets soon"
  if (remaining < 60 * 60_000) return `resets in ${Math.ceil(remaining / 60_000)}m`
  if (remaining < 24 * 60 * 60_000) return `resets in ${Math.ceil(remaining / (60 * 60_000))}h`
  return `resets in ${Math.ceil(remaining / (24 * 60 * 60_000))}d`
}

function SubscriptionUsageWidget(props: {
  usage?: SubscriptionUsageSnapshot
  loading: boolean
  error?: string
  width?: number
  grow?: boolean
}) {
  const { theme } = useTheme()
  return (
    <Panel title="Subscription Usage" width={props.width} grow={props.grow}>
      <Switch>
        <Match when={props.loading && !props.usage}>
          <text fg={theme.textMuted}>Reading Codex limits…</text>
        </Match>
        <Match when={props.usage}>
          {(usage) => (
            <box flexDirection="column" gap={0}>
              <text fg={theme.primary} wrapMode="none">
                Codex{usage().plan ? ` · ${usage().plan}` : ""}
              </text>
              <For each={usage().windows}>
                {(window) => (
                  <box flexDirection="column" gap={0}>
                    <box flexDirection="row" justifyContent="space-between">
                      <text fg={theme.text}>{window.label}</text>
                      <text
                        fg={
                          window.usedPercent >= 90
                            ? theme.error
                            : window.usedPercent >= 70
                              ? theme.warning
                              : theme.textMuted
                        }
                      >
                        {Math.round(window.usedPercent)}% · {resetLabel(window.resetsAt)}
                      </text>
                    </box>
                    <ProgressBar
                      value={window.usedPercent / 100}
                      width={12}
                      color={
                        window.usedPercent >= 90
                          ? theme.error
                          : window.usedPercent >= 70
                            ? theme.warning
                            : theme.success
                      }
                    />
                  </box>
                )}
              </For>
            </box>
          )}
        </Match>
        <Match when={!props.loading && !props.usage}>
          <box flexDirection="column" gap={0}>
            <text fg={theme.textMuted}>{props.error ?? "Codex plan limits unavailable"}</text>
            <text fg={theme.textMuted}>Claude, Kimi, Grok · no local quota feed</text>
          </box>
        </Match>
      </Switch>
    </Panel>
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

function UsageGraph(props: {
  insights: UsageInsights
  mode: Exclude<HeatMode, "daily">
  columns: number
  cellWidth?: number
  rows?: number
  selectedIndex?: number
}) {
  const { theme } = useTheme()
  const rowCount = createMemo(() => props.rows ?? 7)
  const visible = createMemo(() => props.insights.days.slice(-props.columns * rowCount()))
  const visibleStart = createMemo(() => Math.max(0, props.insights.days.length - visible().length))
  const series = createMemo(() => statsGraphSeries({ days: visible(), mode: props.mode, rowCount: rowCount() }))
  const peak = createMemo(() => Math.max(1, ...series().map((point) => point.value)))
  const cellWidth = createMemo(() => Math.max(1, props.cellWidth ?? 2))
  const graphHeight = createMemo(() => Math.max(4, Math.min(8, rowCount())))
  const selectedColumn = createMemo(() => {
    const selected = props.selectedIndex
    if (selected === undefined) return undefined
    return series().findIndex(
      (point) => selected >= visibleStart() + point.index && selected <= visibleStart() + point.endIndex,
    )
  })
  const isSelectedColumn = createSelector(selectedColumn)
  const labels = createMemo(() => timelineLabels(visible()))
  const graphCell = (point: ReturnType<typeof statsGraphSeries>[number], row: number) => {
    if (point.value <= 0) return "".padEnd(cellWidth())
    const level = Math.round((point.value / peak()) * (graphHeight() - 1))
    const rowLevel = graphHeight() - 1 - row
    return (rowLevel <= level ? "█" : " ").padEnd(cellWidth())
  }
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} gap={0}>
      <box flexDirection="column" flexGrow={1} justifyContent="center" gap={0}>
        <For each={Array.from({ length: graphHeight() }, (_, index) => index)}>
          {(row) => (
            <box flexDirection="row" gap={0} height={1} justifyContent="space-between" width="100%">
              <For each={series()}>
                {(point, column) => (
                  <text
                    fg={
                      isSelectedColumn(column())
                        ? theme.warning
                        : props.mode === "cumulative"
                          ? theme.primary
                          : theme.success
                    }
                    wrapMode="none"
                  >
                    {graphCell(point, row)}
                  </text>
                )}
              </For>
            </box>
          )}
        </For>
      </box>
      <Show when={props.rows !== 7}>
        <box flexDirection="row" justifyContent="space-between" paddingTop={1} overflow="hidden">
          <For each={labels()}>{(label) => <text fg={theme.textMuted}>{label}</text>}</For>
        </box>
      </Show>
    </box>
  )
}

function TokenActivityView(props: {
  insights: UsageInsights
  mode: HeatMode
  columns: number
  cellWidth?: number
  rows?: number
  labels?: boolean
  selectedIndex?: number
}) {
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} gap={0}>
      <Switch>
        <Match when={props.mode === "daily"}>
          <UsageHeatmap
            insights={props.insights}
            mode="daily"
            columns={props.columns}
            cellWidth={props.cellWidth}
            rows={props.rows}
            labels={props.labels}
            selectedIndex={props.selectedIndex}
          />
        </Match>
        <Match when={props.mode === "weekly" || props.mode === "cumulative"}>
          <UsageGraph
            insights={props.insights}
            mode={props.mode === "cumulative" ? "cumulative" : "weekly"}
            columns={props.columns}
            cellWidth={props.cellWidth}
            rows={props.rows}
            selectedIndex={props.selectedIndex}
          />
        </Match>
      </Switch>
    </box>
  )
}

function UsageHeatmap(props: {
  insights: UsageInsights
  mode: HeatMode
  columns: number
  cellWidth?: number
  rows?: number
  labels?: boolean
  selectedIndex?: number
}) {
  const { theme } = useTheme()
  const rowCount = createMemo(() => props.rows ?? 7)
  const visible = createMemo(() => props.insights.days.slice(-props.columns * rowCount()))
  const visibleStart = createMemo(() => Math.max(0, props.insights.days.length - visible().length))
  const columnCount = createMemo(() => Math.max(1, Math.ceil(visible().length / rowCount())))
  const cellWidth = createMemo(() => Math.max(1, props.cellWidth ?? 2))
  const values = createMemo(() => {
    if (props.mode === "weekly") {
      const daily = visible().map(statsDayTokenValue)
      return daily.map((_, index) => {
        const column = Math.floor(index / rowCount())
        const start = column * rowCount()
        return daily.slice(start, start + rowCount()).reduce((sum, value) => sum + value, 0)
      })
    }
    let running = 0
    return visible().map((day) => {
      const value = props.mode === "daily" ? statsDayVisualValue(day) : statsDayTokenValue(day)
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
  const isSelected = createSelector(() => props.selectedIndex)
  const cellText = (cell: HeatCell) => {
    if (cell.index === undefined) return "".padEnd(cellWidth())
    if (isSelected(cell.index)) return "▣".padEnd(cellWidth())
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
                    fg={
                      cell.index !== undefined && isSelected(cell.index)
                        ? theme.warning
                        : heatColor(theme, cell.value, peak())
                    }
                    wrapMode="none"
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

async function listGlobalSessions(sdk: ReturnType<typeof useSDK>, query: SessionListQuery, signal: AbortSignal) {
  const headers = new Headers(sdk.headers)
  if (sdk.directory) headers.set("x-mendcode-directory", encodeURIComponent(sdk.directory))
  try {
    const response = await sdk.fetch(statsURL(sdk, "/experimental/session", query), { headers, signal })
    if (!response.ok) throw new Error(`global stats failed: ${response.status}`)
    return (await response.json()) as SessionInsightInput["session"][]
  } catch (error) {
    if (signal.aborted) throw error
    const result = await sdk.client.experimental.session.list(query, { throwOnError: true, signal })
    return (result.data ?? []) as SessionInsightInput["session"][]
  }
}

async function loadGlobalUsageInsights(
  sdk: ReturnType<typeof useSDK>,
  input: { start: number; limit: number; messageLimit: number },
  signal: AbortSignal,
) {
  const headers = new Headers(sdk.headers)
  if (sdk.directory) headers.set("x-mendcode-directory", encodeURIComponent(sdk.directory))
  const response = await sdk.fetch(statsURL(sdk, "/experimental/usage-insights", input), { headers, signal })
  if (!response.ok) throw new Error(`usage insights failed: ${response.status}`)
  return (await response.json()) as UsageInsights
}

export async function mapStatsSessionsInBatches<T, R>(
  input: readonly T[],
  load: (item: T) => Promise<R>,
  options: { concurrency?: number; onBatch?: (items: readonly R[], batch: number, batches: number) => void } = {},
) {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? STATS_MESSAGE_FETCH_CONCURRENCY))
  const batches = Array.from({ length: Math.ceil(input.length / concurrency) }, (_, index) =>
    input.slice(index * concurrency, (index + 1) * concurrency),
  )
  const result: R[] = []
  for (const [index, batch] of batches.entries()) {
    result.push(...(await Promise.all(batch.map(load))))
    options.onBatch?.(result, index, batches.length)
  }
  return result
}

async function loadInsights(
  sdk: ReturnType<typeof useSDK>,
  options: {
    advanced: boolean
    scope: StatsScope
    query: SessionScopeQuery
    cached?: boolean
    signal?: AbortSignal
    onFirstBatch?: (insights: UsageInsights) => void
  },
) {
  const days = options.advanced ? ADVANCED_DAYS : DEFAULT_DAYS
  const end = Date.now()
  const start = end - days * DAY_MS
  const timeout = abortAfterAny(STATS_REQUEST_TIMEOUT_MS, ...(options.signal ? [options.signal] : []))
  const signal = timeout.signal
  const query: SessionListQuery = {
    start,
    limit: options.advanced ? STATS_ADVANCED_SESSION_LIMIT : STATS_NORMAL_SESSION_LIMIT,
    ...options.query,
  }
  try {
    if (options.scope === "global") {
      if (options.onFirstBatch && query.limit > STATS_FALLBACK_SESSION_LIMIT) {
        const partial = await loadGlobalUsageInsights(
          sdk,
          {
            start,
            limit: STATS_FALLBACK_SESSION_LIMIT,
            messageLimit: options.advanced ? STATS_ADVANCED_MESSAGE_LIMIT : STATS_NORMAL_MESSAGE_LIMIT,
          },
          signal,
        ).catch(() => undefined)
        if (partial) options.onFirstBatch(partial)
      }
      let aggregateError: unknown
      const aggregated = await loadGlobalUsageInsights(
        sdk,
        {
          start,
          limit: query.limit,
          messageLimit: options.advanced ? STATS_ADVANCED_MESSAGE_LIMIT : STATS_NORMAL_MESSAGE_LIMIT,
        },
        signal,
      ).catch((error) => {
        aggregateError = error
        return undefined
      })
      if (aggregated) return aggregated
      // Never fan out transcript requests behind a cached view. If the aggregate
      // endpoint is unavailable, keep the last snapshot interactive instead.
      if (options.cached) {
        throw aggregateError instanceof Error ? aggregateError : new Error("Usage insights endpoint unavailable")
      }
    }
    const fallbackQuery: SessionListQuery = {
      ...query,
      limit: Math.min(query.limit, STATS_FALLBACK_SESSION_LIMIT),
    }
    const sessions =
      options.scope === "global"
        ? await listGlobalSessions(sdk, fallbackQuery, signal)
        : ((await sdk.client.session.list(fallbackQuery, { throwOnError: true, signal })).data ?? [])
    const items = await mapStatsSessionsInBatches(
      sessions,
      async (session) => {
        const result = await sdk.client.session.messages(
          { sessionID: session.id, limit: STATS_FALLBACK_MESSAGE_LIMIT, view: "tui" },
          { throwOnError: true, signal },
        )
        return { session, messages: result.data ?? [] } as SessionInsightInput
      },
      {
        onBatch: (loaded, batch, batches) => {
          if (batch === 0 && batches > 1) options.onFirstBatch?.(buildUsageInsights([...loaded], { start, end }))
        },
      },
    )
    return buildUsageInsights(items, { start, end })
  } catch (error) {
    if (signal.aborted) throw new Error(`Usage insights timed out after ${STATS_REQUEST_TIMEOUT_MS / 1000}s`)
    throw error
  } finally {
    timeout.clearTimeout()
  }
}

export function usageInsightsCacheKey(scope: StatsScope, query: SessionScopeQuery = {}, directory?: string) {
  if (scope === "global") return `${STATS_CACHE_KEY}:${scope}`
  const identity =
    directory || query.scope || query.directory || query.path
      ? JSON.stringify([directory ?? null, query.scope ?? null, query.directory ?? null, query.path ?? null])
      : ""
  return `${STATS_CACHE_KEY}:${scope}${identity ? `:${encodeURIComponent(identity)}` : ""}`
}

export function statsSelectedDayIndex(input: {
  days: readonly { day: string }[]
  selectedDay?: string
  selectedIndex?: number
  followLatest?: boolean
}) {
  if (input.days.length <= 0) return undefined
  if (input.followLatest) return input.days.length - 1
  const selectedDayIndex = input.selectedDay ? input.days.findIndex((day) => day.day === input.selectedDay) : -1
  if (selectedDayIndex >= 0) return selectedDayIndex

  if (input.selectedIndex === undefined || input.selectedIndex < 0 || input.selectedIndex >= input.days.length) {
    return input.days.length - 1
  }
  return input.selectedIndex
}

function statsLocalDayKey(now = Date.now()) {
  const date = new Date(now)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

export function statsCacheNeedsRefresh(input: {
  updated?: number
  days: readonly { day: string }[]
  now?: number
  staleMs?: number
  todayStaleMs?: number
}) {
  const now = input.now ?? Date.now()
  const staleMs = input.staleMs ?? STATS_CACHE_STALE_MS
  const todayStaleMs = input.todayStaleMs ?? STATS_TODAY_CACHE_STALE_MS
  if (!input.updated || now - input.updated > staleMs) return true
  const latestDay = input.days.at(-1)?.day
  const today = statsLocalDayKey(now)
  if (latestDay && latestDay < today) return true
  return Boolean(latestDay === today && now - input.updated > todayStaleMs)
}

export async function warmUsageInsightsCache(input: {
  sdk: ReturnType<typeof useSDK>
  kv: ReturnType<typeof useKV>
  scope?: StatsScope
  query?: SessionScopeQuery
}) {
  const scope = input.scope ?? "global"
  const next = await loadInsights(input.sdk, { advanced: true, scope, query: input.query ?? {} })
  input.kv.set(usageInsightsCacheKey(scope, input.query, input.sdk.directory), { updated: Date.now(), data: next })
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
  const deck = createMemo(() => commandDeckLayout({ ...dimensions(), hasRail: false, hasContext: false }))
  const [advanced, setAdvanced] = createSignal(false)
  const [scope] = createSignal<StatsScope>(route.data.type === "stats" ? (route.data.scope ?? "global") : "global")
  const [mode, setMode] = createSignal<HeatMode>("daily")
  const [weatherConfig, setWeatherConfig] = createSignal<StatsWeatherConfig>({ enabled: false })
  const [weatherRefresh, setWeatherRefresh] = createSignal(0)
  const [weatherError, setWeatherError] = createSignal<string | undefined>()
  const [weatherReady, setWeatherReady] = createSignal(false)
  const [widgets, setWidgets] = createSignal<StatsWidgetID[]>([...DEFAULT_STATS_WIDGETS])
  const [selectedDayIndex, setSelectedDayIndex] = createSignal<number | undefined>()
  const [selectedDayKey, setSelectedDayKey] = createSignal<string | undefined>()
  const [selectedDayPinned, setSelectedDayPinned] = createSignal(false)
  const [cacheUpdated, setCacheUpdated] = createSignal<number | undefined>()
  const [cacheReady, setCacheReady] = createSignal(false)
  const [insightRefreshRequest, setInsightRefreshRequest] = createSignal(0)
  const [refreshingInsights, setRefreshingInsights] = createSignal(false)
  const [insightError, setInsightError] = createSignal<string | undefined>()
  const [statsRefreshTick, setStatsRefreshTick] = createSignal(0)
  const [subscriptionRefreshTick, setSubscriptionRefreshTick] = createSignal(0)
  const [subscriptionError, setSubscriptionError] = createSignal<string | undefined>()
  let activeInsightRequest: AbortController | undefined
  const tiny = createMemo(() => statsUsesScrollableLayout(dimensions().width, dimensions().height))
  const narrow = createMemo(() => !tiny() && dimensions().width < 124)
  const wide = createMemo(() => dimensions().width >= 142 && dimensions().height >= 34)
  const roomy = createMemo(() => dimensions().width >= 170 && dimensions().height >= 38)
  const showDetails = createMemo(() => advanced() && dimensions().height >= 38 && !tiny() && !narrow())
  const heatColumns = createMemo(() => {
    return HEATMAP_COLUMNS
  })
  const heatCellWidth = createMemo(() => {
    if (!roomy()) return 1
    const sideColumn = wide() ? 46 : 0
    const panelChrome = 8
    const available = Math.max(HEATMAP_COLUMNS, dimensions().width - sideColumn - panelChrome)
    return Math.max(1, Math.min(4, Math.floor(available / HEATMAP_COLUMNS)))
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
  const statsCacheKey = createMemo(() => usageInsightsCacheKey(scope(), scopeQuery(), sdk.directory))
  const [cachedInsights, setCachedInsights] = createSignal<UsageInsights | undefined>()
  let lastAutoRefreshCacheSignature: string | undefined
  const statsRefreshPoll = setInterval(() => setStatsRefreshTick((value) => value + 1), STATS_TODAY_CACHE_STALE_MS)
  onCleanup(() => {
    clearInterval(statsRefreshPoll)
    activeInsightRequest?.abort()
  })
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
    setWidgets(normalizeStatsWidgets(kv.get(WIDGETS_KV_KEY)))
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
      if (cached && input.refresh === 0) {
        setInsightError(undefined)
        return cached
      }
      setInsightError(undefined)
      setRefreshingInsights(true)
      activeInsightRequest?.abort()
      const request = new AbortController()
      activeInsightRequest = request
      try {
        const next = await loadInsights(sdk, {
          ...input,
          cached: Boolean(cached),
          signal: request.signal,
          onFirstBatch: cached ? undefined : (partial) => setCachedInsights(normalizeUsageInsights(partial)),
        })
        if (activeInsightRequest !== request) return cachedInsights()
        const updated = Date.now()
        const normalized = normalizeUsageInsights(next)
        const payload = { updated, data: normalized ?? next }
        setCachedInsights(normalized)
        setCacheUpdated(updated)
        kv.set(statsCacheKey(), payload)
        setInsightError(undefined)
        return next
      } catch (error) {
        if (activeInsightRequest !== request) return cachedInsights()
        setInsightError(error instanceof Error ? error.message : "Usage insights failed")
        const fallback = cachedInsights()
        if (fallback) return fallback
        throw error
      } finally {
        if (activeInsightRequest === request) {
          activeInsightRequest = undefined
          setRefreshingInsights(false)
        }
      }
    },
  )
  createEffect(() => {
    const refreshTick = statsRefreshTick()
    if (!kv.ready || !cacheReady() || refreshingInsights()) return
    const cached = cachedInsights()
    if (!cached) return
    const signature = `${statsCacheKey()}:${cacheUpdated() ?? 0}:${cached.days.at(-1)?.day ?? "none"}:${refreshTick}`
    if (lastAutoRefreshCacheSignature === signature) return
    if (!statsCacheNeedsRefresh({ updated: cacheUpdated(), days: cached.days })) return
    lastAutoRefreshCacheSignature = signature
    setInsightRefreshRequest((value) => value + 1)
  })
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

  const [subscriptionUsage] = createResource(
    () => ({ refresh: subscriptionRefreshTick() }),
    async () => {
      setSubscriptionError(undefined)
      try {
        return await loadSubscriptionUsage()
      } catch (error) {
        setSubscriptionError(error instanceof Error ? error.message : "Subscription usage failed")
        return undefined
      }
    },
  )

  const weatherStart = setTimeout(() => setWeatherReady(true), 1_500)
  const weatherPoll = setInterval(() => {
    if (weatherConfig().enabled) setWeatherRefresh((value) => value + 1)
  }, 30 * 60_000)
  const subscriptionPoll = setInterval(() => setSubscriptionRefreshTick((value) => value + 1), 60_000)
  onCleanup(() => {
    clearTimeout(weatherStart)
    clearInterval(weatherPoll)
    clearInterval(subscriptionPoll)
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

  function persistWidgets(next: StatsWidgetID[]) {
    const normalized = normalizeStatsWidgets(next)
    setWidgets(normalized)
    kv.set(WIDGETS_KV_KEY, normalized)
  }

  function showWidgetPicker() {
    const enabled = new Set(widgets())
    dialog.replace(() => (
      <DialogSelect
        title="Stats widgets"
        placeholder="Search widgets"
        options={[
          ...STATS_WIDGET_IDS.map((id) => ({
            title: `${enabled.has(id) ? "●" : "○"} ${STATS_WIDGET_META[id].title}`,
            value: id,
            category: STATS_WIDGET_META[id].category,
            description: STATS_WIDGET_META[id].description,
            onSelect: () => {
              const next = enabled.has(id) ? widgets().filter((item) => item !== id) : [...widgets(), id]
              persistWidgets(next)
              showWidgetPicker()
            },
          })),
          {
            title: "Reset default layout",
            value: "__reset__",
            category: "Layout",
            description: "Restore the recommended widget set",
            onSelect: () => {
              persistWidgets([...DEFAULT_STATS_WIDGETS])
              showWidgetPicker()
            },
          },
        ]}
      />
    ))
  }

  const visibleInsights = createMemo(() => cachedInsights() ?? insights())
  const visibleWidgetSet = createMemo<ReadonlySet<StatsWidgetID>>(() => new Set(widgets()))
  createEffect(() => {
    const data = visibleInsights()
    if (!data || data.days.length === 0) return
    const nextSelectedDayIndex = statsSelectedDayIndex({
      days: data.days,
      selectedDay: selectedDayKey(),
      selectedIndex: selectedDayIndex(),
      followLatest: !selectedDayPinned(),
    })
    if (nextSelectedDayIndex === undefined) return
    const nextSelectedDayKey = data.days[nextSelectedDayIndex]?.day
    if (selectedDayIndex() === nextSelectedDayIndex && selectedDayKey() === nextSelectedDayKey) return
    batch(() => {
      setSelectedDayIndex(nextSelectedDayIndex)
      setSelectedDayKey(nextSelectedDayKey)
    })
  })

  function selectDay(index: number) {
    const data = visibleInsights()
    if (!data || data.days.length === 0) return
    const next = Math.max(0, Math.min(data.days.length - 1, index))
    const key = data.days[next]?.day
    batch(() => {
      setSelectedDayPinned(true)
      setSelectedDayIndex(next)
      setSelectedDayKey(key)
    })
  }

  function moveSelectedDay(delta: number) {
    const data = visibleInsights()
    if (!data || data.days.length === 0) return
    selectDay((selectedDayIndex() ?? data.days.length - 1) + delta)
  }

  function moveSelectedColumn(delta: number) {
    moveSelectedDay(delta * HEATMAP_ROWS)
  }

  function cycleMode() {
    const index = HEAT_MODES.indexOf(mode())
    setMode(HEAT_MODES[(index + 1) % HEAT_MODES.length] ?? "daily")
  }

  useKeyboard((evt) => {
    if (evt.name === "escape") {
      evt.preventDefault()
      evt.stopPropagation()
      const request = activeInsightRequest
      activeInsightRequest = undefined
      request?.abort()
      setRefreshingInsights(false)
      route.navigate(routeReturnTarget(route.data))
      return
    }
    if (evt.name === "a") {
      setAdvanced((value) => !value)
      return
    }
    if (evt.name === "m" || evt.name === "tab") {
      evt.preventDefault()
      evt.stopPropagation()
      cycleMode()
      return
    }
    if (evt.name === "1" || evt.name === "2" || evt.name === "3") {
      evt.preventDefault()
      evt.stopPropagation()
      setMode(evt.name === "1" ? "daily" : evt.name === "2" ? "weekly" : "cumulative")
      return
    }
    if (evt.name === "r") {
      evt.preventDefault()
      evt.stopPropagation()
      if (!refreshingInsights()) setInsightRefreshRequest((value) => value + 1)
      setSubscriptionRefreshTick((value) => value + 1)
      return
    }
    if (evt.name === "c") {
      evt.preventDefault()
      evt.stopPropagation()
      showWidgetPicker()
      return
    }
    if (evt.name === "w") {
      evt.preventDefault()
      evt.stopPropagation()
      configureWeather()
      return
    }
    if (evt.name === "left") {
      evt.preventDefault()
      evt.stopPropagation()
      moveSelectedColumn(-1)
      return
    }
    if (evt.name === "right") {
      evt.preventDefault()
      evt.stopPropagation()
      moveSelectedColumn(1)
      return
    }
    if (evt.name === "up") {
      evt.preventDefault()
      evt.stopPropagation()
      moveSelectedDay(-1)
      return
    }
    if (evt.name === "down") {
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
      stat(
        "tokens",
        formatInsightNumber(current.tokens),
        `${formatInsightNumber(current.peakTokens)} peak day · ${formatInsightNumber(current.cacheTokens)} cache included`,
      ),
      stat("sessions", formatInsightNumber(current.sessions), `${formatInsightNumber(current.activeDays)} active days`),
      stat(
        "AI generating",
        formatInsightDuration(current.aiResponseMs),
        `${formatInsightDuration(current.longestTaskMs)} longest`,
      ),
      stat(
        "user words",
        formatInsightNumber(current.userWords),
        `${formatInsightNumber(current.userMessages)} prompts`,
      ),
      stat("cache tokens", formatInsightNumber(current.cacheTokens)),
      stat("streak", `${current.currentStreak} days`, `${current.longestStreak} longest`),
    ]
  })
  const kpis = createMemo(() => {
    const current = totals()
    if (!current) return []
    return [
      stat(
        "tokens",
        formatInsightNumber(current.tokens),
        `${formatInsightNumber(current.peakTokens)} peak · ${formatInsightNumber(current.cacheTokens)} cache included`,
      ),
      stat("sessions", formatInsightNumber(current.sessions), `${formatInsightNumber(current.activeDays)} days`),
      stat(
        "AI time",
        formatInsightDuration(current.aiResponseMs),
        `${formatInsightDuration(current.longestTaskMs)} longest`,
      ),
      stat("words", formatInsightNumber(current.userWords), `${formatInsightNumber(current.userMessages)} prompts`),
    ]
  })
  const tokenRows = createMemo(() => {
    const current = totals()
    if (!current) return []
    return [
      stat("input", formatInsightNumber(current.inputTokens)),
      stat("output", formatInsightNumber(current.outputTokens)),
      stat("reasoning", formatInsightNumber(current.reasoningTokens)),
      stat("cache", formatInsightNumber(current.cacheTokens)),
    ]
  })
  const outcomeRows = createMemo(() => {
    const current = totals()
    if (!current) return []
    return [
      stat("sessions with code changes", formatInsightNumber(current.sessionsWithCodeChanges)),
      stat("changed files", formatInsightNumber(current.changedFiles)),
      stat("tool runtime", formatInsightDuration(current.toolMs)),
      stat("loaded window", advanced() ? `${ADVANCED_DAYS} days` : `${DEFAULT_DAYS} days`),
    ]
  })

  const statusRows = createMemo(() => {
    const current = totals()
    if (!current) return []
    return [
      stat("window", advanced() ? `${ADVANCED_DAYS} days` : `${DEFAULT_DAYS} days`),
      stat("visible sync", formatInsightNumber(sync.data.session.length)),
      stat("active days", formatInsightNumber(current.activeDays)),
      stat("sessions", formatInsightNumber(current.sessions)),
      stat("prompts", formatInsightNumber(current.userMessages)),
      stat("streak", `${current.currentStreak}d`, `${current.longestStreak} longest`),
      stat("cache tokens", formatInsightNumber(current.cacheTokens)),
      stat(
        "cache age",
        cacheAgeLabel(cacheUpdated()),
        insightError() ? "stale" : refreshingInsights() ? "refreshing" : "ready",
      ),
      stat("changed files", formatInsightNumber(current.changedFiles)),
      stat("code sessions", formatInsightNumber(current.sessionsWithCodeChanges)),
    ]
  })
  const responseRows = createMemo(() => {
    const current = totals()
    if (!current) return []
    return [
      stat("AI generating", formatInsightDuration(current.aiResponseMs)),
      stat("tool runtime", formatInsightDuration(current.toolMs)),
      stat("cache", formatInsightNumber(current.cacheTokens)),
    ]
  })
  return (
    <CommandDeck
      page="stats"
      subtitle={() =>
        `${scope() === "global" ? "global" : scope() === "project" ? "project" : "directory"} · ${mode()} · ${advanced() ? ADVANCED_DAYS : DEFAULT_DAYS}d`
      }
      status={() =>
        insightError()
          ? visibleInsights()
            ? "STALE"
            : "ERROR"
          : refreshingInsights()
            ? "SYNCING"
            : visibleInsights()
              ? "LIVE"
              : "LOADING"
      }
      summary={() => {
        const current = totals()
        return current
          ? `${formatInsightNumber(current.sessions)} sessions · ${formatInsightNumber(current.tokens)} tokens · ${formatInsightDuration(current.aiResponseMs)} AI`
          : "loading insights"
      }}
      footer="↑↓ Day   ←→ Week   A Details   M/Tab Mode   C Widgets   R Refresh   W Weather   Esc/Q Back"
    >
      <box flexDirection="column" minHeight={0} flexGrow={1} gap={1}>
        <Switch>
          <Match when={!visibleInsights()}>
            <LoadingStats tiny={tiny()} error={insightError()} />
          </Match>
          <Match when={visibleInsights()}>
            {(data) => (
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
                      cellWidth={heatCellWidth()}
                      contentWidth={deck().contentWidth}
                      selectedDay={selectedDay()}
                      selectedDayIndex={selectedDayIndex()}
                      tokenRows={tokenRows()}
                      responseRows={responseRows()}
                      statusRows={statusRows()}
                      widgets={visibleWidgetSet()}
                      subscriptionUsage={subscriptionUsage()}
                      subscriptionLoading={subscriptionUsage.loading}
                      subscriptionError={subscriptionError()}
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
                    kpis={kpis()}
                    tokenRows={tokenRows()}
                    responseRows={responseRows()}
                    outcomeRows={outcomeRows()}
                    statusRows={statusRows()}
                    contentWidth={deck().contentWidth}
                    weatherConfig={weatherConfig()}
                    weather={weather()}
                    weatherLoading={weather.loading || (weatherConfig().enabled && !weatherReady())}
                    weatherError={weatherError()}
                    onConfigureWeather={configureWeather}
                    widgets={visibleWidgetSet()}
                    subscriptionUsage={subscriptionUsage()}
                    subscriptionLoading={subscriptionUsage.loading}
                    subscriptionError={subscriptionError()}
                  />
                </Match>
              </Switch>
            )}
          </Match>
        </Switch>
      </box>
    </CommandDeck>
  )
}
