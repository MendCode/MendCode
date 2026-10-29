import { describe, expect, test } from "bun:test"
import { createApiProvider, fetchProviderModels, mistralBaseUrl, mistralVariants, RetryableProviderError, type Fetch, type ModelRequest, type ResolvedProvider } from "../src"
import { collect, hangingSse, sse } from "./fake-server"

const KEY = "mistral-private-fixture-0123456789"
const request: ModelRequest = { system: "Be precise.", messages: [{ role: "user", content: "Hello" }], tools: [], signal: new AbortController().signal }
const resolved = (fields: Partial<ResolvedProvider> = {}): ResolvedProvider => ({ id: "mistral", type: "mistral", baseUrl: "http://127.0.0.1:1234/v1", apiKey: () => KEY, keyRequired: true, models: [{ id: "mistral-small-latest", images: true }], ...fields })
const finished = () => sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } }, "[DONE]"])

describe("B10.07 native Mistral", () => {
  test("streams text/thinking, fragmented parallel tools and usage with Mistral's own body", async () => {
    let body: any, headers: Headers | undefined
    const provider = createApiProvider({ provider: resolved({ headers: { Authorization: "never-use-this-header" }, parameters: { safePrompt: true, documentImageLimit: 4, documentPageLimit: 8, parallelToolCalls: false, seed: 9 }, models: [{ id: "mistral-small-latest", images: true, options: { temperature: 0.2 } }] }), fetch: async (url, init) => {
      expect(url).toBe("http://127.0.0.1:1234/v1/chat/completions")
      expect(init.redirect).toBe("error")
      headers = new Headers(init.headers)
      body = JSON.parse(String(init.body))
      return sse([
        { choices: [{ delta: { content: [{ type: "thinking", thinking: [{ type: "text", text: "Check." }] }, { type: "text", text: "Sí " }] } }] },
        { choices: [{ delta: { content: "✓", tool_calls: [{ index: 0, id: "abc123def", function: { name: "read", arguments: '{"file":' } }, { index: 1, id: "ghi456jkl", function: { name: "ls", arguments: "{}" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 42, completion_tokens: 11, total_tokens: 53 } }, "[DONE]",
      ], { chunkSize: 1 })
    } })
    const events = await collect(provider.stream({ ...request, effort: "high", tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }], parameters: { temperature: 0.4 } }))
    expect(headers!.get("authorization")).toBe(`Bearer ${KEY}`)
    expect(body).toMatchObject({ model: "mistral-small-latest", stream: true, safe_prompt: true, document_image_limit: 4, document_page_limit: 8, parallel_tool_calls: false, random_seed: 9, temperature: 0.4, reasoning_effort: "high", tools: [{ type: "function", function: { name: "read" } }], tool_choice: "auto" })
    expect(body.stream_options).toBeUndefined()
    expect(body.safePrompt).toBeUndefined()
    expect(events).toEqual([
      { type: "reasoning", delta: "Check." }, { type: "text", delta: "Sí " }, { type: "text", delta: "✓" },
      { type: "tool_call", call: { callId: "abc123def", name: "read", args: { file: "a.ts" } } },
      { type: "tool_call", call: { callId: "ghi456jkl", name: "ls", args: {} } },
      { type: "usage", usage: { input: 42, output: 11, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }, { type: "finish", reason: "tool_calls" },
    ])
  })

  test("replays paired tools with stable collision-free nine-character ids, names and tool→user alternation", async () => {
    let body: any
    const provider = createApiProvider({ provider: resolved(), fetch: async (_url, init) => {
      body = JSON.parse(String(init.body))
      return finished()
    } })
    const messages: ModelRequest["messages"] = [
      { role: "assistant", content: "", toolCalls: [{ callId: "call-foo!", name: "read", args: {} }, { callId: "call_foo?", name: "ls", args: {} }, { callId: "callfoo00", name: "grep", args: {} }] },
      { role: "tool", callId: "call-foo!", name: "read", output: "file", isError: false },
      { role: "tool", callId: "call_foo?", name: "ls", output: "list", isError: false },
      { role: "tool", callId: "callfoo00", name: "grep", output: "match", isError: false },
      { role: "user", content: "Continue" },
    ]
    const original = structuredClone(messages)
    await collect(provider.stream({ ...request, messages }))
    const calls = body.messages[1].tool_calls
    expect(new Set(calls.map((call: any) => call.id)).size).toBe(3)
    expect(calls.every((call: any) => /^[a-zA-Z0-9]{9}$/.test(call.id))).toBe(true)
    expect(calls[2].id).toBe("callfoo00")
    expect(body.messages.slice(2, 5).map((message: any) => message.tool_call_id)).toEqual(calls.map((call: any) => call.id))
    expect(body.messages.slice(2, 5).map((message: any) => message.name)).toEqual(["read", "ls", "grep"])
    expect(body.messages[1].content).toBe("")
    expect(body.messages[5]).toEqual({ role: "assistant", content: "Done." })
    expect(body.messages[6]).toEqual({ role: "user", content: [{ type: "text", text: "Continue" }] })
    expect(messages).toEqual(original)
    await collect(provider.stream({ ...request, messages: [{ role: "assistant", content: "Answer:", toolCalls: [] }] }))
    expect(body.messages.at(-1)).toEqual({ role: "assistant", content: "Answer:", prefix: true })
  })

  test("images and PDF files use Mistral content parts; incapable models never receive images", async () => {
    let body: any
    const provider = createApiProvider({ provider: resolved({ models: [{ id: "vision", images: true }, { id: "text", images: false }] }), fetch: async (_url, init) => {
      body = JSON.parse(String(init.body))
      return finished()
    } })
    const withFiles: ModelRequest = { ...request, model: "vision", messages: [{ role: "user", content: "Inspect", images: [{ mime: "image/png", base64: "aW1hZ2U=" }], documents: [{ mime: "application/pdf", base64: "cGRm", name: "brief.pdf" }] }], parameters: { documentPageLimit: 2 } }
    await collect(provider.stream(withFiles))
    expect(body.messages[1].content).toEqual([{ type: "text", text: "Inspect" }, { type: "image_url", image_url: "data:image/png;base64,aW1hZ2U=" }, { type: "document_url", document_url: "data:application/pdf;base64,cGRm" }])
    expect(body.document_page_limit).toBe(2)
    await collect(provider.stream({ ...withFiles, model: "text" }))
    expect(JSON.stringify(body)).not.toContain("aW1hZ2U=")
    expect(body.messages[1].content.at(-1)).toEqual({ type: "document_url", document_url: "data:application/pdf;base64,cGRm" })
  })

  test("structured JSON, safe/parallel flags and nested SDK options map to native fields", async () => {
    let body: any
    const provider = createApiProvider({ provider: resolved(), fetch: async (_url, init) => {
      body = JSON.parse(String(init.body))
      return finished()
    } })
    const schema = { type: "object", properties: { ok: { type: "boolean" } } }
    await collect(provider.stream({ ...request, effort: "medium", parameters: { mistral: { safePrompt: false, strictJsonSchema: true, reasoningEffort: "none" }, responseFormat: { type: "json", schema, name: "verdict", description: "Result" }, parallelToolCalls: true } }))
    expect(body).toMatchObject({ safe_prompt: false, reasoning_effort: "none", response_format: { type: "json_schema", json_schema: { schema, name: "verdict", description: "Result", strict: true } } })
    expect(body.parallel_tool_calls).toBeUndefined()
    expect(body.mistral).toBeUndefined()
    expect(body.responseFormat).toBeUndefined()
    await collect(provider.stream({ ...request, parameters: { responseFormat: { type: "json", schema }, structuredOutputs: false } }))
    expect(body.response_format).toEqual({ type: "json_object" })
    await collect(provider.stream({ ...request, parameters: { responseFormat: { type: "json" } } }))
    expect(body.messages[0].content).toContain("JSON")
    await collect(provider.stream({ ...request, effort: "medium" }))
    expect(body.reasoning_effort).toBeUndefined()
  })

  test("only v1's high variants are advertised; invalid options fail before HTTP", async () => {
    for (const id of ["mistral-small-2603", "mistral-small-latest", "mistral-medium-3.5", "mistral-medium-2604"]) expect(mistralVariants(id)).toEqual({ high: { effort: "high", parameters: { reasoningEffort: "high" } } })
    expect(mistralVariants("devstral-latest")).toEqual({})
    let calls = 0
    const provider = createApiProvider({ provider: resolved(), fetch: async () => {
      calls++
      return finished()
    } })
    for (const parameters of [{ reasoningEffort: "low" }, { safePrompt: "true" }, { documentPageLimit: -1 }, { seed: 1.5 }, { strictJsonSchema: "true" }, { structuredOutputs: "false" }]) await expect(collect(provider.stream({ ...request, parameters }))).rejects.toThrow()
    expect(calls).toBe(0)
  })

  test("model refresh uses authenticated GET, capabilities and context; no OCR or embeddings", async () => {
    const models = await fetchProviderModels({ provider: resolved({ headers: { Authorization: "wrong-token", "x-team": "local" } }), fetch: async (url, init) => {
      expect(url).toEndWith("/v1/models")
      expect(init.method).toBe("GET")
      expect(init.redirect).toBe("error")
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEY}`)
      return Response.json({ data: [{ id: "mistral-small-latest", name: "Small", max_context_length: 131_072, capabilities: { completion_chat: true, vision: true } }, { id: "devstral-latest", capabilities: { vision: false } }, { id: "mistral-embed" }, { id: "mistral-ocr-latest" }, { id: "not-chat", capabilities: { completion_chat: false } }, { id: "x".repeat(67) }] })
    } })
    expect(models.map((model) => model.id)).toEqual(["devstral-latest", "mistral-small-latest"])
    expect(models[1]).toMatchObject({ context: 131_072, images: true, effort: true, variants: { high: { parameters: { reasoningEffort: "high" } } } })
    expect(models[0]).toMatchObject({ images: false, effort: false })
  })

  test("token/headers stay redacted, HTTP failures retain retryability and redirects are rejected", async () => {
    const secret = "team-secret-fixture"
    for (const status of [401, 429, 500, 307]) {
      const provider = createApiProvider({ provider: resolved({ headers: { "x-team-token": secret } }), fetch: async (_url, init) => {
        expect(init.redirect).toBe("error")
        return new Response(`rejected ${KEY} ${secret}`, { status, headers: { "retry-after": "2" } })
      } })
      const error = await collect(provider.stream(request)).catch((error) => error)
      expect(error).toBeInstanceOf(Error)
      expect(error.message).not.toContain(KEY)
      expect(error.message).not.toContain(secret)
      expect(error instanceof RetryableProviderError).toBe(status === 429 || status === 500)
      if (status === 429 || status === 500) expect(error.retryAfterMs).toBe(2_000)
    }
    await expect(fetchProviderModels({ provider: resolved({ headers: { "x-team-token": secret } }), fetch: async () => new Response(`bad ${KEY} ${secret}`, { status: 500 }) })).rejects.toThrow("[redacted")
  })

  test("missing auth is never anonymous; rotated keys apply to the existing adapter", async () => {
    let key: string | undefined, calls = 0
    const tokens: string[] = []
    const provider = createApiProvider({ provider: resolved({ apiKey: () => key }), fetch: async (_url, init) => {
      calls++
      tokens.push(new Headers(init.headers).get("authorization")!)
      return finished()
    } })
    await expect(collect(provider.stream(request))).rejects.toThrow("no API key")
    expect(calls).toBe(0)
    key = KEY
    await collect(provider.stream(request))
    key = "rotated-private-fixture"
    await collect(provider.stream(request))
    expect(tokens).toEqual([`Bearer ${KEY}`, `Bearer ${key}`])
  })

  test("truncated/malformed and silent streams are bounded; caller cancellation finishes no answer", async () => {
    const truncated = createApiProvider({ provider: resolved(), fetch: async () => sse(["broken", { choices: [{ delta: { content: "partial" } }] }]) })
    await expect(collect(truncated.stream(request))).rejects.toBeInstanceOf(RetryableProviderError)
    const stalled = createApiProvider({ provider: resolved(), idleTimeoutMs: 20, fetch: async () => hangingSse([{ choices: [{ delta: { content: "partial" } }] }]) })
    await expect(collect(stalled.stream(request))).rejects.toBeInstanceOf(RetryableProviderError)
    const cancelled = createApiProvider({ provider: resolved(), fetch: async () => hangingSse([]) })
    const events = await collect(cancelled.stream({ ...request, signal: AbortSignal.timeout(20) }))
    expect(events.some((event) => event.type === "finish")).toBe(false)
  })

  test("endpoint credentials, cleartext remote hosts, query and fragments never pass validation", () => {
    for (const url of ["https://api.mistral.ai/v1", "http://127.0.0.1:1234/v1", "http://localhost:1234/v1", "http://[::1]:1234/v1"]) expect(mistralBaseUrl(url + "/")).toBe(url)
    for (const url of ["http://remote.example/v1", "https://user:secret@example.test/v1", "https://api.mistral.ai/v1?key=secret", "https://api.mistral.ai/v1#secret", "file:///tmp/key"]) expect(() => mistralBaseUrl(url)).toThrow()
  })
})
