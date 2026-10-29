import { expect, test } from "bun:test"
import { createAnthropicProvider, createChatCompletionsProvider, createResponsesProvider, type ModelProvider, type ModelRequest } from "../src"

const request = (): ModelRequest => ({ system: "local", messages: [{ role: "user", content: "hello" }], tools: [], signal: new AbortController().signal })
async function collect(provider: ModelProvider, input: ModelRequest) { const events = []; for await (const event of provider.stream(input)) events.push(event); return events }
const forbidden = async (): Promise<Response> => { throw new Error("default transport must not run") }

test("Responses auth plugin supplies both headers and transport without a subscription login", async () => {
  const seen: RequestInit[] = []
  const provider = createResponsesProvider({ id: "local", model: "local-model", baseUrl: "http://127.0.0.1:1", headers: async () => { throw new Error("default login must not run") }, fetch: forbidden })
  const events = await collect(provider, { ...request(), headers: { authorization: "Bearer test-private" }, fetch: async (_url, input) => {
    seen.push(input)
    return new Response('data: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.completed","response":{"status":"completed","model":"local-model","output":[]}}\n\n', { headers: { "content-type": "text/event-stream" } })
  } })
  expect(new Headers(seen[0]!.headers).get("authorization")).toBe("Bearer test-private")
  expect(events).toContainEqual({ type: "text", delta: "ok" })
})

test("compatible auth plugin transport works without an environment key", async () => {
  const seen: RequestInit[] = []
  const provider = createChatCompletionsProvider({ id: "local", model: "local-model", baseUrl: "http://127.0.0.1:1", requireKey: true, apiKey: () => undefined, fetch: forbidden })
  const events = await collect(provider, { ...request(), headers: { authorization: "Bearer test-private" }, fetch: async (_url, input) => {
    seen.push(input)
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } })
  } })
  expect(new Headers(seen[0]!.headers).get("authorization")).toBe("Bearer test-private")
  expect(events).toContainEqual({ type: "text", delta: "ok" })
})

test("Anthropic plugin key/transport bypass the missing default key without a network call", async () => {
  const seen: RequestInit[] = []
  const provider = createAnthropicProvider({ id: "local", model: "local-model", apiKey: () => undefined, fetch: forbidden })
  const events = await collect(provider, { ...request(), headers: { "x-api-key": "test-private" }, fetch: async (_url, input) => {
    seen.push(input)
    return new Response('data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\ndata: {"type":"message_stop"}\n\n', { headers: { "content-type": "text/event-stream" } })
  } })
  expect(new Headers(seen[0]!.headers).get("x-api-key")).toBe("test-private")
  expect(events).toContainEqual({ type: "text", delta: "ok" })
})
