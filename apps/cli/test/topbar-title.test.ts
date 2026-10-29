import { describe, expect, test } from "bun:test"
import { createIdFactory, type SessionEvent, type SessionSummary } from "@mendcode/protocol"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"

const ids = createIdFactory()
const NOW = 1_800_000_000_000
const plain = (line: Line) => line.map((span) => span.text).join("")

function summary(sessionId: SessionSummary["sessionId"], title: string): SessionSummary {
  return { sessionId, title, directory: "/work/app", createdAt: NOW - 1_000, updatedAt: NOW, lastSeq: 0, state: "idle", queued: 0 }
}

/** `recent` answers the small startup lookup (limit under 100); `all` answers the session list page. */
function harness(lists: { recent?: (id: SessionSummary["sessionId"]) => SessionSummary[]; all?: (id: SessionSummary["sessionId"]) => SessionSummary[] }) {
  const frames: Line[][] = []
  const sessionId = ids("session")
  const turnId = ids("turn")
  const screen = { size: { width: 100, height: 30 }, draw: (rows: Line[]) => void frames.push(rows) } as unknown as Parameters<typeof createApp>[0]["screen"]
  const app = createApp({
    sessionId,
    screen,
    directory: "/work/app",
    exit() {},
    schedule: (fn) => fn(),
    glyphs: glyphs({}),
    now: () => NOW,
    random: () => 0,
    mode: "balanced",
    subscribe: async () => ({ ok: true }),
    send: (async (command: Record<string, unknown>) => {
      if (command.type !== "session.list") return { ok: true }
      const list = (command.limit as number) < 100 ? lists.recent : lists.all
      return { ok: true, result: { sessions: list?.(sessionId) ?? [] } }
    }) as never,
  })
  let seq = 0
  const ev = (patch: Record<string, unknown>) => app.onEvent({ sessionId, seq: ++seq, at: NOW, ...patch } as SessionEvent)
  /** A session with a message shows the top bar (the home does not). */
  const message = () => {
    const itemId = ids("item")
    ev({ type: "item.started", turnId, itemId, kind: "agent_message" })
    ev({ type: "item.completed", itemId, status: "ok", text: "hello" })
  }
  const topbar = () => plain(frames.at(-1)![0]!)
  const settle = async () => {
    await Bun.sleep(10)
    app.render()
  }
  /** Opens the session list page (which loads the full list) and comes back to the chat. */
  const visitSessionList = async () => {
    await app.onInput("/sessions")
    await app.onKey("\r")
    await settle()
    await app.onKey("\x1b")
    await settle()
  }
  return { app, message, topbar, settle, visitSessionList }
}

describe("top bar title", () => {
  test("shows the listed title of a session that has no agent title", async () => {
    const h = harness({ all: (id) => [summary(id, "workflow · ship · Build")] })
    h.app.applySettings({})
    h.message()
    await h.settle()
    expect(h.topbar()).not.toContain("workflow · ship · Build")
    await h.visitSessionList()
    expect(h.topbar()).toContain("workflow · ship · Build")
  })

  test("the agent title wins over the listed title", async () => {
    const h = harness({ recent: (id) => [summary(id, "agent title")], all: (id) => [summary(id, "listed title")] })
    h.app.applySettings({})
    h.message()
    await h.settle()
    await h.visitSessionList()
    expect(h.topbar()).toContain("agent title")
    expect(h.topbar()).not.toContain("listed title")
  })
})
