import { afterEach, describe, expect, test } from "bun:test"
import { createApiProvider, RetryableProviderError, type ModelEvent, type ModelRequest, type ResolvedProvider } from "../src"
import { collect, fakeServer, hangingSse, sse } from "./fake-server"

const KEY = "sk-proj-test-0123456789abcdefghijklmnop"
const stops: Array<() => void> = []
afterEach(() => stops.splice(0).forEach((stop) => stop()))

function setup(handler: Parameters<typeof fakeServer>[0], overrides: Partial<ResolvedProvider> = {}) {
  const server = fakeServer(handler)
  stops.push(server.stop)
  const provider = createApiProvider({
    provider: { id: "openai", type: "openai", baseUrl: `${server.url}/v1`, apiKey: () => KEY, keyRequired: true, models: [{ id: "gpt-test", images: false }], ...overrides },
  })
  return { server, provider }
}

const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({
  system: "be brief",
  messages: [{ role: "user", content: "hi" }],
  tools: [{ name: "read", description: "read a file", parameters: { type: "object" } }],
  signal: new AbortController().signal,
  ...overrides,
})

const TURN = [
  { type: "response.reasoning_summary_text.delta", delta: "look" },
  { type: "response.output_text.delta", delta: "Leyendo " },
  { type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "read", arguments: '{"path":"a.ts"}' } },
  { type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 60 }, output_tokens_details: { reasoning_tokens: 5 } } } },
]

describe("OpenAI API-key provider (Responses API)", () => {
  test("uses the Responses path with a bearer key, no session routing header, and only the hosted tools API hosts run", async () => {
    const { server, provider } = setup(() => sse(TURN))
    const events = await collect(provider.stream(request({ model: "gpt-x", effort: "high", cacheKey: "sess_1", hostedTools: ["web_search", "image_generation"] })))
    expect(events).toEqual([
      { type: "reasoning", delta: "look" },
      { type: "text", delta: "Leyendo " },
      { type: "tool_call", call: { callId: "c1", name: "read", args: { path: "a.ts" } } },
      { type: "usage", usage: { input: 40, output: 20, reasoning: 5, cacheRead: 60, cacheWrite: 0 } },
      { type: "finish", reason: "tool_calls" },
    ])
    const sent = server.requests[0]!
    expect(sent.path).toBe("/v1/responses")
    expect(sent.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(sent.headers.session_id).toBeUndefined()
    expect(sent.body).toMatchObject({ model: "gpt-x", stream: true, store: false, prompt_cache_key: "sess_1", reasoning: { effort: "high" } })
    expect(sent.body.tools.map((tool: { type: string }) => tool.type)).toEqual(["function", "web_search"])
  })

  test("a request without tools names no tool policy, and maxOutputTokens respects the API's floor of 16", async () => {
    const { server, provider } = setup(() => sse(TURN))
    await collect(provider.stream(request({ tools: [], maxOutputTokens: 8 })))
    const body = server.requests[0]!.body
    expect(body.tool_choice).toBeUndefined()
    expect(body.parallel_tool_calls).toBeUndefined()
    expect(body.max_output_tokens).toBe(16)
  })

  test("images are dropped with a note for a model configured without image input", async () => {
    const { server, provider } = setup(() => sse(TURN))
    await collect(provider.stream(request({ model: "gpt-test", messages: [{ role: "user", content: "look", images: [{ mime: "image/png", base64: "AAAA" }] }] })))
    expect(JSON.stringify(server.requests[0]!.body.input)).toContain("1 image omitted")
    expect(JSON.stringify(server.requests[0]!.body.input)).not.toContain("AAAA")
  })

  test("a tool result goes back as function_call_output and the final text follows", async () => {
    const { server, provider } = setup((_, index) => sse(index === 0 ? TURN : [{ type: "response.output_text.delta", delta: "done" }, { type: "response.completed", response: {} }]))
    await collect(provider.stream(request()))
    const second = await collect(
      provider.stream(
        request({
          messages: [
            { role: "user", content: "hi" },
            { role: "assistant", content: "", toolCalls: [{ callId: "c1", name: "read", args: { path: "a.ts" } }] },
            { role: "tool", callId: "c1", name: "read", output: "file text", isError: false },
          ],
        }),
      ),
    )
    expect(second).toEqual([{ type: "text", delta: "done" }, { type: "finish", reason: "stop" }])
    expect(server.requests[1]!.body.input.at(-1)).toEqual({ type: "function_call_output", call_id: "c1", output: "file text" })
  })

  test("429 with retry-after is retryable; the key never shows", async () => {
    const { provider } = setup(() => new Response(JSON.stringify({ error: { message: `slow down ${KEY}` } }), { status: 429, headers: { "retry-after": "4" } }))
    const error = await collect(provider.stream(request())).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RetryableProviderError)
    expect((error as RetryableProviderError).retryAfterMs).toBe(4_000)
    expect((error as Error).message).not.toContain(KEY)
  })

  test("401 is a clear final auth error without the key", async () => {
    const { provider } = setup(() => new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}` } }), { status: 401 }))
    const error = (await collect(provider.stream(request())).catch((e: unknown) => e)) as Error
    expect(error).not.toBeInstanceOf(RetryableProviderError)
    expect(error.message).toStartWith("[AUTH]: openai 401 rejected the API key")
    expect(error.message).not.toContain(KEY)
  })

  test("a missing key stops before any request", async () => {
    const { server, provider } = setup(() => sse(TURN), { apiKey: () => undefined })
    const error = (await collect(provider.stream(request())).catch((e: unknown) => e)) as Error
    expect(error.message).toStartWith("[AUTH]: no API key for openai")
    expect(server.requests).toHaveLength(0)
  })

  test("aborting mid-stream ends the iteration quietly", async () => {
    const { provider } = setup(() => hangingSse([{ type: "response.output_text.delta", delta: "partial" }]))
    const controller = new AbortController()
    const seen: ModelEvent[] = []
    for await (const event of provider.stream(request({ signal: controller.signal }))) {
      seen.push(event)
      controller.abort()
    }
    expect(seen).toEqual([{ type: "text", delta: "partial" }])
  })
})

describe("createApiProvider picks the wire format", () => {
  test("anthropic and openai-compatible entries reach their own endpoints", async () => {
    const paths: string[] = []
    const server = fakeServer((recorded) => {
      paths.push(recorded.path)
      return sse([{ type: "message_stop" }])
    })
    stops.push(server.stop)
    for (const type of ["anthropic", "openai-compatible"] as const) {
      const provider = createApiProvider({ provider: { id: type, type, baseUrl: server.url, apiKey: () => KEY, keyRequired: true, models: [] } })
      await collect(provider.stream(request({ model: "m" }))).catch(() => {})
    }
    expect(paths).toEqual(["/messages", "/chat/completions"])
  })
})
