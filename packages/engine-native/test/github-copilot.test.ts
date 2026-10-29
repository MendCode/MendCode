import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { COPILOT_AUTH_FILE, createApiProvider, createCopilotAuth, fetchProviderModels, RetryableProviderError, type ModelRequest, type ResolvedProvider } from "../src"
import { ProviderModel as ModelSchema } from "@mendcode/protocol"
import { collect, hangingSse, sse } from "./fake-server"

const TOKEN = "gho_fixture_private_0123456789"
const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
function temp() { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-copilot-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const request = (extra: Partial<ModelRequest> = {}): ModelRequest => ({ system: "Be brief", messages: [{ role: "user", content: "Read the file" }], tools: [{ name: "read", description: "Read", parameters: { type: "object" } }], signal: new AbortController().signal, ...extra })
const CHAT = [{ choices: [{ delta: { content: "Hello" } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: '{"path":"a.ts"}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 5 } } }, "[DONE]"]
const RESPONSES = [{ type: "response.output_text.delta", delta: "Hello" }, { type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "read", arguments: '{"path":"a.ts"}' } }, { type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 60 }, output_tokens_details: { reasoning_tokens: 5 } } } }]
function adapter(reply: (url: string, init: RequestInit) => Response | Promise<Response>, models: ResolvedProvider["models"] = []) {
  const sent: { url: string; headers: Headers; body: Record<string, any>; signal: AbortSignal | null | undefined }[] = []
  const provider = createApiProvider({ provider: { id: "github-copilot", type: "github-copilot", baseUrl: "http://127.0.0.1:3210", apiKey: () => TOKEN, keyRequired: true, models }, fetch: async (url, init) => { sent.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)), signal: init.signal }); return reply(url, init) } })
  return { provider, sent }
}

describe("Copilot native transport", () => {
  test("v1 GPT routing streams text, tools and usage with token auth and no output cap", async () => {
    const h = adapter((url) => sse(url.endsWith("/responses") ? RESPONSES : CHAT))
    for (const model of ["gpt-4o", "gpt-5-mini", "gpt-5", "gpt-6-sol"]) {
      const events = await collect(h.provider.stream(request({ model, maxOutputTokens: 8, parameters: { max_tokens: 99, max_output_tokens: 99 } })))
      expect(events).toContainEqual({ type: "text", delta: "Hello" })
      expect(events).toContainEqual({ type: "tool_call", call: { callId: "c1", name: "read", args: { path: "a.ts" } } })
      expect(events).toContainEqual({ type: "usage", usage: { input: 40, output: 20, reasoning: 5, cacheRead: 60, cacheWrite: 0 } })
      const sent = h.sent.at(-1)!
      expect(sent.url).toEndWith(["gpt-5", "gpt-6-sol"].includes(model) ? "/responses" : "/chat/completions")
      expect(sent.headers.get("authorization")).toBe(`Bearer ${TOKEN}`)
      expect(sent.headers.get("x-initiator")).toBe("user")
      expect(sent.headers.get("openai-intent")).toBe("conversation-edits")
      expect(sent.body.max_tokens).toBeUndefined()
      expect(sent.body.max_output_tokens).toBeUndefined()
    }
  })
  test("tool loops and synthetic image/subagent calls are agent initiated; vision uses the sent content", async () => {
    const h = adapter(() => sse(CHAT))
    await collect(h.provider.stream(request({ model: "gpt-4o", messages: [{ role: "user", content: "Read" }, { role: "assistant", content: "", toolCalls: [{ callId: "c1", name: "read", args: {} }] }, { role: "tool", callId: "c1", name: "read", output: "File", isError: false }] })))
    expect(h.sent.at(-1)!.headers.get("x-initiator")).toBe("agent")
    expect(h.sent.at(-1)!.body.messages.at(-1)).toMatchObject({ role: "tool", content: "File" })
    for (const extra of [{ initiator: "agent" as const }, { messages: [{ role: "user" as const, content: "[image from read call]", images: [{ mime: "image/png", base64: "AAAA" }] }] }]) {
      await collect(h.provider.stream(request({ model: "gpt-4o", ...extra })))
      expect(h.sent.at(-1)!.headers.get("x-initiator")).toBe("agent")
    }
    expect(h.sent.at(-1)!.headers.get("copilot-vision-request")).toBe("true")
    const plain = adapter(() => sse(CHAT), [{ id: "gpt-4o", images: false }])
    await collect(plain.provider.stream(request({ model: "gpt-4o", messages: [{ role: "user", content: "Look", images: [{ mime: "image/png", base64: "AAAA" }] }] })))
    expect(plain.sent[0]!.headers.get("copilot-vision-request")).toBeNull()
  })
  test("Messages models use /v1/messages, bearer auth and replay signed thinking and tool results", async () => {
    const events = [{ type: "message_start", message: { usage: { input_tokens: 40, cache_read_input_tokens: 60 } } }, { type: "content_block_start", index: 0, content_block: { type: "thinking" } }, { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Reason" } }, { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signature" } }, { type: "content_block_stop", index: 0 }, { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "c1", name: "read" } }, { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"a.ts"}' } }, { type: "content_block_stop", index: 1 }, { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } }, { type: "message_stop" }]
    const h = adapter(() => sse(events), [{ id: "claude-fixture", copilotEndpoint: "/v1/messages", maxOutputTokens: 16_000 }])
    const first = await collect(h.provider.stream(request({ model: "claude-fixture", effort: "high" })))
    const reasoning = first.find((event) => event.type === "reasoning_state")
    if (reasoning?.type !== "reasoning_state") throw new Error("Missing reasoning")
    await collect(h.provider.stream(request({ model: "claude-fixture", effort: "high", messages: [{ role: "user", content: "Read" }, { role: "assistant", content: "", toolCalls: [{ callId: "c1", name: "read", args: { path: "a.ts" } }], reasoning: reasoning.state }, { role: "tool", callId: "c1", name: "read", output: "File", isError: false }] })))
    expect(h.sent[0]!.url).toEndWith("/v1/messages")
    expect(h.sent[0]!.headers.get("x-api-key")).toBeNull()
    expect(h.sent[0]!.headers.get("anthropic-beta")).toBe("interleaved-thinking-2025-05-14")
    expect(h.sent[0]!.body.max_tokens).toBe(16_000)
    expect(h.sent[1]!.headers.get("x-initiator")).toBe("agent")
    expect(JSON.stringify(h.sent[1]!.body)).toContain("signature")
    expect(JSON.stringify(h.sent[1]!.body)).toContain("tool_result")
    expect(JSON.stringify(h.sent[0]!.body)).not.toContain("eager_input_streaming")
    expect(first).toContainEqual({ type: "usage", usage: { input: 40, output: 20, reasoning: 0, cacheRead: 60, cacheWrite: 0 } })
  })
  test("401 redacts the bearer token; 429 honors retry-after; missing auth makes no HTTP call", async () => {
    for (const status of [401, 429]) {
      const h = adapter(() => new Response(`Error ${TOKEN}`, { status, headers: { "retry-after": "2" } }))
      const error = await collect(h.provider.stream(request({ model: "gpt-4o" }))).catch((error: unknown) => error)
      expect(String(error)).not.toContain(TOKEN)
      expect(error instanceof RetryableProviderError).toBe(status === 429)
      if (error instanceof RetryableProviderError) expect(error.retryAfterMs).toBe(2000)
    }
    const provider = createApiProvider({ provider: { id: "github-copilot", type: "github-copilot", baseUrl: "https://copilot.example", apiKey: () => undefined, keyRequired: true, models: [] }, fetch: async () => { throw new Error("Must not request") } })
    await expect(collect(provider.stream(request()))).rejects.toThrow("no GitHub Copilot token")
  })
  test("abort ends a silent stream without tools or usage being invented", async () => {
    const h = adapter(() => hangingSse([{ choices: [{ delta: { content: "partial" } }] }]))
    const abort = new AbortController(), seen = []
    for await (const event of h.provider.stream(request({ model: "gpt-4o", signal: abort.signal }))) { seen.push(event); abort.abort() }
    expect(seen).toEqual([{ type: "text", delta: "partial" }])
    expect(h.sent[0]!.signal?.aborted).toBe(true)
  })
  test("catalog filters disabled/hidden models and preserves endpoint, vision, window and variants", async () => {
    const item = { id: "claude-fixture", name: "Claude fixture", model_picker_enabled: true, supported_endpoints: ["/v1/messages"], capabilities: { limits: { max_context_window_tokens: 200_000, max_output_tokens: 32_000 }, supports: { streaming: true, tool_calls: true, vision: true, adaptive_thinking: true, reasoning_effort: ["low", "high"] } } }
    const models = await fetchProviderModels({ provider: { id: "github-copilot", type: "github-copilot", baseUrl: "http://127.0.0.1:3210", apiKey: () => TOKEN, keyRequired: true, models: [] }, fetch: async (_url, init) => { expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`); expect(init.redirect).toBe("error"); return Response.json({ data: [item, { ...item, id: "hidden", model_picker_enabled: false }, { ...item, id: "disabled", policy: { state: "disabled" } }, null] }) } })
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({ id: "claude-fixture", context: 200_000, maxOutputTokens: 32_000, images: true, effort: true, copilotEndpoint: "/v1/messages", variants: { high: { parameters: { thinking: { type: "adaptive" }, output_config: { effort: "high" } } } } })
    expect(ModelSchema.safeParse(models[0]).success).toBe(true)
  })
})

describe("Copilot device auth", () => {
  function login(reply: (call: number) => object, extra: Partial<Parameters<typeof createCopilotAuth>[0]> = {}) {
    const dir = temp(), waits: number[] = [], posts: Record<string, unknown>[] = []
    let tick: (() => void) | undefined, clock = 1000, call = 0
    const auth = createCopilotAuth({ dir, clientId: "fixture-client", issuer: "http://127.0.0.1:3210", now: () => clock, wait: (ms, signal) => { waits.push(ms); return new Promise<void>((resolve, reject) => { tick = () => { clock += ms; resolve() }; signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }) }) }, fetch: async (url, init) => { expect(init.redirect).toBe("error"); posts.push(JSON.parse(String(init.body))); return Response.json(url.endsWith("/device/code") ? { verification_uri: "http://127.0.0.1:3210/login/device", user_code: "ABCD-EFGH", device_code: "private-device", interval: 1, expires_in: 900 } : reply(++call)) }, ...extra })
    cleanups.push(() => auth.stop())
    return { auth, dir, waits, posts, async tick() { tick?.(); await Bun.sleep(1) } }
  }
  test("device polling honors pending/slow_down; stores privately, restarts and logs out without token reports", async () => {
    const h = login((call) => call === 1 ? { error: "authorization_pending" } : call === 2 ? { error: "slow_down", interval: 8 } : { access_token: TOKEN })
    expect(await h.auth.authorize()).toMatchObject({ provider: "github-copilot", method: "device", instructions: "Enter code: ABCD-EFGH" })
    expect(h.auth.status().state).toBe("pending")
    await expect(h.auth.authorize()).rejects.toThrow("pending")
    await h.tick(); await h.tick(); await h.tick()
    expect(h.waits).toEqual([4000, 4000, 11000])
    expect(h.posts.at(-1)).toMatchObject({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: "fixture-client" })
    expect(h.auth.status()).toMatchObject({ state: "authorized", source: "v2", refreshTokenPresent: false })
    expect(JSON.stringify(h.auth.status())).not.toContain("private")
    expect(JSON.stringify(h.auth.status())).not.toContain(TOKEN)
    const file = path.join(h.dir, COPILOT_AUTH_FILE), bytes = readFileSync(file, "utf8")
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const restored = createCopilotAuth({ dir: h.dir, issuer: "http://127.0.0.1:3210" })
    expect(await restored.tokenForRequest()).toBe(TOKEN)
    expect(readFileSync(file, "utf8")).toBe(bytes)
    restored.logout()
    expect(restored.status().state).toBe("none")
  })
  test("cancellation prevents late token persistence; rejected login exposes no provider payload", async () => {
    let resolve!: (response: Response) => void
    const h = login(() => ({}), { fetch: async (url) => url.endsWith("/device/code") ? Response.json({ verification_uri: "http://127.0.0.1:3210/login/device", user_code: "ABCD-EFGH", device_code: "private-device", interval: 1 }) : new Promise<Response>((done) => { resolve = done }) })
    await h.auth.authorize(); await h.tick(); h.auth.cancel(); resolve(Response.json({ access_token: TOKEN })); await Bun.sleep(1)
    expect(h.auth.status().state).toBe("cancelled")
    expect(() => readFileSync(path.join(h.dir, COPILOT_AUTH_FILE))).toThrow()
    const denied = login(() => ({ error: `denied ${TOKEN}` }))
    await denied.auth.authorize(); await denied.tick()
    expect(denied.auth.status().state).toBe("failed")
    expect(JSON.stringify(denied.auth.status())).not.toContain(TOKEN)
  })
  test("expiring tokens refresh once concurrently; logout wins against a late refresh", async () => {
    const dir = temp(), file = path.join(dir, COPILOT_AUTH_FILE)
    writeFileSync(file, JSON.stringify({ access: TOKEN, refresh: "private-refresh", issuer: "http://127.0.0.1:3210", expiresAt: 1 }))
    let count = 0, resolve!: (response: Response) => void
    const auth = createCopilotAuth({ dir, issuer: "http://127.0.0.1:3210", clientId: "fixture", fetch: async () => { count++; return new Promise<Response>((done) => { resolve = done }) } })
    const a = auth.tokenForRequest(), b = auth.tokenForRequest()
    expect(count).toBe(1)
    resolve(Response.json({ access_token: "private-new-token", expires_in: 3600 }))
    expect(await a).toBe("private-new-token"); expect(await b).toBe("private-new-token")
    const refreshing = auth.refresh(); auth.logout(); resolve(Response.json({ access_token: "private-late-token", expires_in: 3600 }))
    await expect(refreshing).rejects.toThrow("refresh failed")
    expect(auth.token()).toBeUndefined()
  })
  test("default login is unavailable; public HTTP and corrupt stores fail without leaking bytes", async () => {
    const auth = createCopilotAuth({ dir: temp() })
    expect(auth.available()).toBe(false)
    await expect(auth.authorize()).rejects.toThrow("CLIENT_ID")
    for (const issuer of ["http://public.example", "https://user:secret@github.com", "https://github.com?token=secret"]) expect(() => createCopilotAuth({ dir: temp(), issuer })).toThrow("HTTPS or loopback")
    const dir = temp(); writeFileSync(path.join(dir, COPILOT_AUTH_FILE), TOKEN)
    const corrupt = createCopilotAuth({ dir })
    expect(corrupt.status()).toMatchObject({ state: "failed", accessTokenPresent: false })
    expect(JSON.stringify(corrupt.status())).not.toContain(TOKEN)
    await expect(corrupt.tokenForRequest()).rejects.toThrow("invalid Copilot credential store")
  })
})
