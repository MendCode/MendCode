import { describe, expect, test } from "bun:test"
import { createIdFactory, type SessionEvent } from "@mendcode/protocol"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"
import type { PresentationMode } from "../src/view/transcript"
import { placeholderFor, PLACEHOLDER_EXAMPLES, promptRule, renderStatusRow } from "../src/view/prompt-chrome"
import { createTurnState } from "../src/view/turn-state"
import { formatElapsed, phaseOf, renderWorkingRow, toolPhase } from "../src/view/working-row"
import { textWidth } from "../src/view/wrap"

const ids = createIdFactory()
const NOW = 1_800_000_000_000
const plain = (line: Line) => line.map((span) => span.text).join("")

function harness(options: { mode?: PresentationMode; width?: number; height?: number; now?: () => number; send?: (command: Record<string, unknown>) => unknown; updated?: boolean } = {}) {
  const frames: Line[][] = []
  const sent: Array<Record<string, unknown>> = []
  const screen = { size: { width: options.width ?? 100, height: options.height ?? 30 }, draw: (rows: Line[]) => void frames.push(rows) } as unknown as Parameters<typeof createApp>[0]["screen"]
  const sessionId = ids("session")
  const turnId = ids("turn")
  let exited = false
  const app = createApp({
    sessionId,
    screen,
    directory: "/work/app",
    exit: () => void (exited = true),
    schedule: (fn) => fn(),
    glyphs: glyphs({}),
    now: options.now ?? (() => NOW),
    random: () => 0,
    mode: options.mode ?? "balanced",
    ...(options.updated ? { updated: true } : {}),
    send: (async (command: Record<string, unknown>) => {
      sent.push(command)
      return (await options.send?.(command)) ?? { ok: true }
    }) as never,
  })
  let seq = 0
  const ev = (patch: Record<string, unknown>, at = NOW) => app.onEvent({ sessionId, seq: ++seq, at, ...patch } as SessionEvent)
  const text = () => frames.at(-1)!.map(plain)
  const frame = () => frames.at(-1)!
  return { app, sent, ev, text, frame, turnId, sessionId, exited: () => exited }
}

async function type(app: ReturnType<typeof createApp>, keys: string) {
  for (const key of keys) await app.onKey(key)
}

describe("turn state", () => {
  const sessionId = ids("session")
  const turnId = ids("turn")
  let seq = 0
  const ev = (patch: Record<string, unknown>, at = NOW) => ({ sessionId, seq: ++seq, at, ...patch }) as SessionEvent

  test("tracks the turn start, the running item and the retry; a new item ends the retry", () => {
    const state = createTurnState()
    state.apply(ev({ type: "turn.started", turnId, queueId: ids("queue") }, NOW - 5_000))
    expect(state.startedAt).toBe(NOW - 5_000)
    const item = ids("item")
    state.apply(ev({ type: "item.started", turnId, itemId: item, kind: "tool_call", meta: { tool: "grep: foo" } }))
    expect(state.current).toEqual({ kind: "tool_call", tool: "grep" })
    state.apply(ev({ type: "turn.retrying", turnId, attempt: 1, nextAt: NOW + 3_000, message: "boom" }))
    expect(state.retry).toEqual({ attempt: 1, nextAt: NOW + 3_000, message: "boom" })
    state.apply(ev({ type: "item.delta", itemId: item, text: "x" }))
    expect(state.retry).toBeUndefined()
    state.apply(ev({ type: "item.completed", itemId: item, status: "ok" }))
    expect(state.current).toBeUndefined()
    state.apply(ev({ type: "turn.completed", turnId }))
    expect(state.startedAt).toBeUndefined()
  })

  test("keeps the extra fields of a request until it is resolved", () => {
    const state = createTurnState()
    const requestId = ids("request")
    state.apply(ev({ type: "server.request", requestId, turnId, kind: "question", title: "q", detail: "", options: [{ label: "A", description: "first" }, { label: "B" }], multiple: true }))
    expect(state.extras(requestId)).toEqual({ options: [{ label: "A", description: "first" }, { label: "B" }], multiple: true })
    state.apply(ev({ type: "server.request.resolved", requestId, resolution: "answered" }))
    expect(state.extras(requestId)).toEqual({})
  })

  test("ignores an event it has already seen", () => {
    const state = createTurnState()
    const started = ev({ type: "turn.started", turnId, queueId: ids("queue") }, 1)
    state.apply(started)
    state.apply({ ...started, at: 99 } as SessionEvent)
    expect(state.startedAt).toBe(1)
  })
})

describe("working row", () => {
  test("elapsed time reads like v1", () => {
    expect([0, 999, 12_000, 65_000, 3_725_000].map(formatElapsed)).toEqual(["0s", "0s", "12s", "1m 5s", "1h 2m"])
  })

  test("phase words come from the state, the running item and the tool", () => {
    expect(phaseOf({ state: "generating" })).toBe("Generating...")
    expect(phaseOf({ state: "generating", current: { kind: "reasoning" } })).toBe("Thinking...")
    expect(phaseOf({ state: "compacting" })).toBe("Compacting...")
    expect(phaseOf({ state: "waiting_approval", waiting: "question" })).toBe("Waiting for answer...")
    expect(phaseOf({ state: "waiting_approval", waiting: "approval" })).toBe("Waiting for approval...")
    const tool = (name: string) => phaseOf({ state: "tool", current: { kind: "tool_call", tool: name } })
    expect(["read", "grep", "edit", "apply_patch", "shell", "task", "web_search", "webfetch", "question"].map(tool)).toEqual([
      "Reading...",
      "Searching...",
      "Editing...",
      "Patching...",
      "Running command...",
      "Waiting for subagents...",
      "Browsing...",
      "Browsing...",
      "Waiting for answer...",
    ])
    expect(toolPhase("mcp__x__do")).toBe("Running command...")
  })

  test("a retry shows the countdown in the error color and always keeps it in view", () => {
    const retry = { attempt: 2, nextAt: NOW + 12_000, message: "429 rate limited ".repeat(20) }
    const row = renderWorkingRow({ width: 100, margin: 3, spinner: "⠋", phase: "Generating...", retry, now: NOW })
    expect(plain(row)).toContain("Retrying provider…")
    expect(plain(row)).toEndWith("[retrying in 12s attempt #2]")
    expect(textWidth(plain(row))).toBeLessThanOrEqual(100)
    expect(row.filter((span) => span.text.trim()).every((span) => span.fg === "error")).toBe(true)
    const narrow = renderWorkingRow({ width: 46, margin: 3, spinner: "⠋", phase: "", retry, now: NOW })
    expect(plain(narrow)).toEndWith("[retrying in 12s attempt #2]")
    expect(textWidth(plain(narrow))).toBeLessThanOrEqual(46)
  })

  test("the interrupt hint is drawn in the warning color", () => {
    const row = renderWorkingRow({ width: 80, margin: 3, spinner: "⠋", phase: "Generating...", elapsedMs: 4_000, now: NOW, interruptHint: true })
    expect(plain(row)).toBe("   ⠋ Generating...  4s  [esc again to interrupt]")
    expect(row.at(-1)).toMatchObject({ fg: "warning" })
  })
})

describe("prompt chrome", () => {
  test("rules are straight with a two-cell margin; minimal keeps bare full-width rules", () => {
    const rich = plain(promptRule({ width: 30, glyphs: glyphs({}), color: "primary", rich: true }))
    expect(rich).toBe(`  ${"─".repeat(26)}`)
    expect(rich).not.toMatch(/[╭╮╰╯]/)
    expect(plain(promptRule({ width: 30, glyphs: glyphs({}), color: "primary", rich: false }))).toBe("─".repeat(30))
  })

  test("the placeholder is one of v1's three examples", () => {
    expect(PLACEHOLDER_EXAMPLES).toEqual(["Fix a TODO in the codebase", "What is the tech stack of this project?", "Fix broken tests"])
    expect([0, 0.4, 0.99].map(placeholderFor)).toEqual(PLACEHOLDER_EXAMPLES.map((example) => `Ask anything... "${example}"`))
  })

  test("the status row is v1's: model and effort left, loops right", () => {
    const row = renderStatusRow({ width: 60, model: "gpt-6-luna", effort: "high", loops: 2 })
    expect(plain(row)).toMatch(/^ {3}gpt-6-luna · high +↻ 2 loops$/)
    expect(textWidth(plain(row))).toBe(58)
    expect(row.find((span) => span.text === "high")).toMatchObject({ fg: "warning", bold: true })
  })

  test("a non-default permission leads the row; the default is not named", () => {
    expect(plain(renderStatusRow({ width: 60, model: "m", permission: "ask", permissionLabel: "ask before edits", loops: 0 })).trim()).toBe("m")
    expect(plain(renderStatusRow({ width: 60, model: "m", permission: "full", permissionLabel: "full access", loops: 0 })).trim()).toBe("full access · m")
  })

  test("a notice and a lost connection sit before the loop count and never overflow", () => {
    const row = renderStatusRow({ width: 62, model: "gpt-6-luna", loops: 1, notice: "view: full", connection: "reconnecting" })
    expect(plain(row)).toContain("offline · reconnecting… · view:")
    expect(textWidth(plain(row))).toBeLessThanOrEqual(62)
    expect(textWidth(plain(renderStatusRow({ width: 12, model: "gpt-6-luna-long-name", effort: "high", loops: 3, notice: "x".repeat(40) })))).toBeLessThanOrEqual(12)
  })
})

describe("prompt area in the app", () => {
  test("balanced draws straight rules, the lead glyph, the placeholder on an empty session and v1's row under the prompt", async () => {
    const { app, text } = harness()
    app.applySettings({})
    await Bun.sleep(1)
    app.render()
    const rows = text()
    expect(rows.some((row) => /[╭╮╰╯]/.test(row))).toBe(false)
    // Every framed row is exactly the screen wide: the rule is followed by its 2-cell right margin.
    const rules = rows.flatMap((row, index) => (row.trimEnd() === `  ${"─".repeat(96)}` && row.length === 100 ? [index] : []))
    expect(rules).toHaveLength(2)
    expect(rows[rules[0]! + 1]!.trimEnd()).toBe('  ❭ Ask anything... "Fix a TODO in the codebase"')
    expect(rows.at(-1)!.trim()).toBe("Build")
    expect(rows.some((row) => row.includes("ctrl+v image"))).toBe(false)
  })

  test("the placeholder goes away with the first message and while typing", async () => {
    const { app, text } = harness()
    app.render()
    await type(app, "hi")
    expect(text().some((row) => row.includes("Ask anything"))).toBe(false)
    expect(text().some((row) => row.startsWith("  ❭ hi"))).toBe(true)
  })

  test("the row under the prompt shows the model, effort and live loops; the daemon supplies them", async () => {
    const { app, text } = harness({
      send: (command) =>
        command.type === "models.list"
          ? { ok: true, result: { engine: "codex", selectable: true, models: [], defaults: { model: "m" }, roles: {}, effective: { model: "gpt-6-luna", effort: "high" } } }
          : command.type === "loop.list"
            ? { ok: true, result: { loops: [{ loopId: "l1", directory: "/work/app", state: "active" }, { loopId: "l2", directory: "/work/app", state: "completed" }, { loopId: "l3", directory: "/elsewhere", state: "active" }] } }
            : undefined,
    })
    app.applySettings({})
    await Bun.sleep(5)
    app.render()
    expect(text().at(-1)).toMatch(/^ {3}Build · GPT-6-Luna · codex +↻ 1 loop$/)
  })

  test("minimal keeps bare rules and nothing below the prompt", () => {
    const { app, text } = harness({ mode: "minimal" })
    app.render()
    const rows = text()
    expect(rows.filter((row) => row === "─".repeat(100))).toHaveLength(2)
    expect(rows.at(-1)).toBe("")
    expect(rows.at(-2)).toBe("─".repeat(100))
  })

  test("full keeps one footer row and the working state above the prompt", async () => {
    const { app, text, ev, turnId } = harness({ mode: "full" })
    app.applySettings({})
    ev({ type: "turn.started", turnId, queueId: ids("queue") })
    ev({ type: "foreground.state", state: "generating", turnId })
    app.render()
    const rows = text()
    expect(rows.at(-1)!.trim()).toBe("Build")
    expect(rows.at(-2)!.trim()).toMatch(/^─+$/)
  })

  test("ctrl+c clears the prompt; it exits only when the prompt is empty", async () => {
    const { app, exited } = harness()
    await type(app, "half a thought")
    await app.onKey("\x03")
    expect(app.editor.text).toBe("")
    expect(exited()).toBe(false)
    await app.onKey("\x03")
    expect(exited()).toBe(true)
  })

  test("a busy turn shows the phase word and elapsed time above the prompt, and not below it", () => {
    let now = NOW
    const { app, text, ev, turnId } = harness({ now: () => now })
    ev({ type: "turn.started", turnId, queueId: ids("queue") }, NOW - 65_000)
    ev({ type: "foreground.state", state: "generating", turnId })
    const item = ids("item")
    ev({ type: "item.started", turnId, itemId: item, kind: "tool_call", meta: { tool: "read: src/a.ts" } })
    app.render()
    let rows = text()
    const working = rows.findIndex((row) => /^ {3}\S Reading\.\.\. {2}1m 5s$/.test(row))
    expect(working).toBeGreaterThan(-1)
    expect(rows[working + 1]!.trimEnd()).toBe(`  ${"─".repeat(96)}`)
    now += 3_000
    ev({ type: "item.completed", itemId: item, status: "ok", text: "" })
    ev({ type: "item.started", turnId, itemId: ids("item"), kind: "reasoning" })
    app.render()
    rows = text()
    expect(rows.some((row) => /Thinking\.\.\. {2}1m 8s$/.test(row))).toBe(true)
    ev({ type: "turn.completed", turnId })
    ev({ type: "foreground.state", state: "idle" })
    app.render()
    expect(text().some((row) => row.includes("Thinking..."))).toBe(false)
  })

  test("the first Esc shows [esc again to interrupt] in the working row; the second cancels", async () => {
    let now = NOW
    const { app, text, ev, turnId, sent } = harness({ now: () => now })
    ev({ type: "turn.started", turnId, queueId: ids("queue") })
    ev({ type: "foreground.state", state: "generating", turnId })
    await app.onKey("\x1b")
    expect(text().some((row) => row.includes("Generating...") && row.includes("[esc again to interrupt]"))).toBe(true)
    expect(text().at(-1)).not.toContain("esc again")
    await app.onKey("\x1b")
    expect(sent.find((command) => command.type === "turn.cancel")).toBeDefined()
    expect(text().some((row) => row.includes("[esc again to interrupt]"))).toBe(false)
    now += 1
  })

  test("Esc Esc before the model answered takes the message back: an undo of it, its text in the prompt to fix, no cancel left over", async () => {
    let now = NOW
    const message = ids("item")
    const { app, text, ev, turnId, sent } = harness({
      now: () => now,
      send: (command) => command.type === "session.undo" ? { ok: true, result: { turnIds: [turnId], itemId: message, files: { restored: [], removed: [], skipped: [] }, history: { messages: 1, tracked: true }, shellUntracked: false, notes: [], prompt: { text: "su dale", attachments: [] }, canRedo: true, changes: [] } } : undefined,
    })
    ev({ type: "turn.started", turnId, queueId: ids("queue") })
    ev({ type: "item.started", turnId, itemId: message, kind: "user_message" })
    ev({ type: "item.completed", itemId: message, status: "ok", text: "su dale" })
    ev({ type: "foreground.state", state: "generating", turnId })
    ev({ type: "item.started", turnId, itemId: ids("item"), kind: "reasoning" })
    await app.onKey("\x1b")
    await app.onKey("\x1b")
    expect(sent.find((command) => command.type === "session.undo")).toMatchObject({ atItemId: message, cancelRunning: true })
    expect(sent.some((command) => command.type === "turn.cancel")).toBe(false)
    expect(app.editor.text).toBe("su dale")
    expect(text().some((row) => row.includes("message back in the prompt"))).toBe(true)
    now += 1
  })

  test("Esc Esc after one line of narration still takes the message back", async () => {
    const message = ids("item")
    const { app, ev, turnId, sent } = harness({ send: (command) => command.type === "session.undo" ? { ok: true, result: { turnIds: [turnId], itemId: message, files: { restored: [], removed: [], skipped: [] }, history: { messages: 1, tracked: true }, shellUntracked: false, notes: [], prompt: { text: "si dale", attachments: [] }, canRedo: true, changes: [] } } : undefined })
    ev({ type: "turn.started", turnId, queueId: ids("queue") })
    ev({ type: "item.started", turnId, itemId: message, kind: "user_message" })
    ev({ type: "item.completed", itemId: message, status: "ok", text: "si dale" })
    ev({ type: "foreground.state", state: "generating", turnId })
    const narration = ids("item")
    ev({ type: "item.started", turnId, itemId: narration, kind: "agent_message" })
    ev({ type: "item.completed", itemId: narration, status: "ok", text: "Continúo sobre el mismo árbol. Corrijo primero el orden de autenticación." })
    ev({ type: "item.started", turnId, itemId: ids("item"), kind: "tool_call", meta: { tool: "read" } })
    await app.onKey("\x1b")
    await app.onKey("\x1b")
    expect(sent.find((command) => command.type === "session.undo")).toMatchObject({ atItemId: message })
    expect(sent.some((command) => command.type === "turn.cancel")).toBe(false)
    expect(app.editor.text).toBe("si dale")
  })

  test("Esc Esc after the model began answering cancels as before and leaves the message where it is", async () => {
    const message = ids("item")
    const { app, ev, turnId, sent } = harness()
    ev({ type: "turn.started", turnId, queueId: ids("queue") })
    ev({ type: "item.started", turnId, itemId: message, kind: "user_message" })
    ev({ type: "item.completed", itemId: message, status: "ok", text: "si dale" })
    ev({ type: "foreground.state", state: "generating", turnId })
    const answer = ids("item")
    ev({ type: "item.started", turnId, itemId: answer, kind: "agent_message" })
    ev({ type: "item.delta", itemId: answer, text: "Arranco con la revisión. ".repeat(12) })
    await app.onKey("\x1b")
    await app.onKey("\x1b")
    expect(sent.some((command) => command.type === "turn.cancel")).toBe(true)
    expect(sent.some((command) => command.type === "session.undo")).toBe(false)
  })

  test("a newer build installed under the terminal is said once on the right of the prompt's top rule, taking no row", () => {
    const { app, text } = harness({ width: 100 })
    app.render()
    const before = text()
    expect(before.some((row) => row.includes("Update installed"))).toBe(false)
    app.announceUpdate()
    app.announceUpdate()
    const after = text()
    const rows = after.filter((row) => row.includes("Update installed"))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.trimEnd()).toMatch(/^ {2}─{40,} ✓ Update installed · \/restart to update ─{3}$/)
    expect(rows[0]!.length).toBe(before.find((row) => row.trim().startsWith("─"))!.length)
    // Nothing moves: the rule takes the notice in place, so the pet keeps standing on the prompt.
    expect(after.findIndex((row) => row.includes("Update installed"))).toBe(before.findIndex((row) => /^ {2}─+ *$/.test(row)))
  })

  test("after the restart into a new build the prompt's top rule says so until the first key", async () => {
    const { app, text } = harness({ width: 100, updated: true })
    app.render()
    const rows = text().filter((row) => row.includes("Updated to the new build"))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.trimEnd()).toMatch(/^ {2}─{40,} ✓ Updated to the new build ─{3}$/)
    await app.onInput("a")
    app.render()
    expect(text().some((row) => row.includes("Updated to the new build"))).toBe(false)
  })

  test("a provider retry shows in the working row with a live countdown until the next event", () => {
    let now = NOW
    const { app, text, ev, turnId } = harness({ now: () => now })
    ev({ type: "turn.started", turnId, queueId: ids("queue") })
    ev({ type: "foreground.state", state: "generating", turnId })
    ev({ type: "turn.retrying", turnId, attempt: 2, nextAt: NOW + 12_000, message: "429 rate limited" })
    expect(text().some((row) => row.includes("Retrying provider… 429 rate limited [retrying in 12s attempt #2]"))).toBe(true)
    now += 5_000
    app.render()
    expect(text().some((row) => row.includes("[retrying in 7s attempt #2]"))).toBe(true)
    ev({ type: "item.started", turnId, itemId: ids("item"), kind: "agent_message" })
    expect(text().some((row) => row.includes("Retrying provider"))).toBe(false)
  })

  test("a network outage shows as offline with how long it has lasted, not as a provider error", () => {
    let now = NOW
    const { app, text, ev, turnId } = harness({ now: () => now })
    ev({ type: "turn.started", turnId, queueId: ids("queue") })
    ev({ type: "foreground.state", state: "generating", turnId })
    ev({ type: "turn.retrying", turnId, attempt: 9, nextAt: NOW + 30_000, message: "ECONNRESET", offlineSince: NOW - 125_000 })
    expect(text().some((row) => row.includes("Offline · waiting for network · 2m 5s  [retrying in 30s]"))).toBe(true)
    expect(text().some((row) => row.includes("Retrying provider"))).toBe(false)
    now += 10_000
    app.render()
    expect(text().some((row) => row.includes("2m 15s  [retrying in 20s]"))).toBe(true)
  })

  test("minimal says the model is working, reports a retry above the prompt and nothing below", () => {
    const { app, text, ev, turnId } = harness({ mode: "minimal" })
    app.render()
    expect(text().some((row) => row.includes("Generating..."))).toBe(false)
    ev({ type: "turn.started", turnId, queueId: ids("queue") })
    ev({ type: "foreground.state", state: "generating", turnId })
    app.render()
    expect(text().some((row) => row.includes("Generating..."))).toBe(true)
    ev({ type: "turn.retrying", turnId, attempt: 1, nextAt: NOW + 4_000, message: "overloaded" })
    expect(text().some((row) => row.includes("[retrying in 4s attempt #1]"))).toBe(true)
    expect(text().at(-1)).toBe("")
  })
})

describe("home and end", () => {
  function scrolled() {
    const h = harness({ height: 20 })
    for (let i = 0; i < 40; i++) {
      const itemId = ids("item")
      h.ev({ type: "item.started", turnId: h.turnId, itemId, kind: "agent_message" })
      h.ev({ type: "item.completed", itemId, status: "ok", text: `message ${i}` })
    }
    h.app.render()
    return h
  }

  test("Home scrolls to the top, End back to the bottom, and a cue shows while not following", async () => {
    const { app, text } = scrolled()
    expect(text().some((row) => row.includes("message 39"))).toBe(true)
    expect(text().some((row) => row.includes("↓ latest"))).toBe(false)
    await app.onKey("\x1b[H")
    expect(text().some((row) => row.includes("message 0"))).toBe(true)
    expect(text().some((row) => row.includes("message 39"))).toBe(false)
    const cue = text().findLast((row) => row.includes("↓ latest · End"))
    expect(cue).toBeDefined()
    expect(cue!.trimEnd()).toEndWith("↓ latest · End")
    expect(text().findIndex((row) => row.includes("↓ latest"))).toBe(text().findIndex((row) => row.includes("─")) - 1)
    await app.onKey("\x1b[F")
    expect(text().some((row) => row.includes("message 39"))).toBe(true)
    expect(text().some((row) => row.includes("↓ latest"))).toBe(false)
  })

  test("with text in the prompt Home and End move the cursor instead", async () => {
    const { app, text } = scrolled()
    await type(app, "abc")
    await app.onKey("\x1b[H")
    expect(app.editor.cursor.col).toBe(0)
    expect(text().some((row) => row.includes("message 39"))).toBe(true)
  })
})

describe("slash popup keys", () => {
  test("Enter runs the highlighted command; Tab completes text", async () => {
    const { app, text } = harness()
    await type(app, "/hel")
    expect(text().some((row) => row.includes("┃") && row.includes("/help"))).toBe(true)
    await app.onKey("\r")
    expect(app.page).toBe("help")
    await app.onKey("\x1b")
    await type(app, "/hel")
    await app.onKey("\t")
    expect(app.page).toBe("chat")
    expect(app.editor.text).toBe("/help")
  })

  test("a command that takes arguments is inserted instead of run", async () => {
    const { app } = harness()
    await type(app, "/rem")
    await app.onKey("\t")
    expect(app.editor.text).toBe("/remember ")
  })

  test("a fully typed command is submitted as typed", async () => {
    const { app, sent } = harness()
    await type(app, "/new")
    await app.onKey("\r")
    expect(sent.some((command) => command.type === "session.create")).toBe(true)
  })

  test("the search popup shows ten rows and follows the selection", async () => {
    const { app, text } = harness({ height: 40 })
    await type(app, "/s")
    expect(text().filter((row) => row.includes("┃"))).toHaveLength(10)
    for (let i = 0; i < 12; i++) await app.onKey("\x1b[B")
    expect(text().filter((row) => row.includes("┃"))).toHaveLength(10)
  })
})

describe("questions", () => {
  function ask(multiple = false) {
    const h = harness({ height: 40 })
    const requestId = ids("request")
    h.ev({ type: "turn.started", turnId: h.turnId, queueId: ids("queue") })
    h.ev({ type: "foreground.state", state: "waiting_approval", turnId: h.turnId })
    h.ev({
      type: "server.request",
      requestId,
      turnId: h.turnId,
      kind: "question",
      title: "Which one?",
      detail: "",
      options: [{ label: "Alpha", description: "the first" }, { label: "Beta" }, { label: "Gamma", description: "the third" }],
      ...(multiple ? { multiple: true } : {}),
    })
    return { ...h, requestId }
  }
  const answers = (sent: Array<Record<string, unknown>>) => sent.filter((command) => command.type === "request.resolve").map((command) => command.decision)

  test("the card takes the prompt's place: the question, numbered options with their descriptions, a row to type your own, the keys", () => {
    const { text } = ask()
    const rows = text().map((row) => row.replace(/^ {2}┃/, ""))
    expect(rows.some((row) => row.trim() === "Which one?")).toBe(true)
    expect(rows.some((row) => row.trim() === "› 1. Alpha")).toBe(true)
    expect(rows.some((row) => row.trim() === "the first")).toBe(true)
    expect(rows.some((row) => row.trim() === "4. Type your own answer")).toBe(true)
    expect(rows.some((row) => row.trim() === "↑↓ select · enter confirm · esc dismiss")).toBe(true)
    // No "waiting" header, no working row saying the same, and no second input under the card.
    expect(rows.some((row) => /waiting for answer/i.test(row))).toBe(false)
    expect(rows.some((row) => row.includes("❭"))).toBe(false)
  })

  test("a digit answers a single-choice question with the label", async () => {
    const { app, sent } = ask()
    await app.onKey("2")
    expect(answers(sent)).toEqual([{ kind: "answer", text: "Beta" }])
  })

  test("arrows move and Enter sends the highlighted label", async () => {
    const { app, sent } = ask()
    await app.onKey("\x1b[B")
    await app.onKey("\x1b[B")
    await app.onKey("\r")
    expect(answers(sent)).toEqual([{ kind: "answer", text: "Gamma" }])
  })

  test("a multi-select ticks with digits or space and Enter sends the labels joined with a comma", async () => {
    const { app, sent, text } = ask(true)
    expect(text().some((row) => row.includes("(select all that apply)"))).toBe(true)
    await app.onKey("3")
    await app.onKey("\x1b[A")
    await app.onKey("\x1b[A")
    await app.onKey(" ")
    expect(text().some((row) => row.includes("[✓] Alpha"))).toBe(true)
    expect(text().some((row) => row.includes("[ ] Beta"))).toBe(true)
    await app.onKey("\r")
    expect(answers(sent)).toEqual([{ kind: "answer", text: "Alpha, Gamma" }])
  })

  test("typing goes to the answer, and digits are text while something is typed", async () => {
    const { app, sent } = ask()
    await type(app, "my 2 cents")
    await app.onKey("\r")
    expect(answers(sent)).toEqual([{ kind: "answer", text: "my 2 cents" }])
  })

  test("Esc dismisses the question", async () => {
    const { app, sent } = ask()
    await app.onKey("\x1b")
    expect(answers(sent)).toEqual([{ kind: "deny" }])
  })

  test("a click on an option picks it", async () => {
    const { app, sent, text } = ask()
    const row = text().findIndex((line) => line.includes("2. Beta"))
    await app.onKey(`\x1b[<0;10;${row + 1}M`)
    expect(answers(sent)).toEqual([{ kind: "answer", text: "Beta" }])
  })
})

describe("approvals and the queue", () => {
  test("an approval shows the permission's icon and a click on an option resolves it", async () => {
    const h = harness({ height: 40 })
    h.ev({ type: "turn.started", turnId: h.turnId, queueId: ids("queue") })
    h.ev({ type: "foreground.state", state: "waiting_approval", turnId: h.turnId })
    h.ev({ type: "server.request", requestId: ids("request"), turnId: h.turnId, kind: "approval", title: "Run command", detail: "bun test", tool: "shell", permission: "execute" })
    expect(h.text().some((row) => row.includes("┃ # Allow Run command?"))).toBe(true)
    const row = h.text().findIndex((line) => line.includes("Allow for this session"))
    await h.app.onKey(`\x1b[<0;12;${row + 1}M`)
    expect(h.sent.at(-1)).toMatchObject({ type: "request.resolve", decision: { kind: "approve", scope: "session" } })
  })

  test("a queued message has a QUEUED chip, and the next one a SEND chip that promotes it", async () => {
    const h = harness({ height: 40 })
    h.ev({ type: "turn.started", turnId: h.turnId, queueId: ids("queue") })
    h.ev({ type: "foreground.state", state: "generating", turnId: h.turnId })
    const first = ids("queue")
    h.ev({ type: "queue.changed", queue: [{ queueId: first, preview: "one", attachments: 0 }, { queueId: ids("queue"), preview: "two", attachments: 0 }] })
    const rows = h.text()
    const at = rows.findIndex((row) => row.includes("… one"))
    expect(rows[at]).toContain("↗ SEND")
    expect(rows[at]).toContain("QUEUED")
    expect(rows[at + 1]).toContain("QUEUED")
    expect(rows[at + 1]).not.toContain("SEND")
    const col = rows[at]!.indexOf("SEND")
    await h.app.onKey(`\x1b[<0;${col + 1};${at + 1}M`)
    expect(h.sent.at(-1)).toMatchObject({ type: "queue.promote", queueId: first })
    await h.app.onKey(`\x1b[<0;3;${at + 1}M`)
    expect(h.sent.filter((command) => command.type === "queue.promote")).toHaveLength(1)
  })
})

describe("shell mode", () => {
  const rule = (rows: string[]) => rows.findIndex((row) => row.trimEnd() === `  ${"─".repeat(96)}`)

  test("! as the first character switches modes and is consumed; the row says Shell and how to leave", async () => {
    const { app, text } = harness()
    app.applySettings({})
    await app.onKey("!")
    expect(app.editor.text).toBe("")
    const rows = text()
    expect(rows[rule(rows) + 1]!.trimEnd()).toBe('  ❭ Run a command... "ls -la"')
    expect(rows.at(-1)).toMatch(/^ {3}Shell +esc exit shell mode$/)
    expect(rows.at(-1)).not.toContain("↻")
  })

  test("! in the middle of a prompt is text, and autocomplete is off in shell mode", async () => {
    const { app, text } = harness()
    await type(app, "hi!")
    expect(app.editor.text).toBe("hi!")
    app.editor.clear()
    await app.onKey("!")
    await type(app, "/he")
    expect(text().some((row) => row.includes("┃"))).toBe(false)
  })

  test("Esc, and Backspace on an empty prompt, leave shell mode", async () => {
    const { app, text } = harness()
    await app.onKey("!")
    await app.onKey("\x1b")
    expect(text().some((row) => row.includes("esc exit shell mode"))).toBe(false)
    await app.onKey("!")
    await app.onKey("\x7f")
    expect(text().some((row) => row.includes("esc exit shell mode"))).toBe(false)
    await app.onKey("!")
    await type(app, "ls")
    await app.onKey("\x7f")
    expect(text().some((row) => row.includes("esc exit shell mode"))).toBe(true)
  })

  test("submitting sends user.shell, not user.submit, and returns to the normal prompt", async () => {
    const { app, sent, sessionId, text } = harness()
    await app.onKey("!")
    await type(app, "git status")
    await app.onKey("\r")
    expect(sent.filter((command) => command.type === "user.submit")).toEqual([])
    expect(sent.find((command) => command.type === "user.shell")).toEqual({ type: "user.shell", sessionId, command: "git status" })
    expect(app.editor.text).toBe("")
    expect(text().some((row) => row.includes("esc exit shell mode"))).toBe(false)
  })

  test("!!cmd sends user.shell with local: true and the command without its second bang", async () => {
    const { app, sent, sessionId } = harness()
    await app.onKey("!")
    await type(app, "!git status")
    await app.onKey("\r")
    expect(sent.filter((command) => command.type === "user.submit")).toEqual([])
    expect(sent.find((command) => command.type === "user.shell")).toEqual({ type: "user.shell", sessionId, command: "git status", local: true })
    expect(app.editor.text).toBe("")
  })

  test("a lone second bang sends nothing", async () => {
    const { app, sent } = harness()
    await app.onKey("!")
    await type(app, "!")
    await app.onKey("\r")
    expect(sent.find((command) => command.type === "user.shell")).toBeUndefined()
  })

  test("an engine without shell mode reports invalid_command as a notice and keeps the command", async () => {
    const { app, text } = harness({ send: (command) => (command.type === "user.shell" ? { ok: false, error: { code: "invalid_command", message: "[ACTOR]: this engine cannot run shell commands" } } : undefined) })
    await app.onKey("!")
    await type(app, "ls")
    await app.onKey("\r")
    expect(app.editor.text).toBe("ls")
    expect(text().join("\n")).toContain("this engine cannot run shell commands")
    expect(text().at(-1)).toContain("Shell")
  })

  test("a queued !command reads $ <command> in the queue rows", () => {
    const h = harness({ height: 40 })
    h.ev({ type: "turn.started", turnId: h.turnId, queueId: ids("queue") })
    h.ev({ type: "foreground.state", state: "generating", turnId: h.turnId })
    const shellId = ids("queue")
    h.ev({ type: "queue.added", queueId: shellId, text: "bun test", attachments: [], shell: true })
    h.ev({ type: "queue.changed", queue: [{ queueId: shellId, preview: "bun test", attachments: 0 }, { queueId: ids("queue"), preview: "then explain", attachments: 0 }] })
    const rows = h.text()
    expect(rows.some((row) => row.includes("… $ bun test"))).toBe(true)
    expect(rows.some((row) => row.includes("… then explain"))).toBe(true)
  })

  test("minimal marks shell mode with a ! lead and still draws nothing below", async () => {
    const { app, text } = harness({ mode: "minimal" })
    await app.onKey("!")
    await type(app, "pwd")
    expect(text().some((row) => row === "! pwd")).toBe(true)
    expect(text().at(-1)).toBe("")
  })
})

describe("script status line", () => {
  const line = (patch: Record<string, unknown> = {}) => ({ type: "status.line", gseq: 1, at: NOW, directory: "/work/app", left: [], right: [], problems: [], ...patch }) as never

  test("the app asks the daemon to watch its directory on start and again after a reconnect", async () => {
    const { app, sent } = harness()
    app.applySettings({})
    expect(sent.filter((command) => command.type === "status.watch")).toEqual([{ type: "status.watch", directory: "/work/app", watching: true }])
    app.onConnection("reconnecting")
    app.onConnection("connected")
    expect(sent.filter((command) => command.type === "status.watch")).toHaveLength(2)
  })

  test("left segments follow the built-in items, right segments end the row, each in its own color", async () => {
    const h = harness({
      send: (command) => (command.type === "models.list" ? { ok: true, result: { engine: "codex", selectable: true, models: [], defaults: { model: "m" }, roles: {}, effective: { model: "gpt-6-luna", effort: "high" } } } : undefined),
    })
    h.app.applySettings({})
    await Bun.sleep(5)
    h.app.onGlobal(line({ left: [{ text: "main", fg: "#22c55e", bold: true }, { text: "3 changed" }], right: [{ text: "12:04", fg: "#38bdf8" }] }))
    const row = h.text().at(-1)!
    expect(row).toMatch(/^ {3}Build · GPT-6-Luna · codex · main · 3 changed +12:04$/)
    const spans = h.frame().at(-1)!
    expect(spans.find((span) => span.text === "main")).toMatchObject({ fgHex: "#22c55e", bold: true })
    expect(spans.find((span) => span.text === "3 changed")).toMatchObject({ fg: "muted" })
    expect(spans.find((span) => span.text === "12:04")).toMatchObject({ fgHex: "#38bdf8" })
  })

  test("a line for another directory is ignored, and minimal draws nothing", () => {
    const h = harness()
    h.app.onGlobal(line({ directory: "/elsewhere", left: [{ text: "nope" }] }))
    h.app.render()
    expect(h.text().some((row) => row.includes("nope"))).toBe(false)
    const minimal = harness({ mode: "minimal" })
    minimal.app.onGlobal(line({ left: [{ text: "hidden" }] }))
    minimal.app.render()
    expect(minimal.text().some((row) => row.includes("hidden"))).toBe(false)
  })

  test("the first problem shows once as a notice", () => {
    const h = harness()
    h.app.onGlobal(line({ problems: ["statusline.json: command exited 2"] }))
    expect(h.text().join("\n")).toContain("statusline.json: command exited 2")
    h.app.onGlobal(line({ problems: ["statusline.json: command exited 2"] }))
    expect(h.text().join("\n").match(/exited 2/g)).toHaveLength(1)
  })
})
