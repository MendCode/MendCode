import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"
import { createIdFactory, type Loop } from "@mendcode/protocol"
import { boot, answer } from "./native-harness"

test("B20 draft, activate, snapshot and bounded tail persist without model calls", async () => {
  const h = await boot()
  try {
    const draftReply = await h.client.send({ type: "loop.draft", directory: h.project, template: "research-digest", trigger: { kind: "manual" } })
    expect(draftReply.ok).toBe(true)
    const draft = (draftReply.ok ? draftReply.result?.loop : undefined) as Loop
    expect(draft).toMatchObject({ state: "paused", draft: true, name: "Research Digest", reportOnly: true, runs: 0 })
    const active = await h.client.send({ type: "loop.activate", loopId: draft.loopId, reason: "Watch sources" })
    expect(active).toMatchObject({ ok: true, result: { loop: { state: "active", reason: "Activated: Watch sources" }, service: { kind: "integrated" } } })
    const snapshot = await h.client.loopSnapshot(draft.loopId)
    expect(snapshot).toMatchObject({ ok: true, snapshot: { loop: { state: "active", runs: 0 }, scheduler: { kind: "integrated", overdue: false }, children: [] } })
    const tail = await h.client.loopEvents(draft.loopId, 1)
    expect(tail).toMatchObject({ ok: true, events: [{ type: "state", title: "Activated: Watch sources", seq: 2 }] })
    expect(h.store.loops.all()[0]?.journal).toHaveLength(2)
    const templates = await h.client.send({ type: "loop.templates" })
    expect(templates.ok && (templates.result?.templates as unknown[]).length).toBe(4)
    expect(h.requests).toEqual([])
  } finally { await h.cleanup() }
})

test("B20 rejects unknown targets, bad templates and cross-project ticks without changing state", async () => {
  const h = await boot()
  try {
    const missing = createIdFactory()("loop")
    for (const type of ["loop.snapshot", "loop.events", "loop.activate"] as const) expect(await h.client.send({ type, loopId: missing, ...(type === "loop.events" ? { limit: 50 } : {}) } as never)).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
    expect(await h.client.send({ type: "loop.draft", directory: h.project, template: "missing" })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    const reply = await h.client.send({ type: "loop.draft", directory: h.project, name: "manual", objective: "inspect" })
    const loop = (reply.ok ? reply.result?.loop : undefined) as Loop
    expect(await h.client.send({ type: "loop.tick", directory: "/other", loopId: loop.loopId, limit: 1, execute: true, reportOnly: false })).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
    expect(await h.client.send({ type: "loop.tick", directory: h.project, loopId: loop.loopId, limit: 1, execute: true, reportOnly: false })).toMatchObject({ ok: true, result: { results: [{ state: "skipped", summary: "Loop is draft" }] } })
    expect(h.store.loops.all()).toEqual([loop])
    expect(h.requests).toEqual([])
  } finally { await h.cleanup() }
})

test("B20 executing tick returns the real run checkpoint; dry-run never submits", async () => {
  const h = await boot({ steps: [answer("```LOOP_CHECKPOINT\nstatus: continue\nsummary: local checks inspected\n```", { input: 10, output: 5 })] })
  try {
    const reply = await h.client.send({ type: "loop.create", directory: h.project, name: "watch", objective: "inspect", trigger: { kind: "manual" }, budget: { mode: "monitor" } })
    const loop = (reply.ok ? reply.result?.loop : undefined) as Loop
    const input = { type: "loop.tick" as const, directory: h.project, loopId: loop.loopId, limit: 1, reportOnly: false }
    const before = structuredClone(h.store.loops.all())
    expect(await h.client.send({ ...input, execute: false })).toMatchObject({ ok: true, result: { results: [{ state: "skipped" }] } })
    expect(h.store.loops.all()).toEqual(before)
    expect(h.requests).toEqual([])
    expect(await h.client.send({ ...input, execute: true })).toMatchObject({ ok: true, result: { results: [{ state: "active", run: 1, summary: "local checks inspected" }] } })
    expect(h.requests).toHaveLength(1)
    const snapshot = await h.client.loopSnapshot(loop.loopId)
    expect(snapshot).toMatchObject({ ok: true, snapshot: { loop: { runs: 1, history: [{ outcome: "completed" }] } } })
  } finally { await h.cleanup() }
})

test("B20 report-only tick denies a model write and keeps the loop's original policy", async () => {
  const h = await boot({ steps: [
    [{ type: "tool_call", call: { callId: "write-1", name: "write", args: { path: "forbidden.txt", content: "bad" } } }, { type: "finish", reason: "tool_calls" }],
    answer("```LOOP_CHECKPOINT\nstatus: complete\nsummary: only reported\n```", { input: 10, output: 5 }),
  ] })
  try {
    const reply = await h.client.send({ type: "loop.create", directory: h.project, name: "repair", objective: "edit the project", trigger: { kind: "manual" }, budget: { mode: "goal" }, checks: ["bun test"] })
    const loop = (reply.ok ? reply.result?.loop : undefined) as Loop
    expect(await h.client.send({ type: "loop.tick", directory: h.project, loopId: loop.loopId, limit: 1, execute: true, reportOnly: true })).toMatchObject({ ok: true, result: { results: [{ state: "active", run: 1 }] } })
    expect(existsSync(path.join(h.project, "forbidden.txt"))).toBe(false)
    expect(h.requests[1]?.messages.at(-1)).toMatchObject({ role: "tool", isError: true })
    const saved = h.store.loops.all()[0]!
    expect(saved.reportOnly).toBeUndefined()
    expect(saved.checks).toEqual(["bun test"])
    expect(saved.history[0]?.sessionId).not.toBe(loop.sessionId)
  } finally { await h.cleanup() }
})

test("B20 snapshots and journal redact secrets saved in historical loop text", async () => {
  const h = await boot()
  try {
    const token = "sk-abcdefghijklmnopqrstuvwxyz1234567890"
    const reply = await h.client.send({ type: "loop.draft", directory: h.project, name: "inspect", objective: `API_KEY=${token}` })
    const loop = (reply.ok ? reply.result?.loop : undefined) as Loop
    const snapshot = await h.client.loopSnapshot(loop.loopId)
    expect(JSON.stringify(snapshot)).not.toContain(token)
    expect(snapshot.ok && snapshot.snapshot.loop.objective).toContain("[redacted:")
  } finally { await h.cleanup() }
})
