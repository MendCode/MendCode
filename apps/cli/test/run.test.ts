import { describe, expect, test } from "bun:test"
import type { Client } from "@mendcode/client"
import { createIdFactory, type SessionEvent } from "@mendcode/protocol"
import { createHeadlessRun, EXIT } from "../src/run"

const ids = createIdFactory()

function harness(options: { thinking?: boolean; approve?: boolean } = {}) {
  const sessionId = ids("session")
  const queueId = ids("queue")
  const turnId = ids("turn")
  const out: string[] = []
  const err: string[] = []
  const sent: unknown[] = []
  const client = { send: async (command: unknown) => { sent.push(command); return { ok: true, result: { queueId } } } } as unknown as Client
  const run = createHeadlessRun({ client, sessionId, prompt: "go", json: false, approve: options.approve ?? false, thinking: options.thinking ?? false, out: { write: (t: string) => out.push(t) }, err: { write: (t: string) => err.push(t) } })
  let seq = 0
  const emit = (e: Record<string, unknown>) => run.onEvent({ sessionId, seq: ++seq, at: 0, ...e } as SessionEvent)
  return { run, emit, out, err, sent, turnId, queueId }
}

describe("headless run output", () => {
  test("stdout carries only the answer; reasoning, tools and compaction go to stderr", async () => {
    const { run, emit, out, err, turnId, queueId } = harness()
    const started = run.start()
    await Promise.resolve()
    emit({ type: "turn.started", turnId, queueId })
    const reasoning = ids("item")
    emit({ type: "item.started", turnId, itemId: reasoning, kind: "reasoning" })
    emit({ type: "item.delta", itemId: reasoning, text: "private thoughts" })
    const first = ids("item")
    emit({ type: "item.started", turnId, itemId: first, kind: "agent_message" })
    emit({ type: "item.delta", itemId: first, text: "Checking." })
    const tool = ids("item")
    emit({ type: "item.started", turnId, itemId: tool, kind: "tool_call", meta: { tool: "shell: ls" } })
    emit({ type: "item.delta", itemId: tool, text: "a.ts\n" })
    const second = ids("item")
    emit({ type: "item.started", turnId, itemId: second, kind: "agent_message" })
    emit({ type: "item.delta", itemId: second, text: "Done." })
    const compaction = ids("item")
    emit({ type: "item.started", turnId, itemId: compaction, kind: "compaction" })
    emit({ type: "item.delta", itemId: compaction, text: "summary text" })
    emit({ type: "turn.completed", turnId })
    expect(await started).toBe(EXIT.completed)
    expect(out.join("")).toBe("Checking.\n\nDone.\n")
    expect(err.join("")).toBe("◆ shell: ls\n◆ compacting context\n")
  })

  test("thinking is opt-in and excludes another turn", async () => {
    const h = harness({ thinking: true })
    const started = h.run.start()
    await Promise.resolve()
    h.emit({ type: "turn.started", turnId: h.turnId, queueId: h.queueId })
    const itemId = ids("item")
    h.emit({ type: "item.started", turnId: ids("turn"), itemId: ids("item"), kind: "reasoning" })
    // Thinking without text (Claude Code keeps it) prints nothing.
    const silent = ids("item")
    h.emit({ type: "item.started", turnId: h.turnId, itemId: silent, kind: "reasoning" })
    h.emit({ type: "item.completed", turnId: h.turnId, itemId: silent, text: "" })
    h.emit({ type: "item.started", turnId: h.turnId, itemId, kind: "reasoning" })
    h.emit({ type: "item.delta", itemId, text: "Check the contract." })
    h.emit({ type: "item.completed", turnId: h.turnId, itemId })
    h.emit({ type: "turn.completed", turnId: h.turnId })
    expect(await started).toBe(0)
    expect(h.out.join("")).toBe("Thinking: Check the contract.\n\n")
  })

  test("approval alias approves only approval requests, not unanswered questions", async () => {
    const h = harness({ approve: true })
    const started = h.run.start()
    await Promise.resolve()
    h.emit({ type: "turn.started", turnId: h.turnId, queueId: h.queueId })
    const approval = ids("request"), question = ids("request")
    h.emit({ type: "server.request", turnId: h.turnId, requestId: approval, kind: "approval", title: "Write", detail: "file" })
    h.emit({ type: "server.request", turnId: h.turnId, requestId: question, kind: "question", title: "Choose" })
    expect(h.sent).toContainEqual(expect.objectContaining({ type: "request.resolve", requestId: approval, decision: { kind: "approve", scope: "once" } }))
    expect(h.sent).toContainEqual(expect.objectContaining({ type: "request.resolve", requestId: question, decision: expect.objectContaining({ kind: "deny" }) }))
    h.emit({ type: "turn.completed", turnId: h.turnId })
    expect(await started).toBe(0)
  })

  test("a command child replays completion and sends approval decisions to that child", async () => {
    const parentId = ids("session"), childId = ids("session"), queueId = ids("queue"), turnId = ids("turn"), requestId = ids("request")
    const sent: unknown[] = [], output: string[] = []
    let run: ReturnType<typeof createHeadlessRun>
    const client = {
      send: async (command: unknown) => { sent.push(command); return { ok: true } },
      subscribe: async (sessionId: string, afterSeq: number) => {
        expect({ sessionId, afterSeq }).toEqual({ sessionId: childId, afterSeq: 0 })
        const emit = (seq: number, event: Record<string, unknown>) => run.onEvent({ sessionId: childId, seq, at: 0, ...event } as SessionEvent)
        emit(1, { type: "turn.started", queueId, turnId })
        emit(2, { type: "server.request", turnId, requestId, kind: "approval", title: "Read diff" })
        const itemId = ids("item")
        emit(3, { type: "item.started", turnId, itemId, kind: "agent_message" })
        emit(4, { type: "item.delta", itemId, text: "No actionable defects." })
        emit(5, { type: "turn.completed", turnId })
        return { ok: true }
      },
    } as unknown as Client
    run = createHeadlessRun({ client, sessionId: parentId, prompt: "/review", json: false, approve: true, out: { write: (text) => output.push(text) }, err: { write() {} }, submit: async () => ({ ok: true, result: { queueId, task: { taskId: childId } } }) })
    expect(await run.start()).toBe(EXIT.completed)
    expect(run.sessionId).toBe(childId)
    expect(output.join("")).toBe("No actionable defects.\n")
    expect(sent).toContainEqual(expect.objectContaining({ type: "request.resolve", sessionId: childId, requestId }))
  })
})

describe("an approval denied for lack of --approve", () => {
  /** A turn that asks to run `tool`, then (optionally) runs another tool that succeeds, then completes. */
  async function turn(options: { approve?: boolean; then?: "ok" | "error"; question?: boolean }) {
    const h = harness(options.approve === undefined ? {} : { approve: options.approve })
    const started = h.run.start()
    await Promise.resolve()
    h.emit({ type: "turn.started", turnId: h.turnId, queueId: h.queueId })
    const asked = ids("item")
    h.emit({ type: "item.started", turnId: h.turnId, itemId: asked, kind: "tool_call", meta: { tool: "shell" } })
    h.emit({ type: "server.request", turnId: h.turnId, requestId: ids("request"), kind: options.question ? "question" : "approval", title: "Run", detail: "rm x", itemId: asked })
    h.emit({ type: "item.completed", itemId: asked, status: options.approve ? "ok" : "error" })
    if (options.then) {
      const next = ids("item")
      h.emit({ type: "item.started", turnId: h.turnId, itemId: next, kind: "tool_call", meta: { tool: "read" } })
      h.emit({ type: "item.completed", itemId: next, status: options.then })
    }
    const answer = ids("item")
    h.emit({ type: "item.started", turnId: h.turnId, itemId: answer, kind: "agent_message" })
    h.emit({ type: "item.delta", itemId: answer, text: "Could not." })
    h.emit({ type: "turn.completed", turnId: h.turnId })
    return { code: await started, err: h.err.join(""), out: h.out.join("") }
  }

  test("ends the turn with exit 5 and says so; the answer still prints", async () => {
    const denied = await turn({})
    expect(denied.code).toBe(EXIT.denied)
    expect(EXIT.denied).toBe(5)
    expect(denied.err).toContain("→ denied (pass --approve to allow)")
    expect(denied.err).toContain("error: an approval was denied and nothing ran after it; pass --approve to allow it")
    expect(denied.out).toBe("Could not.\n")
  })

  test("a later tool call that fails keeps exit 5; one that succeeds makes the turn a normal completion", async () => {
    expect((await turn({ then: "error" })).code).toBe(EXIT.denied)
    const recovered = await turn({ then: "ok" })
    expect(recovered.code).toBe(EXIT.completed)
    expect(recovered.err).not.toContain("nothing ran after it")
  })

  test("granted approvals and unanswered questions keep exit 0", async () => {
    expect((await turn({ approve: true })).code).toBe(EXIT.completed)
    expect((await turn({ question: true })).code).toBe(EXIT.completed)
  })

  test("the denied call reporting ok itself is not work that succeeded", async () => {
    const h = harness()
    const started = h.run.start()
    await Promise.resolve()
    h.emit({ type: "turn.started", turnId: h.turnId, queueId: h.queueId })
    const asked = ids("item")
    h.emit({ type: "item.started", turnId: h.turnId, itemId: asked, kind: "tool_call" })
    h.emit({ type: "server.request", turnId: h.turnId, requestId: ids("request"), kind: "approval", title: "Run", detail: "rm x", itemId: asked })
    h.emit({ type: "item.completed", itemId: asked, status: "ok" })
    h.emit({ type: "turn.completed", turnId: h.turnId })
    expect(await started).toBe(EXIT.denied)
  })

  test("--compat JSON carries approvalDenied on the completion line", async () => {
    const sessionId = ids("session"), queueId = ids("queue"), turnId = ids("turn")
    const lines: Array<{ event: string; data: Record<string, unknown> }> = []
    const client = { send: async () => ({ ok: true, result: { queueId } }) } as unknown as Client
    const run = createHeadlessRun({ client, sessionId, prompt: "go", json: true, compat: true, approve: false, out: { write: (text: string) => lines.push(JSON.parse(text)) }, err: { write() {} } })
    const started = run.start()
    await Promise.resolve()
    let seq = 0
    const emit = (event: Record<string, unknown>) => run.onEvent({ sessionId, seq: ++seq, at: 0, ...event } as SessionEvent)
    emit({ type: "turn.started", turnId, queueId })
    emit({ type: "server.request", turnId, requestId: ids("request"), kind: "approval", title: "Run", detail: "rm x" })
    emit({ type: "turn.completed", turnId })
    expect(await started).toBe(EXIT.denied)
    expect(lines.at(-1)).toMatchObject({ event: "session.completed", data: { status: "completed", approvalDenied: true } })
  })
})
