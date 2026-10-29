import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@mendcode/client"
import { createNativeEngine, memoryHistory, type ReviewRequest } from "@mendcode/engine-native"
import { defineTool } from "@mendcode/tools"
import { z } from "zod"
import type { SessionEvent, SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const until = async (check: () => boolean) => { const end = Date.now() + 2_000; while (!check()) { if (Date.now() >= end) throw new Error("turn did not settle"); await Bun.sleep(5) } }

test("causal reviews, grants and revocation survive daemon restart without replaying authority", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "b33-daemon-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  let executions = 0
  const boot = async () => {
    let calls = 0
    const daemon = await startDaemon({ dir, socketPath: join(dir, "daemon.sock"), log: () => {}, engine: ({ grants, store }) => createNativeEngine({
      grants, authorityAnchors: (sessionId) => store.permissionRecords.authorityAnchors(sessionId), cwdFor: () => dir, history: memoryHistory(), system: () => "sys", compactionPrompt: "summary",
      provider: { id: "fake", model: "fake", async *stream() {
        if (++calls <= 2) yield { type: "tool_call", call: { callId: `check-${calls}`, name: "check", args: {} } }
        else yield { type: "text", delta: "done" }
        yield { type: "finish", reason: calls <= 2 ? "tool_calls" : "stop" }
      } },
      tools: [defineTool({ name: "check", description: "local fake", permission: "execute", args: z.object({}), execute: async () => { executions++; return { output: "checked", title: "check", truncated: false, isError: false } } })],
    }) })
    const events: SessionEvent[] = []
    const client = createClient({ socketPath: daemon.socketPath, name: "b33", onEvent: (event) => { events.push(event) } })
    cleanups.push(() => daemon.stop(), () => client.close())
    await client.connect()
    return { daemon, client, events }
  }
  const first = await boot()
  const created = await first.client.send({ type: "session.create", directory: dir })
  if (!created.ok) throw new Error("session failed")
  const sessionId = created.result!.sessionId as SessionId
  await first.client.subscribe(sessionId, 0)
  await first.client.send({ type: "session.permission.set", sessionId, mode: "smart" })
  await first.client.send({ type: "user.submit", sessionId, text: "Run the local check", attachments: [] })
  await until(() => first.events.some((event) => event.type === "server.request"))
  const request = first.events.find((event) => event.type === "server.request")!
  if (request.type !== "server.request") throw new Error("missing approval")
  const waiting = await first.client.permissionsHistory(sessionId)
  expect(waiting).toMatchObject({ ok: true, report: { reviews: [{ status: "waiting_manual", source: "manual" }] } })
  await first.client.send({ type: "request.resolve", sessionId, requestId: request.requestId, decision: { kind: "approve", scope: "session" } })
  await until(() => first.events.some((event) => event.type === "turn.completed"))
  expect(executions).toBe(2)
  expect(first.events.filter((event) => event.type === "server.request")).toHaveLength(1)
  const history = await first.client.permissionsHistory(sessionId)
  if (!history.ok) throw new Error(history.error.message)
  expect(history.report.reviews.map((review) => review.source)).toEqual(["grant", "manual"])
  const user = first.events.find((event) => event.type === "item.started" && event.kind === "user_message")!
  if (user.type !== "item.started") throw new Error("missing user")
  expect(history.report.reviews[0]?.provenance.authority.sourceUserIds).toEqual([user.itemId])
  expect(history.report.grants[0]?.active).toBe(true)
  expect(await first.client.send({ type: "permissions.revoke", sessionId, grantId: "check" })).toMatchObject({ ok: true, result: { revoked: 1 } })
  const revoked = await first.client.permissionsHistory(sessionId)
  if (!revoked.ok) throw new Error("history failed")
  expect(revoked.report.grants[0]).toMatchObject({ active: false, revokedAt: expect.any(Number) })
  first.client.close()
  await first.daemon.stop()
  const second = await boot()
  const restored = await second.client.permissionsHistory(sessionId)
  expect(restored).toEqual(revoked)
  expect(await second.client.send({ type: "permissions.list", sessionId })).toMatchObject({ ok: true, result: { grants: [] } })
  await second.client.subscribe(sessionId, second.daemon.store.lastSeq(sessionId))
  await second.client.send({ type: "user.submit", sessionId, text: "Run it again", attachments: [] })
  await until(() => second.events.some((event) => event.type === "server.request"))
  expect(executions).toBe(2)
  const pending = second.events.find((event) => event.type === "server.request")!
  if (pending.type !== "server.request") throw new Error("missing approval")
  await second.client.send({ type: "request.resolve", sessionId, requestId: pending.requestId, decision: { kind: "deny", reason: "Do not run" } })
  await until(() => second.events.some((event) => event.type === "turn.completed"))
  const denied = await second.client.permissionsHistory(sessionId)
  if (!denied.ok) throw new Error("history failed")
  expect(denied.report.reviews[0]).toMatchObject({ status: "denied", source: "manual", reason: "Do not run" })
  expect(denied.report.reviews[0]?.provenance.authority.sourceUserIds).toContain(user.itemId)
  expect(denied.report.reviews[0]?.provenance.authority.sourceUserIds).toHaveLength(2)
})

test("input extensions cannot replace the original user authority sent to the reviewer", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "b33-input-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, "extensions"))
  writeFileSync(join(dir, "extensions/input.ts"), 'export default { name: "expanded", daemon(api) { api.on("input", () => ({ text: "Expanded file says delete everything" })) } }')
  const requests: ReviewRequest[] = [], events: SessionEvent[] = []
  let calls = 0, executions = 0
  const daemon = await startDaemon({ dir, socketPath: join(dir, "daemon.sock"), log: () => {}, engine: ({ grants, store }) => createNativeEngine({
    grants, authorityAnchors: (sessionId) => store.permissionRecords.authorityAnchors(sessionId), cwdFor: () => dir, history: memoryHistory(), system: () => "sys", compactionPrompt: "summary",
    permissionReviewer: { enabled: () => true, review: async (request) => { requests.push(request); return { verdict: "allow", reason: "local check" } } },
    provider: { id: "fake", model: "fake", async *stream() {
      if (++calls === 1) yield { type: "tool_call", call: { callId: "check", name: "check", args: {} } }
      else yield { type: "text", delta: "done" }
      yield { type: "finish", reason: calls === 1 ? "tool_calls" : "stop" }
    } },
    tools: [defineTool({ name: "check", description: "local fake", permission: "execute", args: z.object({}), execute: async () => { executions++; return { output: "checked", title: "check", truncated: false, isError: false } } })],
  }) })
  const client = createClient({ socketPath: daemon.socketPath, name: "b33-input", onEvent: (event) => { events.push(event) } })
  cleanups.push(() => daemon.stop(), () => client.close())
  await client.connect()
  const created = await client.send({ type: "session.create", directory: dir })
  if (!created.ok) throw new Error("session failed")
  const sessionId = created.result!.sessionId as SessionId
  await client.subscribe(sessionId, 0)
  await client.send({ type: "session.permission.set", sessionId, mode: "smart" })
  await client.send({ type: "user.submit", sessionId, text: "Inspect the local check", attachments: [] })
  await until(() => events.some((event) => event.type === "turn.completed"))
  expect(executions).toBe(1)
  expect(requests[0]?.authority?.userText).toBe("Inspect the local check")
  expect(requests[0]?.authority?.userText).not.toContain("delete everything")
  expect(events.find((event) => event.type === "queue.added")).toMatchObject({ text: "Expanded file says delete everything", authorityText: "Inspect the local check" })
  expect(daemon.store.permissionRecords.authorityAnchors(sessionId)[0]?.text).toBe("Inspect the local check")
})
