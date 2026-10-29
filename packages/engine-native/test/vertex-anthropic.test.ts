import { describe, expect, test } from "bun:test"
import { createApiProvider, fetchProviderModels, RetryableProviderError, vertexAnthropicRouting, type Fetch, type ModelEvent, type ModelMessage, type ModelRequest, type ResolvedProvider } from "../src"

const TOKEN = "vertex-claude-fixture-token-0123456789"
const MODEL = "claude-haiku-4-5@20251001"
const base: ResolvedProvider = { id: "google-vertex-anthropic", type: "google-vertex-anthropic", baseUrl: "http://127.0.0.1:9911/v1", apiKey: () => undefined, keyRequired: false, googleToken: async () => TOKEN, vertex: { project: "test-project", location: "global" }, models: [{ id: MODEL, images: true, cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1.25 } }] }
const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({ system: "Be brief", messages: [{ role: "user", content: "hi" }], tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }], signal: new AbortController().signal, ...over })
const collect = async (stream: AsyncIterable<ModelEvent>) => { const events: ModelEvent[] = []; for await (const event of stream) events.push(event); return events }
const sse = (events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""))
const answer = () => sse([{ type: "message_start", message: { usage: { input_tokens: 3 } } }, { type: "content_block_start", index: 0, content_block: { type: "text" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }, { type: "message_stop" }])
function setup(respond: (index: number) => Response = answer, over: Partial<ResolvedProvider> = {}) {
  const sent: { url: string; headers: Headers; body: Record<string, any>; redirect?: RequestRedirect }[] = []
  const fetch: Fetch = async (url, init) => { sent.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)), ...(init.redirect ? { redirect: init.redirect } : {}) }); return respond(sent.length - 1) }
  return { sent, fetch, provider: createApiProvider({ provider: { ...base, ...over }, fetch }) }
}

describe("B10.05 Vertex Anthropic native adapter", () => {
  test("v1 Claude project/location precedence differs from Gemini and defaults to global", () => {
    expect(vertexAnthropicRouting()).toEqual({ project: undefined, location: "global" })
    expect(vertexAnthropicRouting({}, { GOOGLE_CLOUD_PROJECT: "primary", GCP_PROJECT: "second", GCLOUD_PROJECT: "third", GOOGLE_VERTEX_LOCATION: "ignored", GOOGLE_CLOUD_LOCATION: "us-east5", VERTEX_LOCATION: "europe-west1" })).toEqual({ project: "primary", location: "us-east5" })
    expect(vertexAnthropicRouting({ project: "config", location: "global" }, { GOOGLE_CLOUD_PROJECT: "env" })).toEqual({ project: "config", location: "global" })
  })

  test("Vertex URL/version and bearer auth are authoritative; hooks, cache, images and output limits survive", async () => {
    const h = setup(answer, { headers: { "X-Team": "dev", authorization: "wrong", "x-api-key": "wrong" }, vertex: { ...base.vertex, quotaProject: "billing-project" }, models: [{ ...base.models[0]!, limit: { context: 200_000, output: 4000 }, options: { temperature: 0.2 } }] })
    const events = await collect(h.provider.stream(request({ cacheMode: "smart", effort: "high", headers: { Authorization: "wrong", "X-Request": "yes" }, transformBody: async (body) => ({ ...body, model: "wrong", anthropic_version: "wrong", stream: false, top_k: 4 }), messages: [{ role: "user", content: "look", images: [{ mime: "image/png", base64: "aW1hZ2U=" }] }] })))
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" })
    const wire = h.sent[0]!
    expect(wire.url).toBe(`${base.baseUrl}/projects/test-project/locations/global/publishers/anthropic/models/${MODEL}:streamRawPredict`)
    expect(wire.redirect).toBe("error")
    expect(wire.headers.get("authorization")).toBe(`Bearer ${TOKEN}`)
    expect(wire.headers.get("x-goog-user-project")).toBe("billing-project")
    for (const header of ["x-api-key", "anthropic-version", "x-goog-api-key"]) expect(wire.headers.has(header)).toBe(false)
    expect(wire.headers.get("x-team")).toBe("dev")
    expect(wire.body).toMatchObject({ anthropic_version: "vertex-2023-10-16", stream: true, max_tokens: 4000, temperature: 0.2, top_k: 4, thinking: { budget_tokens: 3999 } })
    expect(wire.body.model).toBeUndefined()
    expect(wire.body.tools[0]).toMatchObject({ name: "read", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } })
    expect(wire.body.messages[0].content[1]).toMatchObject({ type: "image", cache_control: { type: "ephemeral" } })
    expect(JSON.stringify(wire.body)).not.toContain(TOKEN)
  })

  test("fragmented SSE tools, signed thinking replay and cumulative usage including cache pricing", async () => {
    const h = setup((index) => index ? answer() : sse([
      { type: "message_start", message: { usage: { input_tokens: 30, cache_read_input_tokens: 20, cache_creation_input_tokens: 8 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Check ñ" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed-block" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_1", name: "read" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"file.ts"}' } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 10 } },
      { type: "message_stop" },
    ]))
    const events = await collect(h.provider.stream(request({ effort: "medium" })))
    expect(events).toContainEqual({ type: "reasoning", delta: "Check ñ" })
    expect(events).toContainEqual({ type: "usage", usage: { input: 30, output: 10, reasoning: 0, cacheRead: 20, cacheWrite: 8, costMicros: 62 } })
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool_calls" })
    const call = events.find((event) => event.type === "tool_call")
    const replay = events.find((event) => event.type === "reasoning_state")
    if (call?.type !== "tool_call" || replay?.type !== "reasoning_state") throw new Error("Missing tool/reasoning")
    expect(call.call).toEqual({ callId: "call_1", name: "read", args: { path: "file.ts" } })
    const messages: ModelMessage[] = [{ role: "user", content: "go" }, { role: "assistant", content: "", toolCalls: [call.call], reasoning: replay.state }, { role: "tool", callId: call.call.callId, name: "read", output: "contents", isError: false }]
    await collect(h.provider.stream(request({ messages, effort: "medium" })))
    expect(h.sent[1]!.body.messages[1].content[0]).toEqual({ type: "thinking", thinking: "Check ñ", signature: "signed-block" })
    expect(h.sent[1]!.body.messages[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "call_1", content: "contents" })
  })

  test("per-request token rotation, quota lookup, model override and offline refresh", async () => {
    let token = TOKEN, reads = 0, quotaReads = 0
    const h = setup(answer, { googleToken: async () => { reads++; return token }, googleQuotaProject: () => { quotaReads++; return "adc-quota" } })
    await collect(h.provider.stream(request()))
    token = "rotated-vertex-token-0123456789"
    await collect(h.provider.stream(request({ model: "claude-sonnet-4-5@20250929" })))
    expect(reads).toBe(2)
    expect(quotaReads).toBe(2)
    expect(h.sent[1]!.headers.get("authorization")).toBe(`Bearer ${token}`)
    expect(h.sent[1]!.headers.get("x-goog-user-project")).toBe("adc-quota")
    expect(h.sent[1]!.url).toContain("claude-sonnet-4-5@20250929:streamRawPredict")
    expect(await fetchProviderModels({ provider: base, fetch: h.fetch })).toEqual(base.models)
    expect(h.sent).toHaveLength(2)
  })

  test("auth errors never expose bare tokens; HTTP and SSE retry metadata are preserved", async () => {
    for (const status of [401, 403, 429, 503]) {
      const h = setup(() => new Response(`Denied ${TOKEN}`, { status, headers: { "retry-after": "3" } }))
      const error = await collect(h.provider.stream(request())).catch((error: Error) => error) as Error
      expect(error.message).not.toContain(TOKEN)
      if (status < 429) expect(error.message).toContain("rejected ADC credentials")
      else { expect(error).toBeInstanceOf(RetryableProviderError); expect((error as RetryableProviderError).retryAfterMs).toBe(3000) }
    }
    const h = setup(() => sse([{ type: "error", error: { type: "overloaded_error", message: TOKEN } }]))
    const error = await collect(h.provider.stream(request())).catch((error: Error) => error) as Error
    expect(error).toBeInstanceOf(RetryableProviderError)
    expect(error.message).not.toContain(TOKEN)
  })

  test("missing ADC, unsafe endpoints/model ids and cancellation never make an anonymous request", async () => {
    for (const over of [{ googleToken: async () => { throw new Error("[AUTH]: Vertex ADC is unavailable") } }, { baseUrl: "http://remote.example/v1" }, { vertex: { location: "global" } }, { googleToken: async () => "bad token" }]) {
      const h = setup(answer, over)
      await expect(collect(h.provider.stream(request()))).rejects.toThrow()
      expect(h.sent).toHaveLength(0)
    }
    for (const model of ["../escape", "claude?token=oops", "claude@version/escape"]) {
      const h = setup()
      await expect(collect(h.provider.stream(request({ model })))).rejects.toThrow("invalid Vertex Anthropic model")
      expect(h.sent).toHaveLength(0)
    }
    const controller = new AbortController(); controller.abort()
    const h = setup()
    await expect(collect(h.provider.stream(request({ signal: controller.signal })))).rejects.toThrow()
    expect(h.sent).toHaveLength(0)
    await expect(collect(setup(() => sse([])).provider.stream(request()))).rejects.toThrow("without completion")
  })

  test("public Anthropic still uses x-api-key, model body and Messages URL", async () => {
    const h = setup(answer, { id: "anthropic", type: "anthropic", apiKey: () => TOKEN, keyRequired: true })
    await collect(h.provider.stream(request()))
    expect(h.sent[0]!.url).toBe(`${base.baseUrl}/messages`)
    expect(h.sent[0]!.headers.get("x-api-key")).toBe(TOKEN)
    expect(h.sent[0]!.body.model).toBe(MODEL)
    expect(h.sent[0]!.body.anthropic_version).toBeUndefined()
  })
})
