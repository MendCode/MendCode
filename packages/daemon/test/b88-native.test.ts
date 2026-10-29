import { afterEach, expect, test } from "bun:test"
import path from "node:path"
import { boot, callTool, openSession, put, stop, until, type NativeHarness } from "./native-harness"

const harnesses: NativeHarness[] = []
afterEach(async () => { for (const h of harnesses.splice(0).reverse()) await h.cleanup() })

test("native rule approvals publish exact permission patterns and honor REST-style session scope", async () => {
  const h = await boot({ steps: [callTool("read", { path: "source.ts" }), stop("read")] })
  harnesses.push(h)
  const file = path.join(h.project, "source.ts")
  put(file, "export const ready = true\n")
  await h.client.send({ type: "settings.set", patch: { permission: { read: "ask" } } })
  const sessionId = await openSession(h, "ask")
  await h.client.send({ type: "user.submit", sessionId, text: "Read source.ts", attachments: [] })
  await until(() => h.events.some((event) => event.type === "server.request"))
  const pending = await h.client.pendingInteractions(h.project, "permission")
  expect(pending.ok).toBe(true)
  const value = pending.ok ? pending.requests[0] : undefined
  expect(value).toMatchObject({ permission: "read", patterns: [file], always: [file] })
  expect((await h.client.send({ type: "request.resolve", sessionId, requestId: value!.id, decision: { kind: "approve", scope: "session" } })).ok).toBe(true)
  await until(() => h.store.turns.list(sessionId).every((turn) => turn.status !== "running"))
  h.steps.push(callTool("read", { path: "source.ts" }), stop("read again"))
  await h.client.send({ type: "user.submit", sessionId, text: "Read source.ts again", attachments: [] })
  await until(() => h.store.turns.list(sessionId).filter((turn) => turn.status !== "running").length === 2)
  expect(h.events.filter((event) => event.type === "server.request")).toHaveLength(1)
})

test("native default write approvals carry edit targets without parsing rendered details", async () => {
  const h = await boot({ steps: [callTool("write", { path: "new.ts", content: "export {}\n" }), stop("denied")] })
  harnesses.push(h)
  const sessionId = await openSession(h, "ask")
  await h.client.send({ type: "user.submit", sessionId, text: "Write new.ts", attachments: [] })
  await until(() => h.events.some((event) => event.type === "server.request"))
  const request = h.events.find((event) => event.type === "server.request")!
  expect(request.type === "server.request" && request.permissionContext).toMatchObject({ name: "edit", patterns: [path.join(h.project, "new.ts")] })
  if (request.type !== "server.request") throw new Error("Missing approval")
  await h.client.send({ type: "request.resolve", sessionId, requestId: request.requestId, decision: { kind: "deny" } })
  await until(() => h.store.turns.list(sessionId).every((turn) => turn.status !== "running"))
})
