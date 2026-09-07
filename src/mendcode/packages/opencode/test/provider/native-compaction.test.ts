import { describe, expect, test } from "bun:test"

import { nativeCapability, compactNative, NativeCompactionError } from "../../src/provider/native-compaction"
import { Provider } from "../../src/provider/provider"
import { Auth } from "../../src/auth"

function model(overrides: Partial<Provider.Model> = {}) {
  return {
    id: "gpt-6-astra",
    providerID: "openai",
    api: { id: "gpt-6-astra", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
    name: "GPT-6 Astra",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 1, output: 2, cache: { read: 0, write: 0 } },
    limit: { context: 1_000_000, input: 900_000, output: 100_000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
    variants: {},
    ...overrides,
  } as Provider.Model
}

function provider(overrides: Partial<Provider.Info> = {}) {
  return {
    id: "openai",
    name: "OpenAI",
    source: "api",
    env: [],
    key: "test-secret",
    options: {},
    models: { "gpt-6-astra": model() },
    ...overrides,
  } as Provider.Info
}

describe("native compaction transport", () => {
  test("sends the documented compact request and returns opaque output unchanged", async () => {
    let seenURL = ""
    let seenInit: RequestInit | undefined
    const response = new Response(
      JSON.stringify({
        id: "resp_compact",
        output: [
          { type: "compaction", id: "cmp_1", encrypted_content: "opaque" },
          { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "kept" }] },
        ],
        usage: { input_tokens: 12 },
      }),
      { status: 200, headers: { "content-type": "application/json", "x-request-id": "req_1" } },
    )
    const injected = await compactNative({
      provider: provider({
        options: {
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            seenURL = String(input)
            seenInit = init
            return response
          },
        },
      }),
      model: model(),
      auth: { type: "api", key: "test-secret" } as Auth.Info,
      inputItems: [{ type: "message", id: "source_1", role: "user", content: "keep this" }],
      tools: [{ type: "function", name: "read" }],
    })
    expect(seenURL).toBe("https://api.openai.com/v1/responses/compact")
    expect(JSON.parse(String(seenInit?.body))).toEqual({
      model: "gpt-6-astra",
      input: [{ type: "message", id: "source_1", role: "user", content: "keep this" }],
      tools: [{ type: "function", name: "read" }],
      store: false,
    })
    expect(seenInit?.headers).toBeDefined()
    expect(injected.outputItems[0]).toEqual({ type: "compaction", id: "cmp_1", encrypted_content: "opaque" })
    expect(injected.outputItems[1]).toEqual({
      type: "message",
      id: "msg_1",
      role: "assistant",
      content: [{ type: "output_text", text: "kept" }],
    })
    expect(injected.requestID).toBe("req_1")
  })

  test("gates API and OAuth separately and rejects custom OpenAI-compatible origins", () => {
    expect(
      nativeCapability({ provider: provider(), model: model(), auth: { type: "api", key: "x" } as Auth.Info }).supported,
    ).toBe(true)
    expect(
      nativeCapability({
        provider: provider({ source: "custom", options: { fetch: async () => new Response() } }),
        model: model(),
        auth: { type: "oauth", refresh: "r", access: "a", expires: Date.now() + 60_000 } as Auth.Info,
      }).protocol,
    ).toBe("codex-oauth-responses-v1")
    expect(
      nativeCapability({
        provider: provider({ options: { baseURL: "https://gateway.example.test/v1" } }),
        model: model(),
        auth: { type: "api", key: "x" } as Auth.Info,
      }),
    ).toMatchObject({ supported: false })
  })

  test("does not dispatch after cancellation and treats malformed output as unusable", async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(
      compactNative({
        provider: provider(),
        model: model(),
        auth: { type: "api", key: "x" } as Auth.Info,
        inputItems: [],
        abort: abort.signal,
      }),
    ).rejects.toMatchObject({ kind: "cancelled" })

    await expect(
      compactNative({
        provider: provider({ options: { fetch: async () => new Response(JSON.stringify({ output: {} }), { status: 200 }) } }),
        model: model(),
        auth: { type: "api", key: "x" } as Auth.Info,
        inputItems: [],
      }),
    ).rejects.toBeInstanceOf(NativeCompactionError)
  })
})
