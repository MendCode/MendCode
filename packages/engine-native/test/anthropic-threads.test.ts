import { afterEach, describe, expect, test } from "bun:test"
import { MESSAGE_THREADS_BETA, anthropicOwnHost, createAnthropicProvider, type ModelMessage, type ModelRequest } from "../src"
import { collect, fakeServer, sse, type Recorded } from "./fake-server"

const KEY = "sk-ant-test-0123456789abcdefghijklmnop"
const stops: Array<() => void> = []
afterEach(() => stops.splice(0).forEach((stop) => stop()))

type Answer = Response | ((request: Recorded) => Response)
/** A provider on a fake host that answers each request with the next of `answers` (the last one repeats). */
function setup(answers: Answer[]) {
  const server = fakeServer((request, index) => {
    const answer = answers[Math.min(index, answers.length - 1)]!
    return typeof answer === "function" ? answer(request) : answer.clone()
  })
  stops.push(server.stop)
  const provider = createAnthropicProvider({ id: "anthropic", model: "claude-test", apiKey: () => KEY, baseUrl: `${server.url}/v1`, messageThreads: true })
  return { server, provider }
}

/** One finished answer with this id: `text`, then the tool calls named in `tools`. */
function reply(id: string, text: string, options: { tools?: string[]; stop?: string; finished?: boolean } = {}) {
  const events: unknown[] = [
    { type: "message_start", message: { id, usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
  ]
  for (const [offset, callId] of (options.tools ?? []).entries()) {
    events.push(
      { type: "content_block_start", index: offset + 1, content_block: { type: "tool_use", id: callId, name: "read", input: {} } },
      { type: "content_block_delta", index: offset + 1, delta: { type: "input_json_delta", partial_json: '{"path":"a.ts"}' } },
      { type: "content_block_stop", index: offset + 1 },
    )
  }
  events.push({ type: "message_delta", delta: { stop_reason: options.stop ?? (options.tools?.length ? "tool_use" : "end_turn") }, usage: { output_tokens: 5 } })
  if (options.finished !== false) events.push({ type: "message_stop" })
  return sse(events, { named: true })
}

const threadError = (status: number, code: string, unsupported?: string) =>
  new Response(JSON.stringify({ type: "error", error: { type: status === 404 ? "not_found_error" : "invalid_request_error", message: "thread", details: { error_code: code, ...(unsupported ? { unsupported } : {}) } } }), { status, headers: { "content-type": "application/json" } })

const TOOLS = [{ name: "read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }]
const request = (messages: ModelMessage[], overrides: Partial<ModelRequest> = {}): ModelRequest => ({
  system: "be brief",
  messages,
  tools: TOOLS,
  conversationId: "s1",
  messageThreads: true,
  signal: new AbortController().signal,
  ...overrides,
})

const hi: ModelMessage = { role: "user", content: "hi" }
const hello: ModelMessage = { role: "assistant", content: "hello", toolCalls: [] }
const next: ModelMessage = { role: "user", content: "next" }
const thanks: ModelMessage = { role: "assistant", content: "sure", toolCalls: [] }
const more: ModelMessage = { role: "user", content: "more" }

describe("Anthropic message threads", () => {
  test("the first request creates a thread with the beta header; the next one sends only its new message and continues from the reply's id", async () => {
    const { server, provider } = setup([reply("msg_1", "hello"), reply("msg_2", "sure")])
    await collect(provider.stream(request([hi])))
    await collect(provider.stream(request([hi, hello, next])))
    const [create, follow] = server.requests
    expect(create!.headers["anthropic-beta"]).toBe(MESSAGE_THREADS_BETA)
    expect(create!.body.thread).toEqual({ type: "create" })
    expect(create!.body.system).toBeDefined()
    expect(create!.body.tools).toHaveLength(1)
    expect(follow!.headers["anthropic-beta"]).toBe(MESSAGE_THREADS_BETA)
    expect(follow!.body.thread).toEqual({ type: "continue", previous_message_id: "msg_1" })
    expect(follow!.body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "next", cache_control: { type: "ephemeral" } }] }])
    // Create-only fields stay out of a continue; the fixed ones are sent again unchanged.
    expect("system" in follow!.body).toBe(false)
    expect("tools" in follow!.body).toBe(false)
    expect(follow!.body.tool_choice).toEqual(create!.body.tool_choice)
    expect(follow!.body.model).toBe(create!.body.model)
  })

  test("a tool loop continues with the tool results alone", async () => {
    const { server, provider } = setup([reply("msg_1", "reading", { tools: ["toolu_1"] }), reply("msg_2", "done")])
    await collect(provider.stream(request([hi])))
    const called: ModelMessage = { role: "assistant", content: "reading", toolCalls: [{ callId: "toolu_1", name: "read", args: { path: "a.ts" } }] }
    await collect(provider.stream(request([hi, called, { role: "tool", callId: "toolu_1", name: "read", output: "file", isError: false }])))
    const follow = server.requests[1]!
    expect(follow.body.thread).toEqual({ type: "continue", previous_message_id: "msg_1" })
    expect(follow.body.messages).toHaveLength(1)
    expect(follow.body.messages[0].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1", content: "file" })
  })

  test("a 404 thread_not_found sends the whole conversation again in a new thread, and the turn after continues from that one", async () => {
    const { server, provider } = setup([reply("msg_1", "hello"), threadError(404, "thread_not_found"), reply("msg_2", "sure"), reply("msg_3", "ok")])
    await collect(provider.stream(request([hi])))
    const events = await collect(provider.stream(request([hi, hello, next])))
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" })
    const replay = server.requests[2]!
    expect(replay.body.thread).toEqual({ type: "create" })
    expect(replay.body.messages).toHaveLength(3)
    expect(replay.body.system).toBeDefined()
    await collect(provider.stream(request([hi, hello, next, thanks, more])))
    expect(server.requests[3]!.body.thread).toEqual({ type: "continue", previous_message_id: "msg_2" })
    expect(server.requests[3]!.body.messages).toHaveLength(1)
  })

  test("any other thread error on a continue (already continued, a 400 without a code) also replays in full", async () => {
    for (const failure of [threadError(400, "thread_already_continued"), threadError(400, "thread_continue_in_flight"), new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad thread" } }), { status: 400 })]) {
      const { server, provider } = setup([reply("msg_1", "hello"), failure, reply("msg_2", "sure")])
      await collect(provider.stream(request([hi])))
      await collect(provider.stream(request([hi, hello, next])))
      expect(server.requests.map((sent) => sent.body.thread?.type)).toEqual(["create", "continue", "create"])
      expect(server.requests[2]!.body.messages).toHaveLength(3)
    }
  })

  test("not found again right after a replay: the conversation goes on without a thread", async () => {
    const { server, provider } = setup([reply("msg_1", "hello"), threadError(404, "thread_not_found"), reply("msg_2", "sure"), threadError(404, "thread_not_found"), reply("msg_3", "ok"), reply("msg_4", "fine")])
    await collect(provider.stream(request([hi])))
    await collect(provider.stream(request([hi, hello, next])))
    await collect(provider.stream(request([hi, hello, next, thanks, more])))
    expect(server.requests.map((sent) => sent.body.thread?.type)).toEqual(["create", "continue", "create", "continue", undefined])
    expect(server.requests[4]!.headers["anthropic-beta"]).toBeUndefined()
    await collect(provider.stream(request([hi, hello, next, thanks, more, { role: "assistant", content: "ok", toolCalls: [] }, { role: "user", content: "again" }])))
    expect(server.requests[5]!.body.thread).toBeUndefined()
  })

  test("thread_unsupported_request sends the request without a thread, and the conversation stays without one", async () => {
    const { server, provider } = setup([threadError(400, "thread_unsupported_request", "hipaa"), reply("msg_1", "hello"), reply("msg_2", "sure")])
    await collect(provider.stream(request([hi])))
    await collect(provider.stream(request([hi, hello, next])))
    // HIPAA readiness holds for the whole organization: another conversation does not try either.
    await collect(provider.stream(request([hi], { conversationId: "s2" })))
    expect(server.requests.map((sent) => sent.body.thread?.type)).toEqual(["create", undefined, undefined, undefined])
  })

  test("after a compaction, an undo or a retraction (history no longer extends the thread) a new thread starts", async () => {
    const { server, provider } = setup([reply("msg_1", "hello"), reply("msg_2", "sure"), reply("msg_3", "ok"), reply("msg_4", "fine")])
    await collect(provider.stream(request([hi])))
    await collect(provider.stream(request([hi, hello, next])))
    // Compaction: the history is a summary now.
    await collect(provider.stream(request([{ role: "user", content: "Summary of the conversation so far." }, { role: "assistant", content: "noted", toolCalls: [] }, more])))
    // Undo: back to the first exchange with another follow-up.
    await collect(provider.stream(request([hi, hello, { role: "user", content: "instead" }])))
    expect(server.requests.map((sent) => sent.body.thread?.type)).toEqual(["create", "continue", "create", "create"])
  })

  test("a reply that differs from the one the thread stored (edited, retracted) starts a new thread", async () => {
    const { server, provider } = setup([reply("msg_1", "hello"), reply("msg_2", "sure")])
    await collect(provider.stream(request([hi])))
    await collect(provider.stream(request([hi, { role: "assistant", content: "hello, edited", toolCalls: [] }, next])))
    expect(server.requests.map((sent) => sent.body.thread?.type)).toEqual(["create", "create"])
  })

  test("a changed tool list (tool_search adding tools) or system prompt starts a new thread", async () => {
    const { server, provider } = setup([reply("msg_1", "hello"), reply("msg_2", "sure"), reply("msg_3", "ok")])
    await collect(provider.stream(request([hi])))
    await collect(provider.stream(request([hi, hello, next], { tools: [...TOOLS, { name: "grep", description: "search", parameters: { type: "object", properties: {} } }] })))
    await collect(provider.stream(request([hi, hello, next, thanks, more], { system: "be brief. new rule" })))
    expect(server.requests.map((sent) => sent.body.thread?.type)).toEqual(["create", "create", "create"])
    expect(server.requests[1]!.body.tools).toHaveLength(2)
  })

  test("the first image of a conversation starts a new thread; a later one continues", async () => {
    const image = { mime: "image/png", base64: "iVBORw0KGgo=" }
    const { server, provider } = setup([reply("msg_1", "hello"), reply("msg_2", "a cat"), reply("msg_3", "a dog")])
    await collect(provider.stream(request([hi])))
    const withImage: ModelMessage = { role: "user", content: "what is this", images: [image] }
    await collect(provider.stream(request([hi, hello, withImage])))
    await collect(provider.stream(request([hi, hello, withImage, { role: "assistant", content: "a cat", toolCalls: [] }, { role: "user", content: "and this", images: [image] }])))
    expect(server.requests.map((sent) => sent.body.thread?.type)).toEqual(["create", "create", "continue"])
  })

  test("a thread is continued only after message_stop: a stream that ended before it leaves nothing to continue", async () => {
    const { server, provider } = setup([reply("msg_1", "hello", { finished: false }), reply("msg_1b", "hello"), reply("msg_2", "sure")])
    await collect(provider.stream(request([hi]))).catch(() => undefined)
    await collect(provider.stream(request([hi])))
    await collect(provider.stream(request([hi, hello, next])))
    expect(server.requests.map((sent) => sent.body.thread?.type)).toEqual(["create", "create", "continue"])
    expect(server.requests[2]!.body.thread.previous_message_id).toBe("msg_1b")
  })

  test("a refusal is not continued", async () => {
    const { server, provider } = setup([reply("msg_1", "no", { stop: "refusal" }), reply("msg_2", "sure")])
    await collect(provider.stream(request([hi])))
    await collect(provider.stream(request([hi, { role: "assistant", content: "no", toolCalls: [] }, next])))
    expect(server.requests.map((sent) => sent.body.thread?.type)).toEqual(["create", "create"])
  })

  test("a continue in smart cache mode carries at most four breakpoints, counting the create request's system and tools", async () => {
    const { server, provider } = setup([reply("msg_1", "reading", { tools: ["toolu_1", "toolu_2"] }), reply("msg_2", "done")])
    await collect(provider.stream(request([hi], { cacheMode: "smart" })))
    const called: ModelMessage = { role: "assistant", content: "reading", toolCalls: [{ callId: "toolu_1", name: "read", args: {} }, { callId: "toolu_2", name: "read", args: {} }] }
    await collect(provider.stream(request([hi, called, { role: "tool", callId: "toolu_1", name: "read", output: "a", isError: false }, { role: "tool", callId: "toolu_2", name: "read", output: "b", isError: false }], { cacheMode: "smart" })))
    const [create, follow] = server.requests
    const marks = (blocks: unknown) => (Array.isArray(blocks) ? blocks.filter((block) => block.cache_control).length : 0)
    const fixed = marks(create!.body.system) + marks(create!.body.tools)
    const sent = (follow!.body.messages as Array<{ content: unknown }>).reduce((sum, message) => sum + marks(message.content), 0)
    expect(follow!.body.thread.type).toBe("continue")
    expect(fixed + sent).toBeLessThanOrEqual(4)
    expect(sent).toBeGreaterThanOrEqual(1)
  })

  test("without messageThreads (feature off, zeroDataRetention), on a gateway host or with a bearer login, no thread is sent", async () => {
    const { server, provider } = setup([reply("msg_1", "hello")])
    await collect(provider.stream(request([hi], { messageThreads: false })))
    await collect(provider.stream(request([hi], { headers: { authorization: "Bearer token" } })))
    await collect(provider.stream(request([hi], { conversationId: undefined as unknown as string })))
    for (const sent of server.requests) {
      expect(sent.body.thread).toBeUndefined()
      expect(sent.headers["anthropic-beta"]).toBeUndefined()
    }
    const gateway = fakeServer(() => reply("msg_1", "hello"))
    stops.push(gateway.stop)
    const plain = createAnthropicProvider({ id: "anthropic", model: "claude-test", apiKey: () => KEY, baseUrl: `${gateway.url}/v1` })
    await collect(plain.stream(request([hi])))
    expect(gateway.requests[0]!.body.thread).toBeUndefined()
    expect(anthropicOwnHost(undefined)).toBe(true)
    expect(anthropicOwnHost("https://api.anthropic.com/v1")).toBe(true)
    expect(anthropicOwnHost("https://gateway.example.com/anthropic/v1")).toBe(false)
  })

  test("through the real engine, a tool loop and the next user turn (with signed thinking) each continue the thread", async () => {
    const thinking = (index: number) => [
      { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: "plan " } },
      { type: "content_block_delta", index, delta: { type: "signature_delta", signature: `sig${index}` } },
      { type: "content_block_stop", index },
    ]
    const answer = (id: string, text: string, call?: string) => sse([
      { type: "message_start", message: { id, usage: { input_tokens: 10, output_tokens: 1 } } },
      ...thinking(0),
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 1 },
      ...(call ? [{ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: call, name: "read", input: {} } }, { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path":"a.ts"}' } }, { type: "content_block_stop", index: 2 }] : []),
      { type: "message_delta", delta: { stop_reason: call ? "tool_use" : "end_turn" }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ], { named: true })
    const script = [answer("msg_1", "Reading.", "toolu_1"), answer("msg_2", "It is a file."), answer("msg_3", "Done.")]
    const server = fakeServer((_request, index) => script[index]!)
    stops.push(server.stop)
    const { defineTool } = await import("@mendcode/tools")
    const { z } = await import("zod")
    const { createNativeEngine, memoryHistory } = await import("../src")
    const { ids, turn } = await import("./harness")
    const engine = createNativeEngine({
      provider: createAnthropicProvider({ id: "anthropic", model: "claude-test", apiKey: () => KEY, baseUrl: `${server.url}/v1`, messageThreads: true }),
      tools: [defineTool({ name: "read", description: "read", permission: "read", args: z.object({ path: z.string().optional() }), execute: async () => ({ output: "contents", truncated: false, title: "read", isError: false }) })],
      history: memoryHistory(),
      cwdFor: () => "/repo",
      system: () => "You are a coding agent.",
      compactionPrompt: "Summarize",
      messageThreads: () => true,
    })
    const sessionId = ids("session")
    await engine.runTurn(turn({ text: "what is a.ts", sessionId, mode: () => "full" }).input)
    await engine.runTurn(turn({ text: "thanks", sessionId, mode: () => "full" }).input)
    expect(server.requests.map((sent) => sent.body.thread)).toEqual([{ type: "create" }, { type: "continue", previous_message_id: "msg_1" }, { type: "continue", previous_message_id: "msg_2" }])
    expect(server.requests[2]!.body.messages).toHaveLength(1)
  })

  test("a beta the provider already sends is kept next to the threads beta", async () => {
    const server = fakeServer(() => reply("msg_1", "hello"))
    stops.push(server.stop)
    const provider = createAnthropicProvider({ id: "anthropic", model: "claude-test", apiKey: () => KEY, baseUrl: `${server.url}/v1`, headers: { "anthropic-beta": "other-2026-01-01" }, messageThreads: true })
    await collect(provider.stream(request([hi])))
    expect(server.requests[0]!.headers["anthropic-beta"]).toBe(`other-2026-01-01,${MESSAGE_THREADS_BETA}`)
  })
})
