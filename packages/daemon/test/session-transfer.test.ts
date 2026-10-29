import { afterEach, expect, test } from "bun:test"
import { writeFileSync, symlinkSync } from "node:fs"
import path from "node:path"
import { createIdFactory, SessionTranscript, SESSION_IMPORT_MAX_BYTES, type SessionTranscript as Transcript } from "@mendcode/protocol"
import { boot, stop, say, type NativeHarness } from "./native-harness"
import { createSessionTransfer, readSessionSource } from "../src/session-transfer"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
async function native() { const h = await boot({ steps: [stop("Continued")] }); cleanup.push(h.cleanup); return h }
const ids = createIdFactory()
function transcript(): Transcript {
  return { format: "mendcode-session@1", sessionId: "source-session", title: "Private client", directory: "/private/project", exportedAt: 2000, truncated: false,
    turns: [{ turnId: "source-turn", at: 1000, outcome: "completed", metadata: { provider: "scripted", model: "script-1", tokens: 23, durationMs: 500, input: 10, output: 13, cacheRead: 5, costMicros: 12, costComplete: true }, items: [
      { itemId: "user", kind: "user_message", text: "Read /private/plan.md", status: "ok", at: 1001, authorityText: "Original task", meta: { custom: "private" }, attachments: [{ name: "plan.png", mime: "image/png", bytes: 20 }] },
      { itemId: "thinking", kind: "reasoning", text: "Check client details", at: 1002 },
      { itemId: "tool", kind: "tool_call", text: "Private output", tool: "read", status: "ok", input: '{"path":"/private/plan.md"}', at: 1003, resultMeta: { exitCode: 0 } },
      { itemId: "assistant", kind: "agent_message", text: "Reviewed", status: "ok", at: 1004 },
    ] }],
  }
}
async function importValue(h: NativeHarness, value: unknown = transcript()) {
  const file = path.join(h.project, "transcript.json")
  writeFileSync(file, JSON.stringify(value))
  return h.client.importSession(file, h.project)
}

test("native JSON import remaps IDs, timestamps, parts and metadata; resumed model receives the conversation without executing imported tools", async () => {
  const h = await native()
  const imported = await importValue(h)
  expect(imported).toMatchObject({ ok: true, import: { sourceSessionId: "source-session", turns: 1, items: 4, attachmentFilesOmitted: 1 } })
  if (!imported.ok) throw new Error(imported.error.message)
  const id = imported.import.sessionId
  expect(h.store.sessionInfo(id)).toMatchObject({ title: "Private client", directory: h.project })
  expect(h.store.readAfter(id, 0)[0]?.at).toBe(1000)
  expect(h.store.turns.list(id)[0]?.at).toBe(1000)
  expect(h.requests).toHaveLength(0)
  const exported = await h.client.exportSession(id, { format: "json", reasoning: true, toolDetails: true, assistantMetadata: true, timestamps: true })
  if (!exported.ok) throw new Error(exported.error.message)
  const data = SessionTranscript.parse(JSON.parse(exported.export.text))
  expect(data.turns[0]).toMatchObject({ at: 1000, outcome: "completed", metadata: { provider: "scripted", model: "script-1", tokens: 23, durationMs: 500, input: 10, output: 13, cacheRead: 5, costMicros: 12, costComplete: true }, items: [{ kind: "user_message", authorityText: "Original task", attachments: [{ name: "plan.png", mime: "image/png", bytes: 20 }] }, { kind: "reasoning", text: "Check client details" }, { kind: "tool_call", input: '{"path":"/private/plan.md"}', resultMeta: { exitCode: 0 } }, { kind: "agent_message", text: "Reviewed" }] })
  expect(data.turns[0]?.turnId).not.toBe("source-turn")
  expect(data.turns[0]?.items[0]?.itemId).not.toBe("user")
  await say(h, id, "Continue")
  expect(h.store.readAfter(id, 0).filter((event) => event.type === "turn.failed")).toEqual([])
  expect(JSON.stringify(h.requests[0]?.messages)).toContain("Read /private/plan.md")
  expect(h.requests[0]?.messages.some((message) => message.role === "tool")).toBe(false)
  expect(h.store.queueOf(id)).toHaveLength(0)
})

test("sanitize hides arbitrary content and paths in JSON and Markdown; importing sanitized exports keeps markers", async () => {
  const h = await native()
  const imported = await importValue(h)
  if (!imported.ok) throw new Error(imported.error.message)
  for (const format of ["json", "markdown"] as const) {
    const exported = await h.client.exportSession(imported.import.sessionId, { format, sanitize: true, reasoning: true, toolDetails: true, assistantMetadata: true, timestamps: true })
    if (!exported.ok) throw new Error(exported.error.message)
    for (const privateText of ["Private client", "Read /private", "Original task", "Private output", "Reviewed", "Check client details", h.project, "plan.png", "script-1"]) expect(exported.export.text).not.toContain(privateText)
    expect(exported.export.text).toContain("[redacted:")
    if (format === "json") {
      const value = SessionTranscript.parse(JSON.parse(exported.export.text))
      expect(value.sanitized).toBe(true)
      expect(value.turns[0]?.items).toHaveLength(4)
      expect(await importValue(h, value)).toMatchObject({ ok: true, import: { sanitized: true } })
    }
  }
})

test("duplicates and unsupported/malformed/oversized JSON fail without writing a partial session or overwriting one", async () => {
  const h = await native()
  const first = await importValue(h)
  if (!first.ok) throw new Error(first.error.message)
  const count = h.store.listSessions({ roots: false }).length
  const duplicated = transcript()
  duplicated.turns[0]!.items.push(duplicated.turns[0]!.items[0]!)
  for (const bad of [duplicated, { info: {}, messages: [] }, { ...transcript(), format: "mendcode-session@99" }, { ...transcript(), turns: [{ ...transcript().turns[0], items: [{ ...transcript().turns[0]!.items[0], text: "x".repeat(65_537) }] }] }]) {
    expect(await importValue(h, bad)).toMatchObject({ ok: false })
    expect(h.store.listSessions({ roots: false })).toHaveLength(count)
  }
  writeFileSync(path.join(h.project, "bad.json"), "{")
  expect(await h.client.importSession("bad.json", h.project)).toMatchObject({ ok: false })
  writeFileSync(path.join(h.project, "big.json"), "x".repeat(SESSION_IMPORT_MAX_BYTES + 1))
  expect(await h.client.importSession("big.json", h.project)).toMatchObject({ ok: false, error: { message: expect.stringContaining("exceeds") } })
  symlinkSync(path.join(h.project, "transcript.json"), path.join(h.project, "link.json"))
  expect(await h.client.importSession("link.json", h.project)).toMatchObject({ ok: false })
  const second = await importValue(h)
  expect(second).toMatchObject({ ok: true })
  if (second.ok) expect(second.import.sessionId).not.toBe(first.import.sessionId)
  expect(h.store.sessionInfo(first.import.sessionId)?.title).toBe("Private client")
})

test("failed store event validation rolls back the entire import; unfinished turns become interrupted and clipped parts remain explicit", async () => {
  const h = await native()
  const count = h.store.listSessions({ roots: false }).length
  const bad = transcript()
  bad.turns[0]!.items[0]!.text = "x".repeat(65_536)
  bad.turns[0]!.items[0]!.authorityText = "x".repeat(65_536)
  expect(await importValue(h, bad)).toMatchObject({ ok: false })
  expect(h.store.listSessions({ roots: false })).toHaveLength(count)
  const unfinished = transcript()
  unfinished.turns[0]!.outcome = "running"
  unfinished.turns[0]!.items[1]!.truncated = true
  const result = await importValue(h, unfinished)
  if (!result.ok) throw new Error(result.error.message)
  expect(result.import.truncated).toBe(true)
  expect(h.store.lastTurnStatus(result.import.sessionId)).toBe("interrupted")
  const exported = await h.client.exportSession(result.import.sessionId, { format: "json" })
  expect(exported).toMatchObject({ ok: true, export: { truncated: true } })
})

test("credentials are redacted in imported text, authority, tool inputs, metadata and error details", async () => {
  const h = await native()
  const value = transcript()
  const secret = `sk-proj-${"A".repeat(40)}`
  value.turns[0]!.items[0]!.authorityText = secret
  value.turns[0]!.items[2]!.input = secret
  value.turns[0]!.items[2]!.meta = { custom: secret, [secret]: secret, marker: "‹secret:2›" }
  value.turns[0]!.outcome = "failed"
  value.turns[0]!.error = { code: "provider", message: secret }
  const imported = await importValue(h, value)
  if (!imported.ok) throw new Error(imported.error.message)
  expect(JSON.stringify(h.store.readAfter(imported.import.sessionId, 0))).not.toContain(secret)
  expect(JSON.stringify(h.store.engineMessages.load(imported.import.sessionId, "native"))).not.toContain(secret)
})

test("public JSON URL source uses no auth or redirects, bounds streams and refuses sharing/credential URLs (local fetch fake)", async () => {
  const requested: Array<{ url: string; init: RequestInit | undefined }> = []
  const request = (async (url: string | URL | Request, init?: RequestInit) => { requested.push({ url: String(url), init }); return new Response(JSON.stringify(transcript())) }) as typeof fetch
  expect(JSON.parse(await readSessionSource("https://example.invalid/session.json", "/unused", request))).toMatchObject({ format: "mendcode-session@1" })
  expect(requested[0]?.init).toMatchObject({ redirect: "error", credentials: "omit" })
  expect(requested[0]?.init?.headers).toBeUndefined()
  for (const url of ["https://user:password@example.invalid/data", "https://example.invalid/share/abc", "ftp://example.invalid/data"]) await expect(readSessionSource(url, "/unused", request)).rejects.toThrow()
  expect(requested).toHaveLength(1)
  const large = (async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(SESSION_IMPORT_MAX_BYTES + 1)); controller.close() } }))) as unknown as typeof fetch
  await expect(readSessionSource("https://example.invalid/data", "/unused", large)).rejects.toThrow("exceeds")
  const error = (async () => new Response("", { status: 404 })) as unknown as typeof fetch
  await expect(readSessionSource("https://example.invalid/data", "/unused", error)).rejects.toThrow("HTTP 404")
})


test("JSON includes retained full tool output, declarative rendering and reasoning; Markdown bounds remain visible", async () => {
  const h = await native()
  const sessionId = ids("session")
  const turnId = ids("turn")
  const toolId = ids("item")
  h.store.createSession({ id: sessionId, title: "Full parts", directory: h.project })
  h.store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
  const text = Array.from({ length: 240 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n")
  const blob = h.store.putBlob(new TextEncoder().encode(text), "text/plain")
  h.store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId: toolId, kind: "tool_call", meta: { tool: "probe" } })
  h.store.sessionSink.append({ type: "item.completed", sessionId, itemId: toolId, status: "ok", text: "preview", blob, render: { type: "text", text: "Tool summary" } })
  h.store.sessionSink.append({ type: "turn.completed", sessionId, turnId })
  const json = await h.client.exportSession(sessionId, { format: "json", toolDetails: true })
  if (!json.ok) throw new Error(json.error.message)
  const exported = SessionTranscript.parse(JSON.parse(json.export.text))
  expect(exported.turns[0]?.items[0]).toMatchObject({ text, render: { type: "text", text: "Tool summary" } })
  expect(json.export.truncated).toBe(false)
  const imported = await importValue(h, exported)
  if (!imported.ok) throw new Error(imported.error.message)
  const again = await h.client.exportSession(imported.import.sessionId, { format: "json", toolDetails: true })
  if (!again.ok) throw new Error(again.error.message)
  expect(SessionTranscript.parse(JSON.parse(again.export.text)).turns[0]?.items[0]).toMatchObject({ text, render: { type: "text", text: "Tool summary" } })
  const md = await h.client.exportSession(sessionId, { format: "markdown" })
  expect(md).toMatchObject({ ok: true, export: { truncated: true } })
})

test("a MendCode v1 export ({ info, messages }) imports as turns with its text, reasoning, tools, usage and failures", async () => {
  const h = await native()
  const v1 = {
    info: { id: "ses_v1", title: "Fix the parser", directory: "/old/project", time: { created: 1_000, updated: 9_000 } },
    messages: [
      { info: { id: "msg_1", role: "user", time: { created: 1_000 } }, parts: [{ type: "text", text: "Why does parse() fail?" }, { type: "file", filename: "log.txt", mime: "text/plain" }] },
      { info: { id: "msg_2", role: "assistant", providerID: "openai", modelID: "gpt-6-luna", time: { created: 1_100 }, tokens: { input: 40, output: 12, reasoning: 0, cache: { read: 8, write: 0 } } }, parts: [
        { type: "step-start" },
        { type: "reasoning", text: "Look at the tokenizer" },
        { type: "tool", tool: "read", callID: "c1", state: { status: "completed", input: { filePath: "src/parse.ts" }, output: "export function parse() {}" } },
        { type: "text", text: "The tokenizer drops the last token." },
      ] },
      { info: { id: "msg_3", role: "user", time: { created: 2_000 } }, parts: [{ type: "text", text: "Fix it" }] },
      { info: { id: "msg_4", role: "assistant", providerID: "openai", modelID: "gpt-6-luna", time: { created: 2_100 }, error: { name: "APIError", data: { message: "rate limited" } } }, parts: [{ type: "tool", tool: "edit", state: { status: "error", input: {}, error: "no match" } }] },
    ],
  }
  const imported = await importValue(h, v1)
  expect(imported).toMatchObject({ ok: true, import: { sourceSessionId: "mendcode-v1:ses_v1", turns: 2, items: 6, attachmentFilesOmitted: 1, from: "mendcode" } })
  if (!imported.ok) throw new Error(imported.error.message)
  const id = imported.import.sessionId
  expect(h.store.sessionInfo(id)).toMatchObject({ title: "Fix the parser", directory: h.project })
  const events = h.store.readAfter(id, 0)
  const texts = events.flatMap((event) => event.type === "item.completed" ? [event.text] : [])
  expect(texts).toEqual(["Why does parse() fail?", "Look at the tokenizer", "export function parse() {}", "The tokenizer drops the last token.", "Fix it", "no match"])
  expect(events.some((event) => event.type === "turn.failed")).toBe(true)
  expect(h.requests).toHaveLength(0)
  expect(await importValue(h, { info: { id: "empty" }, messages: [] })).toMatchObject({ ok: false, error: { message: expect.stringContaining("No messages") } })
})
