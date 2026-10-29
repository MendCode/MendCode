import { describe, expect, test } from "bun:test"
import { createIdFactory, TUI_DEFAULTS, type SessionEvent } from "@mendcode/protocol"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"
import { renderHome, type HomeSession } from "../src/view/home"
import { renderSessionSidebar } from "../src/view/sidebar"
import { createTranscript } from "../src/view/transcript"
import { DEFAULT_TUI_PROFILE, normalizeTuiProfile, type TuiProfile } from "../src/view/tui-profile"

const ids = createIdFactory()
const NOW = 1_800_000_000_000
const plain = (line: Line) => line.map((span) => span.text).join("")

function app(profile: Partial<TuiProfile> = {}, send: (command: { type: string }, sessionId: string) => unknown = () => undefined) {
  const frames: Line[][] = []
  const screen = { size: { width: 100, height: 30 }, draw: (rows: Line[]) => void frames.push(rows) } as unknown as Parameters<typeof createApp>[0]["screen"]
  const sessionId = ids("session")
  const made = createApp({
    sessionId, screen, directory: "/work/app", exit: () => {}, schedule: (fn) => fn(), glyphs: glyphs({}), now: () => NOW, random: () => 0, mode: "balanced",
    profile: normalizeTuiProfile({ ...DEFAULT_TUI_PROFILE, ...profile }),
    send: (async (command: { type: string }) => send(command, sessionId) ?? { ok: true }) as never,
  })
  return { app: made, sessionId, text: () => frames.at(-1)!.map(plain) }
}

describe("profile keys for the parts of the screen that had none", () => {
  test("each new key has the same default in the terminal and in the daemon's schema, and survives normalizing", () => {
    const fresh = { homeHeader: true, homePanel: true, showPlaceholder: true, placeholderText: "", sidebarHeader: true, showTasks: true, assistantName: "" }
    for (const [key, value] of Object.entries(fresh)) {
      expect([key, DEFAULT_TUI_PROFILE[key as keyof TuiProfile]]).toEqual([key, value])
      expect([key, TUI_DEFAULTS[key]]).toEqual([key, value])
    }
    const set = normalizeTuiProfile({ homeHeader: false, homePanel: false, showPlaceholder: false, placeholderText: "Ask me\nanything", sidebarHeader: false, showTasks: false, assistantName: "Mend" })
    expect(set).toMatchObject({ homeHeader: false, homePanel: false, showPlaceholder: false, placeholderText: "Ask me anything", sidebarHeader: false, showTasks: false, assistantName: "Mend" })
  })

  test("showPlaceholder false leaves the empty prompt blank; placeholderText replaces the built-in example", async () => {
    const shown = app()
    shown.app.render()
    expect(shown.text().some((row) => row.includes('❭ Ask anything... "Fix a TODO in the codebase"'))).toBe(true)
    const off = app({ showPlaceholder: false })
    off.app.render()
    expect(off.text().some((row) => row.includes("Ask anything"))).toBe(false)
    expect(off.text().some((row) => row.trimEnd() === "  ❭")).toBe(true)
    const own = app({ placeholderText: "What shall we build?" })
    own.app.render()
    expect(own.text().some((row) => row.includes("❭ What shall we build?"))).toBe(true)
  })

  test("homeHeader false removes the home's first row (folder, product, version); homePanel false the session list under the logo", () => {
    const sessions: HomeSession[] = [{ id: "a", title: "Port palette", state: "working", updatedAt: NOW - 60_000, startedAt: NOW - 120_000 }]
    const base = { root: "~/Code/notes", version: "0.4.2", now: NOW, width: 120, height: 34, screenHeight: 40, sessions }
    const on = renderHome({ ...base, look: { layout: "centered" } }).map(plain)
    expect(on.slice(0, 2).join("\n")).toContain("~/Code/notes")
    expect(on.join("\n")).toContain("Port palette")
    const off = renderHome({ ...base, look: { layout: "centered", homeHeader: false, homePanel: false } }).map(plain)
    expect(off.join("\n")).not.toContain("~/Code/notes")
    expect(off.join("\n")).not.toContain("Port palette")
    expect(off.join("\n")).toContain("█▄ ▄█")
    // The split welcome without its panel keeps the identity in one column and still names the folder inside its box.
    const split = renderHome({ ...base, look: { layout: "split", homePanel: false } }).map(plain)
    expect(split.join("\n")).not.toContain("Port palette")
    expect(split.join("\n")).toContain("~/Code/notes")
  })

  test("sidebarHeader false gives the session list's title row and the blank under it to the sessions", () => {
    const sessions = [{ sessionId: "s1", title: "First", state: "idle", queued: 0, updatedAt: NOW }] as never
    const on = renderSessionSidebar({ sessions, current: "s1", focused: false, height: 12, now: NOW })
    expect(plain(on.rows[0]!)).toContain("Sessions")
    const off = renderSessionSidebar({ sessions, current: "s1", focused: false, height: 12, now: NOW, header: false })
    expect(off.rows.map(plain).join("\n")).not.toContain("Sessions")
    expect(plain(off.rows[0]!)).toContain("Active")
    expect(off.hits[0]!.row).toBe(on.hits[0]!.row - 2)
  })

  test("showTasks false takes the running background commands off the rows over the prompt", async () => {
    const running = (command: { type: string }, sessionId: string) => command.type === "background.list" ? { ok: true, result: { tasks: [{ id: "t1", sessionId, command: "bun run dev-server", status: "running", startedAt: NOW - 5_000 }] } } : undefined
    const seen = async (profile: Partial<TuiProfile>) => {
      const made = app(profile, running)
      const turnId = ids("turn"), itemId = ids("item")
      for (const [seq, event] of [{ type: "turn.started", turnId, queueId: ids("queue") }, { type: "item.started", turnId, itemId, kind: "user_message" }, { type: "item.completed", itemId, status: "ok", text: "start it" }].entries()) made.app.onEvent({ sessionId: made.sessionId, seq: seq + 1, at: NOW, ...event } as SessionEvent)
      made.app.onGlobal({ type: "session.background.changed", sessionId: made.sessionId, at: NOW, gseq: 1 } as Parameters<typeof made.app.onGlobal>[0])
      await Bun.sleep(5)
      made.app.render()
      return made.text().join("\n")
    }
    expect(await seen({})).toContain("bun run dev-server")
    expect(await seen({ showTasks: false })).not.toContain("bun run dev-server")
  })

  test("assistantName is the assistant's label: set, it shows even with assistantLabel off", () => {
    const sessionId = ids("session"), turnId = ids("turn"), itemId = ids("item")
    const events = [
      { type: "turn.started", turnId, queueId: ids("queue") },
      { type: "item.started", turnId, itemId, kind: "agent_message" },
      { type: "item.completed", itemId, status: "ok", text: "hello there" },
    ].map((event, seq) => ({ sessionId, seq: seq + 1, at: NOW, ...event }) as SessionEvent)
    const rows = (appearance: Partial<TuiProfile>) => {
      const transcript = createTranscript({ appearance, glyphs: glyphs({}), mode: "balanced", now: () => NOW })
      for (const event of events) transcript.apply(event)
      return transcript.viewport(80, 40).map((line) => line.text).join("\n")
    }
    expect(rows({})).not.toContain("Mend")
    expect(rows({ assistantName: "Mend" })).toContain("Mend")
    expect(rows({ assistantLabel: true })).toContain("Assistant")
  })
})
