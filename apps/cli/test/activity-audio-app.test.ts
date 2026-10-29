import { afterEach, expect, test } from "bun:test"
import path from "node:path"
import type { SessionEvent, SessionId } from "@mendcode/protocol"
import { CUSTOMIZE_ROWS, renderCustomizePage } from "../src/view/customize-page"
import { DEFAULT_TUI_PROFILE, readTuiProfile, writeTuiProfile } from "../src/view/tui-profile"
import { tuiProblems } from "@mendcode/protocol/wire"
import { textWidth } from "../src/view/wrap"
import { appHarness, cleanTemps, ids, NOW, tempDir } from "./session-ui-harness"

const apps: ReturnType<typeof appHarness>[] = []
afterEach(async () => {
  const results = await Promise.allSettled(apps.splice(0).map((h) => h.app.onKey("\x03")))
  cleanTemps()
  for (const result of results) if (result.status === "rejected") throw result.reason
})
type EventInput<T = SessionEvent> = T extends SessionEvent ? Omit<T, "sessionId" | "seq" | "at"> & { sessionId?: SessionId } : never

test("audio factory keeps the startup graph free of schemas, zod and player processes", () => {
  const result = Bun.spawnSync([process.execPath, "-e", `await import("./src/ui/app"); await import("@mendcode/client");
const keys = Object.keys(require.cache);
console.log(JSON.stringify({ zod: keys.filter((k) => k.includes("/zod/")).length, schemas: keys.filter((k) => /protocol\\/src\\/(commands|events|queries|frames|activity-audio)\\.ts$/.test(k)).length, player: keys.filter((k) => k.endsWith("/activity-audio-player.ts")).length }))`], { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" })
  expect(result.exitCode).toBe(0)
  expect(result.stderr.toString()).toBe("")
  expect(JSON.parse(result.stdout.toString())).toEqual({ zod: 0, schemas: 0, player: 0 })
})

function scene(mode: "off" | "pulse" | "hum" = "off", options: Parameters<typeof appHarness>[0] = {}) {
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, activitySound: mode })
  const h = appHarness({ dataDir, ...options })
  apps.push(h)
  const commands = () => h.sentOf("audio.play")
  let seq = 0
  const emit = (event: EventInput, at = NOW) => {
    const full = { sessionId: h.sessionId, seq: ++seq, at, ...event } as SessionEvent
    h.app.onEvent(full)
    return full
  }
  return { ...h, commands, emit, dataDir }
}

test("audio defaults off; historical, duplicate and other-session events stay silent", () => {
  const h = scene()
  h.emit({ type: "turn.started", turnId: ids("turn"), queueId: ids("queue") })
  h.emit({ type: "turn.completed", turnId: ids("turn") })
  expect(h.commands()).toEqual([])
  const audible = scene("hum")
  audible.emit({ type: "turn.started", turnId: ids("turn"), queueId: ids("queue") }, NOW - 1)
  audible.emit({ type: "turn.completed", turnId: ids("turn") }, NOW - 1)
  audible.emit({ type: "turn.started", sessionId: ids("session"), turnId: ids("turn"), queueId: ids("queue") })
  expect(audible.commands()).toEqual([])
  const event = audible.emit({ type: "turn.started", turnId: ids("turn"), queueId: ids("queue") })
  audible.app.onEvent(event)
  audible.emit({ type: "foreground.state", state: "tool" })
  expect(audible.commands()).toEqual([{ type: "audio.play", action: "start" }])
})

test("hum follows activity, pulses once for approval/completion, idle keeps completion audible", () => {
  const h = scene("hum")
  const turnId = ids("turn")
  const requestId = ids("request")
  h.emit({ type: "turn.started", turnId, queueId: ids("queue") })
  h.emit({ type: "foreground.state", state: "waiting_approval" })
  h.emit({ type: "server.request", requestId, turnId, kind: "approval", title: "Run tests", detail: "bun test focused.test.ts" })
  h.emit({ type: "server.request.resolved", requestId, resolution: "approved" })
  h.emit({ type: "foreground.state", state: "generating" })
  h.emit({ type: "turn.completed", turnId })
  h.emit({ type: "foreground.state", state: "idle" })
  expect(h.commands()).toEqual([
    { type: "audio.play", action: "start" }, { type: "audio.play", action: "pulse", scale: 0.8 },
    { type: "audio.play", action: "start" }, { type: "audio.play", action: "pulse", scale: 1 },
  ])
  const pulse = scene("pulse")
  pulse.emit({ type: "turn.started", turnId, queueId: ids("queue") })
  pulse.emit({ type: "turn.failed", turnId, error: { code: "internal", message: "Local fake failed" } })
  expect(pulse.commands()).toEqual([{ type: "audio.play", action: "pulse", scale: 0.8 }])
})

test("cancel, interruption, session switch and both exit paths stop playback", async () => {
  for (const type of ["turn.cancelled", "turn.interrupted"] as const) {
    const h = scene("hum")
    const turnId = ids("turn")
    h.emit({ type: "turn.started", turnId, queueId: ids("queue") })
    h.emit(type === "turn.cancelled" ? { type, turnId, by: "user" } : { type, turnId, reason: "restart" })
    expect(h.commands().at(-1)).toEqual({ type: "audio.play", action: "stop" })
  }
  const switched = scene("hum", { reply: (command) => command.type === "session.create" ? { ok: true, result: { sessionId: ids("session") } } : undefined })
  switched.emit({ type: "turn.started", turnId: ids("turn"), queueId: ids("queue") })
  await switched.type("/new\r")
  expect(switched.commands().at(-1)).toEqual({ type: "audio.play", action: "stop" })
  for (const exit of ["\x03", "/quit\r"]) {
    const h = scene("hum")
    h.emit({ type: "turn.started", turnId: ids("turn"), queueId: ids("queue") })
    await h.type(exit)
    expect(h.commands().at(-1)).toEqual({ type: "audio.play", action: "stop" })
  }
})

test("customize cycles/persists opt-in and turning off stops immediately; row fits every required width", async () => {
  expect(tuiProblems({ activitySound: "hum" })).toEqual([])
  expect(tuiProblems({ activitySound: "loud" })).not.toEqual([])
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]] as const) {
    const rows = renderCustomizePage({ width, height, state: { row: CUSTOMIZE_ROWS.indexOf("activitySound") }, profile: { ...DEFAULT_TUI_PROFILE, activitySound: "hum" }, preview: { root: "/work/mendcode", now: NOW, tip: "" } })
    expect(rows.map((row) => row.map((span) => span.text).join("")).join("\n")).toContain("Activity sound")
    expect(rows).toHaveLength(height)
    expect(rows.every((row) => textWidth(row.map((span) => span.text).join("")) <= width)).toBe(true)
  }
  {
    const width = 100, height = 30
    const h = scene("off", { width, height })
    await h.type("/customize\r")
    for (let i = 0; i < CUSTOMIZE_ROWS.indexOf("activitySound"); i++) await h.app.onKey("\x1b[B")
    expect(h.text().join("\n")).toContain("Activity sound")
    expect(h.text()).toHaveLength(height!)
    expect(h.text().every((row) => textWidth(row) <= width!)).toBe(true)
    await h.app.onKey("\x1b[C")
    expect(readTuiProfile(h.dataDir).activitySound).toBe("pulse")
    await h.app.onKey("\x1b[C")
    expect(readTuiProfile(h.dataDir).activitySound).toBe("hum")
    h.emit({ type: "turn.started", turnId: ids("turn"), queueId: ids("queue") })
    await h.app.onKey("\x1b[C")
    expect(readTuiProfile(h.dataDir).activitySound).toBe("off")
    expect(h.commands().at(-1)).toEqual({ type: "audio.play", action: "stop" })
  }
}, 30_000)

test("live extension profile changes stop audio; remote clients never request host playback", () => {
  const h = scene("hum")
  h.emit({ type: "turn.started", turnId: ids("turn"), queueId: ids("queue") })
  h.app.onGlobal({ type: "tui.changed", profile: { activitySound: "off" }, at: NOW, gseq: 1 })
  expect(h.commands().at(-1)).toEqual({ type: "audio.play", action: "stop" })
  const remote = scene("hum", { remote: { host: "127.0.0.1", readOnly: false } })
  remote.emit({ type: "turn.started", turnId: ids("turn"), queueId: ids("queue") })
  remote.emit({ type: "turn.completed", turnId: ids("turn") })
  expect(remote.commands()).toEqual([])
})

test("missing playback warns once; disabling audio during loading suppresses stale errors", async () => {
  const missing = scene("pulse", { reply: (command) => command.type === "audio.play" ? { ok: true, result: { played: false } } : undefined })
  missing.emit({ type: "turn.completed", turnId: ids("turn") })
  await Bun.sleep(2)
  expect(missing.text().join("\n")).toContain("Activity sound unavailable")
  let finish!: (reply: { ok: true; result: { played: false } }) => void
  const loading = scene("hum", { reply: (command) => command.type === "audio.play" && command.action === "start" ? new Promise((resolve) => { finish = resolve }) : undefined })
  loading.emit({ type: "turn.started", turnId: ids("turn"), queueId: ids("queue") })
  loading.app.onGlobal({ type: "tui.changed", profile: { activitySound: "off" }, at: NOW, gseq: 1 })
  finish({ ok: true, result: { played: false } })
  await Bun.sleep(2)
  expect(loading.text().join("\n")).not.toContain("Activity sound unavailable")
})
