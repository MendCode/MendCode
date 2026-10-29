import { describe, expect, test } from "bun:test"
import { createIdFactory, type GlobalEvent, type SessionSummary } from "@mendcode/protocol"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"

const ids = createIdFactory()
const NOW = 1_800_000_000_000
const current = ids("session")

function summary(patch: Partial<SessionSummary> & { sessionId: SessionSummary["sessionId"] }): SessionSummary {
  return { title: "task", directory: "/work/alpha", createdAt: NOW, updatedAt: NOW - 60_000, lastSeq: 1, state: "idle", queued: 0, ...patch }
}

const activity = (patch: Partial<Extract<GlobalEvent, { type: "session.activity" }>> & { sessionId: SessionSummary["sessionId"] }): GlobalEvent => ({
  type: "session.activity", gseq: 0, at: NOW, directory: "/work/alpha", title: "task", state: "idle", updatedAt: NOW, ...patch,
})

async function harness(initial: SessionSummary[]) {
  const frames: Line[][] = []
  const screen = { size: { width: 90, height: 14 }, draw: (rows: Line[]) => void frames.push(rows) } as unknown as Parameters<typeof createApp>[0]["screen"]
  const app = createApp({
    sessionId: current,
    screen,
    send: async (command) => (command.type === "session.list" ? { ok: true, result: { sessions: initial } } : { ok: true }),
    exit() {},
    schedule: (fn) => fn(),
    glyphs: glyphs({}),
    now: () => NOW,
  } as never)
  for (const key of "/sessions") await app.onKey(key)
  await app.onKey("\r")
  const text = () => frames
    .at(-1)!
    .map((row) => {
      const full = row.map((s) => s.text).join("")
      return full.replace(/^│ /, "").replace(/ │$/, "").trimEnd()
    })
    .filter((line) => line.length > 0)
  const titleRow = () => text().find((line) => line.startsWith("all projects"))!
  return { app, text, titleRow, frames }
}

describe("live session panel in the app", () => {
  test("opening /sessions shows the grouped list", async () => {
    const { text } = await harness([summary({ sessionId: current, title: "open one" }), summary({ sessionId: ids("session"), title: "other", directory: "/work/beta" })])
    expect(text().some((line) => line.startsWith("Active · /work/alpha (1)"))).toBe(true)
    expect(text().some((line) => line.startsWith("Active · /work/beta (1)"))).toBe(true)
  })

  test("an activity event updates state, title and time of a listed session and redraws", async () => {
    const other = ids("session")
    const { app, text, titleRow, frames } = await harness([summary({ sessionId: current }), summary({ sessionId: other, title: "old title", directory: "/work/beta" })])
    const before = frames.length
    app.onGlobal(activity({ sessionId: other, title: "new title", directory: "/work/beta", state: "waiting_approval", updatedAt: NOW }))
    expect(frames.length).toBeGreaterThan(before)
    const row = text().find((line) => line.includes("new title"))!
    expect(row).toContain("needs approval")
    expect(row).toContain("now")
    expect(text().some((line) => line.includes("old title"))).toBe(false)
    expect(titleRow()).toEndWith("2 sessions · 1 needs approval")
  })

  test("an event for an unlisted session inserts it under its project", async () => {
    const { app, text, titleRow } = await harness([summary({ sessionId: current })])
    expect(titleRow()).toEndWith("1 session")
    app.onGlobal(activity({ sessionId: ids("session"), title: "brand new", directory: "/work/gamma", state: "generating" }))
    expect(text().some((line) => line.startsWith("Active · /work/gamma (1)"))).toBe(true)
    expect(text().some((line) => line.includes("brand new"))).toBe(true)
    expect(titleRow()).toEndWith("2 sessions · 1 working")
  })

  test("a later event moves a working session back to idle", async () => {
    const other = ids("session")
    const { app, titleRow } = await harness([summary({ sessionId: current }), summary({ sessionId: other, title: "busy", state: "generating" })])
    expect(titleRow()).toContain("1 working")
    app.onGlobal(activity({ sessionId: other, title: "busy", state: "idle" }))
    expect(titleRow()).not.toContain("working")
    expect(titleRow()).toEndWith("2 sessions")
  })

  test("events are ignored when the sessions page is not open", async () => {
    const frames: Line[][] = []
    const screen = { size: { width: 80, height: 10 }, draw: (rows: Line[]) => void frames.push(rows) } as unknown as Parameters<typeof createApp>[0]["screen"]
    const app = createApp({ sessionId: current, screen, send: async () => ({ ok: true }), exit() {}, schedule: (fn) => fn(), glyphs: glyphs({}) })
    const before = frames.length
    app.onGlobal(activity({ sessionId: ids("session") }))
    expect(frames.length).toBe(before)
  })
})
