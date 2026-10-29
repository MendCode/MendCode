import { expect, test } from "bun:test"
import { ContextReport, createIdFactory } from "@mendcode/protocol"
import type { EngineEvent, TurnInput } from "@mendcode/kernel"
import { createFauxEngine } from "../src"

function fixture(text: string) {
  const ids = createIdFactory()
  const events: EngineEvent[] = []
  const input: TurnInput = {
    text, sessionId: ids("session"), turnId: ids("turn"), attachments: [], signal: new AbortController().signal,
    newItemId: () => ids("item"), emit: (event) => void events.push(event),
    ask: async () => ({ kind: "approve", scope: "once" }), permissionMode: () => "ask", setPermissionMode() {},
  }
  const engine = createFauxEngine({ deltaMs: 0, clock: { now: () => 123, setTimer: (_ms, fn) => {
    fn()
    return { cancel() {} }
  } } })
  return { events, input, run: () => engine.runTurn(input) }
}

test("faux question waits for a local fixture answer", async () => {
  const f = fixture("/faux-question")
  const requests: unknown[] = []
  f.input.ask = async (request) => { requests.push(request); return { kind: "answer", text: "First" } }
  expect(await f.run()).toEqual({ status: "ok" })
  expect(requests).toEqual([{ kind: "question", title: "faux question", detail: "Choose a direction", options: [{ label: "First" }, { label: "Second" }] }])
})

test("faux smoke limit includes a synthetic reset, without a provider", async () => {
  const f = fixture("/faux-limit")
  expect(await f.run()).toEqual({ status: "error", code: "usage_limit_reached", message: 'faux 429 usage_limit_reached {"resets_in_seconds":3600}' })
  expect(f.events).toEqual([])
})

test("faux graft emits only a completed tool fixture with both directions and a second hop", async () => {
  const f = fixture("/graft")
  expect(await f.run()).toEqual({ status: "ok" })
  expect(f.events).toHaveLength(2)
  expect(f.events[0]).toMatchObject({ type: "item.started", kind: "tool_call", meta: { tool: "mcp__graft__graft_trace_calls: renderToolCard" } })
  expect(f.events[1]).toMatchObject({ type: "item.completed", status: "ok" })
  const output = f.events[1] as Extract<EngineEvent, { type: "item.completed" }>
  expect(output.text).toContain("calls ← defaultBody")
  expect(output.text).toContain("calls → computerCard")
  expect(output.text).toContain("[depth 2]")
})

test("thread check acknowledges an actual expanded snapshot rather than the mention alone", async () => {
  for (const [text, reply] of [["/thread-check @thread:123", "faux thread snapshot missing"], ["/thread-check @thread:123\n\n<thread-snapshot readonly=\"true\">data</thread-snapshot>", "faux thread snapshot received"]]) {
    const f = fixture(text!)
    expect(await f.run()).toEqual({ status: "ok" })
    expect(f.events.at(-1)).toMatchObject({ type: "item.completed", text: reply })
  }
})

test("offline context fixture is valid and usage bypasses the real slash page", async () => {
  const ids = createIdFactory()
  const engine = createFauxEngine({ clock: { now: () => 0, setTimer: () => ({ cancel() {} }) } })
  const report = ContextReport.parse(await engine.contextReport!(ids("session")))
  expect(report.model).toBe("faux fixture")
  expect(report.sections.reduce((sum, section) => sum + section.tokens, 0)).toBe(report.estimatedTokens)
  const f = fixture("/faux-usage")
  expect(await f.run()).toEqual({ status: "ok" })
  expect(f.events).toContainEqual(expect.objectContaining({ type: "usage", provider: "faux", input: 11, output: 17 }))
})
