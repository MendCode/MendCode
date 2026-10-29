import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createVirtualClock } from "@mendcode/kernel"
import { createIdFactory, GlobalEvent, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { createActivityThrottle, type ActivityEntry, type SessionActivityEvent } from "../src/session-activity"

const ids = createIdFactory()
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function throttle() {
  const clock = createVirtualClock(1_000)
  const events: SessionActivityEvent[] = []
  const sessionId = ids("session")
  const throttled = createActivityThrottle({ clock, emit: (event) => void events.push(event) })
  const entry = (state: ActivityEntry["state"], patch: Partial<ActivityEntry> = {}): ActivityEntry => ({ sessionId, directory: "/repo", title: "t", state, updatedAt: 1, ...patch })
  return { clock, events, throttled, entry, sessionId }
}

describe("activity throttle", () => {
  test("the first push of a session goes out immediately with every field", () => {
    const { events, throttled, entry, sessionId } = throttle()
    throttled.push(entry("idle", { title: "hello", updatedAt: 42 }))
    expect(events).toEqual([{ type: "session.activity", gseq: 0, at: 1_000, sessionId, directory: "/repo", title: "hello", state: "idle", updatedAt: 42 }])
    expect(GlobalEvent.safeParse(events[0]).success).toBe(true)
  })

  test("pushes inside 250 ms are coalesced and only the newest state is delivered at the end of the window", () => {
    const { clock, events, throttled, entry } = throttle()
    throttled.push(entry("idle"))
    clock.advance(10)
    throttled.push(entry("generating"))
    clock.advance(10)
    throttled.push(entry("tool"))
    clock.advance(10)
    throttled.push(entry("generating"))
    expect(events.length).toBe(1)
    clock.advance(240)
    expect(events.map((e) => e.state)).toEqual(["idle", "generating"])
    expect(events[1]!.at).toBe(1_250)
  })

  test("a push after the window goes out immediately and a long burst is limited to one event per 250 ms", () => {
    const { clock, events, throttled, entry } = throttle()
    throttled.push(entry("generating"))
    clock.advance(250)
    throttled.push(entry("tool"))
    expect(events.length).toBe(2)
    for (let i = 0; i < 100; i++) {
      clock.advance(10)
      throttled.push(entry(i % 2 ? "tool" : "generating"))
    }
    clock.advance(300)
    const times = events.map((e) => e.at)
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(250)
    expect(events.length).toBeLessThanOrEqual(7)
  })

  test("a final idle inside the window is never lost", () => {
    const { clock, events, throttled, entry } = throttle()
    throttled.push(entry("generating"))
    clock.advance(20)
    throttled.push(entry("idle", { updatedAt: 9 }))
    clock.advance(500)
    expect(events.at(-1)).toMatchObject({ state: "idle", updatedAt: 9 })
  })

  test("transitions to or from waiting_approval and error are immediate", () => {
    const { clock, events, throttled, entry } = throttle()
    throttled.push(entry("generating"))
    clock.advance(5)
    throttled.push(entry("waiting_approval"))
    clock.advance(5)
    throttled.push(entry("tool"))
    clock.advance(5)
    throttled.push(entry("error"))
    clock.advance(5)
    throttled.push(entry("idle"))
    expect(events.map((e) => e.state)).toEqual(["generating", "waiting_approval", "tool", "error", "idle"])
  })

  test("an immediate event cancels the pending delivery so nothing stale follows", () => {
    const { clock, events, throttled, entry } = throttle()
    throttled.push(entry("idle"))
    clock.advance(10)
    throttled.push(entry("generating"))
    clock.advance(10)
    throttled.push(entry("waiting_approval"))
    clock.advance(1_000)
    expect(events.map((e) => e.state)).toEqual(["idle", "waiting_approval"])
  })

  test("force delivers immediately even inside the window", () => {
    const { clock, events, throttled, entry } = throttle()
    throttled.push(entry("idle", { title: "old" }))
    clock.advance(5)
    throttled.push(entry("idle", { title: "new" }), { force: true })
    expect(events.map((e) => e.title)).toEqual(["old", "new"])
  })

  test("sessions are throttled independently and forget drops a pending delivery", () => {
    const { clock, events, throttled, entry, sessionId } = throttle()
    const other = ids("session")
    throttled.push(entry("idle"))
    throttled.push(entry("idle", { sessionId: other }))
    clock.advance(10)
    throttled.push(entry("generating"))
    throttled.push(entry("generating", { sessionId: other }))
    throttled.forget(sessionId)
    clock.advance(300)
    expect(events.map((e) => `${e.sessionId === sessionId ? "a" : "b"}:${e.state}`)).toEqual(["a:idle", "b:idle", "b:generating"])
  })
})

async function boot() {
  const dir = mkdtempSync(path.join(tmpdir(), "mendd-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanups.push(() => daemon.stop())
  const seen: SessionActivityEvent[] = []
  const client = createClient({ socketPath: daemon.socketPath, name: "A", onEvent: () => {}, onGlobal: (event) => event.type === "session.activity" && seen.push(event) })
  await client.connect()
  cleanups.push(() => client.close())
  return { client, seen }
}

async function until(check: () => boolean, ms = 3_000) {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 5))
  if (!check()) throw new Error("timed out")
}

describe("daemon session.activity", () => {
  test("creating a session pushes an idle activity with its directory", async () => {
    const { client, seen } = await boot()
    const created = await client.send({ type: "session.create", directory: "/work/app", title: "first" })
    const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
    await until(() => seen.some((e) => e.sessionId === sessionId))
    expect(seen.find((e) => e.sessionId === sessionId)).toMatchObject({ directory: "/work/app", title: "first", state: "idle", gseq: 0 })
  })

  test("a running turn pushes working states and ends with idle plus the auto title", async () => {
    const { client, seen } = await boot()
    const created = await client.send({ type: "session.create", directory: "/work/app", title: "" })
    const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
    await client.subscribe(sessionId, 0)
    await client.send({ type: "user.submit", sessionId, text: "/tool 700", attachments: [] })
    await until(() => seen.some((e) => e.sessionId === sessionId && (e.state === "generating" || e.state === "tool")))
    await until(() => seen.at(-1)?.state === "idle" && seen.length > 2)
    expect(seen.at(-1)).toMatchObject({ sessionId, state: "idle", title: "/tool 700" })
  })

  test("renaming pushes the new title immediately", async () => {
    const { client, seen } = await boot()
    const created = await client.send({ type: "session.create", directory: "/work/app", title: "a" })
    const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
    await client.send({ type: "session.rename", sessionId, title: "renamed" })
    await until(() => seen.some((e) => e.title === "renamed"))
    expect(seen.find((e) => e.title === "renamed")).toMatchObject({ sessionId, state: "idle" })
  })
})
