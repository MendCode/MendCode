import { afterEach, expect, test } from "bun:test"
import path from "node:path"
import { boot, callTool, openSession, stop, until, type NativeHarness } from "./native-harness"

const harnesses: NativeHarness[] = []
afterEach(async () => { for (const h of harnesses.splice(0).reverse()) await h.cleanup() })

const pendingRequests = (h: NativeHarness) => h.events.filter((event) => event.type === "server.request")

async function firstRequest(h: NativeHarness, count = 1) {
  await until(() => pendingRequests(h).length >= count)
  const request = pendingRequests(h)[count - 1]!
  if (request.type !== "server.request") throw new Error("missing approval")
  return request
}

async function settings(h: NativeHarness) {
  const reply = await h.client.send({ type: "settings.get" })
  if (!reply.ok) throw new Error("settings.get failed")
  return (reply.result as { settings: { permission?: unknown; projectConfig?: Record<string, { permission?: unknown }> } }).settings
}

test("always allow in this project approves the call once and saves the rule in the project's settings", async () => {
  const h = await boot({ steps: [callTool("write", { path: "a.ts", content: "export {}\n" }), stop("one"), callTool("write", { path: "b.ts", content: "export {}\n" }), stop("two")] })
  harnesses.push(h)
  const sessionId = await openSession(h, "ask")
  await h.client.send({ type: "user.submit", sessionId, text: "write a", attachments: [] })
  const request = await firstRequest(h)
  const reply = await h.client.send({ type: "request.resolve", sessionId, requestId: request.requestId, decision: { kind: "approve", scope: "once", remember: { level: "project" } } })
  expect(reply).toMatchObject({ ok: true, result: { remembered: { level: "project", label: "edits" } } })
  await until(() => h.store.turns.list(sessionId).every((turn) => turn.status !== "running"))
  expect((await settings(h)).projectConfig?.[h.project]?.permission).toEqual({ edit: { "*": "allow" } })
  expect((await settings(h)).permission).toBeUndefined()

  await h.client.send({ type: "user.submit", sessionId, text: "write b", attachments: [] })
  await until(() => h.store.turns.list(sessionId).filter((turn) => turn.status !== "running").length === 2)
  expect(pendingRequests(h)).toHaveLength(1)
})

test("always allow for all projects writes the user's permission rules", async () => {
  const h = await boot({ steps: [callTool("write", { path: "a.ts", content: "export {}\n" }), stop("one")] })
  harnesses.push(h)
  const sessionId = await openSession(h, "ask")
  await h.client.send({ type: "user.submit", sessionId, text: "write a", attachments: [] })
  const request = await firstRequest(h)
  const reply = await h.client.send({ type: "request.resolve", sessionId, requestId: request.requestId, decision: { kind: "approve", scope: "once", remember: { level: "user" } } })
  expect(reply.ok).toBe(true)
  await until(() => h.store.turns.list(sessionId).every((turn) => turn.status !== "running"))
  expect((await settings(h)).permission).toEqual({ edit: { "*": "allow" } })
  expect((await settings(h)).projectConfig).toBeUndefined()
})

test("a rule is saved only for a request that can offer one, and a refused answer saves nothing", async () => {
  const h = await boot({ steps: [callTool("write", { path: "a.ts", content: "export {}\n" }), stop("one")] })
  harnesses.push(h)
  const sessionId = await openSession(h, "ask")
  await h.client.send({ type: "user.submit", sessionId, text: "write a", attachments: [] })
  const request = await firstRequest(h)
  // Another session's id cannot save a rule from this request.
  const other = await openSession(h, "ask")
  const wrong = await h.client.send({ type: "request.resolve", sessionId: other, requestId: request.requestId, decision: { kind: "approve", scope: "once", remember: { level: "user" } } })
  expect(wrong).toMatchObject({ ok: false, error: { code: "invalid_command" } })
  expect((await settings(h)).permission).toBeUndefined()
  await h.client.send({ type: "request.resolve", sessionId, requestId: request.requestId, decision: { kind: "deny", reason: "not now" } })
  await until(() => h.store.turns.list(sessionId).every((turn) => turn.status !== "running"))
  // Already resolved: the answer is refused and no rule appears.
  const late = await h.client.send({ type: "request.resolve", sessionId, requestId: request.requestId, decision: { kind: "approve", scope: "once", remember: { level: "user" } } })
  expect(late.ok).toBe(false)
  expect((await settings(h)).permission).toBeUndefined()
  expect(path.isAbsolute(h.project)).toBe(true)
})

test("permissions.retry says so when the reviewer denied nothing", async () => {
  const h = await boot({ steps: [] })
  harnesses.push(h)
  const sessionId = await openSession(h, "ask")
  expect(await h.client.send({ type: "permissions.retry", sessionId })).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
})
