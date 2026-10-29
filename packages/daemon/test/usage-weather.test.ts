import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { UsageWeatherReport } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { createUsageWeather } from "../src/usage-weather"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const reading = { location: "Example City", label: "Clear", temperatureC: 23, windKmh: 8, observedAt: 100 }

test("no service and disabled or empty-region queries never call an adapter", async () => {
  expect(await createUsageWeather()({ enabled: true, region: "Example City" })).toEqual({ status: "unavailable", region: "Example City" })
  let calls = 0
  const weather = createUsageWeather(async () => { calls++; return reading })
  expect(await weather({ region: "Example City" })).toEqual({ status: "off" })
  expect(await weather({ enabled: false, region: "Example City" })).toEqual({ status: "off" })
  expect(await weather({ enabled: true, region: " " })).toEqual({ status: "off" })
  expect(calls).toBe(0)
})

test("one in-flight call per region, region-isolated five-minute cache, bounded eviction", async () => {
  let at = 1_000, calls = 0
  const weather = createUsageWeather(async ({ region }) => { calls++; await Promise.resolve(); return { ...reading, location: region } }, () => at)
  const pair = await Promise.all([weather({ enabled: true, region: "Example City" }), weather({ enabled: true, region: "Example City" })])
  expect(pair[0]).toEqual(pair[1])
  expect(calls).toBe(1)
  await weather({ enabled: true, region: "Other City" })
  await weather({ enabled: true, region: "Example City" })
  expect(calls).toBe(2)
  at += 300_000
  await weather({ enabled: true, region: "Example City" })
  expect(calls).toBe(3)
  for (let i = 0; i < 16; i++) await weather({ enabled: true, region: `City ${i}` })
  await weather({ enabled: true, region: "Example City" })
  expect(calls).toBe(20)
})

test("a hanging adapter aborts at its own timeout and can be retried", async () => {
  let aborted = false, calls = 0
  const weather = createUsageWeather(async ({ signal }) => { calls++; if (calls > 1) return reading; signal.addEventListener("abort", () => { aborted = true }); return new Promise(() => {}) }, Date.now, 5)
  expect(await weather({ enabled: true, region: "Example City" })).toEqual({ status: "error", region: "Example City" })
  expect(aborted).toBe(true)
  expect(await weather({ enabled: true, region: "Example City" })).toMatchObject({ status: "ready" })
}, 1_000)

test("unsafe service output and sync/async failures do not expose error bodies or poison pending requests", async () => {
  let calls = 0
  const weather = createUsageWeather(() => { calls++; if (calls === 1) throw new Error("secret upstream body"); return Promise.resolve(calls === 2 ? { ...reading, label: "Clear\x1b[2J" } : reading) })
  const first = await weather({ enabled: true, region: "Example City" })
  expect(first).toEqual({ status: "error", region: "Example City" })
  expect(JSON.stringify(first)).not.toContain("secret")
  expect(await weather({ enabled: true, region: "Example City" })).toMatchObject({ status: "error" })
  expect(await weather({ enabled: true, region: "Example City" })).toMatchObject({ status: "ready" })
})

test("daemon + typed client transport preserves off/ready reports and validates commands without network", async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-b77-weather-")))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  let calls = 0
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "w.sock"), log: () => {}, engine: ({ clock }) => createFauxEngine({ clock }), usageWeather: async ({ region }) => { calls++; return { ...reading, location: region } } })
  cleanup.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "b77-weather", reconnect: false })
  cleanup.push(() => client.close())
  await client.connect()
  expect(await client.usageWeather({ region: "Example City" })).toEqual({ ok: true, report: { status: "off" } })
  expect(calls).toBe(0)
  const result = await client.usageWeather({ enabled: true, region: "Example City" })
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error.message)
  expect(UsageWeatherReport.parse(result.report)).toEqual({ status: "ready", region: "Example City", reading })
  expect(calls).toBe(1)
  expect(await client.usageWeather({ enabled: true, region: "Example City" })).toEqual(result)
  expect(calls).toBe(1)
  expect(await client.send({ type: "usage.weather.query", enabled: true, region: "bad\x1b[31m" })).toMatchObject({ ok: false })
})
