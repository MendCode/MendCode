import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createIdFactory, isReadOnlyCommand } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { expandAgentMentions, mentionedAgents } from "../src/agent-mentions"
import { remoteTokens } from "../src/remote"
import { boot, callTool, openSession, put, say, stop, type NativeHarness } from "./native-harness"

let h: NativeHarness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

test("tags and a color mark live in the agent-view metadata and are listed with the session", async () => {
  h = await boot({ steps: [stop("done")] })
  const id = await openSession(h)
  await say(h, id, "tag me")
  const patch = (body: Record<string, unknown>, sessionId = id) => h!.client.send({ type: "session.agent-view.metadata.patch", sessionId, patch: body } as never)
  expect(await patch({ tags: ["auth", "auth", "needs-review"], color: "cyan" })).toMatchObject({ ok: true, result: { metadata: { tags: ["auth", "needs-review"], color: "cyan" } } })
  expect(await h.client.send({ type: "session.list" })).toMatchObject({ ok: true, result: { sessions: [{ sessionId: id, tags: ["auth", "needs-review"], color: "cyan" }] } })
  expect(await h.client.send({ type: "session.get", sessionId: id })).toMatchObject({ ok: true, result: { session: { tags: ["auth", "needs-review"], color: "cyan" } } })
  // An absent field is kept; tags: [] and color: null clear, and an empty record is removed.
  expect(await patch({ color: "red" })).toMatchObject({ ok: true, result: { metadata: { tags: ["auth", "needs-review"], color: "red" } } })
  expect(await h.client.send({ type: "session.get", sessionId: id })).toMatchObject({ ok: true, result: { session: { tags: ["auth", "needs-review"], color: "red" } } })
  expect(await patch({ tags: [], color: null })).toMatchObject({ ok: true })
  const cleared = await h.client.send({ type: "session.get", sessionId: id })
  expect(cleared.ok && cleared.result && (cleared.result as { session: Record<string, unknown> }).session).not.toHaveProperty("tags")
  expect(cleared.ok && cleared.result && (cleared.result as { session: Record<string, unknown> }).session).not.toHaveProperty("color")
  expect(h.store.agentCommands.getMetadata(id)).toBeUndefined()
  expect(await patch({ color: "magenta" })).toMatchObject({ ok: false })
  expect(await patch({ tags: ["x"] }, createIdFactory()("session"))).toMatchObject({ ok: false })
})

test("a session the user renamed is marked named, one titled by its first message is not", async () => {
  h = await boot({ steps: [stop("a"), stop("b")] })
  const id = await openSession(h)
  await say(h, id, "first message title")
  expect(await h.client.send({ type: "session.get", sessionId: id })).not.toMatchObject({ result: { session: { named: true } } })
  await h.client.send({ type: "session.rename", sessionId: id, title: "My title" })
  expect(await h.client.send({ type: "session.get", sessionId: id })).toMatchObject({ ok: true, result: { session: { title: "My title", named: true } } })
})

test("message search finds phrases and expressions in user and assistant text, scoped and bounded", async () => {
  h = await boot({ steps: [stop("the refund flow is in billing.ts"), stop("nothing relevant")] })
  const one = await openSession(h)
  await say(h, one, "please look at the Refund handler")
  const two = await openSession(h)
  await say(h, two, "unrelated chat")
  const find = (extra: Record<string, unknown>) => h!.client.send({ type: "session.search", ...extra } as never)
  const phrase = await find({ text: "refund" })
  expect(phrase).toMatchObject({ ok: true, result: { hits: [{ sessionId: one, snippet: expect.stringContaining("refund") }] } })
  expect(phrase.ok && (phrase.result as { hits: unknown[] }).hits).toHaveLength(1)
  expect(await find({ text: "REFUND FLOW", sessionIds: [one] })).toMatchObject({ ok: true, result: { hits: [{ sessionId: one }] } })
  expect(await find({ text: "refund", sessionIds: [two] })).toMatchObject({ ok: true, result: { hits: [] } })
  expect(await find({ text: "bill+ing\\.ts", regex: true })).toMatchObject({ ok: true, result: { hits: [{ sessionId: one }] } })
  expect(await find({ text: "(?=[\\s\\S]*refund)(?=[\\s\\S]*billing)", regex: true })).toMatchObject({ ok: true, result: { hits: [{ sessionId: one }] } })
  expect(await find({ text: "(?=[\\s\\S]*refund)(?=[\\s\\S]*unrelated)", regex: true })).toMatchObject({ ok: true, result: { hits: [] } })
  expect(await find({ text: "(", regex: true })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
  expect(await find({ text: "refund", limit: 1 })).toMatchObject({ ok: true, result: { hits: [{ sessionId: one }] } })
  expect(await find({ text: "" })).toMatchObject({ ok: false })
})

test("a remote client cannot search message text, and none of the new commands are read-only", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mendd-c7-remote-"))
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), listen: "127.0.0.1:0", engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  const local = createClient({ socketPath: daemon.socketPath, name: "local" })
  await local.connect()
  const token = remoteTokens(dir).create({ name: "full", readOnly: false }).token
  const remote = createClient({ name: "remote", remote: { hostname: "127.0.0.1", port: daemon.remotePort!, token } })
  await remote.connect()
  try {
    const found = await local.send({ type: "session.search", text: "anything" })
    expect(found).toMatchObject({ ok: true, result: { hits: [] } })
    const reply = await remote.send({ type: "session.search", text: "anything" } as never)
    expect(!reply.ok ? reply.error.code : "").toBe("forbidden")
    for (const type of ["session.search", "session.context-window"] as const) expect(isReadOnlyCommand(type)).toBe(false)
  } finally {
    remote.close()
    local.close()
    await daemon.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a context window override moves the reported window and compaction threshold, and reset goes back", async () => {
  h = await boot({ steps: [stop("done")] })
  const id = await openSession(h)
  await say(h, id, "size me")
  const before = await h.client.send({ type: "context.query", sessionId: id })
  expect(before).toMatchObject({ ok: true })
  expect(before.ok && (before.result as Record<string, unknown>).contextWindowOverride).toBeUndefined()
  expect(await h.client.send({ type: "session.context-window", sessionId: id, tokens: 50_000 })).toMatchObject({ ok: true, result: { contextWindow: 50_000 } })
  const during = await h.client.send({ type: "context.query", sessionId: id })
  expect(during).toMatchObject({ ok: true, result: { contextWindow: 50_000, contextWindowOverride: true } })
  expect(during.ok && (during.result as { compactAtTokens: number }).compactAtTokens).toBeLessThanOrEqual(50_000)
  expect(await h.client.send({ type: "session.context-window", sessionId: id, tokens: null })).toMatchObject({ ok: true })
  const after = await h.client.send({ type: "context.query", sessionId: id })
  expect(after.ok && (after.result as Record<string, unknown>).contextWindowOverride).toBeUndefined()
  expect(await h.client.send({ type: "session.context-window", sessionId: id, tokens: 10 })).toMatchObject({ ok: false })
  expect(await h.client.send({ type: "session.context-window", sessionId: createIdFactory()("session"), tokens: 5_000 })).toMatchObject({ ok: false, error: { code: "unknown_session" } })
})

test("the context report lists the files the history holds", async () => {
  h = await boot({ steps: [callTool("read", { path: "notes.txt" }, "call-read-1"), stop("read it")] })
  put(path.join(h.project, "notes.txt"), "line one\nline two\n")
  const id = await openSession(h)
  await say(h, id, "read the notes")
  const report = await h.client.send({ type: "context.query", sessionId: id })
  expect(report).toMatchObject({ ok: true, result: { files: [{ path: "notes.txt", reads: 1, edits: 0, tokens: expect.any(Number) }] } })
})

test("@agent in a prompt tells the model to delegate, while the transcript keeps what was typed", async () => {
  h = await boot({ steps: [stop("delegating")] })
  const id = await openSession(h)
  await say(h, id, "please ask @explore to find the router, thanks")
  const sent = JSON.stringify(h.requests[0]!.messages)
  expect(sent).toContain("<agent-mention name=\\\"explore\\\">")
  expect(sent).toContain("task tool")
  const shown = h.store.readAfter(id, 0).flatMap((event) => event.type === "item.completed" && event.text !== undefined ? [event.text] : [])
  expect(shown).toEqual(["please ask @explore to find the router, thanks", "delegating"])
})

test("an @name that is not a sub-agent is left alone", async () => {
  h = await boot({ steps: [stop("ok")] })
  const id = await openSession(h)
  await say(h, id, "look at @README.md and @build")
  expect(JSON.stringify(h.requests[0]!.messages)).not.toContain("agent-mention")
})

test("agent mentions are found only at word starts, once each, and only for known names", () => {
  const known = ["explore", "general"]
  expect(mentionedAgents("ask @explore, then @general. @explore again", known)).toEqual(["explore", "general"])
  expect(mentionedAgents("mail me@explore.com or @unknown or @explore-x", known)).toEqual([])
  expect(mentionedAgents("@explore", known)).toEqual(["explore"])
  expect(expandAgentMentions({ text: "no mention here", known })).toBe("no mention here")
  expect(expandAgentMentions({ text: "ask @general", known })).toBe(`ask @general\n\n<agent-mention name="general">The user addressed @general. Delegate the part of this request meant for it to the "general" sub-agent with the task tool (agent: "general") and use its result.</agent-mention>`)
})
