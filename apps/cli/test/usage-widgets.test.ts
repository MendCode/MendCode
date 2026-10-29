import { afterEach, expect, test } from "bun:test"
import path from "node:path"
import { USAGE_WIDGET_IDS } from "@mendcode/protocol/wire"
import type { UsageWeatherReport } from "@mendcode/protocol"
import { b77Harness } from "./b77-harness"
import { cleanTemps } from "./session-ui-harness"
import { DEFAULT_TUI_PROFILE, normalizeTuiProfile, readTuiProfile, writeTuiProfile } from "../src/view/tui-profile"
import { createUsagePageState, renderUsagePage } from "../src/view/usage-page"
import { usageFixture } from "./ui-5-harness"
import { textWidth } from "../src/view/wrap"

const running: Array<ReturnType<typeof b77Harness>> = []
const harness = (options: Parameters<typeof b77Harness>[0] = {}) => { const h = b77Harness(options); running.push(h); return h }
afterEach(async () => { for (const h of running.splice(0)) { await h.app.onKey("\x1b"); await h.app.onKey("\x03") }; cleanTemps() })
const all = (h: ReturnType<typeof b77Harness>) => h.text().join("\n")

test("default core dashboard has header settings hints, optional widgets off and no weather query", async () => {
  for (const [width, height] of [[100, 30], [180, 50]] as const) {
    const h = harness({ width, height })
    await h.type("/usage\r")
    expect(h.text()[0]).toContain("C Widgets")
    expect(h.text()[0]).toContain("W Weather")
    expect(all(h)).toContain("2026-09-30")
    expect(all(h)).toContain("AI 0s · Tools 0s")
    for (const label of width >= 110 ? ["Token activity", "Tokens", "Per-day tokens", "Top sessions"] : ["Token activity", "Tokens"]) expect(all(h)).toContain(label)
    for (const label of ["Outcome signals", "Subscription usage", "Clock", "Weather", "Response load"]) expect(all(h).split("\n").slice(4).join("\n")).not.toContain(label)
    expect(h.sentOf("usage.weather.query")).toHaveLength(0)
    expect(readTuiProfile(h.dataDir).usageWidgets).toEqual([])
  }
})

test("C selector toggles without leaving Usage, persists immediately and restores on a new terminal", async () => {
  const h = harness()
  await h.type("/usage\r")
  await h.app.onKey("c")
  expect(all(h)).toContain("Usage widgets")
  expect(all(h)).toContain("› [ ] Token mix")
  await h.app.onKey("\r")
  expect(all(h)).toContain("› [x] Token mix")
  expect(readTuiProfile(h.dataDir).usageWidgets).toEqual(["token-mix"])
  await h.app.onKey("\x1b")
  expect(all(h)).toContain("Usage Insights")
  const second = harness({ dataDir: h.dataDir })
  await second.type("/usage\r")
  await second.app.onKey("c")
  expect(all(second)).toContain("› [x] Token mix")
  await second.app.onKey(" ")
  expect(readTuiProfile(h.dataDir).usageWidgets).toEqual([])
})

test("settings consume Enter and arrows before the Sessions tab; reset leaves no enabled widgets", async () => {
  const h = harness({ profile: { usageWidgets: [...USAGE_WIDGET_IDS] } })
  await h.type("/usage\r")
  await h.app.onKey("6")
  await h.app.onKey("c")
  await h.app.onKey("\x1b[A")
  await h.app.onKey("\r")
  expect(all(h)).toContain("Usage widgets")
  expect(h.subscriptions).toHaveLength(0)
  await h.app.onKey("d")
  expect(readTuiProfile(h.dataDir).usageWidgets).toEqual([])
  await h.app.onKey("\x1b")
  expect(all(h)).toContain("6 Sessions")
})

test("weather region is opt-in, auto-enables its widget and blank disables immediately and persistently", async () => {
  const h = harness({ width: 180, height: 50 })
  await h.type("/usage\r")
  await h.app.onKey("w")
  await h.type("Example City")
  expect(h.sentOf("usage.weather.query")).toHaveLength(0)
  await h.app.onKey("\r")
  expect(readTuiProfile(h.dataDir)).toMatchObject({ usageWeatherEnabled: true, usageWeatherRegion: "Example City", usageWidgets: ["weather"] })
  expect(h.sentOf("usage.weather.query")).toMatchObject([{ enabled: true, region: "Example City" }])
  expect(all(h)).toContain("Clear · 23°C")
  await h.app.onKey("w")
  await h.app.onKey("\x15")
  await h.app.onKey("\r")
  expect(all(h)).toContain("Weather is off")
  expect(readTuiProfile(h.dataDir)).toMatchObject({ usageWeatherEnabled: false, usageWeatherRegion: "" })
  expect(h.sentOf("usage.weather.query")).toHaveLength(1)
  const next = harness({ dataDir: h.dataDir })
  await next.type("/usage\r")
  expect(next.sentOf("usage.weather.query")).toHaveLength(0)
})

test("weather editor supports arrows, home/end, delete and bracketed paste; Escape cancels", async () => {
  const h = harness()
  await h.type("/usage\r")
  await h.app.onKey("w")
  await h.type("\x1b[200~Example\nCity\x1b[201~")
  await h.app.onKey("\x1b[H")
  await h.app.onKey("\x1b[3~")
  await h.app.onKey("E")
  await h.app.onKey("\x1b[F")
  await h.app.onKey("\x1b[D")
  await h.app.onKey("\x7f")
  await h.app.onKey("t")
  await h.app.onKey("\r")
  expect(readTuiProfile(h.dataDir).usageWeatherRegion).toBe("Example City")
  await h.app.onKey("w")
  await h.app.onKey("\x15")
  await h.type("Other City")
  await h.app.onKey("\x1b")
  expect(readTuiProfile(h.dataDir).usageWeatherRegion).toBe("Example City")
})

test("a stale weather reply cannot resurrect disabled weather", async () => {
  let release: ((report: UsageWeatherReport) => void) | undefined
  const h = harness({ width: 180, height: 50, weather: () => new Promise((resolve) => { release = resolve }) })
  await h.type("/usage\r")
  await h.app.onKey("w")
  await h.type("Example City")
  const saving = h.app.onKey("\r")
  await Bun.sleep(2)
  expect(all(h)).toContain("Loading weather")
  await h.app.onKey("w")
  await h.app.onKey("\x15")
  await h.app.onKey("\r")
  release!({ status: "ready", region: "Example City", reading: { location: "Example City", label: "Clear", temperatureC: 23, observedAt: 1 } })
  await saving
  h.app.render()
  expect(all(h)).toContain("Weather is off")
  expect(all(h)).not.toContain("Clear")
})

test("all ten widgets render real scoped state in a full-width grid with no empty bottom band", async () => {
  const h = harness({ width: 180, height: 50, profile: { usageWidgets: [...USAGE_WIDGET_IDS], usageWeatherEnabled: true, usageWeatherRegion: "Example City" } })
  await h.type("/usage\r")
  for (const label of ["Token mix", "Response load", "Subscription usage", "Peak pressure", "Clock", "Weather", "Status", "Outcome signals", "Most used tools", "Agents & models", "14 changed files", "6 sessions with changes", "Retained snapshots only", "42 turns"]) expect(all(h)).toContain(label)
  expect(h.text().at(-2)!.trimEnd()).toEndWith("┘")
  await h.app.onKey("s")
  expect(all(h)).toContain("Scope project")
  await h.app.onKey("s")
  expect(all(h)).toContain("Scope directory")
})

test("unavailable/error and empty data never invent readings or file changes", async () => {
  for (const status of ["unavailable", "error"] as const) {
    const h = harness({ width: 180, height: 50, empty: true, profile: { usageWidgets: [...USAGE_WIDGET_IDS], usageWeatherEnabled: true, usageWeatherRegion: "Example City" }, weather: (region) => ({ status, region }) })
    await h.type("/usage\r")
    expect(all(h)).toContain(status === "unavailable" ? "Service unavailable" : "Weather unavailable")
    expect(all(h)).toContain("0 changed files")
    expect(all(h)).toContain("No agent activity")
    expect(all(h)).not.toContain("°C")
  }
})

test("every report/settings state stays inside the supported cell grids; compact is a single column", () => {
  const report = { ...usageFixture(), agents: [{ name: "review", turns: 5 }], outcomes: { changedFiles: 2, sessionsWithCodeChanges: 1, coverage: "retained-snapshots" as const } }
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]] as const) {
    for (const patch of [{}, { widgetIndex: 9 }, { weatherInput: "漢字".repeat(50), weatherCursor: 100 }]) {
      const rows = renderUsagePage({ report, state: { ...createUsagePageState("2026-09-30"), ...patch }, today: "2026-09-30", now: 1, width, height, widgets: USAGE_WIDGET_IDS, profile: { ...DEFAULT_TUI_PROFILE, usageWidgets: [...USAGE_WIDGET_IDS] } })
      expect(rows).toHaveLength(height)
      for (const row of rows) expect(textWidth(row.map((span) => span.text).join(""))).toBe(width)
      if (width === 60 && Object.keys(patch).length === 0) expect(rows.map((row) => row.map((span) => span.text).join("")).join("\n")).not.toContain("Clock")
    }
  }
})

test("widget profiles sanitize and round-trip independently from other customization", () => {
  const h = harness()
  const profile = normalizeTuiProfile({ usageWidgets: ["clock", "tools", "clock", "unknown"], usageWeatherEnabled: true, usageWeatherRegion: " Example\x1b[2J City ", productName: "Local Tool" })
  expect(profile).toMatchObject({ usageWidgets: ["clock", "tools"], usageWeatherEnabled: true, usageWeatherRegion: "Example City", productName: "Local Tool" })
  expect(writeTuiProfile(h.dataDir, profile)).toEqual({ ok: true })
  expect(readTuiProfile(h.dataDir)).toEqual(profile)
})

test("usage widgets remain lazy and the startup graph stays free of schemas and zod", () => {
  const h = harness()
  const result = Bun.spawnSync(["bun", "-e", 'await import("./apps/cli/src/ui/app"); const keys = Object.keys(require.cache); console.log(JSON.stringify(keys.filter(k => k.includes("/zod/") || /protocol\\/src\\/(commands|queries|events|usage-widgets)\\.ts$/.test(k) || k.endsWith("/view/usage-widgets.ts"))))'], { cwd: path.resolve(import.meta.dir, "../../.."), env: { ...process.env, MENDCODE_V2_DIR: h.dataDir }, stdout: "pipe", stderr: "pipe" })
  expect(result.exitCode).toBe(0)
  expect(result.stderr.toString()).toBe("")
  expect(JSON.parse(result.stdout.toString())).toEqual([])
})
