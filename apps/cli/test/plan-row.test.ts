import { describe, expect, test } from "bun:test"
import { createIdFactory, type SessionEvent, type Settings } from "@mendcode/protocol"
import type { EngineEvent } from "@mendcode/kernel"
import type { CommandInput, CommandReply } from "@mendcode/client"
import { createClaudePlan, createTurnMapper } from "../../../packages/engine-claude/src"
import { createUpdateMapper } from "../../../packages/engine-acp/src"
import { codexPlanCard } from "../../../packages/engine-codex/src/engine"
import { createApp } from "../src/ui/app"
import { appHarness, cleanTemps, tempDir } from "./session-ui-harness"
import { reviewFixture } from "./panel-review-fixture"
import { glyphs, glyphSet, type Line } from "../src/ui/theme"
import { latestTodos } from "../src/view/plan-row"
import { parseTodoText } from "../src/view/dock"
import type { Block } from "../src/view/transcript"
import type { PresentationMode } from "../src/view/transcript"

const ids = createIdFactory()
const NOW = 1_800_000_000_000
const plain = (line: Line) => line.map((span) => span.text).join("")
const LIST = "[x] Read the parser\n[~] Fix the off-by-one in the tokenizer's column count\n[ ] Run the tests\n[-] Rewrite the lexer"

describe("latest todos", () => {

  test("the current list is the newest finished card: a running or failed call keeps the one before, an empty one clears it", () => {
    const block = (status: Block["status"], text: string, title = "todo 1/2"): Block => ({ itemId: ids("item"), turnId: ids("turn"), kind: "tool_call", text, title, status })
    const before = block("ok", "[x] a\n[~] b")
    expect(latestTodos([before, block("running", "", "todo")])).toEqual(parseTodoText("[x] a\n[~] b"))
    expect(latestTodos([before, block("error", "items: expected array")])).toEqual(parseTodoText("[x] a\n[~] b"))
    expect(latestTodos([before, block("ok", "", "todo 0/0")])).toEqual([])
    expect(latestTodos([before, block("ok", "x", "todoist: sync")])).toEqual(parseTodoText("[x] a\n[~] b"))
  })
})

function harness(options: { mode?: PresentationMode; width?: number; height?: number; accessible?: boolean; ascii?: boolean } = {}) {
  const frames: Line[][] = []
  const screen = { size: { width: options.width ?? 100, height: options.height ?? 30 }, draw: (rows: Line[]) => void frames.push(rows), setTitle: () => {} } as unknown as Parameters<typeof createApp>[0]["screen"]
  const sessionId = ids("session")
  const turnId = ids("turn")
  const app = createApp({
    sessionId, screen, directory: "/Users/dev/work/app", home: "/Users/dev", exit() {}, schedule: (fn) => fn(),
    glyphs: options.ascii ? glyphSet("ascii") : glyphs({}), now: () => NOW, random: () => 0, mode: options.mode ?? "balanced",
    ...(options.accessible ? { accessible: true } : {}),
    subscribe: async () => ({ ok: true }), send: (async () => ({ ok: true })) as never,
  })
  let seq = 0
  const ev = (patch: Record<string, unknown>) => app.onEvent({ sessionId, seq: ++seq, at: NOW, turnId, ...patch } as SessionEvent)
  /** An engine's events, as the daemon appends them to the session. */
  const engine = (events: readonly EngineEvent[]) => { for (const event of events) ev(event as unknown as Record<string, unknown>) }
  const todo = (text: string, title = "todo") => {
    const itemId = ids("item")
    ev({ type: "item.started", itemId, kind: "tool_call", meta: { tool: "todo" } })
    ev({ type: "item.completed", itemId, status: "ok", text, meta: { tool: title, retitled: true } })
  }
  const text = () => { app.render(); return frames.at(-1)!.map(plain) }
  /** The row right over the prompt's top rule, and the rows under that rule (the prompt and the footer). */
  const promptAt = (rows: string[]) => rows.findLastIndex((row) => /^\s*─{8,}/.test(row) || /^\s*-{8,}/.test(row))
  return { app, ev, engine, todo, text, promptAt, frames, sessionId, turnId }
}
const tier = (h: ReturnType<typeof harness>, settings: Partial<Settings>) => h.app.applySettings(settings as Settings)

describe("no pinned progress row in the app", () => {
  test("balanced: the card stays in the transcript without a current-task row", async () => {
    const h = harness()
    tier(h, { tier: "balanced" })
    h.todo(LIST, "todo 1/4")
    const rows = h.text()
    const row = rows.findIndex((line) => line.includes("▸ Fix the off-by-one in the tokenizer's column count · 1/3"))
    expect(row).toBe(-1)
    expect(rows.join("\n")).toContain("Todos 1/4")
    h.todo("[x] Read the parser\n[x] Fix the off-by-one\n[x] Run the tests\n[-] Rewrite the lexer", "todo 3/4")
    expect(h.text().some((line) => /[▸□] .* · \d+\/\d+$/.test(line.trim()))).toBe(false)
  })

  test("full, narrow: neither an open nor a cleared list adds a row", () => {
    const h = harness({ mode: "full", width: 40 })
    tier(h, { tier: "full" })
    h.todo(LIST)
    expect(h.text().some((row) => row.includes("· 1/3"))).toBe(false)
    h.todo("", "todo 0/0")
    expect(h.text().some((row) => row.includes("1/3"))).toBe(false)
  })

  test("minimalist draws no row; balanced with visible_plan off draws none either", () => {
    const minimal = harness({ mode: "minimal" })
    tier(minimal, { tier: "minimalist" })
    minimal.todo(LIST)
    expect(minimal.text().some((row) => row.includes("1/3"))).toBe(false)
    const off = harness()
    tier(off, { tier: "balanced", features: { visible_plan: false } })
    off.todo(LIST)
    expect(off.text().some((row) => row.includes("1/3"))).toBe(false)
  })

  test("ctrl+t: the dock lists the plan; closing it adds no row", async () => {
    const h = harness({ height: 40 })
    tier(h, { tier: "balanced" })
    h.todo(LIST)
    await h.app.onKey("\x14")
    const open = h.text()
    expect(open.some((row) => row.includes("Todos") && row.includes("2 open"))).toBe(true)
    expect(open.some((row) => row.includes("· 1/3"))).toBe(false)
    await h.app.onKey("\x14")
    expect(h.text().some((row) => row.includes("· 1/3"))).toBe(false)
  })

  test("ASCII chrome and screen-reader mode", () => {
    const ascii = harness({ ascii: true })
    tier(ascii, { tier: "balanced" })
    ascii.todo(LIST)
    expect(ascii.text().some((row) => row.includes("> Fix the off-by-one in the tokenizer's column count | 1/3"))).toBe(false)
    const reader = harness({ accessible: true })
    tier(reader, { tier: "balanced" })
    reader.todo(LIST)
    expect(reader.text().some((row) => row.includes("Plan: Fix the off-by-one in the tokenizer's column count, 1 of 3 done"))).toBe(false)
  })

  test("dictating keeps the voice row without a current-task row", async () => {
    const report = (recording: boolean) => ({ enabled: true, recording, ready: true, provider: "openai", model: "gpt-4o-mini-transcribe", maxSeconds: 60, recorder: "rec" })
    const h = appHarness({
      directory: tempDir("mendcode-plan-voice-"),
      reply: (command: CommandInput) => command.type === "voice.control" ? { ok: true, result: report(command.action === "start") } as CommandReply : undefined,
    })
    // No tier: dictation and the visible plan are both on, as they are with full and voice switched on.
    h.app.onEvent({ sessionId: h.sessionId, seq: 2, at: NOW, type: "item.started", turnId: "turn-v", itemId: "item-v", kind: "tool_call", meta: { tool: "todo" } } as unknown as SessionEvent)
    h.app.onEvent({ sessionId: h.sessionId, seq: 3, at: NOW, type: "item.completed", turnId: "turn-v", itemId: "item-v", status: "ok", text: LIST } as unknown as SessionEvent)
    await h.type("/voice\r")
    const rows = h.text()
    const voice = rows.findIndex((row) => /● ▁{16}\s+0:00/.test(row))
    const plan = rows.findIndex((row) => row.includes("▸ Fix the off-by-one in the tokenizer's column count · 1/3"))
    expect(voice).toBeGreaterThan(0)
    expect(plan).toBe(-1)
    await h.app.onInput("/voice cancel\r")
    cleanTemps()
  })

  test("bottom sheets have no current-task row at either height", async () => {
    const shown = async (height: number) => {
      const h = reviewFixture({ session: "active", width: 60, height, preset: "pulse", rightSidebar: true })
      await Bun.sleep(15)
      h.app.render()
      return h.text().some((row) => row.includes("Fix the next cycle · 1/3"))
    }
    expect(await shown(20)).toBe(false)
    expect(await shown(60)).toBe(false)
    cleanTemps()
  })
})

describe("other engines' lists feed the dock without a pinned row", () => {
  const feedsRow = async (events: readonly EngineEvent[], current: string, count: string) => {
    const h = harness({ height: 40 })
    tier(h, { tier: "balanced" })
    h.engine(events)
    expect(h.text().some((row) => row.includes(`▸ ${current} · ${count}`))).toBe(false)
    await h.app.onKey("\x14")
    // The dock's Todos panel retains the item and its priority.
    const open = h.text()
    expect(open.some((row) => row.includes("Todos"))).toBe(true)
    expect(open.some((row) => row.includes("▸ ") && row.includes(current) && !row.includes(`· ${count}`))).toBe(true)
    expect(open.some((row) => row.includes(`▸ ${current} · ${count}`))).toBe(false)
  }

  test("Claude Code TodoWrite: the item in progress reads as its activeForm", async () => {
    const events: EngineEvent[] = []
    const mapper = createTurnMapper({ newItemId: () => ids("item"), emit: (event) => void events.push(event), model: "claude-sonnet-5-5", plan: createClaudePlan() })
    const todos = [{ content: "Read the parser", status: "completed", activeForm: "Reading the parser" }, { content: "Fix the bug", status: "in_progress", activeForm: "Fixing the bug" }, { content: "Run the tests", status: "pending", activeForm: "Running the tests" }]
    for (const message of [
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "TodoWrite" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ todos }) } } },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Todos have been modified successfully." }] } },
    ]) mapper.accept(message as never)
    await feedsRow(events, "Fixing the bug", "1/3")
  })

  test("an ACP agent's plan", async () => {
    const events: EngineEvent[] = []
    const mapper = createUpdateMapper({ newItemId: () => ids("item"), emit: (event) => void events.push(event) })
    mapper.accept({ sessionUpdate: "plan", entries: [{ content: "write code", priority: "high", status: "completed" }, { content: "test it", priority: "medium", status: "in_progress" }] })
    await feedsRow(events, "test it", "1/2")
  })

  test("a Codex plan update", async () => {
    const card = codexPlanCard([{ step: "Read", status: "completed" }, { step: "Patch the loop", status: "inProgress" }, { step: "Check", status: "pending" }])!
    const itemId = ids("item")
    await feedsRow([{ type: "item.started", itemId, kind: "tool_call", meta: { tool: card.title } }, { type: "item.completed", itemId, status: "ok", text: card.text }] as EngineEvent[], "Patch the loop", "1/3")
  })
})
