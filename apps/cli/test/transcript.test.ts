import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { createIdFactory, type SessionEvent } from "@mendcode/protocol"
import { createTranscript, createViewState } from "../src/view/transcript"
import { textWidth, wrap } from "../src/view/wrap"
import { budgetMs } from "../../../scripts/test-budget"

const ids = createIdFactory()
const sessionId = ids("session")

function log() {
  let seq = 0
  const events: SessionEvent[] = []
  const push = (event: Record<string, unknown>) => events.push({ sessionId, seq: ++seq, at: 0, ...event } as SessionEvent)
  return { events, push }
}

function turnWithMessages(count: number, words = 40) {
  const { events, push } = log()
  const turnId = ids("turn")
  push({ type: "turn.started", turnId, queueId: ids("queue") })
  for (let i = 0; i < count; i++) {
    const itemId = ids("item")
    push({ type: "item.started", turnId, itemId, kind: i % 2 ? "agent_message" : "user_message" })
    push({ type: "item.completed", itemId, status: "ok", text: Array.from({ length: words }, (_, k) => `w${i}-${k}`).join(" ") })
  }
  return { events, push, turnId }
}

describe("wrap", () => {
  test("respects terminal cell width for wide characters and hard-breaks long words", () => {
    for (const line of wrap("hola 漢字漢字漢字 emoji 🚀🚀🚀 " + "x".repeat(50), 10)) expect(textWidth(line)).toBeLessThanOrEqual(10)
    expect(wrap("", 10)).toEqual([""])
    expect(() => wrap("x", 0)).toThrow(RangeError)
  })
})

describe("transcript view model", () => {
  test("replayed events are applied once even if delivered twice (reconnect)", () => {
    const { events } = turnWithMessages(3)
    const t = createTranscript()
    for (const e of [...events, ...events]) t.apply(e)
    expect(t.blocks().length).toBe(3)
  })

  test("the viewport returns exactly `height` rows ending at the bottom, and scrolls by offset", () => {
    const { events } = turnWithMessages(200)
    const t = createTranscript()
    events.forEach(t.apply)
    const bottom = t.viewport(80, 30, 0)
    expect(bottom.length).toBe(30)
    const up = t.viewport(80, 30, 30)
    expect(up.length).toBe(30)
    expect(up.map((l) => l.text)).not.toEqual(bottom.map((l) => l.text))
    expect(t.viewport(80, 60, 0).slice(0, 30)).toEqual(up)
    expect(t.viewport(80, 30, t.totalLines(80) - 10).length).toBe(10)
  })

  test("streaming into 10,000 finished messages stays cheap (no O(n) re-wrap per token, FC-35)", () => {
    const { events, push, turnId } = turnWithMessages(10_000)
    const t = createTranscript()
    events.forEach(t.apply)
    t.viewport(160, 45)
    const live = ids("item")
    push({ type: "item.started", turnId, itemId: live, kind: "agent_message" })
    t.apply(events.at(-1)!)
    // 500 tokens as five runs of 100, and the cheapest run counts: the machine taking the processor away (twelve test processes share
    // it) only ever adds time to a run, while a re-wrap of the 10,000 messages per token would add it to every one of them.
    const runs: number[] = []
    for (let run = 0; run < 5; run++) {
      const start = performance.now()
      for (let i = 0; i < 100; i++) {
        push({ type: "item.delta", itemId: live, text: "token " })
        t.apply(events.at(-1)!)
        t.viewport(160, 45)
      }
      runs.push((performance.now() - start) / 100)
    }
    const perFrameMs = Math.min(...runs)
    expect(perFrameMs).toBeLessThan(budgetMs(2))
  })

  test("view state survives navigation and keeps a reader's position while new lines arrive (FC-04, FC-22)", () => {
    const view = createViewState()
    view.scroll("ses_a", 40, 1_000)
    view.get("ses_b")
    expect(view.get("ses_a")).toMatchObject({ offset: 40, follow: false })
    view.onGrowth("ses_a", 5)
    expect(view.get("ses_a").offset).toBe(45)
    view.scroll("ses_a", -1_000, 1_000)
    expect(view.get("ses_a").follow).toBe(true)
    view.onGrowth("ses_a", 5)
    expect(view.get("ses_a").offset).toBe(0)
  })
})

describe("client boundaries (P4)", () => {
  test("the CLI app never imports storage, kernel, process spawning or network fetch", () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry)
        if (statSync(full).isDirectory()) walk(full)
        else if (full.endsWith(".ts") || full.endsWith(".tsx")) files.push(full)
      }
    }
    walk(path.join(import.meta.dir, "../src"))
    for (const file of files) {
      const source = readFileSync(file, "utf8")
      expect(/from\s+"(@mendcode\/(store|kernel|daemon)|bun:sqlite)"/.test(source)).toBe(false)
      // Only the launcher may start a process (the daemon itself).
      if (!file.endsWith("launcher.ts")) expect(/from\s+"(node:)?child_process"/.test(source)).toBe(false)
      expect(/\bfetch\(|Bun\.spawn/.test(source) && !file.endsWith("launcher.ts")).toBe(false)
    }
  })
})

describe("concurrent blocks", () => {
  test("a running block that grows under a newer one is counted at its new height", () => {
    const { events, push } = log()
    const turnId = ids("turn")
    const a = ids("item")
    const b = ids("item")
    push({ type: "turn.started", turnId, queueId: ids("queue") })
    push({ type: "item.started", turnId, itemId: a, kind: "agent_message" })
    push({ type: "item.delta", itemId: a, text: "first line" })
    push({ type: "item.started", turnId, itemId: b, kind: "agent_message" })
    push({ type: "item.delta", itemId: b, text: "other" })
    const transcript = createTranscript()
    for (const event of events) transcript.apply(event)
    const before = transcript.totalLines(60)
    push({ type: "item.delta", itemId: a, text: "\n\nmore\n\nand more\n\nstill more" })
    transcript.apply(events.at(-1)!)
    const total = transcript.totalLines(60)
    expect(total).toBeGreaterThan(before)
    expect(total).toBe(transcript.viewport(60, 1_000, 0).length)
  })
})

describe("sub-agent threads across pages", () => {
  test("an older page gives an open thread its beginning, and its tool count is not doubled", () => {
    const { events, push } = log()
    const turnId = ids("turn")
    const parent = ids("item")
    push({ type: "turn.started", turnId, queueId: ids("queue") })
    push({ type: "item.started", turnId, itemId: parent, kind: "tool_call", meta: { tool: "agent explore", subagent: true, agent: "general-purpose", background: false } })
    const child = (kind: string, text: string, meta: Record<string, unknown> = {}) => {
      const itemId = ids("item")
      push({ type: "item.started", turnId, itemId, kind, meta: { agentParent: parent, ...meta } })
      push({ type: "item.completed", itemId, status: "ok", text })
    }
    child("tool_call", "listed files", { tool: "Glob" })
    child("agent_message", "early finding")
    const cut = events.length
    child("tool_call", "read a file", { tool: "Read" })
    child("agent_message", "late finding")
    const transcript = createTranscript()
    for (const event of events.slice(cut)) transcript.apply(event)
    transcript.prepend(events.slice(0, cut))
    const thread = transcript.agentTranscript(parent) as ReturnType<typeof createTranscript>
    const texts = thread.blocks().map((block) => block.text)
    expect(texts).toContain("early finding")
    expect(texts).toContain("late finding")
    expect(transcript.agentThreads().find((each) => each.itemId === parent)?.tools).toBe(2)
  })
})
