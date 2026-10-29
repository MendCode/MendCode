import { describe, expect, test } from "bun:test"
import { createIdFactory, type GlobalEvent, type SessionEvent } from "@mendcode/protocol"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"
import { textWidth } from "../src/view/wrap"

const ids = createIdFactory()
const home = ids("session")
const one = ids("session")
const two = ids("session")

type Activity = Extract<GlobalEvent, { type: "session.activity" }>
const activity = (over: Partial<Activity> & { sessionId: Activity["sessionId"] }): GlobalEvent =>
  ({ gseq: 1, at: 0, type: "session.activity", directory: "/work/app", title: "t", state: "generating", updatedAt: 1, ...over }) as GlobalEvent

function harness(width = 100) {
  const frames: Line[][] = []
  const sent: Array<Record<string, unknown>> = []
  let shells: unknown[] = []
  let listed: unknown[] = []
  const screen = { size: { width, height: 30 }, draw: (rows: Line[]) => void frames.push(rows) } as unknown as Parameters<typeof createApp>[0]["screen"]
  const send = async (command: unknown) => {
    const c = command as Record<string, unknown>
    sent.push(c)
    if (c.type === "background.list") return { ok: true, result: { tasks: shells } }
    if (c.type === "session.list") return { ok: true, result: { sessions: listed } }
    return { ok: true }
  }
  const app = createApp({ sessionId: home, screen, send: send as never, subscribe: async () => ({ ok: true }) as never, exit() {}, schedule: (fn) => fn(), glyphs: glyphs({}), now: () => 1_800_000_000_000 })
  const text = () => frames.at(-1)!.map((row) => row.map((s) => s.text).join(""))
  return { app, text, sent, setShells: (v: unknown[]) => (shells = v), setListed: (v: unknown[]) => (listed = v) }
}

describe("agent view in the app", () => {
  test("/agents opens the page; busy sessions arrive by push, idle ones drop out", async () => {
    const h = harness()
    h.app.onGlobal(activity({ sessionId: one, title: "fix flaky reconnect", state: "tool", tool: "read: a.ts", since: 1_800_000_000_000 - 65_000, queued: 1 }))
    h.app.onGlobal(activity({ sessionId: two, title: "review scheduler", state: "waiting_approval", pending: "Run command", since: 1_800_000_000_000 - 5_000 }))
    await h.app.onInput("/agents")
    await h.app.onInput("\r")
    expect(h.app.page).toBe("agents")
    let rows = h.text()
    expect(rows[1]!.includes("Agents")).toBe(true)
    expect(rows.some((line) => line.includes("2 busy"))).toBe(true)
    expect(rows.some((line) => line.includes("fix flaky reconnect"))).toBe(true)
    expect(rows.some((line) => line.includes("read: a.ts") && line.includes("+1 queued"))).toBe(true)
    expect(rows.some((line) => line.includes("Run command"))).toBe(true)
    h.app.onGlobal(activity({ sessionId: one, title: "fix flaky reconnect", state: "idle" }))
    rows = h.text()
    expect(rows.some((line) => line.includes("fix flaky reconnect"))).toBe(false)
    expect(rows.some((line) => line.includes("1 busy"))).toBe(true)
  })

  test("opening the page seeds busy sessions from session.list and fetches background shells", async () => {
    const h = harness()
    h.setListed([{ sessionId: one, title: "listed one", directory: "/work/app", createdAt: 1, updatedAt: 2, lastSeq: 3, state: "generating", queued: 0, since: 1_800_000_000_000 - 3_000, tool: "grep: x" }, { sessionId: two, title: "listed idle", directory: "/w", createdAt: 1, updatedAt: 2, lastSeq: 3, state: "idle", queued: 0 }])
    h.setShells([{ id: "bg1", sessionId: one, command: "bun run dev", cwd: "/work/app", status: "running", startedAt: 1_800_000_000_000 - 125_000 }])
    await h.app.onInput("/agents")
    await h.app.onInput("\r")
    expect(h.sent.some((c) => c.type === "session.list")).toBe(true)
    expect(h.sent.some((c) => c.type === "background.list")).toBe(true)
    const rows = h.text()
    expect(rows.some((line) => line.includes("listed one"))).toBe(true)
    expect(rows.some((line) => line.includes("grep: x"))).toBe(true)
    expect(rows.some((line) => line.includes("listed idle"))).toBe(false)
    expect(rows.some((line) => line.includes("bun run dev"))).toBe(true)
  })

  test("activity while the page is open re-queries the shells; other pages do not", async () => {
    const h = harness()
    await h.app.onInput("/agents")
    await h.app.onInput("\r")
    const before = h.sent.filter((c) => c.type === "background.list").length
    h.setShells([{ id: "bg2", sessionId: one, command: "make watch", cwd: "/x", status: "running", startedAt: 1_800_000_000_000 - 1_000 }])
    h.app.onGlobal(activity({ sessionId: one, state: "tool", tool: "shell: make watch" }))
    await new Promise((r) => setTimeout(r, 10))
    expect(h.sent.filter((c) => c.type === "background.list").length).toBeGreaterThan(before)
    expect(h.text().some((line) => line.includes("make watch"))).toBe(true)
    await h.app.onKey("\x1b")
    expect(h.app.page).toBe("chat")
    const after = h.sent.filter((c) => c.type === "background.list").length
    h.app.onGlobal(activity({ sessionId: two, state: "generating" }))
    await new Promise((r) => setTimeout(r, 10))
    expect(h.sent.filter((c) => c.type === "background.list").length).toBe(after)
  })

  test("sub-agents of the current session come from its running task tool calls", async () => {
    const h = harness()
    const turnId = ids("turn")
    const item = ids("item")
    let seq = 0
    const ev = (e: Record<string, unknown>) => ({ sessionId: home, seq: ++seq, at: 0, ...e }) as SessionEvent
    h.app.onEvent(ev({ type: "turn.started", turnId, queueId: ids("queue") }))
    h.app.onEvent(ev({ type: "item.started", turnId, itemId: item, kind: "tool_call", meta: { tool: "task: find usages of createApp" } }))
    h.app.onEvent(ev({ type: "item.delta", itemId: item, text: "◆ grep: createApp\n" }))
    h.app.onEvent(ev({ type: "item.delta", itemId: item, text: "◆ read: apps/cli/src/ui/app.ts\n" }))
    await h.app.onInput("/agents")
    await h.app.onInput("\r")
    const rows = h.text()
    expect(rows.some((line) => line.includes("find usages"))).toBe(true)
    h.app.onEvent(ev({ type: "item.completed", itemId: item, status: "ok", text: "done" }))
    expect(h.text().some((line) => line.includes("Sub-agents"))).toBe(false)
  })

  test("enter opens the selected session and a jumps to the one waiting for approval", async () => {
    const h = harness()
    h.app.onGlobal(activity({ sessionId: one, title: "long run", state: "generating", since: 1 }))
    h.app.onGlobal(activity({ sessionId: two, title: "asks", state: "waiting_approval", pending: "Run command", since: 2 }))
    await h.app.onInput("/agents")
    await h.app.onInput("\r")
    await h.app.onKey("j")
    await h.app.onKey("\r")
    expect(h.app.page).toBe("chat")
    expect(h.app.sessionId).toBe(one)
    await h.app.onInput("/agents")
    await h.app.onInput("\r")
    await h.app.onKey("a")
    expect(h.app.page).toBe("chat")
    expect(h.app.sessionId).toBe(two)
  })

  test("esc closes; every frame fits at 40 to 140 columns", async () => {
    for (const width of [40, 60, 100, 140]) {
      const h = harness(width)
      for (let i = 0; i < 30; i++) h.app.onGlobal(activity({ sessionId: ids("session"), title: `session number ${i} with a fairly long title`, state: i % 3 ? "generating" : "waiting_approval", tool: "shell: bun test packages", pending: i % 3 ? undefined : "Run command", since: 1, queued: i % 4 }))
      await h.app.onInput("/agents")
      await h.app.onInput("\r")
      for (const line of h.text()) expect(textWidth(line)).toBeLessThanOrEqual(width)
      await h.app.onKey("\x1b")
      expect(h.app.page).toBe("chat")
    }
  })

  test("the agent view sets no timers of its own", async () => {
    const h = harness()
    const intervals: unknown[] = []
    const original = globalThis.setInterval
    const originalClear = globalThis.clearInterval
    globalThis.setInterval = ((...args: unknown[]) => (h.app.page === "agents" && intervals.push(args), intervals.length + 1)) as never
    globalThis.clearInterval = (() => {}) as never
    try {
      h.app.onGlobal(activity({ sessionId: one, state: "generating", since: 1 }))
      // The home and the chat animate their own rows; only what is set while the agent view is the page counts.
      await h.app.onInput("/agents")
      await h.app.onInput("\r")
      h.app.onGlobal(activity({ sessionId: one, state: "tool", tool: "x", since: 1 }))
    } finally {
      globalThis.setInterval = original
      globalThis.clearInterval = originalClear
    }
    expect(intervals).toEqual([])
  })
})

describe("/ps", () => {
  test("lists this session's background work, x stops the selected item, a stops all, esc closes", async () => {
    const h = harness()
    const now = 1_800_000_000_000
    h.setShells([
      { id: "bg1", sessionId: home, command: "bun install && bun run dev", startedAt: now - 70_000, status: "running", kind: "command" },
      { id: "engine:a1", sessionId: home, command: "T3 engine spike", startedAt: now - 120_000, status: "running", kind: "agent" },
      { id: "bg9", sessionId: one, command: "other session job", startedAt: now, status: "running" },
      { id: "bg0", sessionId: home, command: "finished job", startedAt: now, status: "exited" },
    ])
    await h.app.onInput("/ps")
    await h.app.onInput("\r")
    const shown = h.text().join("\n")
    expect(shown).toContain("Background · 2 running")
    expect(shown).toContain("bun install && bun run dev · command · 1m 10s")
    expect(shown).toContain("T3 engine spike · agent · 2m")
    expect(shown).not.toContain("other session job")
    expect(shown).not.toContain("finished job")
    await h.app.onInput("\x1b[B")
    await h.app.onInput("x")
    expect(h.sent.filter((c) => c.type === "background.stop").at(-1)).toMatchObject({ sessionId: home, taskId: "engine:a1" })
    await h.app.onInput("a")
    expect(h.sent.filter((c) => c.type === "background.stop").at(-1)).toEqual({ type: "background.stop", sessionId: home })
    await h.app.onInput("\x1b")
    expect(h.text().join("\n")).not.toContain("Background · ")
  })
})
