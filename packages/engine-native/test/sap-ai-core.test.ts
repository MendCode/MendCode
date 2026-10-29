import { describe, expect, test } from "bun:test"
import { createApiProvider, fetchProviderModels, RetryableProviderError, testProvider } from "../src"
import { parseSapServiceKey } from "../src/sap-ai-core"
import { collectSap, sapDone, sapFake, sapRequest, sapResolved, sapSse, SAP_KEY, SAP_MODELS, SAP_SECRET, SAP_SERVICE, SAP_TOKEN, SAP_URL } from "./sap-ai-fixtures"

describe("B10.18 SAP AI Core native transport", () => {
  test("exchanges a service key, authenticates orchestration, and keeps credentials out of hooks/body", async () => {
    let tokens = 0
    const provider = createApiProvider({ provider: sapResolved({ headers: { authorization: "wrong", "AI-Resource-Group": "wrong" } }), fetch: async (url, init) => {
      expect(init.redirect).toBe("error")
      const headers = new Headers(init.headers)
      if (url.endsWith("/oauth/token")) {
        tokens++
        expect(headers.get("authorization")).toBe(`Basic ${Buffer.from(`${SAP_SERVICE.clientid}:${SAP_SECRET}`).toString("base64")}`)
        expect(init.body).toBe("grant_type=client_credentials")
      } else {
        expect(url).toBe(`${SAP_URL}/inference/deployments/deployment-fixture/v2/completion`)
        expect(headers.get("authorization")).toBe(`Bearer ${SAP_TOKEN}`)
        expect(headers.get("AI-Resource-Group")).toBe("test")
        const body = JSON.parse(String(init.body))
        const module = body.config.modules.prompt_templating
        expect(body.config.stream.enabled).toBe(true)
        expect(module.model).toMatchObject({ name: "chat-fixture", params: { max_tokens: 4096, temperature: 0.2, stream_options: { include_usage: true } } })
        expect(module.prompt.template).toMatchObject([{ role: "system", content: "Be brief" }, { role: "user", content: "Read a.ts" }])
        expect(module.prompt.tools[0].function.name).toBe("read")
        for (const secret of [SAP_KEY, SAP_SECRET, SAP_TOKEN]) expect(String(init.body)).not.toContain(secret)
      }
      return sapFake(url, init)
    } })
    const request = sapRequest({ model: "chat-fixture", maxOutputTokens: 8000, parameters: { temperature: 0.2 }, headers: { authorization: "hook-token", "AI-Resource-Group": "hook-group" } })
    expect((await collectSap(provider.stream(request))).at(-1)).toEqual({ type: "finish", reason: "stop" })
    await collectSap(provider.stream(request))
    expect(tokens).toBe(1)
  })

  test("normalizes fragmented text, reasoning, parallel tools, usage and a tool-result followup", async () => {
    let call = 0
    const provider = createApiProvider({ provider: sapResolved(), fetch: async (url, init) => {
      if (url.endsWith("/oauth/token")) return sapFake(url, init)
      if (call++ > 0) {
        const messages = JSON.parse(String(init.body)).config.modules.prompt_templating.prompt.template
        expect(messages.some((entry: { role: string; tool_call_id?: string }) => entry.role === "tool" && entry.tool_call_id === "read-call")).toBe(true)
        return sapDone()
      }
      const response = sapSse([
        { intermediate_results: { content: "must not render" } },
        { final_result: { choices: [{ delta: { content: "Reading", reasoning_content: "Consider" } }] } },
        { final_result: { choices: [{ delta: { tool_calls: [{ index: 0, id: "read-call", function: { name: "read", arguments: '{"path":' } }, { index: 1, id: "other-call", function: { name: "read", arguments: '{"path":"b.ts"}' } }] } }] } },
        { final_result: { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }, finish_reason: "tool_calls" }] } },
        { final_result: { usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 25 }, completion_tokens_details: { reasoning_tokens: 4 } } } },
      ])
      const bytes = new Uint8Array(await response.arrayBuffer())
      return new Response(new ReadableStream({ start(controller) { for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7)); controller.close() } }))
    } })
    const events = await collectSap(provider.stream(sapRequest()))
    expect(events).toContainEqual({ type: "text", delta: "Reading" })
    expect(events).toContainEqual({ type: "reasoning", delta: "Consider" })
    expect(events.filter((event) => event.type === "tool_call")).toEqual([{ type: "tool_call", call: { callId: "read-call", name: "read", args: { path: "a.ts" } } }, { type: "tool_call", call: { callId: "other-call", name: "read", args: { path: "b.ts" } } }])
    expect(events).toContainEqual({ type: "usage", usage: { input: 75, output: 10, reasoning: 4, cacheRead: 25, cacheWrite: 0 } })
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool_calls" })
    expect(JSON.stringify(events)).not.toContain("must not render")
    await collectSap(provider.stream(sapRequest({ messages: [{ role: "user", content: "Read" }, { role: "assistant", content: "Reading", toolCalls: [{ callId: "read-call", name: "read", args: { path: "a.ts" } }] }, { role: "tool", callId: "read-call", name: "read", output: "file content", isError: false }] })))
  })

  test("discovers the latest running orchestration deployment and tenant chat models only", async () => {
    const provider = sapResolved({ sapAi: {} })
    const models = await fetchProviderModels({ provider, fetch: sapFake })
    expect(models).toEqual([{ id: "chat-fixture", name: "SAP chat fixture", context: 128_000, images: true }, { id: "text-fixture", name: "SAP text fixture", images: false }])
    expect(await testProvider({ provider, fetch: async (url, init) => {
      if (url.endsWith("/lm/deployments")) return Response.json({ resources: [{ id: "bad", scenarioId: "other", status: "RUNNING" }, { id: "stopped", scenarioId: "orchestration", status: "STOPPED" }, { id: "old", scenarioId: "orchestration", status: "RUNNING", createdAt: "2025" }, { id: "latest", scenarioId: "orchestration", status: "RUNNING", createdAt: "2026" }] })
      if (init.method === "POST" && !url.endsWith("/oauth/token")) expect(url).toContain("/latest/v2/completion")
      return sapFake(url, init)
    } })).toMatchObject({ ok: true, model: SAP_MODELS[0]!.id })
  })

  test("rotating service keys and expired or rejected tokens exchange again without process.env mutation", async () => {
    let key = SAP_KEY, exchanges = 0, reject = false
    const before = process.env.AICORE_SERVICE_KEY
    const provider = createApiProvider({ provider: sapResolved({ apiKey: () => key }), fetch: async (url, init) => {
      if (url.endsWith("/oauth/token")) { exchanges++; return Response.json({ access_token: SAP_TOKEN, expires_in: exchanges === 1 ? 0.001 : 3600 }) }
      if (reject) { reject = false; return new Response(SAP_TOKEN, { status: 401 }) }
      return sapFake(url, init)
    } })
    await collectSap(provider.stream(sapRequest()))
    await Bun.sleep(3)
    await collectSap(provider.stream(sapRequest()))
    key = JSON.stringify({ ...SAP_SERVICE, clientsecret: `${SAP_SECRET}-rotated` })
    await collectSap(provider.stream(sapRequest()))
    reject = true
    await expect(collectSap(provider.stream(sapRequest()))).rejects.toThrow("401")
    await collectSap(provider.stream(sapRequest()))
    expect(exchanges).toBe(4)
    expect(process.env.AICORE_SERVICE_KEY).toBe(before)
  })

  test("refuses missing/malformed keys, every public or capability URL, and unsafe deployments before transport", async () => {
    for (const value of [undefined, "not JSON", "{}", JSON.stringify({ ...SAP_SERVICE, clientsecret: "" })]) expect(() => parseSapServiceKey(value)).toThrow()
    for (const url of ["http://public.example/v2","http://localhost.evil/v2", "http://u:p@localhost/v2", "http://localhost/v2?token=x", "http://localhost/v2#x", "ftp://localhost/v2"]) {
      for (const over of [{ baseUrl: url }, { apiKey: () => JSON.stringify({ ...SAP_SERVICE, url }) }, { apiKey: () => JSON.stringify({ ...SAP_SERVICE, serviceurls: { AI_API_URL: url } }) }]) {
        let calls = 0
        const provider = sapResolved(over)
        expect(await testProvider({ provider, fetch: async () => { calls++; return sapDone() } })).toMatchObject({ ok: false, error: expect.stringContaining("loopback") })
        await expect(fetchProviderModels({ provider, fetch: async () => { calls++; return sapDone() } })).rejects.toThrow("loopback")
        expect(calls).toBe(0)
      }
    }
    expect(await testProvider({ provider: sapResolved({ sapAi: { deploymentId: "../escape" } }), fetch: async () => { throw new Error("must not call") } })).toMatchObject({ ok: false, error: expect.stringContaining("invalid SAP") })
  })

  test("auth/service/stream failures never echo key components, and retryable status stays retryable", async () => {
    for (const [status, oauth] of [[401, true], [302, true], [429, false], [503, false]] as const) {
      const provider = sapResolved()
      const fetch = async (url: string, init: RequestInit) => url.endsWith("/oauth/token") === oauth ? new Response(`${SAP_KEY} ${SAP_SECRET} ${SAP_TOKEN}`, { status, headers: { "retry-after": "2" } }) : sapFake(url, init)
      const result = await testProvider({ provider, fetch })
      expect(result.ok).toBe(false)
      for (const secret of [SAP_SERVICE.clientid, SAP_SECRET, SAP_TOKEN]) expect(JSON.stringify(result)).not.toContain(secret)
      if (status >= 400 && !oauth) await expect(collectSap(createApiProvider({ provider, fetch }).stream(sapRequest()))).rejects.toBeInstanceOf(RetryableProviderError)
    }
    expect(await testProvider({ provider: sapResolved(), fetch: async (url, init) => url.endsWith("/oauth/token") ? sapFake(url, init) : sapSse([{ error: { code: 400, message: SAP_SECRET } }]) })).toMatchObject({ ok: false, error: expect.stringContaining("orchestration failed") })
    expect(await testProvider({ provider: sapResolved(), fetch: async (url, init) => url.endsWith("/oauth/token") ? sapFake(url, init) : sapSse([{ final_result: { choices: [{ delta: { content: "incomplete" } }] } }], false) })).toMatchObject({ ok: false, error: expect.stringContaining("without completion") })
  })

  test("abort reaches token exchange and a silent token exchange observes the stream deadline", async () => {
    const controller = new AbortController()
    const provider = createApiProvider({ provider: sapResolved(), fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
      controller.abort()
    }) })
    expect(await collectSap(provider.stream(sapRequest({ signal: controller.signal })))).toEqual([])
    await expect(collectSap(createApiProvider({ provider: sapResolved(), idleTimeoutMs: 20, fetch: async (_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) }).stream(sapRequest()))).rejects.toThrow("stalled")
  })
})
