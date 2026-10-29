import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createIdFactory, type Loop } from "@mendcode/protocol"
import { openStore } from "@mendcode/store"
import { startDaemon } from "../src"

const cleanup: Array<() => unknown> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })

test("B44 daemon validates, persists budgets/rubric and enforces checkpoint-bound reviews through the typed client", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b44-"))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const ids = createIdFactory()
  const store = openStore({ dir })
  const sessionId = ids("session")
  store.createSession({ id: sessionId, directory: dir, title: "loop fake" })
  const loop: Loop = { loopId: ids("loop"), sessionId, name: "review tests", directory: dir, objective: "tests pass", trigger: { kind: "manual" }, budget: { mode: "goal" }, costBudget: { maxCost: 1 }, usage: { tokens: 42, costMicros: 10, unknownCostCalls: 0 }, rubric: { criteria: [{ id: "tests", description: "tests pass" }] }, state: "blocked", runs: 1, createdAt: 1, updatedAt: 2, history: [{ run: 1, startedAt: 1, endedAt: 2, checkpoint: { status: "complete", summary: "tests pass" }, checkpointHash: "a".repeat(64), gates: [{ id: "bun test", status: "fail", detail: "exit 1" }] }] }
  store.loops.save(loop)
  const editedLoop: Loop = { ...loop, loopId: ids("loop"), name: "edited review" }
  store.loops.save(editedLoop)
  store.close()
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanup.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "B44" })
  cleanup.push(() => client.close())
  await client.connect()
  expect(await client.send({ type: "loop.list", directory: dir })).toMatchObject({ ok: true, result: { loops: expect.arrayContaining([loop, editedLoop]) } })
  expect(await client.send({ type: "loop.control", loopId: loop.loopId, action: "accept", reason: "bypass" })).toMatchObject({ ok: false })
  const input = { loopId: loop.loopId, action: "waive" as const, gateId: "bun test", run: 1, checkpointHash: "a".repeat(64), reviewer: "user", reason: "verified separately" }
  expect(await client.reviewLoop({ ...input, checkpointHash: "b".repeat(64) })).toMatchObject({ ok: false, error: { message: expect.stringContaining("stale") } })
  expect(await client.reviewLoop(input)).toMatchObject({ ok: true, loop: { history: [{ gates: [{ status: "pass", waiver: { actor: "user", checkpointHash: input.checkpointHash } }] }] } })
  expect(await client.reviewLoop({ ...input, action: "accept" })).toMatchObject({ ok: true, loop: { state: "completed" } })
  expect(daemon.store.loops.all().find((entry) => entry.loopId === loop.loopId)?.history[0]?.gates?.[0]?.waiver?.reason).toBe("verified separately")
  expect(await client.send({ type: "loop.update", loopId: editedLoop.loopId, approvalPolicy: { requireApprovalFor: ["deploy"] } })).toMatchObject({ ok: true, result: { loop: { reviewInvalidatedAt: expect.any(Number), history: editedLoop.history } } })
  expect(await client.reviewLoop({ ...input, loopId: editedLoop.loopId, action: "accept" })).toMatchObject({ ok: false, error: { message: expect.stringContaining("settings changed") } })
  expect(daemon.store.loops.all().find((entry) => entry.loopId === editedLoop.loopId)?.reviewInvalidatedAt).toBeDefined()
  expect(await client.send({ type: "loop.create", name: "bad", directory: dir, objective: "bad", trigger: { kind: "manual" }, budget: { mode: "monitor" }, rubric: { criteria: [{ id: "tests", description: "tests" }] } })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
  const created = await client.send({ type: "loop.create", name: "caps", directory: dir, objective: "o", trigger: { kind: "manual" }, budget: { mode: "goal" }, costBudget: { maxTokens: 10 }, rubric: { criteria: [{ id: "tests", description: "tests" }] }, approvalPolicy: { requireApprovalFor: ["push"] } })
  expect(created).toMatchObject({ ok: true, result: { loop: { costBudget: { maxTokens: 10 }, rubric: { criteria: [{ id: "tests" }] }, approvalPolicy: { requireApprovalFor: ["push"] } } } })
  const id = (created.ok ? created.result?.loop as Loop : undefined)!.loopId
  expect(await client.send({ type: "loop.update", loopId: id, name: "renamed" })).toMatchObject({ ok: true, result: { loop: { costBudget: { maxTokens: 10 }, approvalPolicy: { requireApprovalFor: ["push"] } } } })
})
