import { describe, expect, test } from "bun:test"
import { createIdFactory, type BlobRef, type SessionEvent, type TurnId } from "@mendcode/protocol"
import { glyphs, sgr } from "../src/ui/theme"
import { defineTheme, mix } from "../src/themes/define"
import { highlight } from "../src/view/syntax"
import { formatDuration, formatElapsed, todayTimeOrDateTime } from "../src/view/time"
import { parsePatch, renderToolCard } from "../src/view/tool-card"
import { createTranscript, type PresentationMode } from "../src/view/transcript"
import { createTurnState } from "../src/view/turn-state"
import { phaseOf, renderWorkingRow } from "../src/view/working-row"
import { budgetMs } from "../../../scripts/test-budget"

const ids = createIdFactory()
const sessionId = ids("session")
const NOW = new Date(2026, 8, 28, 15, 50).getTime()

function stream() {
  let seq = 0
  let clock = NOW - 60_000
  const events: SessionEvent[] = []
  const emit = (event: Record<string, unknown>, advance = 100) => {
    clock += advance
    events.push({ sessionId, seq: ++seq, at: clock, ...event } as SessionEvent)
  }
  const item = (turnId: TurnId, kind: string, options: { meta?: Record<string, string>; text?: string; deltas?: string[]; status?: string; attachments?: BlobRef[]; advance?: number } = {}) => {
    const itemId = ids("item")
    emit({ type: "item.started", turnId, itemId, kind, ...(options.meta ? { meta: options.meta } : {}) })
    for (const text of options.deltas ?? []) emit({ type: "item.delta", itemId, text })
    if (options.status !== "running") emit({ type: "item.completed", itemId, status: options.status ?? "ok", ...(options.text !== undefined ? { text: options.text } : {}), ...(options.attachments ? { attachments: options.attachments } : {}) }, options.advance ?? 100)
    return itemId
  }
  const turn = () => {
    const turnId = ids("turn")
    emit({ type: "turn.started", turnId, queueId: ids("queue") })
    return turnId
  }
  return { emit, item, turn, events }
}

function view(events: SessionEvent[], options: { mode?: PresentationMode; width?: number; height?: number; timestamps?: boolean } = {}) {
  const t = createTranscript({ appearance: { messageLayout: "classic", messageMeta: "full", userIcon: "●", userLead: "", userLabel: true, assistantLead: "", userTint: false }, glyphs: glyphs({}), mode: options.mode ?? "balanced", now: () => NOW })
  // These tests pin the whole preview the full view prints, which is the `dense` density.
  t.setAppearance({ reasoning: "auto", toolOutput: "auto", toolDensity: "dense", timestamps: options.timestamps ?? false })
  for (const event of events) t.apply(event)
  const lines = t.viewport(options.width ?? 100, options.height ?? 200)
  return { t, lines, text: lines.map((l) => l.text).filter((l) => l.trim()) }
}

describe("turn end lines", () => {
  test("with timestamps on the line ends with when the turn was done; off, it says nothing of the clock", () => {
    const { emit, item, turn, events } = stream()
    const turnId = turn()
    item(turnId, "agent_message", { text: "hello" })
    emit({ type: "turn.completed", turnId })
    expect(view(events, { timestamps: true }).text.at(-1)).toMatch(/ · done \d{1,2}:\d{2} [AP]M$/)
    expect(view(events).text.at(-1)).not.toContain("done")
  })

  test("completion totals include reasoning and full view names its reported tokens", () => {
    const { emit, item, turn, events } = stream()
    const turnId = turn()
    item(turnId, "agent_message", { text: "hello" })
    emit({ type: "usage.recorded", turnId, provider: "p", model: "gpt-6-luna", input: 1_000, output: 300, reasoning: 200, cacheRead: 0, cacheWrite: 0 })
    emit({ type: "turn.completed", turnId })
    expect(view(events).text.at(-1)).toContain("↑1,000 ↓500")
    expect(view(events).text.at(-1)).not.toContain("reasoning tokens")
    expect(view(events, { mode: "full" }).text.at(-1)).toContain("200 reasoning tokens")
  })

  test("a completed turn ends with model, summed tokens and duration", () => {
    const { emit, item, turn, events } = stream()
    const turnId = turn()
    item(turnId, "user_message", { text: "hi" })
    item(turnId, "agent_message", { text: "hello" })
    emit({ type: "usage.recorded", turnId, provider: "p", model: "gpt-5.6", input: 1_000, output: 300, reasoning: 0, cacheRead: 9_000, cacheWrite: 500 })
    emit({ type: "usage.recorded", turnId, provider: "p", model: "gpt-5.6", input: 2_000, output: 840, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
    emit({ type: "turn.completed", turnId }, 12_300 - 700)
    const { text, lines } = view(events)
    expect(text.at(-1)).toMatch(/^ {5}◈ GPT-5\.6 · ↑12\.5K ↓1,140 · 2 calls · \d+(\.\d)?s$/)
    expect(lines.at(-2)!.kind).toBe("status")
  })

  test("a turn whose calls all had a price says what it cost, and the full view how much of its prompt came from the cache", () => {
    const { emit, item, turn, events } = stream()
    const turnId = turn()
    item(turnId, "agent_message", { text: "hello" })
    emit({ type: "usage.recorded", turnId, provider: "p", model: "gpt-6-luna", input: 1_000, output: 300, reasoning: 0, cacheRead: 9_000, cacheWrite: 0, costMicros: 120_000 })
    emit({ type: "usage.recorded", turnId, provider: "p", model: "gpt-6-luna", input: 1_000, output: 300, reasoning: 0, cacheRead: 9_000, cacheWrite: 0, costMicros: 60_000 })
    emit({ type: "turn.completed", turnId })
    expect(view(events).text.at(-1)).toContain("↑20K ↓600 · $0.18 · 2 calls")
    expect(view(events).text.at(-1)).not.toContain("cached")
    expect(view(events, { mode: "full" }).text.at(-1)).toContain("90% cached")
    // One call without a price: no partial sum that reads as the whole cost.
    const unpriced = stream()
    const other = unpriced.turn()
    unpriced.item(other, "agent_message", { text: "hello" })
    unpriced.emit({ type: "usage.recorded", turnId: other, provider: "p", model: "gpt-6-luna", input: 1_000, output: 300, reasoning: 0, cacheRead: 0, cacheWrite: 0, costMicros: 120_000 })
    unpriced.emit({ type: "usage.recorded", turnId: other, provider: "p", model: "gpt-6-luna", input: 1_000, output: 300, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
    unpriced.emit({ type: "turn.completed", turnId: other })
    expect(view(unpriced.events).text.at(-1)).not.toContain("$")
  })

  test("a cancelled turn is muted and marked; an interrupted one says why in words", () => {
    const { emit, turn, events } = stream()
    const cancelled = turn()
    emit({ type: "turn.cancelled", turnId: cancelled, by: "user" }, 1_500)
    const interrupted = turn()
    emit({ type: "turn.interrupted", turnId: interrupted, reason: "transport" }, 2_000)
    const { text, lines } = view(events)
    expect(text).toEqual(["     ◈ 1.5s · cancelled", "     ◈ 2s · interrupted (connection lost)"])
    const cancelledSpans = lines.find((l) => l.text.includes("cancelled"))!.spans
    expect(cancelledSpans.find((s) => s.text.startsWith("◈"))).toMatchObject({ fg: "muted" })
    const interruptedSpans = lines.find((l) => l.text.includes("interrupted"))!.spans
    expect(interruptedSpans.find((s) => s.text.startsWith("interrupted"))).toMatchObject({ fg: "warning" })
  })

  test("a failed turn shows the provider message in an error box, capped at 10 rows, with its code", () => {
    const { emit, turn, events } = stream()
    const turnId = turn()
    const message = Array.from({ length: 30 }, (_, i) => `provider line ${i}`).join("\n")
    emit({ type: "turn.failed", turnId, error: { code: "rate_limit", message } }, 800)
    const { lines, text } = view(events)
    const box = lines.filter((l) => l.spans.some((s) => s.text === "┃"))
    expect(box.length).toBeGreaterThanOrEqual(12)
    expect(box[0]!.spans.find((s) => s.text === "┃")).toMatchObject({ fg: "error", bg: "panel" })
    expect(text.some((l) => l.includes("provider line 9"))).toBe(true)
    expect(text.some((l) => l.includes("provider line 10"))).toBe(false)
    expect(text.some((l) => l.includes("… 20 more lines"))).toBe(true)
    expect(text.some((l) => l.trim().endsWith("rate_limit"))).toBe(true)
    expect(text.at(-1)).toContain("◈")
  })

  test("a turn that ended without anything to report adds no block", () => {
    const { emit, turn, events } = stream()
    emit({ type: "turn.completed", turnId: turn() }, 0)
    const withoutClock = events.map((event) => ({ ...event, at: 0 }) as SessionEvent)
    expect(view(withoutClock).t.blocks()).toHaveLength(0)
  })

  test("minimal shows the failure in one short error line and a dim end line", () => {
    const { emit, turn, events } = stream()
    const turnId = turn()
    emit({ type: "turn.failed", turnId, error: { code: "auth", message: "invalid api key" } }, 300)
    const { text } = view(events, { mode: "minimal" })
    expect(text[0]).toBe("  ✗ invalid api key")
    expect(text.at(-1)).toMatch(/◈ 300ms$/)
  })
})

describe("user message", () => {
  test("has a `● You` header, the time on the right and no left bar or message fill", () => {
    const { item, turn, events } = stream()
    item(turn(), "user_message", { text: "hello there" })
    const { lines } = view(events, { width: 60, timestamps: true })
    const rows = lines.slice(0, 4)
    // v1's columns: the panel starts at column 3, the header and text are inset by two inside it.
    expect(rows[0]!.text).toMatch(/^ {5}● You {2,}3:49 PM {2}$/)
    expect(rows[1]!.text.trimEnd()).toBe("     hello there")
    for (const row of rows) expect(row.spans.some((s) => s.text === "┃")).toBe(false)
    for (const row of rows) expect(row.spans.every((s) => s.bg === undefined)).toBe(true)
    expect(rows[0]!.spans.find((s) => s.text.includes("●"))).toMatchObject({ fg: "primary" })
    expect(rows[0]!.spans.find((s) => s.text === " You")).toMatchObject({ fg: "muted" })
  })

  test("an older message adds the date to its time", () => {
    const at = new Date(2026, 8, 27, 15, 45).getTime()
    expect(todayTimeOrDateTime(at, NOW)).toBe("3:45 PM · 9/27/2026")
    expect(todayTimeOrDateTime(NOW, NOW)).toBe("3:50 PM")
    expect(todayTimeOrDateTime(0, NOW)).toBe("")
  })

  test("text over 18 lines or 2400 characters is cut and says what is hidden; ctrl+o opens it", () => {
    const { item, turn, events } = stream()
    item(turn(), "user_message", { text: Array.from({ length: 53 }, (_, i) => `log line ${i}`).join("\n") })
    const { t, text } = view(events)
    expect(text.some((l) => l.includes("log line 17"))).toBe(true)
    expect(text.some((l) => l.includes("log line 18"))).toBe(false)
    expect(text.find((l) => l.includes("chars hidden"))).toMatch(/… \d+ chars hidden · 35 more lines/)
    t.toggleTools()
    expect(t.viewport(100, 200).some((l) => l.text.includes("log line 52"))).toBe(true)
    const long = stream()
    long.item(long.turn(), "user_message", { text: "x".repeat(5_000) })
    expect(view(long.events).text.find((l) => l.includes("chars hidden"))).toContain("2,600 chars hidden")
  })

  test("attachments are one chip per file: a colored badge by type and the name", () => {
    const { item, turn, events } = stream()
    const ref = (mime: string, name?: string): BlobRef => ({ sha256: "c".repeat(64), bytes: 10, mime, ...(name ? { name } : {}) })
    item(turn(), "user_message", { text: "see", attachments: [ref("image/png", "shot.png"), ref("application/pdf", "spec.pdf"), ref("text/plain"), ref("image/jpeg")] })
    const { lines } = view(events, { width: 100 })
    const chips = lines.find((l) => l.text.includes(" img "))!
    expect(chips.text).toContain(" img  shot.png ")
    expect(chips.text).toContain(" pdf  spec.pdf ")
    expect(chips.text).toContain(" txt  file 3 ")
    expect(chips.text).toContain(" img  image 4 ")
    expect(chips.spans.find((s) => s.text === " img ")).toMatchObject({ bg: "accent", fg: "background" })
    expect(chips.spans.find((s) => s.text === " pdf ")).toMatchObject({ bg: "primary" })
    expect(chips.spans.find((s) => s.text === " txt ")).toMatchObject({ bg: "secondary" })
    expect(chips.spans.find((s) => s.text === " shot.png ")).toMatchObject({ bg: "element", fg: "muted" })
  })

  test("a `!command` is one primary bold command line on the panel with the time on the right", () => {
    const { item, turn, events } = stream()
    item(turn(), "user_message", { meta: { shell: true } as never, text: "git status --short" })
    const { lines, text } = view(events, { width: 60 })
    expect(text).toHaveLength(1)
    expect(text[0]).toMatch(/^ {5}\$ git status --short {2,}3:49 PM {2}$/)
    expect(lines[0]!.spans.find((s) => s.text === "git")).toMatchObject({ fg: "primary", bold: true, bg: "panel" })
    expect(text[0]).not.toContain("You")
    expect(view(events, { mode: "minimal" }).text).toEqual(["  $ git status --short"])
  })

  test("a `!!command` card says it is local and not sent to the model; a plain one does not", () => {
    const { item, turn, events } = stream()
    item(turn(), "user_message", { meta: { shell: true, local: true } as never, text: "cat notes.txt" })
    expect(view(events, { width: 70 }).text[0]).toContain("$ cat notes.txt local · not sent to the model")
    expect(view(events, { mode: "minimal" }).text).toEqual(["  $ cat notes.txt local"])
    const plain = stream()
    plain.item(plain.turn(), "user_message", { meta: { shell: true } as never, text: "cat notes.txt" })
    expect(view(plain.events, { width: 70 }).text.join("\n")).not.toContain("local")
  })

  test("a finished `!command` turn has no ◈ line (no model ran; the shell card carries the time)", () => {
    const { item, turn, emit, events } = stream()
    const turnId = turn()
    item(turnId, "user_message", { meta: { shell: true } as never, text: "git status --short" })
    item(turnId, "tool_call", { meta: { tool: "shell: git status --short" }, text: " M a.ts" })
    emit({ type: "turn.completed", turnId })
    expect(view(events, { width: 80 }).text.join("\n")).not.toContain("◈")
    // A model turn that ends the same way still gets its line.
    const other = stream()
    const modelTurn = other.turn()
    other.item(modelTurn, "user_message", { text: "hi" })
    other.item(modelTurn, "agent_message", { text: "hello" })
    other.emit({ type: "turn.completed", turnId: modelTurn })
    expect(view(other.events, { width: 80 }).text.join("\n")).toContain("◈")
  })

  test("every row stays inside the width", () => {
    const { item, turn, events } = stream()
    item(turn(), "user_message", { text: "word ".repeat(80) })
    for (const width of [20, 40, 80]) for (const line of view(events, { width }).lines) expect(line.text.length).toBeLessThanOrEqual(width)
  })
})

describe("reasoning", () => {
  const thought = (deltas: string[], status = "ok") => {
    const { item, turn, events } = stream()
    item(turn(), "reasoning", { deltas, status, advance: 3_200 })
    return events
  }

  test("a thought whose first line is long prose is not shown twice: the header is `Thought · <duration>` and the body keeps the line", () => {
    const prose = "I'm checking whether Ponytail actually beat us anywhere. Sonnet shows whittle winning both metrics, but Luna has some wins too."
    const done = view(thought([`${prose}\n\nThen the older round.`]))
    expect(done.text[0]).toMatch(/^ {4}┃ Thought · [\d.]+s$/)
    expect(done.text.join("\n").split("Ponytail").length - 1).toBe(1)
  })

  test("streaming shows `Thinking: <title>`, done shows `Thought: <title> · <duration>`, both on an element rail", () => {
    const running = view(thought(["**Reading the code**\n", "look at math.ts"], "running"))
    expect(running.text[0]).toBe("    ┃ Thinking: Reading the code")
    expect(running.text[1]).toBe("    ┃ look at math.ts")
    const done = view(thought(["**Reading the code**\n", "look at math.ts"]))
    expect(done.text[0]).toMatch(/^ {4}┃ Thought: Reading the code · 3\.4s$/)
    expect(done.lines[0]!.spans.find((s) => s.text === "┃ ")).toMatchObject({ fg: "element" })
    expect(done.lines[0]!.spans.find((s) => s.text.startsWith("Thought"))).toMatchObject({ fg: "warning", dim: true })
    expect(running.lines[0]!.spans.find((s) => s.text.startsWith("Thinking"))?.dim).toBeUndefined()
  })

  test("a write whose input the model is still writing says how much is written, and the working row says Writing... until the input is whole", () => {
    const { emit, item, turn, events } = stream()
    const turnId = turn()
    const itemId = item(turnId, "tool_call", { meta: { tool: "write: /p/plan.json" }, status: "running" })
    emit({ type: "item.delta", itemId, text: "", input: { chars: 6_200, lines: 84 } })
    const state = createTurnState()
    for (const event of events) state.apply(event)
    expect(phaseOf({ state: "tool", current: state.current! })).toBe("Writing...")
    expect(view(events).text.find((line) => line.includes("/p/plan.json"))).toContain("writing 84 lines · 6.2 KB")

    emit({ type: "item.delta", itemId, text: "", input: { chars: 9_000, lines: 120, done: true } })
    state.apply(events.at(-1)!)
    expect(phaseOf({ state: "tool", current: state.current! })).toBe("Editing...")
    expect(view(events).text.join("\n")).not.toContain("writing")
  })

  test("thinking without text draws no card, running or done, while the working row says Thinking...", () => {
    const { emit, item, turn, events } = stream()
    const turnId = turn()
    item(turnId, "reasoning", { status: "running" })
    const state = createTurnState()
    for (const event of events) state.apply(event)
    expect(view(events).text).toEqual([])
    expect(phaseOf({ state: "generating", current: state.current! })).toBe("Thinking...")
    const row = renderWorkingRow({ width: 60, margin: 2, spinner: "⠋", phase: phaseOf({ state: "generating", current: state.current! }), elapsedMs: 4_000, now: NOW })
    expect(row.map((span) => span.text).join("")).toBe("  ⠋ Thinking...  4s")

    emit({ type: "item.completed", itemId: (events.at(-1) as { itemId: string }).itemId, status: "ok", text: "" }, 3_200)
    item(turnId, "agent_message", { text: "391" })
    state.apply(events.at(-3)!)
    expect(state.current).toBeUndefined()
    const done = view(events).text
    expect(done.join("\n")).not.toMatch(/Thought|Thinking/)
    expect(done.some((line) => line.includes("391"))).toBe(true)
  })

  test("the body is bounded to the last clamp(height × 0.32, 4, 14) rows", () => {
    const events = thought([Array.from({ length: 60 }, (_, i) => `step ${i}`).join("\n\n")])
    for (const [height, rows] of [[10, 4], [40, 12], [100, 14]] as const) {
      const { lines } = view(events, { height })
      const body = lines.filter((l) => l.text.startsWith("    ┃")).slice(1)
      expect(body).toHaveLength(rows)
      expect(body[0]!.text).toMatch(/… \d+ earlier lines/)
      expect(body.at(-1)!.text).toContain("step 59")
    }
  })

  test("minimal keeps a single dim line", () => {
    const { text } = view(thought(["**Reading the code**\n", "a\n\nb\n\nc"]), { mode: "minimal" })
    expect(text).toEqual(["  Thought: Reading the code · 3.4s"])
  })
})

describe("tools", () => {
  const withTool = (meta: string, text: string, options: { status?: string; deltas?: string[]; advance?: number } = {}) => {
    const { item, turn, events } = stream()
    item(turn(), "tool_call", { meta: { tool: meta }, text, ...options })
    return events
  }

  test("a shell is its command over a rule holding the tail: primary while running, border when done, last 6 lines (10 in the full view)", () => {
    const output = Array.from({ length: 25 }, (_, i) => `out ${i}`).join("\n")
    const done = view(withTool("shell: bun test", output, { advance: 4_000 }), { width: 60 })
    expect(done.text[0]).toMatch(/^ {5}\$ bun test {2,}4s$/)
    expect(done.text[1]).toBe("     │ … +19 lines")
    expect(done.text.some((l) => l.includes("out 18"))).toBe(false)
    expect(done.text.some((l) => l.includes("out 19"))).toBe(true)
    expect(done.text.some((l) => l.includes("out 24"))).toBe(true)
    const full = view(withTool("shell: bun test", output, { advance: 4_000 }), { width: 60, mode: "full" })
    expect(full.text.some((l) => l.includes("out 14"))).toBe(false)
    expect(full.text.some((l) => l.includes("out 15"))).toBe(true)
    expect(done.lines[2]!.spans.find((span) => span.text.startsWith("│"))).toMatchObject({ fg: "border" })
    expect(done.text.some((l) => /[┌└]/.test(l))).toBe(false)
    for (const line of done.lines) expect(line.text.length).toBeLessThanOrEqual(60)
    const running = view(withTool("shell: bun test", "", { status: "running", deltas: ["partial\n"] }), { width: 60 })
    expect(running.lines.find((l) => l.text.includes("partial"))!.spans.find((span) => span.text.startsWith("│"))).toMatchObject({ fg: "primary" })
    expect(running.text.some((l) => l.includes("partial"))).toBe(true)
    const empty = view(withTool("shell: sleep 5", "", { status: "running" }), { width: 60 })
    expect(empty.text.some((l) => l.includes("No output yet"))).toBe(true)
  })

  test("a finished shell shows its reported duration, and its exit code only when it is not zero", () => {
    const completed = (meta: Record<string, number | boolean>, status = "error") => {
      const { emit, turn, events } = stream()
      const turnId = turn()
      const itemId = ids("item")
      emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: "shell: make" } })
      emit({ type: "item.completed", itemId, status, text: "boom", meta })
      return events
    }
    expect(view(completed({ exitCode: 2, timedOut: false, durationMs: 1_500 })).text[0]).toMatch(/^ {5}✗ make {2}exit 2 +1\.5s$/)
    expect(view(completed({ exitCode: 0, durationMs: 820 }, "ok")).text[0]).toBe("     $ make")
    // A failure with no exit code (a timeout, a kill) still says so in words.
    expect(view(completed({ durationMs: 820 })).text[0]).toBe("     ✗ make  failed")
  })

  test("a finished task is one row with its calls and duration at the right edge", () => {
    const { emit, turn, events } = stream()
    const turnId = turn()
    const itemId = ids("item")
    emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: "task: explore" } })
    emit({ type: "item.completed", itemId, status: "ok", text: "found it", meta: { toolCalls: 7, durationMs: 65_000 } })
    expect(view(events).text).toHaveLength(1)
    expect(view(events).text[0]).toMatch(/^ {5}◔ Task explore {2}7 calls +1m 5s$/)
  })

  test("ctrl+o opens the shell output, a page at a time", () => {
    const events = withTool("shell: seq 30", Array.from({ length: 30 }, (_, i) => `n${i}`).join("\n"))
    const { t } = view(events)
    t.toggleTools()
    const text = t.viewport(100, 100).map((l) => l.text)
    expect(text.some((l) => /│ n0$/.test(l))).toBe(true)
    expect(text.some((l) => /│ n29$/.test(l))).toBe(true)
    expect(text.some((l) => l.includes("+") && l.includes("lines"))).toBe(false)
  })

  const diff = (rows: number) => ["@@ -1,1 +1,1 @@", ...Array.from({ length: rows }, (_, i) => `+line ${i}`)].join("\n")

  test("an edit shows `Edit path +a −d` and up to 40 diff rows in balanced and full before `… +N lines`; minimal keeps it to its row", () => {
    const { text } = view(withTool("edit: src/a.ts", diff(60)))
    expect(text[0]).toBe("     ✎ Edit src/a.ts  +60")
    expect(text.filter((l) => /\+ line \d+/.test(l))).toHaveLength(40)
    expect(text.at(-1)).toBe("     │ … +20 lines")
    expect(view(withTool("edit: src/a.ts", diff(60)), { mode: "minimal" }).text.filter((l) => /\+ line \d+/.test(l)).length).toBeLessThan(40)
    const full = view(withTool("edit: src/a.ts", diff(60)), { mode: "full" }).text
    expect(full.filter((l) => /\+ line \d+/.test(l))).toHaveLength(40)
    expect(full.at(-1)).toContain("+20 lines")
    expect(view(withTool("edit: src/a.ts", "@@ -1,1 +1,1 @@\n-old\n+new")).text[0]).toBe("     ✎ Edit src/a.ts  +1 −1")
  })

  test("a diff has one line-number column, aligned to the widest, no `@@` row, and marks what changed inside a line", () => {
    const text = ["@@ -98,3 +98,3 @@", " keep", "-const total = items.length", "+const total = items.length + extra", " tail"].join("\n")
    const { text: rows, lines } = view(withTool("edit: src/a.ts", text))
    expect(rows.slice(1).map((row) => row.trimEnd())).toEqual(["     │  98   keep", "     │  99 - const total = items.length", "     │  99 + const total = items.length + extra", "     │ 100   tail"])
    const added = lines.find((l) => l.text.includes("+ const total"))!
    expect(added.spans.find((s) => s.text === " + extra")).toMatchObject({ fg: "success", bold: true })
    expect(added.spans.find((s) => s.text.startsWith("const total"))).toMatchObject({ fg: "body", bg: "diffAddedBg" })
  })

  test("apply_patch draws one block per file with Added/Deleted/Patched and its own stats", () => {
    const patch = ["*** Add File: a.txt", "+one", "+two", "*** Delete File: b.txt", "*** Update File: c.ts -> d.ts", "@@ -1,1 +1,1 @@", "-x", "+y"].join("\n")
    const files = parsePatch(patch)!
    expect(files.map((f) => [f.verb, f.path, f.added, f.removed])).toEqual([["Added", "a.txt", 2, 0], ["Deleted", "b.txt", 0, 0], ["Patched", "c.ts -> d.ts", 1, 1]])
    const { text } = view(withTool("apply_patch", patch))
    expect(text.filter((l) => /^ {5}[+\-±] /.test(l))).toEqual(["     ± Add a.txt  +2", "     ± Delete b.txt", "     ± Patch c.ts -> d.ts  +1 −1"])
  })

  test("a run of more than five completed one-line rows folds the oldest into `◇ N tools more`; ctrl+o unfolds", () => {
    const { item, turn, events } = stream()
    const turnId = turn()
    for (let i = 0; i < 8; i++) item(turnId, "tool_call", { meta: { tool: `webfetch: https://x.dev/f${i}` }, text: "x" })
    const { t, text } = view(events)
    expect(text.filter((l) => l.includes("Fetch"))).toHaveLength(5)
    expect(text[0]).toBe("     ◇ 3 tools more")
    expect(text[1]).toContain("f3")
    t.toggleTools()
    expect(t.viewport(100, 100).filter((l) => l.text.includes("Fetch"))).toHaveLength(8)
    expect(view(events, { mode: "minimal" }).text).toEqual(["◆ 8 tools · webfetch: https://x.dev/f7 ✓"])
  })

  test("Claude Code edits, writes and commands never fold into `◇ N tools more` once they finish, in full or balanced; its reads still do", () => {
    const { item, turn, events } = stream()
    const turnId = turn()
    const changing = ["edit /p/a.ts", "write /p/b.ts", "rm /p/c.ts", "notebookedit /p/n.ipynb", "MultiEdit", "bash", "edit /p/d.ts", "write /p/e.ts"]
    for (const tool of changing) item(turnId, "tool_call", { meta: { tool }, text: "The file has been updated." })
    for (let i = 0; i < 7; i++) item(turnId, "tool_call", { meta: { tool: `read /p/r${i}.ts` }, text: "x" })
    for (const mode of ["full", "balanced"] as const) {
      const { text } = view(events, { mode })
      for (const tool of changing) expect(text.some((l) => l.includes(tool))).toBe(true)
      expect(text.filter((l) => l.includes("◇"))).toEqual(["     ◇ 2 tools more"])
      expect(text.some((l) => l.includes("r1.ts"))).toBe(false)
    }
  })

  test("failed rows are never folded and a running row stays visible", () => {
    const { item, turn, events } = stream()
    const turnId = turn()
    for (let i = 0; i < 7; i++) item(turnId, "tool_call", { meta: { tool: `webfetch: https://x.dev/f${i}` }, text: "x", ...(i === 0 ? { status: "error" } : {}) })
    item(turnId, "tool_call", { meta: { tool: "webfetch: https://x.dev/live" }, status: "running" })
    const { text } = view(events)
    expect(text.some((l) => l.includes("f0"))).toBe(true)
    expect(text.some((l) => l.includes("live"))).toBe(true)
    expect(text.filter((l) => l.includes("◇"))).toEqual(["     ◇ 1 tool more"])
  })

  test("a todo card draws ✓ ▸ □ in success/warning/text and takes the todo icon even as `todo 2/5`", () => {
    const list = ["[x] one", "[~] two", "[ ] three"].join("\n")
    for (const title of ["todo", "todo 1/3"]) {
      const { lines, text } = view(withTool(title, list))
      expect(text.slice(0, 4)).toEqual(["     ✓ Todos 1/3", "       ✓ one", "       ▸ two", "       □ three"])
      expect(lines[1]!.spans.find((s) => s.text === "✓ ")).toMatchObject({ fg: "success" })
      expect(lines[2]!.spans.find((s) => s.text === "▸ ")).toMatchObject({ fg: "warning" })
      expect(lines[3]!.spans.find((s) => s.text === "□ ")).toMatchObject({ fg: "text" })
    }
  })

  test("the task tool uses ◔ and an answered question shows `? <question>` with the answer indented", () => {
    expect(view(withTool("task: explore", "found it")).text[0]).toStartWith("     ◔ Task explore")
    const { text } = view(withTool("question: Use bun?", "yes, bun"))
    expect(text.slice(0, 2)).toEqual(["     ? Use bun?", "       yes, bun"])
  })

  test("the card of a tool waiting for approval is tinted warning", () => {
    const { item, turn, emit, events } = stream()
    const turnId = turn()
    const itemId = item(turnId, "tool_call", { meta: { tool: "shell: rm -rf build" }, status: "running" })
    emit({ type: "server.request", requestId: ids("request"), turnId, kind: "approval", title: "Run command", detail: "", itemId })
    const { lines } = view(events, { width: 60 })
    expect(lines[0]!.spans.find((s) => s.text.includes("rm -rf build"))).toMatchObject({ fg: "warning", bold: true })
    expect(lines[0]!.spans.find((s) => s.text === "⠋")).toMatchObject({ fg: "warning" })
  })
})

describe("compaction", () => {
  const compaction = (status: string, text?: string) => {
    const { item, turn, events } = stream()
    item(turn(), "compaction", { status, ...(text !== undefined ? { text } : {}) })
    return events
  }

  test("running, done and failed", () => {
    const running = view(compaction("running")).text.join("\n")
    // While it runs the live panel above the prompt carries the progress; the transcript only marks the place with a rule.
    expect(running).toContain("─ Packing context ─")
    expect(running).not.toContain("┌─")
    expect(running).not.toContain("Write memory")
    expect(view(compaction("running"), { mode: "minimal" }).text.join("\n")).not.toContain("Write memory")
    const summary = "The session moved the footer fix forward. " + "More detail. ".repeat(30)
    const done = view(compaction("ok", summary))
    expect(done.text[0]).toContain("┌─ Context packed")
    expect(done.text.join("\n")).toContain("▸ Compacted memory · packed")
    expect(done.text.join("\n")).not.toContain("The session moved")
    done.t.toggleTools()
    expect(done.t.viewport(100, 40).some((l) => l.text.includes("More detail. More detail."))).toBe(true)
    expect(view(compaction("error")).text[0]).toContain("Compaction failed")
  })

  test("folded summaries stay hidden and expanding preserves all their text", () => {
    const { t, text } = view(compaction("ok", "x".repeat(300)), { width: 200 })
    expect(text.join("\n")).not.toContain("xxxxx")
    t.toggleTools()
    const expanded = t.viewport(200, 40).map((line) => line.text).join("\n")
    expect(expanded.split("\n").filter((line) => line.includes("xxxxx")).join("").match(/x/g)).toHaveLength(300)
    expect(expanded).not.toContain("…")
  })
})

describe("syntax highlighting", () => {
  const roles = (line: string, lang: string) => highlight(line, lang).map((s) => [s.text, s.fg])

  test("colors comments, strings, numbers, keywords, calls and types", () => {
    const spans = highlight('const total: Count = add(1, "two") // sum', "ts")
    const byText = Object.fromEntries(spans.map((s) => [s.text, s.fg]))
    expect(byText).toMatchObject({ const: "synKeyword", Count: "synType", add: "synFunction", "1": "synNumber", '"two"': "synString", "// sum": "synComment" })
    expect(spans.map((s) => s.text).join("")).toBe('const total: Count = add(1, "two") // sum')
  })

  test("block comments and python triple quotes carry across lines", () => {
    const state = {}
    expect(highlight("/* start", "ts", state)).toEqual([{ text: "/* start", fg: "synComment" }])
    expect(highlight("still */ const x", "ts", state)[0]).toMatchObject({ fg: "synComment", text: "still */" })
    const py = {}
    expect(highlight('"""doc', "py", py)[0]).toMatchObject({ fg: "synString" })
    expect(highlight("more", "py", py)).toEqual([{ text: "more", fg: "synString" }])
    expect(highlight('end""" x', "py", py)[0]).toMatchObject({ fg: "synString", text: 'end"""' })
  })

  test("json, shell, diff and markdown", () => {
    expect(roles('{"a": 1, "b": true}', "json")).toEqual(expect.arrayContaining([['"a"', "synString"], ["1", "synNumber"], ["true", "synKeyword"]]))
    expect(roles("git commit -m 'x' | wc -l # count", "sh")).toEqual(expect.arrayContaining([["git", "synFunction"], ["wc", "synFunction"], ["# count", "synComment"], ["'x'", "synString"]]))
    expect(highlight("+added", "diff")[0]).toMatchObject({ fg: "success" })
    expect(highlight("-gone", "diff")[0]).toMatchObject({ fg: "error" })
    expect(highlight("@@ -1 +1 @@", "diff")[0]).toMatchObject({ fg: "info" })
    expect(highlight("# Title", "md")[0]).toMatchObject({ fg: "heading", bold: true })
  })

  test("go and rust keywords; a rust lifetime is not a string", () => {
    expect(roles("func main() { return nil }", "go")).toEqual(expect.arrayContaining([["func", "synKeyword"], ["main", "synFunction"], ["nil", "synKeyword"]]))
    expect(roles("fn get<'a>(x: &'a str) -> Option<i32>", "rust").some(([, fg]) => fg === "synString")).toBe(false)
  })

  test("is fast enough to run on every streamed frame", () => {
    const line = 'export const value = compute(items.map((item) => item.count * 2), "label") // trailing'
    const start = performance.now()
    for (let i = 0; i < 20_000; i++) highlight(line, "ts")
    expect((performance.now() - start) / 20_000).toBeLessThan(budgetMs(0.05))
  })
})

describe("theme roles and formatting", () => {
  test("syntax roles and `background` are derived when a theme omits them, and a theme can set them", () => {
    const base = { name: "t", label: "T", dark: true, background: "#101010", colors: { primary: "#22c55e", text: "#ffffff", body: "#eeeeee", muted: "#888888", border: "#333333", heading: "#4ade80", code: "#a5f3fc", link: "#60a5fa", success: "#22c55e", warning: "#f59e0b", error: "#ef4444" } }
    const derived = defineTheme(base)
    expect(derived.colors).toMatchObject({ background: "#101010", synComment: "#888888", synKeyword: "#4ade80", synString: "#22c55e", synNumber: "#f59e0b", synFunction: "#60a5fa", synType: mix("#f59e0b", "#ffffff", 0.35) })
    expect(defineTheme({ ...base, colors: { ...base.colors, synKeyword: "#ff00ff" } }).colors.synKeyword).toBe("#ff00ff")
    expect(sgr({ text: "x", fg: "synKeyword" }, "truecolor")).toContain("38;2;")
  })

  test("durations and elapsed clocks", () => {
    expect([820, 12_300, 65_000, 7_380_000].map(formatDuration)).toEqual(["820ms", "12.3s", "1m 5s", "2h 3m"])
    expect([4_900, 65_000].map(formatElapsed)).toEqual(["4s", "1m 5s"])
  })

  test("renderToolCard alone: an unknown parse falls back to the inline card", () => {
    const card = renderToolCard({ title: "edit: a.ts", text: "no diff here", status: "ok", width: 60, expanded: false, frame: 0, tailLines: 4 })
    expect(card[0]!.map((s) => s.text).join("")).toBe("   ✎ Edit a.ts")
  })
})
