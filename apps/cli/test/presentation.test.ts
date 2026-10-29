import { describe, expect, test } from "bun:test"
import { createIdFactory, type SessionEvent } from "@mendcode/protocol"
import { createTranscript, type PresentationMode } from "../src/view/transcript"
import { glyphs } from "../src/ui/theme"
import { createApp } from "../src/ui/app"
import type { Line } from "../src/ui/theme"

const ids = createIdFactory()
const sessionId = ids("session")
const turnId = ids("turn")

function turnWithTools(options: { failSecond?: boolean } = {}) {
  let seq = 0
  const ev = (e: Record<string, unknown>) => ({ sessionId, seq: ++seq, at: 0, ...e }) as SessionEvent
  const events: SessionEvent[] = [ev({ type: "turn.started", turnId, queueId: ids("queue") })]
  const reasoning = ids("item")
  events.push(ev({ type: "item.started", turnId, itemId: reasoning, kind: "reasoning" }))
  events.push(ev({ type: "item.delta", itemId: reasoning, text: "plan the change\ncheck the tests" }))
  events.push(ev({ type: "item.completed", itemId: reasoning, status: "ok" }))
  const tools = ["ls", "cat a.ts", "bun test"]
  tools.forEach((title, i) => {
    const itemId = ids("item")
    events.push(ev({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: title } }))
    events.push(ev({ type: "item.delta", itemId, text: `${title} output\n` }))
    events.push(ev({ type: "item.completed", itemId, status: options.failSecond && i === 1 ? "error" : "ok" }))
  })
  const message = ids("item")
  events.push(ev({ type: "item.started", turnId, itemId: message, kind: "agent_message" }))
  events.push(ev({ type: "item.completed", itemId: message, status: "ok", text: "Done." }))
  return events
}

function render(mode: PresentationMode, events = turnWithTools()) {
  const t = createTranscript({ appearance: { messageLayout: "classic", messageMeta: "full", assistantLead: "", toolDensity: "dense" }, glyphs: glyphs({}), mode })
  for (const event of events) t.apply(event)
  return t.viewport(60, 100).map((l) => l.text).filter(Boolean)
}

describe("presentation modes", () => {
  test("minimal keeps reasoning to one line and folds a run of successful tools into one line", () => {
    expect(render("minimal")).toEqual(["  Thought: plan the change", "◆ 3 tools · bun test ✓", "  Done."])
  })

  test("minimal still shows a failed tool on its own line", () => {
    const lines = render("minimal", turnWithTools({ failSecond: true }))
    expect(lines.some((l) => l.includes("cat a.ts") && l.includes("error"))).toBe(true)
    expect(lines.some((l) => l.includes("bun test"))).toBe(true)
  })

  test("balanced shows every tool card collapsed and the thought with its title and a railed body", () => {
    const lines = render("balanced")
    // One card per tool: "ls" gets the list glyph, the other two the generic one.
    expect(lines.filter((l) => /^ {5}[▦◆] /.test(l))).toHaveLength(3)
    expect(lines).toContain("    ┃ Thought: plan the change")
    expect(lines).toContain("    ┃ check the tests")
    expect(lines.some((l) => l.includes("cat a.ts output"))).toBe(false)
  })

  test("a web search card shows what it searched; a read says its lines and a list its entries in singular or plural", () => {
    let seq = 0
    const ev = (e: Record<string, unknown>) => ({ sessionId, seq: ++seq, at: 0, ...e }) as SessionEvent
    const card = (tool: string, text: string) => {
      const itemId = ids("item")
      return [ev({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool } }), ev({ type: "item.completed", itemId, status: "ok", text })]
    }
    const events = [ev({ type: "turn.started", turnId, queueId: ids("queue") }), ...card("web_search", "bun latest · bun release notes 2026"), ...card("read: a.ts", "one"), ...card("ls", "a\nb")]
    const lines = render("balanced", events)
    expect(lines).toContain("     ⌁ Web search bun latest · bun release notes 2026")
    expect(lines).toContain("     ▤ Read a.ts  1 line")
    expect(lines).toContain("     ▦ List .  2 entries")
    expect(lines).toContain("     │ a  b")
    const narrow = createTranscript({ appearance: { messageLayout: "classic", messageMeta: "full", assistantLead: "" }, glyphs: glyphs({}), mode: "balanced" })
    for (const event of events) narrow.apply(event)
    const searchLine = narrow.viewport(30, 100).map((l) => l.text).find((l) => l.includes("Web search"))!
    expect(searchLine.endsWith("…")).toBe(true)
    expect(searchLine.length).toBeLessThanOrEqual(30)
  })

  test("a background notice shows as one muted line, with the output tail only in full view", () => {
    let seq = 0
    const ev = (e: Record<string, unknown>) => ({ sessionId, seq: ++seq, at: 0, ...e }) as SessionEvent
    const itemId = ids("item")
    const events = [
      ev({ type: "turn.started", turnId, queueId: ids("queue") }),
      ev({ type: "item.started", turnId, itemId, kind: "user_message", meta: { notice: true } }),
      ev({ type: "item.completed", itemId, status: "ok", text: "[background task bg_1 exited 0 after 3s: bun run build]\nlast output:\nbuilt ok" }),
    ]
    const balanced = render("balanced", events)
    expect(balanced).toEqual(["  ◆ [background task bg_1 exited 0 after 3s: bun run build]"])
    const full = render("full", events)
    expect(full).toContain("    built ok")
    const plain = createTranscript({ appearance: { messageLayout: "classic", messageMeta: "full", assistantLead: "" }, glyphs: glyphs({}), mode: "balanced" })
    for (const event of events) plain.apply(event)
    const spans = plain.viewport(60, 10).find((l) => l.text.includes("bg_1"))!.spans
    expect(spans.some((s) => s.bold)).toBe(false)
  })

  test("a background notice read inside a running turn shows where it was delivered and leaves the queue box", () => {
    let seq = 0
    const ev = (e: Record<string, unknown>) => ({ sessionId, seq: ++seq, at: 0, ...e }) as SessionEvent
    const [tool, notice, answer, queueId] = [ids("item"), ids("item"), ids("item"), ids("queue")]
    const t = createTranscript({ appearance: { messageLayout: "classic", messageMeta: "full", assistantLead: "", toolDensity: "dense" }, glyphs: glyphs({}), mode: "balanced" })
    const lines = () => t.viewport(70, 100).map((l) => l.text).filter(Boolean)
    for (const event of [
      ev({ type: "turn.started", turnId, queueId: ids("queue") }),
      ev({ type: "item.started", turnId, itemId: tool, kind: "tool_call", meta: { tool: "bun test" } }),
      // The task ends while the tool runs: the notice waits for the turn's next boundary, marked as joining it.
      ev({ type: "queue.changed", queue: [{ queueId, preview: "[background task bg_1 exited 0 after 3s: bun run build]", attachments: 0, kind: "notice", delivery: "steer" }] }),
    ]) t.apply(event)
    expect(t.queue).toMatchObject([{ queueId, notice: true, delivery: "steer" }])
    expect(lines().some((l) => l.includes("bg_1"))).toBe(false)
    for (const event of [
      ev({ type: "item.completed", itemId: tool, status: "ok" }),
      ev({ type: "item.started", turnId, itemId: notice, kind: "user_message", meta: { notice: true } }),
      ev({ type: "item.completed", itemId: notice, status: "ok", text: "[background task bg_1 exited 0 after 3s: bun run build]\nlast output:\nbuilt ok" }),
      ev({ type: "queue.changed", queue: [] }),
      ev({ type: "item.started", turnId, itemId: answer, kind: "agent_message" }),
      ev({ type: "item.completed", itemId: answer, status: "ok", text: "The build passed." }),
    ]) t.apply(event)
    expect(t.queue).toEqual([])
    const shown = lines()
    const at = shown.findIndex((l) => l.includes("[background task bg_1 exited 0 after 3s: bun run build]"))
    expect(shown[at]).toBe("  ◆ [background task bg_1 exited 0 after 3s: bun run build]")
    expect(shown.findIndex((l) => l.includes("bun test"))).toBeLessThan(at)
    expect(shown.findIndex((l) => l.includes("The build passed."))).toBeGreaterThan(at)
    expect(shown.filter((l) => l.includes("bg_1"))).toHaveLength(1)
  })

  test("full expands tool output and shows the reasoning text", () => {
    const lines = render("full")
    expect(lines.some((l) => l.includes("ls output"))).toBe(true)
    expect(lines.some((l) => l.includes("plan the change"))).toBe(true)
  })

  test("full reasoning is bounded and says how much was left out", () => {
    let seq = 0
    const ev = (e: Record<string, unknown>) => ({ sessionId, seq: ++seq, at: 0, ...e }) as SessionEvent
    const itemId = ids("item")
    const text = Array.from({ length: 100 }, (_, i) => `step ${i}`).join("\n\n")
    const lines = render("full", [
      ev({ type: "turn.started", turnId, queueId: ids("queue") }),
      ev({ type: "item.started", turnId, itemId, kind: "reasoning" }),
      ev({ type: "item.delta", itemId, text }),
      ev({ type: "item.completed", itemId, status: "ok" }),
    ])
    // A title line (the first step), then at most 40 body rows whose first says how many were left out.
    expect(lines.length).toBe(41)
    expect(lines[0]).toContain("Thought: step 0")
    expect(lines[1]).toMatch(/… \d+ earlier lines/)
    expect(lines.at(-1)).toContain("step 99")
  })

  test("switching mode re-renders the same events without refetching", () => {
    const t = createTranscript({ appearance: { messageLayout: "classic", messageMeta: "full", assistantLead: "", toolDensity: "dense" }, glyphs: glyphs({}), mode: "balanced" })
    for (const event of turnWithTools()) t.apply(event)
    t.setMode("minimal")
    expect(t.viewport(60, 40).map((l) => l.text).filter(Boolean)).toEqual(["  Thought: plan the change", "◆ 3 tools · bun test ✓", "  Done."])
    t.setMode("full")
    expect(t.viewport(60, 40).some((l) => l.text.includes("ls output"))).toBe(true)
  })
})

describe("app input", () => {
  function harness() {
    const frames: Line[][] = []
    const screen = { size: { width: 60, height: 12 }, draw: (rows: Line[]) => void frames.push(rows) } as unknown as Parameters<typeof createApp>[0]["screen"]
    const app = createApp({ sessionId, screen, send: async () => ({ ok: true }), exit() {}, schedule: (fn) => fn(), glyphs: glyphs({}) })
    let seq = 0
    const ev = (e: Record<string, unknown>) => ({ sessionId, seq: ++seq, at: 0, ...e }) as SessionEvent
    app.onEvent(ev({ type: "turn.started", turnId, queueId: ids("queue") }))
    for (let i = 0; i < 30; i++) {
      const itemId = ids("item")
      app.onEvent(ev({ type: "item.started", turnId, itemId, kind: "agent_message" }))
      app.onEvent(ev({ type: "item.completed", itemId, status: "ok", text: `message ${i}` }))
    }
    const text = () => frames.at(-1)!.map((row) => row.map((s) => s.text).join(""))
    return { app, text }
  }

  test("mouse wheel scrolls the transcript and mouse clicks are never typed into the prompt", async () => {
    const { app, text } = harness()
    expect(text().some((l) => l.includes("message 29"))).toBe(true)
    await app.onInput("\x1b[<64;10;5M\x1b[<64;10;5M")
    expect(text().some((l) => l.includes("message 29"))).toBe(false)
    await app.onInput("\x1b[<65;10;5M\x1b[<65;10;5M")
    expect(text().some((l) => l.includes("message 29"))).toBe(true)
    await app.onInput("\x1b[<0;10;5M\x1b[<0;10;5m")
    expect(app.editor.isEmpty()).toBe(true)
  })

  test("shift+tab and /permissions request a permission mode; the footer follows the daemon's event", async () => {
    const sent: Array<Record<string, unknown>> = []
    const frames: Line[][] = []
    const screen = { size: { width: 80, height: 10 }, draw: (rows: Line[]) => void frames.push(rows) } as unknown as Parameters<typeof createApp>[0]["screen"]
    const app = createApp({ sessionId, screen, send: async (c) => (sent.push(c as Record<string, unknown>), { ok: true }), exit() {}, schedule: (fn) => fn(), glyphs: glyphs({}) })
    await app.onInput("\x1b[Z")
    expect(sent.at(-1)).toMatchObject({ type: "session.permission.set", mode: "edits" })
    await app.onInput("/permissions full\r")
    expect(sent.at(-1)).toMatchObject({ type: "session.permission.set", mode: "full" })
    app.onEvent({ sessionId, seq: 1, at: 0, type: "session.permission", mode: "full" } as SessionEvent)
    expect(frames.at(-1)!.at(-1)!.map((s) => s.text).join("")).toContain("full access")
  })

  test("↑ recalls this project's prompts newest first, ↓ returns to the unsent draft", async () => {
    const sent: Array<Record<string, unknown>> = []
    const screen = { size: { width: 80, height: 10 }, draw() {} } as unknown as Parameters<typeof createApp>[0]["screen"]
    const send = async (c: Record<string, unknown>) => {
      sent.push(c)
      return c.type === "prompt.history" ? { ok: true as const, result: { prompts: ["second", "first"] } } : { ok: true as const }
    }
    const app = createApp({ sessionId, screen, send: send as never, exit() {}, schedule: (fn) => fn(), glyphs: glyphs({}), directory: "/repo" })
    await app.onInput("draft")
    await app.onInput("\x1b[A")
    expect(sent.find((c) => c.type === "prompt.history")).toMatchObject({ directory: "/repo" })
    expect(app.editor.text).toBe("second")
    await app.onInput("\x1b[A")
    expect(app.editor.text).toBe("first")
    await app.onInput("\x1b[A")
    expect(app.editor.text).toBe("first")
    await app.onInput("\x1b[B\x1b[B")
    expect(app.editor.text).toBe("draft")
    app.editor.clear()
    await app.onInput("third\r")
    await app.onInput("\x1b[A")
    expect(app.editor.text).toBe("third")
    expect(sent.filter((c) => c.type === "prompt.history")).toHaveLength(1)
  })

  test("ctrl+s promotes the first queued message and ctrl+k on an empty prompt drops the last one", async () => {
    const sent: Array<Record<string, unknown>> = []
    const screen = { size: { width: 80, height: 12 }, draw() {} } as unknown as Parameters<typeof createApp>[0]["screen"]
    const app = createApp({ sessionId, screen, send: async (c) => (sent.push(c as Record<string, unknown>), { ok: true }), exit() {}, schedule: (fn) => fn(), glyphs: glyphs({}) })
    const first = ids("queue")
    const last = ids("queue")
    app.onEvent({ sessionId, seq: 1, at: 0, type: "queue.changed", queue: [{ queueId: first, preview: "a", attachments: 0 }, { queueId: last, preview: "b", attachments: 0 }] } as SessionEvent)
    await app.onInput("\x13")
    expect(sent.at(-1)).toMatchObject({ type: "queue.promote", queueId: first })
    await app.onInput("x\x0b")
    expect(sent.filter((c) => c.type === "queue.remove")).toHaveLength(0)
    app.editor.clear()
    await app.onInput("\x0b")
    expect(sent.at(-1)).toMatchObject({ type: "queue.remove", queueId: last })
  })

  test("/view cycles and /view <mode> sets the presentation mode", async () => {
    const { app } = harness()
    await app.onInput("/view\r")
    expect(app.transcript.mode).toBe("full")
    await app.onInput("/view minimal\r")
    expect(app.transcript.mode).toBe("minimal")
    await app.onInput("/view nope\r")
    expect(app.transcript.mode).toBe("minimal")
  })
})
