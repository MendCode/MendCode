import { afterEach, describe, expect, test } from "bun:test"
import { fetchProviderModels, testProvider, type ResolvedProvider } from "../src"
import { fakeServer, sse } from "./fake-server"

const KEY = "sk-test-0123456789abcdefghijklmnopqrstuv"
const stops: Array<() => void> = []
afterEach(() => stops.splice(0).forEach((stop) => stop()))

const provider = (type: ResolvedProvider["type"], baseUrl: string, overrides: Partial<ResolvedProvider> = {}): ResolvedProvider => ({ id: "p", type, baseUrl, apiKey: () => KEY, keyRequired: true, models: [{ id: "m1" }], ...overrides })
const serve = (handler: Parameters<typeof fakeServer>[0]) => {
  const server = fakeServer(handler)
  stops.push(server.stop)
  return server
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

describe("fetchProviderModels", () => {
  test("OpenAI-compatible: lists /models with the bearer key, sorted, with context and capabilities when the host says them", async () => {
    const server = serve(() =>
      json({
        data: [
          { id: "zeta/model", context_length: 128_000, supported_parameters: ["reasoning", "tools"], architecture: { input_modalities: ["text", "image"] } },
          { id: "alpha/model", name: "Alpha", context_window: 32_000, architecture: { input_modalities: ["text"] } },
          { id: "", name: "no id" },
        ],
      }),
    )
    const models = await fetchProviderModels({ provider: provider("openai-compatible", `${server.url}/v1`) })
    expect(models).toEqual([
      { id: "alpha/model", name: "Alpha", context: 32_000, images: false },
      { id: "zeta/model", context: 128_000, effort: true, images: true },
    ])
    expect(server.requests[0]!.method).toBe("GET")
    expect(server.requests[0]!.path).toBe("/v1/models")
    expect(server.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`)
  })

  test("Anthropic: /v1/models with x-api-key and the version header; display names are kept", async () => {
    const server = serve(() => json({ data: [{ id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", type: "model" }, { id: "claude-3-haiku-20240307", display_name: "Claude 3 Haiku" }], has_more: false }))
    const models = await fetchProviderModels({ provider: provider("anthropic", `${server.url}/v1`) })
    expect(models).toEqual([
      { id: "claude-3-haiku-20240307", name: "Claude 3 Haiku", effort: false, images: true },
      { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", effort: true, images: true },
    ])
    expect(server.requests[0]!.path).toBe("/v1/models?limit=1000")
    expect(server.requests[0]!.headers["x-api-key"]).toBe(KEY)
    expect(server.requests[0]!.headers["anthropic-version"]).toBe("2023-06-01")
  })

  test("OpenAI: embeddings, speech and image models are left out", async () => {
    const server = serve(() => json({ data: [{ id: "gpt-6-luna" }, { id: "text-embedding-3-large" }, { id: "whisper-1" }, { id: "gpt-image-1" }, { id: "o4-mini" }] }))
    const models = await fetchProviderModels({ provider: provider("openai", `${server.url}/v1`) })
    expect(models.map((m) => m.id)).toEqual(["gpt-6-luna", "o4-mini"])
    expect(models.find((m) => m.id === "o4-mini")?.effort).toBe(true)
  })

  test("a keyless local server is asked without credentials", async () => {
    const server = serve(() => json({ data: [{ id: "llama3:8b" }] }))
    const models = await fetchProviderModels({ provider: provider("openai-compatible", `${server.url}/v1`, { apiKey: () => undefined, keyRequired: false }) })
    expect(models).toEqual([{ id: "llama3:8b" }])
    expect(server.requests[0]!.headers.authorization).toBeUndefined()
  })

  test("401 is a clear auth error without the key; a missing key never reaches the network", async () => {
    const server = serve(() => json({ error: { message: `bad key ${KEY}` } }, 401))
    const error = (await fetchProviderModels({ provider: provider("openai", `${server.url}/v1`) }).catch((e: unknown) => e)) as Error
    expect(error.message).toStartWith("[AUTH]: p 401")
    expect(error.message).not.toContain(KEY)
    const before = server.requests.length
    await expect(fetchProviderModels({ provider: provider("openai", `${server.url}/v1`, { apiKey: () => undefined }) })).rejects.toThrow("[AUTH]: no API key")
    expect(server.requests.length).toBe(before)
  })

  test("a host that never answers times out", async () => {
    const server = serve(() => new Promise<Response>(() => {}))
    await expect(fetchProviderModels({ provider: provider("openai-compatible", `${server.url}/v1`), timeoutMs: 50 })).rejects.toThrow("model list timed out")
  })

  test("an answer without a model list is an error", async () => {
    const server = serve(() => json({ hello: "world" }))
    await expect(fetchProviderModels({ provider: provider("openai-compatible", `${server.url}/v1`) })).rejects.toThrow("without a model list")
  })
})

describe("testProvider", () => {
  test("one tiny streaming request per wire format; ok with a latency", async () => {
    const answers: Record<string, () => Response> = {
      anthropic: () => sse([{ type: "message_start", message: { usage: {} } }, { type: "content_block_start", index: 0, content_block: { type: "text" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }, { type: "message_stop" }], { named: true }),
      "openai-compatible": () => sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }, "[DONE]"]),
      openai: () => sse([{ type: "response.output_text.delta", delta: "ok" }, { type: "response.completed", response: {} }]),
    }
    for (const type of ["anthropic", "openai-compatible", "openai"] as const) {
      const server = serve(() => answers[type]!())
      let clock = 1_000
      const result = await testProvider({ provider: provider(type, server.url), now: () => (clock += 25) })
      expect(result).toEqual({ ok: true, latencyMs: 25, model: "m1" })
      const body = server.requests[0]!.body
      expect(body.stream).toBe(true)
      expect(body.max_tokens ?? body.max_output_tokens).toBe(type === "openai" ? 16 : 8)
    }
  })

  test("a 401 is reported as a failure with a clear message and no key", async () => {
    const server = serve(() => json({ error: { message: `nope ${KEY}` } }, 401))
    const result = await testProvider({ provider: provider("anthropic", server.url) })
    expect(result.ok).toBe(false)
    expect(result.error).toContain("[AUTH]: p 401")
    expect(JSON.stringify(result)).not.toContain(KEY)
  })

  test("no model configured says so without a request", async () => {
    const server = serve(() => json({}))
    const result = await testProvider({ provider: provider("openai-compatible", server.url, { models: [] }) })
    expect(result.ok).toBe(false)
    expect(result.error).toContain("no model configured")
    expect(server.requests).toHaveLength(0)
  })

  test("a host that never answers times out instead of hanging", async () => {
    const server = serve(() => new Promise<Response>(() => {}))
    const result = await testProvider({ provider: provider("openai-compatible", server.url), timeoutMs: 50 })
    expect(result).toMatchObject({ ok: false, error: "timed out" })
  })
})
