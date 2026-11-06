import { afterAll, describe, expect, test } from "bun:test"
import type { CommandReply } from "@mendcode/client"
import type { SessionEvent, SessionSummary } from "@mendcode/protocol"
import { SIDEBAR_GAP, SIDEBAR_WIDTH } from "../src/view/sidebar"
import { textWidth } from "../src/view/wrap"
import { appHarness, cleanTemps, conversation, ids, NOW, plain, tempDir } from "./session-ui-harness"

afterAll(cleanTemps)
const reply = (result: unknown) => ({ ok: true, result }) as CommandReply
const offset = SIDEBAR_WIDTH + SIDEBAR_GAP

function chatApp(width = 180, height = 50, mode: "balanced" | "full" = "balanced", tasks: () => unknown[] = () => []) {
  const current = ids("session")
  const next = ids("session")
  const elsewhere = ids("session")
  const sessions: SessionSummary[] = [
    { sessionId: current, title: "Chrome", directory: "/work/app", createdAt: NOW, updatedAt: NOW - 60_000, lastSeq: 0, state: "idle", queued: 0 },
    { sessionId: next, title: "Client reconnect", directory: "/work/app", createdAt: NOW, updatedAt: NOW - 600_000, lastSeq: 0, state: "generating", queued: 0 },
    { sessionId: elsewhere, title: "Other project", directory: "/other", createdAt: NOW, updatedAt: NOW, lastSeq: 0, state: "waiting_approval", queued: 0 },
  ]
  const h = appHarness({ width, height, mode, sessionId: current, dataDir: tempDir(), directory: "/work/app", reply: (command) => {
    if (command.type === "session.list") return reply({ sessions })
    if (command.type === "models.list") return reply({ engine: "codex", selectable: false, models: [], defaults: { model: "gpt-6-luna" }, effective: { model: "gpt-6-luna", effort: "medium" }, roles: {} })
    if (command.type === "agents.list") return reply({ current: "build", agents: [], problems: [] })
    if (command.type === "background.list") return reply({ tasks: tasks() })
    return undefined
  } })
  h.app.applySettings({})
  const chat = conversation(h.sessionId, (event) => h.app.onEvent(event))
  chat.exchange("Show the layout", "## Answer\n\nKeep **text** and `code` readable.")
  chat.emit({ type: "usage.recorded", turnId: ids("turn"), provider: "codex", model: "gpt-6-luna", input: 24_000, output: 600, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
  return { ...h, next, chat }
}

describe("UI-1 chat chrome", () => {
  test("Tab only completes commands, with a space for arguments; Enter remains explicit", async () => {
    const h = chatApp(100, 30)
    for (const [query, completed] of [["/btw", "/btw "], ["/hel", "/help"], ["/sid", "/sidebar "], ["/new", "/new"]]) {
      h.app.editor.clear()
      const before = h.sent.length
      await h.type(`${query}\t`)
      expect(h.app.editor.text).toBe(completed!)
      expect(h.sent.slice(before).some((command) => ["session.aside", "session.create", "usage.query"].includes(command.type))).toBe(false)
      expect(h.app.page).toBe("chat")
      expect(h.text().join("\n")).not.toContain("usage: /btw")
    }
    h.app.editor.clear()
    await h.type("/help\r")
    expect(h.app.page).toBe("help")
  })

  test("project sessions show current, running and waiting states and refresh on activity", async () => {
    const h = chatApp()
    await Bun.sleep(5)
    h.app.render()
    const sidebar = () => h.text().map((row) => row.slice(0, SIDEBAR_WIDTH)).join("\n")
    // One row each: the current one carries the bar, the running one a spinner frame, ages sit on the right.
    expect(sidebar()).toMatch(/▌ · Chrome +1m │/)
    expect(sidebar()).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏•] Client reconnect +10m │/)
    expect(sidebar()).not.toContain("Other project")
    expect(h.sentOf("session.list")[0]).toMatchObject({ directory: "/work/app", limit: 50 })
    h.app.onGlobal({ type: "session.activity", gseq: 1, at: NOW, sessionId: h.next, directory: "/work/app", title: "Review reconnect", state: "waiting_approval", updatedAt: NOW } as never)
    expect(sidebar()).toContain("? Review reconnect")
    expect(sidebar()).toMatch(/Sessions +\?1 │/)
    h.app.onGlobal({ type: "session.activity", gseq: 2, at: NOW, sessionId: h.next, directory: "/work/app", title: "Review reconnect", state: "idle", queued: 2, updatedAt: NOW } as never)
    expect(sidebar()).toContain("… Review reconnect")
  })

  test("left arrow focuses sessions, arrows select, Enter switches; a click switches too", async () => {
    const h = chatApp()
    await Bun.sleep(5)
    await h.type("\x1b[D\x1b[B\r")
    expect(h.app.sessionId).toBe(h.next)
    expect(h.subscriptions.at(-1)?.sessionId).toBe(h.next)
    const clicked = chatApp()
    await Bun.sleep(5)
    clicked.app.render()
    const row = clicked.text().findIndex((row) => row.slice(0, SIDEBAR_WIDTH).includes("Client reconnect"))
    await clicked.type(`\x1b[<0;5;${row + 1}M`)
    expect(clicked.app.sessionId).toBe(clicked.next)
  })

  test("hover and click show inline context detail; mouse-out restores the bar", async () => {
    for (const width of [100, 180]) {
      const h = chatApp(width)
      await Bun.sleep(5)
      h.app.render()
      const bar = h.text()[0]!
      expect(bar).toContain("15%")
      await h.type(`\x1b[<35;${width - 2};1M`)
      expect(h.text()[0]).toContain("24.6K / 160K")
      expect(textWidth(h.text()[0]!)).toBe(textWidth(bar))
      await h.type("\x1b[<35;1;2M")
      expect(h.text()[0]).toBe(bar)
      await h.type(`\x1b[<0;${width - 2};1M`)
      expect(h.text()[0]).toContain("24.6K / 160K")
      expect(h.app.page).toBe("chat")
      expect(h.sentOf("context.query")).toHaveLength(0)
    }
  })

  test("balanced and full use one footer; zero tokens and missing quotas stay absent", async () => {
    for (const mode of ["balanced", "full"] as const) {
      const h = chatApp(100, 30, mode)
      await Bun.sleep(5)
      h.app.onGlobal({ type: "usage.today", gseq: 1, at: NOW, day: "2026-09-30", tokens: 0, calls: 0 } as never)
      h.app.render()
      // Both views draw the default pack, `clean`: the folder, then the model, the reasoning effort (`showEffort` is on by default) and
      // the context as a filling circle. A quota with no reading and an empty cost say nothing.
      const below = () => h.text().slice(h.text().findLastIndex((row) => /^ *─+ *$/.test(row)) + 1).map((row) => row.trim().replace(/ {2,}/g, "  "))
      expect(below()).toEqual(["/work/app  GPT-6-Luna · medium · ◔ 15%"])
      expect(below().join("\n")).not.toMatch(/ready|today|quota/)
      h.app.onGlobal({ type: "usage.today", gseq: 2, at: NOW, day: "2026-09-30", tokens: 2400, calls: 1 } as never)
      expect(below().join("\n")).not.toContain("today")
    }
  })

  test("command notices show over the prompt, never in the footer, and leave when navigating away", async () => {
    const h = chatApp(100, 30)
    const screen = () => h.text().join("\n")
    await h.type("/diagram\r")
    expect(h.text().at(-1)).not.toContain("no diagram")
    await h.type("/sidebar invalid\r")
    expect(screen()).toContain("usage: /sidebar")
    expect(h.text().at(-1)).not.toContain("usage: /sidebar")
    await h.type("/help\r")
    expect(screen()).not.toContain("usage: /sidebar")
    await h.type("\x1b")
    expect(screen()).not.toContain("usage: /sidebar")
  })

  test("this session's background work shows over the prompt, loads at startup and refreshes; another session's does not", async () => {
    let tasks: unknown[] = [{ id: "bg1", sessionId: ids("session"), command: "bun run dev", cwd: "/work/app", status: "running", startedAt: NOW }]
    const h = chatApp(100, 30, "balanced", () => tasks)
    await Bun.sleep(5)
    h.app.render()
    expect(h.text().join("\n")).not.toContain("bun run dev")
    expect(h.text().at(-1)).not.toContain("job")
    tasks = [{ id: "bg2", sessionId: h.sessionId, command: "bun run watch", cwd: "/work/app", status: "running", startedAt: NOW }]
    h.chat.exchange("Start watching", "Watching")
    await Bun.sleep(5)
    h.app.render()
    expect(h.text().join("\n")).toContain("background command · bun run watch")
    expect(h.text().join("\n")).toContain("/ps")
    tasks = []
    h.app.onGlobal({ type: "session.activity", gseq: 1, at: NOW, sessionId: h.next, directory: "/work/app", title: "Client reconnect", state: "idle", updatedAt: NOW } as never)
    await Bun.sleep(5)
    h.app.render()
    expect(h.text().join("\n")).not.toContain("bun run watch")
  })

  test("home and unpaged sessions never advertise start of session", async () => {
    for (const messages of [0, 1, 40]) {
      const sessionId = ids("session")
      const events: SessionEvent[] = []
      const source = conversation(sessionId, (event) => events.push(event))
      for (let i = 0; i < messages; i++) source.exchange(`question ${i}`, `answer ${i}`)
      const h = appHarness({ width: 100, height: 30, sessionId, events: {
        loadWindow: async () => ({ ok: true, window: { events, firstSeq: events[0]?.seq ?? 0, lastSeq: events.at(-1)?.seq ?? 0, sessionLastSeq: events.at(-1)?.seq ?? 0, more: false } }),
        loadBefore: async () => { throw new Error("no earlier page") },
      } })
      await h.app.start()
      await h.type("\x1b[H")
      expect(h.text().join("\n")).not.toContain("start of session")
    }
  })

  test("frames fit every contracted size and toasts never paint over the sidebar", async () => {
    for (const [width, height] of [[60, 20], [100, 30], [110, 30], [160, 45], [180, 50], [220, 60]]) {
      const h = chatApp(width, height)
      await Bun.sleep(5)
      h.app.render()
      expect(h.frames.at(-1)).toHaveLength(height!)
      for (const row of h.frames.at(-1)!) expect(textWidth(plain(row))).toBeLessThanOrEqual(width!)
      const before = h.text().map((row) => row.slice(0, offset))
      await h.type("/footer invented\r")
      expect(h.text().join("\n")).toContain("unknown footer")
      if (width! >= 110) expect(h.text().map((row) => row.slice(0, offset))).toEqual(before)
      for (const row of h.frames.at(-1)!) expect(textWidth(plain(row))).toBeLessThanOrEqual(width!)
    }
  })
})
