import { expect, test } from "bun:test"
import { Command, createIdFactory, TuiProfilePatch, UsageReport, UsageWeatherReport } from "../src"
import { isReadOnlyCommand, normalizeUsageWidgets, TUI_DEFAULTS, tuiProblems } from "../src/wire"

const ids = createIdFactory()
const query = { id: ids("command"), clientId: ids("client"), type: "usage.weather.query" as const }

test("weather commands are additive, opt-in, bounded and excluded from remote read-only commands", () => {
  expect(Command.parse(query)).toEqual(query)
  expect(Command.parse({ ...query, enabled: true, region: "  Example City  " })).toMatchObject({ enabled: true, region: "Example City" })
  for (const region of ["", "x".repeat(121), "bad\x1b[31m", "bad\nregion"]) expect(Command.safeParse({ ...query, region }).success).toBe(false)
  expect(isReadOnlyCommand("usage.weather.query")).toBe(false)
})

test("widget profile fields default off and reject unknown IDs and unsafe regions", () => {
  expect(TUI_DEFAULTS).toMatchObject({ usageWidgets: [], usageWeatherEnabled: false, usageWeatherRegion: "" })
  expect(TuiProfilePatch.parse({ usageWidgets: ["clock", "tools"], usageWeatherEnabled: false })).toEqual({ usageWidgets: ["clock", "tools"], usageWeatherEnabled: false })
  for (const profile of [{ usageWidgets: ["unknown"] }, { usageWidgets: [false] }, { usageWeatherRegion: "a\nregion" }, { usageWeatherRegion: "a".repeat(121) }]) expect(tuiProblems(profile).length).toBeGreaterThan(0)
  expect(normalizeUsageWidgets(["tools", false, "missing", "clock", "tools"])).toEqual(["tools", "clock"])
})

test("weather readings require finite safe data and a ready reading; old usage reports remain valid", () => {
  const ready = { status: "ready" as const, region: "Example City", reading: { location: "Example City", label: "Clear", temperatureC: 23, windKmh: 8, observedAt: 100 } }
  expect(UsageWeatherReport.parse(ready)).toEqual(ready)
  expect(UsageWeatherReport.safeParse({ status: "ready", region: "Example City" }).success).toBe(false)
  for (const reading of [{ ...ready.reading, temperatureC: NaN }, { ...ready.reading, windKmh: -1 }, { ...ready.reading, label: "Clear\x1b[2J" }]) expect(UsageWeatherReport.safeParse({ ...ready, reading }).success).toBe(false)
  const report = { from: "2026-09-30", to: "2026-09-30", days: [], models: [], quotas: [] }
  expect(UsageReport.parse(report)).toEqual(report)
  expect(UsageReport.parse({ ...report, agents: [{ name: "build", turns: 1 }], outcomes: { changedFiles: 2, sessionsWithCodeChanges: 1, coverage: "retained-snapshots" } })).toMatchObject({ outcomes: { changedFiles: 2 } })
})
