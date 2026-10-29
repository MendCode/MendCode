import { describe, expect, test } from "bun:test"
import { createApiProvider, fetchProviderModels, geminiVariants, RetryableProviderError, testProvider, toGeminiContents, type Fetch, type ModelEvent, type ModelMessage, type ModelRequest, type ResolvedProvider } from "../src"

const KEY = "gemini-fixture-never-print-0123456789"
const base: ResolvedProvider = { id: "google", type: "google", baseUrl: "http://127.0.0.1:1234/v1beta", apiKey: () => KEY, keyRequired: true, models: [{ id: "gemini-2.5-flash", images: true }] }
const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({ system: "Be brief", messages: [{ role: "user", content: "hi" }], tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } }], signal: new AbortController().signal, ...over })
const collect = async (stream: AsyncIterable<ModelEvent>) => { const events: ModelEvent[] = []; for await (const event of stream) events.push(event); return events }
const sse = (chunks: unknown[]) => new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join(""), { headers: { "content-type": "text/event-stream" } })
const answer = () => sse([{ candidates: [{ index: 0, content: { parts: [{ text: "done" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } }])
function setup(respond: (index: number) => Response | Promise<Response>, over: Partial<ResolvedProvider> = {}) {
  const sent: { url: string; headers: Headers; body: Record<string, any>; signal: AbortSignal }[] = []
  const fetch: Fetch = async (url, init) => { sent.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)), signal: init.signal! }); return respond(sent.length - 1) }
  return { sent, provider: createApiProvider({ provider: { ...base, ...over }, fetch }), fetch }
}

describe("B10.03 native Gemini", () => {
  test("native request, UTF-8 SSE, thoughts, primary candidate and cumulative usage", async () => {
    const { provider, sent } = setup(() => {
      const text = [
        { candidates: [{ index: 0, content: { parts: [{ text: "Consider ñ", thought: true }] } }, { index: 1, content: { parts: [{ text: "ignore" }] } }] },
        { candidates: [{ index: 0, content: { parts: [{ text: "Hello ñ", thoughtSignature: "signed" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 7, cachedContentTokenCount: 60 } },
        { usageMetadata: { candidatesTokenCount: 12 } },
      ].map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join("")
      const bytes = new TextEncoder().encode(text)
      return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3)); controller.close() } }))
    })
    const events = await collect(provider.stream(request({ effort: "high", maxOutputTokens: 500 })))
    expect(events.filter((event) => event.type === "text" || event.type === "reasoning")).toEqual([{ type: "reasoning", delta: "Consider ñ" }, { type: "text", delta: "Hello ñ" }])
    expect(events.find((event) => event.type === "usage")).toEqual({ type: "usage", usage: { input: 40, output: 19, reasoning: 7, cacheRead: 60, cacheWrite: 0 } })
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" })
    const wire = sent[0]!
    expect(wire.url).toBe(`${base.baseUrl}/models/gemini-2.5-flash:streamGenerateContent?alt=sse`)
    expect(wire.url).not.toContain(KEY)
    expect(wire.headers.get("x-goog-api-key")).toBe(KEY)
    expect(wire.headers.get("authorization")).toBeNull()
    expect(wire.body).toMatchObject({ contents: [{ role: "user", parts: [{ text: "hi" }] }], systemInstruction: { parts: [{ text: "Be brief" }] }, tools: [{ functionDeclarations: [{ name: "read", parametersJsonSchema: request().tools[0]!.parameters }] }], toolConfig: { functionCallingConfig: { mode: "AUTO" } }, generationConfig: { temperature: 1, topP: 0.95, topK: 64, maxOutputTokens: 500, thinkingConfig: { includeThoughts: true, thinkingBudget: 16_000 } } })
    expect(wire.body).not.toHaveProperty("messages")
    expect(wire.body).not.toHaveProperty("model")
  })

  test("parallel tools round trip preserves every signed part without merging or adding wire ids", async () => {
    const parts = [{ text: "Working", thought: true, thoughtSignature: "think" }, { text: "Read files", thoughtSignature: "text" }, { functionCall: { name: "read", args: { path: "a.ts" } }, thoughtSignature: "call" }, { functionCall: { id: "wire-2", name: "read", args: { path: "b.ts" } } }]
    const { provider, sent } = setup((index) => index === 0 ? sse([{ candidates: [{ content: { parts }, finishReason: "STOP" }] }]) : answer())
    const first = await collect(provider.stream(request({ model: "gemini-3.1-pro" })))
    const calls = first.filter((event): event is Extract<ModelEvent, { type: "tool_call" }> => event.type === "tool_call")
    const state = first.find((event) => event.type === "reasoning_state")
    if (state?.type !== "reasoning_state") throw new Error("missing replay")
    expect(calls).toHaveLength(2)
    expect(calls[0]!.call.callId).not.toBe(calls[1]!.call.callId)
    expect(state.state.blocks).toEqual(parts)
    const messages: ModelMessage[] = [{ role: "user", content: "go" }, { role: "assistant", content: "Read files", toolCalls: calls.map((event) => event.call), reasoning: state.state }, ...calls.map((event, index): ModelMessage => ({ role: "tool", callId: event.call.callId, name: event.call.name, output: index === 0 ? "file text" : "denied", isError: index === 1 }))]
    expect((await collect(provider.stream(request({ model: "gemini-3.1-pro", messages })))).at(-1)).toEqual({ type: "finish", reason: "stop" })
    expect(sent[1]!.body.contents[1]).toEqual({ role: "model", parts })
    expect(sent[1]!.body.contents[2]).toEqual({ role: "user", parts: [{ functionResponse: { name: "read", response: { output: "file text" } } }, { functionResponse: { id: "wire-2", name: "read", response: { error: "denied" } } }] })
  })

  test("foreign or restarted history repairs missing results and never replays another model's signatures", () => {
    const messages: ModelMessage[] = [{ role: "assistant", content: "before", toolCalls: [{ callId: "c", name: "read", args: { path: "a" } }], reasoning: { provider: "google", model: "other", blocks: [{ text: "private", thoughtSignature: "foreign" }] } }, { role: "user", content: "next" }, { role: "tool", callId: "orphan", name: "read", output: "orphan", isError: false }]
    const contents = toGeminiContents(messages, "gemini-3-pro")
    expect(contents[0]!.role).toBe("user")
    expect(contents[1]!.parts[1]).toEqual({ functionCall: { id: "c", name: "read", args: { path: "a" } }, thoughtSignature: "skip_thought_signature_validator" })
    expect(contents[2]!.parts[0]).toEqual({ functionResponse: { id: "c", name: "read", response: { error: "cancelled" } } })
    expect(JSON.stringify(contents)).not.toMatch(/private|foreign|orphan/)
  })

  test("images and PDFs use inlineData; unsupported images become a note", async () => {
    const message: ModelMessage = { role: "user", content: "Look", images: [{ mime: "image/png", base64: "IMAGE" }], documents: [{ mime: "application/pdf", base64: "PDF", name: "a.pdf" }] }
    const supported = setup(answer)
    await collect(supported.provider.stream(request({ messages: [message] })))
    expect(supported.sent[0]!.body.contents[0].parts).toEqual([{ text: "Look" }, { inlineData: { mimeType: "image/png", data: "IMAGE" } }, { inlineData: { mimeType: "application/pdf", data: "PDF" } }])
    const unsupported = setup(answer, { models: [{ id: "gemini-2.5-flash", images: false }] })
    await collect(unsupported.provider.stream(request({ messages: [message] })))
    expect(JSON.stringify(unsupported.sent[0]!.body)).toContain("1 image omitted")
    expect(JSON.stringify(unsupported.sent[0]!.body)).not.toContain("IMAGE")
  })

  test("v1 variants, model-specific efforts and request hooks preserve transport ownership", async () => {
    const { provider, sent } = setup(answer)
    for (const [model, effort] of [["gemini-2.5-pro", "minimal"], ["gemini-2.5-flash", "xhigh"], ["gemini-3-pro", "medium"], ["gemini-3.1-pro", "medium"]] as const) await collect(provider.stream(request({ model, effort })))
    expect(sent.map((wire) => wire.body.generationConfig.thinkingConfig)).toEqual([{ includeThoughts: true, thinkingBudget: 128 }, { includeThoughts: true, thinkingBudget: 24_576 }, { includeThoughts: true, thinkingLevel: "high" }, { includeThoughts: true, thinkingLevel: "medium" }])
    await collect(provider.stream(request({ model: "gemini-3.1-pro" })))
    expect(sent.at(-1)!.body.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "high" })
    await collect(provider.stream(request({ parameters: { temperature: 0.2, contents: [], tools: [], apiKey: "bad", generationConfig: { topP: 0.5 }, ...geminiVariants("gemini-2.5-flash").max!.parameters }, transformBody: async (body) => ({ ...body, generationConfig: { ...(body.generationConfig as object), seed: 7 } }) })))
    expect(sent.at(-1)!.body).toMatchObject({ contents: [{ role: "user" }], tools: [{ functionDeclarations: [{ name: "read" }] }], generationConfig: { temperature: 0.2, topP: 0.5, seed: 7, thinkingConfig: { thinkingBudget: 24_576 } } })
    expect(JSON.stringify(sent.at(-1)!.body)).not.toContain("apiKey")
    expect(Object.keys(geminiVariants("gemini-3.1-pro"))).toEqual(["low", "medium", "high"])
  })

  test("key rotation applies immediately; missing keys and unsafe model ids never send", async () => {
    let key: string | undefined = KEY
    const { provider, sent } = setup(answer, { apiKey: () => key })
    await collect(provider.stream(request()))
    key = "rotated-fixture-0123456789"
    await collect(provider.stream(request()))
    expect(sent.map((wire) => wire.headers.get("x-goog-api-key"))).toEqual([KEY, key])
    key = undefined
    await expect(collect(provider.stream(request()))).rejects.toThrow("[AUTH]: no API key for google")
    key = KEY
    await expect(collect(provider.stream(request({ model: "../models/evil?key=value" })))).rejects.toThrow("invalid Gemini model id")
    expect(sent).toHaveLength(2)
  })

  test("auth errors are final and scrubbed; overload is retryable with retry-after", async () => {
    for (const status of [400, 401, 403, 429, 503]) {
      const { provider } = setup(() => Response.json({ error: { message: `refused ${KEY}` } }, { status, headers: { "retry-after": "3" } }))
      const error = await collect(provider.stream(request())).catch((error: unknown) => error) as Error
      expect(error.message).not.toContain(KEY)
      expect(error instanceof RetryableProviderError).toBe(status >= 429)
      if (error instanceof RetryableProviderError) expect(error.retryAfterMs).toBe(3000)
      if (status === 401 || status === 403) expect(error.message).toContain("[AUTH]")
    }
    const streamed = setup(() => sse([{ error: { code: 503, message: `overloaded ${KEY}` } }]))
    const error = await collect(streamed.provider.stream(request())).catch((error: unknown) => error) as Error
    expect(error).toBeInstanceOf(RetryableProviderError)
    expect(error.message).not.toContain(KEY)
  })

  test("truncation, safety blocks and malformed streams never execute a tool", async () => {
    for (const finishReason of [undefined, "MAX_TOKENS", "SAFETY", "MALFORMED_FUNCTION_CALL"]) {
      const { provider } = setup(() => sse([{ candidates: [{ content: { parts: [{ functionCall: { name: "write", args: { path: "file" } } }] }, ...(finishReason ? { finishReason } : {}) }] }]))
      const events: ModelEvent[] = []
      let error: unknown
      try { for await (const event of provider.stream(request())) events.push(event) } catch (caught) { error = caught }
      expect(events.some((event) => event.type === "tool_call")).toBe(false)
      if (finishReason === "MAX_TOKENS") expect(events.at(-1)).toEqual({ type: "finish", reason: "length" })
      else expect(error).toBeInstanceOf(Error)
    }
    for (const chunks of [[null], [{ promptFeedback: { blockReason: "SAFETY" } }]]) await expect(collect(setup(() => sse(chunks)).provider.stream(request()))).rejects.toThrow()
    await expect(collect(setup(() => new Response("data: bad-json\n\n")).provider.stream(request()))).rejects.toThrow("without completion")
  })

  test("abort stops immediately, including multiple parts in the same chunk", async () => {
    const { provider, sent } = setup(() => sse([{ candidates: [{ content: { parts: [{ text: "partial" }, { text: "never" }] }, finishReason: "STOP" }] }]))
    const controller = new AbortController()
    const events: ModelEvent[] = []
    for await (const event of provider.stream(request({ signal: controller.signal }))) { events.push(event); controller.abort() }
    expect(events).toEqual([{ type: "text", delta: "partial" }])
    expect(sent[0]!.signal.aborted).toBe(true)
    await collect(provider.stream(request({ signal: controller.signal })))
    expect(sent).toHaveLength(1)
  })

  test("a silent stream times out under the existing per-request watchdog", async () => {
    let cancelled = false
    const fetch: Fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true } }))
    const provider = createApiProvider({ provider: base, fetch, idleTimeoutMs: 30 })
    await expect(collect(provider.stream(request()))).rejects.toThrow("stream stalled")
    expect(cancelled).toBe(true)
  })
})

describe("B10.03 Gemini admin calls", () => {
  test("model listing paginates, authenticates, filters non-chat models and adds v1 variants", async () => {
    const urls: string[] = []
    const fetch: Fetch = async (url, init) => {
      urls.push(url)
      expect(new Headers(init.headers).get("x-goog-api-key")).toBe(KEY)
      expect(init.redirect).toBe("error")
      return Response.json(urls.length === 1 ? { models: [{ name: "models/gemini-3.1-pro", displayName: "Gemini 3.1 Pro", inputTokenLimit: 1_000_000, supportedGenerationMethods: ["generateContent"] }, { name: "models/gemini-embedding", supportedGenerationMethods: ["embedContent"] }, { name: "models/gemini-flash-image", supportedGenerationMethods: ["generateContent"] }], nextPageToken: "next /+" } : { models: [{ name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] }, { name: "models/gemini-3.1-pro", displayName: "Gemini 3.1 Pro", inputTokenLimit: 1_000_000, supportedGenerationMethods: ["generateContent"] }] })
    }
    const models = await fetchProviderModels({ provider: base, fetch })
    expect(models.map((model) => model.id)).toEqual(["gemini-2.5-flash", "gemini-3.1-pro"])
    expect(models[1]).toMatchObject({ name: "Gemini 3.1 Pro", context: 1_000_000, images: true, effort: true })
    expect(models[0]!.variants).toEqual(geminiVariants("gemini-2.5-flash"))
    expect(new URL(urls[1]!).searchParams.get("pageToken")).toBe("next /+")
    expect(urls.join("")).not.toContain(KEY)
  })

  test("invalid pagination or missing list fails; keys are scrubbed from GET failures", async () => {
    await expect(fetchProviderModels({ provider: base, fetch: async () => Response.json({ models: [], nextPageToken: "same" }) })).rejects.toThrow("invalid model pagination")
    await expect(fetchProviderModels({ provider: base, fetch: async () => Response.json({}) })).rejects.toThrow("without a model list")
    const error = await fetchProviderModels({ provider: base, fetch: async () => { throw new Error(KEY) } }).catch((error: unknown) => error) as Error
    expect(error.message).not.toContain(KEY)
  })

  test("connection test uses the native transport, reports success and redacts failures", async () => {
    const { fetch, sent } = setup(answer)
    expect(await testProvider({ provider: base, fetch })).toMatchObject({ ok: true, model: "gemini-2.5-flash" })
    expect(sent[0]!.body.generationConfig.maxOutputTokens).toBe(8)
    expect(await testProvider({ provider: base, fetch: async () => Response.json({ error: { message: KEY } }, { status: 401 }) })).toMatchObject({ ok: false, error: expect.stringContaining("[AUTH]") })
    expect(JSON.stringify(await testProvider({ provider: base, fetch: async () => { throw new Error(KEY) } }))).not.toContain(KEY)
  })
})
