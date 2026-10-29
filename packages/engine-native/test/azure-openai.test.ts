import { describe, expect, test } from "bun:test"
import { createApiProvider, createAzureEntraCredential, azureUrl, RetryableProviderError, type Fetch, type ModelEvent, type ModelRequest, type ResolvedProvider } from "../src"

const KEY = "azure-key-fixture-never-print-0123456789"
const TOKEN = "entra-token-fixture-never-print-0123456789"
const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({ system: "Be brief", messages: [{ role: "user", content: "Read the file" }], tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }], signal: new AbortController().signal, ...over })
const collect = async (stream: AsyncIterable<ModelEvent>) => { const events: ModelEvent[] = []; for await (const event of stream) events.push(event); return events }
const sse = (chunks: unknown[]) => new Response(chunks.map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
const responses = () => sse([
  { type: "response.reasoning_summary_text.delta", delta: "Look" },
  { type: "response.output_text.delta", delta: "Reading" },
  { type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "read", arguments: '{"path":"a.ts"}' } },
  { type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 60 }, output_tokens_details: { reasoning_tokens: 5 } } } },
])
const chat = () => sse([
  { choices: [{ delta: { reasoning_content: "Look", content: "Reading", tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: '{"path":' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }, finish_reason: "tool_calls" }] },
  { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 5 } } },
  "[DONE]",
])
const resolved = (over: Partial<ResolvedProvider> = {}): ResolvedProvider => ({ id: "azure", type: "azure", baseUrl: "https://team.openai.azure.com/openai", keyRequired: true, apiKey: () => KEY, models: [{ id: "team-coder", images: true }], ...over })

describe("B10.02 Azure native transport", () => {
  test("Responses default: live Azure api-key, tools, reasoning, usage, replay and per-request deployment", async () => {
    let key = KEY
    const sent: { url: string; headers: Headers; body: any }[] = []
    const provider = createApiProvider({ provider: resolved({ apiKey: () => key }), fetch: async (url, init) => { sent.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) }); return responses() } })
    const events = await collect(provider.stream(request({ model: "team-coder", effort: "high" })))
    expect(events).toEqual([
      { type: "reasoning", delta: "Look" }, { type: "text", delta: "Reading" },
      { type: "tool_call", call: { callId: "c1", name: "read", args: { path: "a.ts" } } },
      { type: "usage", usage: { input: 40, output: 20, reasoning: 5, cacheRead: 60, cacheWrite: 0 } }, { type: "finish", reason: "tool_calls" },
    ])
    expect(sent[0]!.url).toBe("https://team.openai.azure.com/openai/v1/responses?api-version=v1")
    expect(sent[0]!.headers.get("api-key")).toBe(KEY)
    expect(sent[0]!.headers.has("authorization")).toBe(false)
    expect(sent[0]!.headers.has("session_id")).toBe(false)
    expect(sent[0]!.body).toMatchObject({ model: "team-coder", stream: true, store: false, reasoning: { effort: "high" } })
    key = `${KEY}-rotated`
    await collect(provider.stream(request({ model: "other-deployment", messages: [{ role: "assistant", content: "", toolCalls: [{ callId: "c1", name: "read", args: { path: "a.ts" } }] }, { role: "tool", callId: "c1", name: "read", output: "file content", isError: false }] })))
    expect(sent[1]!.body.model).toBe("other-deployment")
    expect(sent[1]!.headers.get("api-key")).toBe(key)
    expect(sent[1]!.body.input).toContainEqual({ type: "function_call_output", call_id: "c1", output: "file content" })
  })

  test("legacy Chat Completions encodes deployment ids, retains tools/images and accounts cache reads", async () => {
    let body: any
    const provider = createApiProvider({ provider: resolved({ azure: { useCompletionUrls: true, useDeploymentBasedUrls: true, apiVersion: "2024-10-21" } }), fetch: async (url, init) => {
      expect(url).toBe("https://team.openai.azure.com/openai/deployments/team%2Fcoder/chat/completions?api-version=2024-10-21")
      expect(new Headers(init.headers).get("api-key")).toBe(KEY)
      expect(new Headers(init.headers).has("authorization")).toBe(false)
      expect(init.redirect).toBe("error")
      body = JSON.parse(String(init.body))
      return chat()
    } })
    const events = await collect(provider.stream(request({ model: "team/coder", effort: "high", messages: [{ role: "user", content: "look", images: [{ mime: "image/png", base64: "AAAA" }] }] })))
    expect(events).toContainEqual({ type: "tool_call", call: { callId: "c1", name: "read", args: { path: "a.ts" } } })
    expect(events).toContainEqual({ type: "usage", usage: { input: 40, output: 20, reasoning: 5, cacheRead: 60, cacheWrite: 0 } })
    expect(body).toMatchObject({ model: "team/coder", stream_options: { include_usage: true }, reasoning_effort: "high" })
    expect(body.messages[1].content).toContainEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } })
  })

  test("URL normalization, gateway paths and rejecting plaintext remote/credential URLs", () => {
    expect(azureUrl("https://team.openai.azure.com", "model", "/responses")).toBe("https://team.openai.azure.com/openai/v1/responses?api-version=v1")
    expect(azureUrl("https://team.services.ai.azure.com/api/projects/dev/openai/v1/", "model", "/responses")).toBe("https://team.services.ai.azure.com/api/projects/dev/openai/v1/responses?api-version=v1")
    for (const url of ["http://remote.example", "https://user:secret@example.com", "https://example.com?key=secret", "https://example.com#secret", "file:///tmp/key"]) expect(() => azureUrl(url, "model", "/responses")).toThrow()
    expect(azureUrl("http://127.0.0.1:1234/openai", "model", "/responses")).toStartWith("http://127.0.0.1:1234/")
  })

  test("Entra uses only bearer auth; token rotation applies live, and request overrides cannot replace auth", async () => {
    let key = KEY, token = TOKEN, calls = 0
    const provider = createApiProvider({ provider: resolved({ apiKey: () => key, azure: { auth: "entra" }, azureToken: async () => token, headers: { authorization: "wrong", "api-key": "wrong", "x-team": "dev" } }), fetch: async (_url, init) => {
      const headers = new Headers(init.headers)
      expect(headers.get("authorization")).toBe(`Bearer ${token}`)
      expect(headers.has("api-key")).toBe(false)
      expect(headers.get("x-team")).toBe("dev")
      calls++
      return responses()
    } })
    await collect(provider.stream(request({ headers: { authorization: "override" } })))
    key = "another-key"; token = `${TOKEN}-changed`
    await collect(provider.stream(request()))
    expect(calls).toBe(2)
  })

  test("missing keys and pre-abort do no HTTP; 401 scrubbed, 429 retried with retry-after", async () => {
    let calls = 0
    const absent = createApiProvider({ provider: resolved({ apiKey: () => undefined }), fetch: async () => { calls++; return responses() } })
    await expect(collect(absent.stream(request()))).rejects.toThrow("no API key")
    const ctl = new AbortController(); ctl.abort()
    expect(await collect(absent.stream(request({ signal: ctl.signal })))).toEqual([])
    expect(calls).toBe(0)
    for (const status of [401, 429]) {
      const provider = createApiProvider({ provider: resolved(), fetch: async () => Response.json({ error: { message: `echo ${KEY}` } }, { status, headers: { "retry-after": "2" } }) })
      const error = await collect(provider.stream(request())).catch((error: Error) => error)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).not.toContain(KEY)
      if (status === 429) expect(error).toMatchObject({ retryAfterMs: 2000 })
      else expect(error).not.toBeInstanceOf(RetryableProviderError)
    }
  })

  test("midstream abort closes a silent local response", async () => {
    const ctl = new AbortController()
    let cancelled = false
    const provider = createApiProvider({ provider: resolved(), fetch: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n')) }, cancel() { cancelled = true } })) })
    const seen: ModelEvent[] = []
    for await (const event of provider.stream(request({ signal: ctl.signal }))) { seen.push(event); ctl.abort() }
    expect(seen).toEqual([{ type: "text", delta: "partial" }])
    expect(cancelled).toBe(true)
  }, 2000)
})

describe("B10.02 Entra credentials", () => {
  test("static tokens are read per request, without HTTP or implicit discovery", async () => {
    const env: Record<string, string> = { TEAM_TOKEN: TOKEN }
    const auth = createAzureEntraCredential({ env: () => env, tokenEnv: "TEAM_TOKEN", fetch: async () => { throw new Error("no HTTP") } })
    expect(auth.ready()).toBe(true)
    expect(await auth.token(new AbortController().signal)).toBe(TOKEN)
    env.TEAM_TOKEN = `${TOKEN}-changed`
    expect(await auth.token(new AbortController().signal)).toBe(`${TOKEN}-changed`)
    delete env.TEAM_TOKEN
    expect(auth.ready()).toBe(false)
    await expect(auth.token(new AbortController().signal)).rejects.toThrow("AZURE_TENANT_ID")
  })

  test("client credentials use fixed scope, cache, refresh before expiry and react to credential rotation", async () => {
    const env = { AZURE_TENANT_ID: "tenant.example", AZURE_CLIENT_ID: "client-id", AZURE_CLIENT_SECRET: "client-secret-never-print" }
    let now = 0, calls = 0
    const fake: Fetch = async (url, init) => {
      expect(url).toBe("https://login.microsoftonline.com/tenant.example/oauth2/v2.0/token")
      expect(init.redirect).toBe("error")
      expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ client_id: env.AZURE_CLIENT_ID, client_secret: env.AZURE_CLIENT_SECRET, scope: "https://cognitiveservices.azure.com/.default", grant_type: "client_credentials" })
      calls++
      return Response.json({ access_token: `${TOKEN}-${calls}`, expires_in: 3600, token_type: "Bearer" })
    }
    const auth = createAzureEntraCredential({ env: () => env, now: () => now, fetch: fake })
    const signal = new AbortController().signal
    expect(await auth.token(signal)).toBe(`${TOKEN}-1`)
    expect(await auth.token(signal)).toBe(`${TOKEN}-1`)
    now = 3_550_000
    expect(await auth.token(signal)).toBe(`${TOKEN}-2`)
    env.AZURE_CLIENT_SECRET = "rotated-secret-never-print"
    expect(await auth.token(signal)).toBe(`${TOKEN}-3`)
    expect(calls).toBe(3)
  })

  test("failed or malformed token responses never expose returned tokens or client secrets", async () => {
    const env = { AZURE_TENANT_ID: "tenant.example", AZURE_CLIENT_ID: "client-id", AZURE_CLIENT_SECRET: KEY }
    for (const status of [400, 401, 429, 200]) {
      const auth = createAzureEntraCredential({ env: () => env, fetch: async () => Response.json({ access_token: TOKEN, error_description: KEY }, { status }) })
      const error = await auth.token(new AbortController().signal).catch((error: Error) => error)
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).not.toContain(KEY)
      expect(String(error)).not.toContain(TOKEN)
      if (status === 429) expect(error).toBeInstanceOf(RetryableProviderError)
    }
    const unsafe = createAzureEntraCredential({ env: () => ({ ...env, AZURE_AUTHORITY_HOST: "http://remote.example" }), fetch: async () => { throw new Error("must not run") } })
    await expect(unsafe.token(new AbortController().signal)).rejects.toThrow("HTTPS origin")
  })
})
