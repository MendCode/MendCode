import { describe, expect, test } from "bun:test"
import { createApiProvider, fetchProviderModels, RetryableProviderError, vertexBaseUrl, vertexRouting, type Fetch, type ModelEvent, type ModelMessage, type ModelRequest, type ResolvedProvider } from "../src"

const TOKEN = "vertex-bearer-fixture-never-print-0123456789"
const base: ResolvedProvider = { id: "google-vertex", type: "google-vertex", baseUrl: "http://127.0.0.1:9911/v1", apiKey: () => undefined, keyRequired: false, googleToken: async () => TOKEN, vertex: { project: "test-project", location: "global" }, models: [{ id: "gemini-2.5-flash", images: true, cost: { input: 1, output: 2 } }] }
const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({ system: "Be brief", messages: [{ role: "user", content: "hi" }], tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }], signal: new AbortController().signal, ...over })
const collect = async (stream: AsyncIterable<ModelEvent>) => { const events: ModelEvent[] = []; for await (const event of stream) events.push(event); return events }
const sse = (chunks: unknown[]) => new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""))
const answer = () => sse([{ candidates: [{ content: { parts: [{ text: "done" }] }, finishReason: "STOP" }] }])
function setup(respond: (index: number) => Response, over: Partial<ResolvedProvider> = {}) {
  const sent: { url: string; headers: Headers; body: Record<string, any>; redirect: RequestRedirect | undefined }[] = []
  const fetch: Fetch = async (url, init) => { sent.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)), redirect: init.redirect }); return respond(sent.length - 1) }
  return { sent, fetch, provider: createApiProvider({ provider: { ...base, ...over }, fetch }) }
}

describe("B10.04 native Vertex", () => {
  test("shared Gemini hooks preserve the public API-key wire format and auth failures", async () => {
    let status = 200
    const sent: { url: string; headers: Headers }[] = []
    const gemini = createApiProvider({ provider: { id: "google", type: "google", baseUrl: "http://127.0.0.1:9911/v1beta", apiKey: () => TOKEN, keyRequired: true, models: base.models }, fetch: async (url, init) => { sent.push({ url, headers: new Headers(init.headers) }); return status === 200 ? answer() : Response.json({ error: TOKEN }, { status }) } })
    expect((await collect(gemini.stream(request()))).at(-1)).toEqual({ type: "finish", reason: "stop" })
    expect(sent[0]!.url).toBe("http://127.0.0.1:9911/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse")
    expect(sent[0]!.headers.get("x-goog-api-key")).toBe(TOKEN)
    expect(sent[0]!.headers.has("authorization")).toBe(false)
    status = 401
    const error = await collect(gemini.stream(request())).catch((error: Error) => error) as Error
    expect(error.message).toContain("rejected the API key")
    expect(error.message).not.toContain(TOKEN)
  })

  test("v1 project/location precedence and regional/global endpoint routing", () => {
    expect(vertexRouting()).toEqual({ project: undefined, location: "us-central1" })
    expect(vertexRouting({}, { GCP_PROJECT: "gcp", GCLOUD_PROJECT: "gcloud", GOOGLE_CLOUD_PROJECT: "google", VERTEX_LOCATION: "global", GOOGLE_CLOUD_LOCATION: "europe-west4", GOOGLE_VERTEX_LOCATION: "us-east1" })).toEqual({ project: "google", location: "us-east1" })
    expect(vertexRouting({ project: "configured", location: "global" }, { GOOGLE_CLOUD_PROJECT: "env" })).toEqual({ project: "configured", location: "global" })
    expect(vertexBaseUrl("global")).toBe("https://aiplatform.googleapis.com/v1")
    expect(vertexBaseUrl("us-central1")).toBe("https://us-central1-aiplatform.googleapis.com/v1")
  })

  test("Bearer stream, thoughts, tools, signed replay and cumulative usage use Vertex wire format", async () => {
    const parts = [{ text: "Consider ñ", thought: true, thoughtSignature: "thinking-signature" }, { functionCall: { name: "read", args: { path: "file.ts" } }, thoughtSignature: "call-signature" }]
    const h = setup((index) => index === 0 ? sse([{ candidates: [{ content: { parts }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 7, cachedContentTokenCount: 60 } }]) : answer())
    const first = await collect(h.provider.stream(request({ effort: "high" })))
    expect(first.find((event) => event.type === "reasoning")).toEqual({ type: "reasoning", delta: "Consider ñ" })
    expect(first.find((event) => event.type === "usage")).toEqual({ type: "usage", usage: { input: 40, output: 17, reasoning: 7, cacheRead: 60, cacheWrite: 0, costMicros: 134 } })
    const calls = first.filter((event): event is Extract<ModelEvent, { type: "tool_call" }> => event.type === "tool_call")
    const replay = first.find((event) => event.type === "reasoning_state")
    if (replay?.type !== "reasoning_state") throw new Error("Missing replay state")
    expect(replay.state).toMatchObject({ provider: "google-vertex", model: "gemini-2.5-flash", blocks: parts })
    const messages: ModelMessage[] = [{ role: "user", content: "go" }, { role: "assistant", content: "", toolCalls: calls.map((event) => event.call), reasoning: replay.state }, { role: "tool", callId: calls[0]!.call.callId, name: "read", output: "file contents", isError: false }]
    await collect(h.provider.stream(request({ messages })))
    const wire = h.sent[0]!
    expect(wire.url).toBe(`${base.baseUrl}/projects/test-project/locations/global/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse`)
    expect(wire.url).not.toContain(TOKEN)
    expect(wire.headers.get("authorization")).toBe(`Bearer ${TOKEN}`)
    expect(wire.headers.has("x-goog-api-key")).toBe(false)
    expect(wire.redirect).toBe("error")
    expect(wire.body).toMatchObject({ tools: [{ functionDeclarations: [{ name: "read" }] }], generationConfig: { thinkingConfig: { includeThoughts: true, thinkingBudget: 16000 } } })
    expect(h.sent[1]!.body.contents[1]).toEqual({ role: "model", parts })
    expect(h.sent[1]!.body.contents[2].parts[0]).toEqual({ functionResponse: { name: "read", response: { output: "file contents" } } })
    expect(first.at(-1)).toEqual({ type: "finish", reason: "tool_calls" })
  })

  test("media, generation parameters, token rotation and ADC quota header apply to each call", async () => {
    let token = TOKEN
    const h = setup(answer, { googleToken: async () => token, googleQuotaProject: () => "adc-quota-project" })
    await collect(h.provider.stream(request({ messages: [{ role: "user", content: "inspect", images: [{ mime: "image/png", base64: "IMAGE" }], documents: [{ mime: "application/pdf", base64: "PDF", name: "paper.pdf" }] }], maxOutputTokens: 32, parameters: { temperature: 0, generationConfig: { seed: 7 } } })))
    expect(h.sent[0]!.body.contents[0].parts).toContainEqual({ inlineData: { mimeType: "application/pdf", data: "PDF" } })
    expect(h.sent[0]!.body.generationConfig).toMatchObject({ temperature: 0, seed: 7, maxOutputTokens: 32 })
    expect(h.sent[0]!.headers.get("x-goog-user-project")).toBe("adc-quota-project")
    token = "rotated-access-token"
    await collect(h.provider.stream(request()))
    expect(h.sent[1]!.headers.get("authorization")).toBe(`Bearer ${token}`)
    const configured = setup(answer, { vertex: { ...base.vertex, quotaProject: "configured-quota" }, googleQuotaProject: () => "adc-quota" })
    await collect(configured.provider.stream(request()))
    expect(configured.sent[0]!.headers.get("x-goog-user-project")).toBe("configured-quota")
  })

  test("unsafe endpoint/model/project and missing ADC fail without sending a request", async () => {
    for (const over of [{ vertex: {} }, { baseUrl: "http://remote.example/v1" }, { baseUrl: "https://user:secret@example.com" }]) {
      const h = setup(answer, over)
      await expect(collect(h.provider.stream(request()))).rejects.toThrow()
      expect(h.sent).toHaveLength(0)
    }
    const h = setup(answer)
    const noAdc = { ...base }; delete noAdc.googleToken
    await expect(collect(createApiProvider({ provider: noAdc, fetch: h.fetch }).stream(request()))).rejects.toThrow("ADC is unavailable")
    await expect(collect(h.provider.stream(request({ model: "../unsafe?secret=1" })))).rejects.toThrow("invalid Gemini model")
    const stopped = new AbortController(); stopped.abort()
    expect(await collect(h.provider.stream(request({ signal: stopped.signal })))).toEqual([])
    expect(h.sent).toHaveLength(0)
  })

  test("401/403 name ADC and scrub tokens; 429/5xx retry with provider backoff", async () => {
    for (const status of [401, 403, 429, 503]) {
      const h = setup(() => Response.json({ error: `refused ${TOKEN}` }, { status, headers: { "retry-after": "2" } }))
      const error = await collect(h.provider.stream(request())).catch((error: Error) => error) as Error
      expect(error.message).not.toContain(TOKEN)
      expect(error instanceof RetryableProviderError).toBe(status >= 429)
      if (status < 429) expect(error.message).toContain("rejected ADC credentials")
      else expect((error as RetryableProviderError).retryAfterMs).toBe(2000)
    }
  })

  test("truncated and safety-blocked streams never execute partial tool calls", async () => {
    for (const finishReason of [undefined, "MAX_TOKENS", "SAFETY"]) {
      const h = setup(() => sse([{ candidates: [{ content: { parts: [{ functionCall: { name: "write", args: { path: "file" } } }] }, ...(finishReason ? { finishReason } : {}) }] }]))
      const events: ModelEvent[] = []
      try { for await (const event of h.provider.stream(request())) events.push(event) } catch {}
      expect(events.some((event) => event.type === "tool_call")).toBe(false)
      if (finishReason === "MAX_TOKENS") expect(events.at(-1)).toEqual({ type: "finish", reason: "length" })
    }
  })

  test("refresh retains configured Vertex catalog without querying a foreign models endpoint", async () => {
    expect(await fetchProviderModels({ provider: base, fetch: async () => { throw new Error("must not fetch") } })).toEqual(base.models)
  })
})
