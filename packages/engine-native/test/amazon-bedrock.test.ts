import { describe, expect, test } from "bun:test"
import { createApiProvider, bedrockModelId, awsEndpoint, signAws, RetryableProviderError, type ModelEvent, type ModelRequest, type ResolvedProvider } from "../src"
import { fetchProviderModels } from "../src/provider-remote"
import { bedrockBody } from "../src/amazon-bedrock"
import { crc32 } from "../src/aws-eventstream"
import { bedrockFinish, bedrockFrame, bedrockResponse } from "./bedrock-fixtures"

const KEY = "fixture-bedrock-bearer-never-print"
const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({ system: "Be brief", messages: [{ role: "user", content: "Read it" }], tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }], signal: new AbortController().signal, ...over })
const resolved = (over: Partial<ResolvedProvider> = {}): ResolvedProvider => ({ id: "amazon-bedrock", type: "amazon-bedrock", baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com", apiKey: () => KEY, keyRequired: true, models: [{ id: "anthropic.claude-sonnet-4-5-20250929-v1:0", images: true }], bedrock: { region: "us-east-1" }, ...over })
const collect = async (events: AsyncIterable<ModelEvent>) => { const out: ModelEvent[] = []; for await (const event of events) out.push(event); return out }

describe("B10.01 Bedrock native wire", () => {
  test("SigV4 matches an independently calculated IAM vector; temporary credentials are signed", () => {
    const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" }
    const base = { url: "https://iam.amazonaws.com/?Version=2010-05-08&Action=ListUsers", method: "GET", body: "", region: "us-east-1", service: "iam", credentials, headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" }, now: new Date("2015-08-30T12:36:00Z") }
    const signed = signAws(base)
    expect(signed.authorization).toBe("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=dd479fa8a80364edf2119ec24bebde66712ee9c9cb2b0d92eb3ab9ccdc0c3947")
    const temporary = signAws({ ...base, credentials: { ...credentials, sessionToken: "session-token-fixture" } })
    expect(temporary["x-amz-security-token"]).toBe("session-token-fixture")
    expect(temporary.authorization).toContain("x-amz-security-token")
    expect(temporary.authorization).not.toBe(signed.authorization)
    expect(signAws({ ...base, url: "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08" })).toEqual(signed)
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926)
  })

  test("v1 region prefixing, explicit profiles and endpoint policy", () => {
    for (const [region, model, expected] of [
      ["us-east-1", "amazon.nova-lite-v1:0", "us.amazon.nova-lite-v1:0"],
      ["us-gov-west-1", "anthropic.claude", "anthropic.claude"],
      ["eu-west-1", "anthropic.claude", "eu.anthropic.claude"],
      ["ap-northeast-1", "anthropic.claude", "jp.anthropic.claude"],
      ["ap-southeast-2", "anthropic.claude-sonnet-4-5", "au.anthropic.claude-sonnet-4-5"],
      ["ap-southeast-1", "amazon.nova-pro", "apac.amazon.nova-pro"],
      ["us-east-1", "global.anthropic.claude", "global.anthropic.claude"],
      ["us-east-1", "arn:aws:bedrock:us-east-1:123456789012:inference-profile/team", "arn:aws:bedrock:us-east-1:123456789012:inference-profile/team"],
    ]) expect(bedrockModelId(model!, region!)).toBe(expected!)
    for (const endpoint of ["http://remote.example", "https://user:secret@remote.example", "https://remote.example?q=secret", "https://remote.example#secret"]) expect(() => awsEndpoint(endpoint)).toThrow()
    expect(awsEndpoint("http://127.0.0.1:1234/")).toBe("http://127.0.0.1:1234")
  })

  test("binary stream: text, concurrent tool JSON, signed reasoning, usage and finish", async () => {
    let body: any
    const adapter = createApiProvider({ provider: resolved(), fetch: async (url, init) => {
      expect(url).toEndWith("/model/us.anthropic.claude-sonnet-4-5-20250929-v1%3A0/converse-stream")
      expect(init.redirect).toBe("error")
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEY}`)
      body = JSON.parse(String(init.body))
      return bedrockResponse([
        bedrockFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { text: "Think" } } }),
        bedrockFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { signature: "signed" } } }),
        bedrockFrame("contentBlockStop", { contentBlockIndex: 0 }),
        bedrockFrame("contentBlockDelta", { contentBlockIndex: 1, delta: { text: "Reading 東京" } }),
        bedrockFrame("contentBlockStart", { contentBlockIndex: 2, start: { toolUse: { toolUseId: "c1", name: "read" } } }),
        bedrockFrame("contentBlockStart", { contentBlockIndex: 3, start: { toolUse: { toolUseId: "c2", name: "read" } } }),
        bedrockFrame("contentBlockDelta", { contentBlockIndex: 2, delta: { toolUse: { input: '{"path":' } } }),
        bedrockFrame("contentBlockDelta", { contentBlockIndex: 3, delta: { toolUse: { input: '{"path":"b.ts"}' } } }),
        bedrockFrame("contentBlockDelta", { contentBlockIndex: 2, delta: { toolUse: { input: '"a.ts"}' } } }),
        bedrockFrame("contentBlockStop", { contentBlockIndex: 2 }), bedrockFrame("contentBlockStop", { contentBlockIndex: 3 }), ...bedrockFinish("tool_use"),
      ], 3)
    } })
    const events = await collect(adapter.stream(request({ effort: "low", headers: { Authorization: "evil", "X-Amz-Security-Token": "evil" } })))
    expect(events).toContainEqual({ type: "text", delta: "Reading 東京" })
    expect(events).toContainEqual({ type: "reasoning", delta: "Think" })
    expect(events).toContainEqual({ type: "tool_call", call: { callId: "c1", name: "read", args: { path: "a.ts" } } })
    expect(events).toContainEqual({ type: "tool_call", call: { callId: "c2", name: "read", args: { path: "b.ts" } } })
    expect(events).toContainEqual({ type: "usage", usage: { input: 100, output: 20, reasoning: 0, cacheRead: 60, cacheWrite: 30 } })
    expect(events.at(-2)).toMatchObject({ type: "reasoning_state", state: { provider: "amazon-bedrock", blocks: [{ reasoningContent: { reasoningText: { text: "Think", signature: "signed" } } }] } })
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool_calls" })
    expect(body.toolConfig.tools[0].toolSpec.inputSchema).toEqual({ json: { type: "object" } })
    expect(body.additionalModelRequestFields.thinking).toMatchObject({ type: "enabled", budget_tokens: 2048 })
  })

  test("history pairs tool results, preserves signed reasoning and images; unsupported images become notes", async () => {
    const model = resolved().models[0]!.id
    const history = request({ model, effort: "low", messages: [
      { role: "user", content: "look", images: [{ mime: "image/png", base64: "AAAA" }], documents: [{ mime: "application/pdf", name: "report.pdf", base64: "BBBB" }] },
      { role: "assistant", content: "", toolCalls: [{ callId: "c1", name: "read", args: { path: "a.ts" } }, { callId: "c2", name: "read", args: {} }], reasoning: { provider: "amazon-bedrock", model, blocks: [{ reasoningContent: { reasoningText: { text: "think", signature: "signed" } } }] } },
      { role: "tool", callId: "c1", name: "read", output: "file", isError: false },
    ] })
    const body = bedrockBody(history, "amazon-bedrock", model) as any
    expect(body.messages[0].content).toContainEqual({ image: { format: "png", source: { bytes: "AAAA" } } })
    expect(body.messages[0].content).toContainEqual({ document: { format: "pdf", name: "Document 1", source: { bytes: "BBBB" } } })
    expect(body.messages[1].content[0]).toMatchObject({ reasoningContent: { reasoningText: { signature: "signed" } } })
    expect(body.messages[2].content).toContainEqual({ toolResult: { toolUseId: "c2", content: [{ text: "cancelled" }], status: "error" } })
    const wrong = { ...history, messages: structuredClone(history.messages) }
    const assistant = wrong.messages[1]
    if (assistant?.role === "assistant" && assistant.reasoning) assistant.reasoning.provider = "anthropic"
    expect((bedrockBody(wrong, "amazon-bedrock", model) as any).additionalModelRequestFields).toBeUndefined()
    history.messages.push({ role: "assistant", content: "", toolCalls: [{ callId: "c3", name: "read", args: {} }] }, { role: "tool", callId: "c3", name: "read", output: "file", isError: false })
    expect((bedrockBody(history, "amazon-bedrock", model) as any).additionalModelRequestFields).toBeUndefined()
    let sent: any
    await collect(createApiProvider({ provider: resolved({ models: [{ id: model, images: false }] }), fetch: async (_, init) => { sent = JSON.parse(String(init.body)); return bedrockResponse() } }).stream(history))
    expect(sent.messages[0].content.some((block: any) => block.image)).toBe(false)
    expect(sent.messages[0].content[0].text).toContain("image omitted")
  })

  test("live bearer rotation, AWS signing and model aliases use the same factory", async () => {
    let token: string | undefined = KEY
    let calls = 0
    const adapter = createApiProvider({ provider: resolved({ apiKey: () => token, awsCredentials: async () => { calls++; return { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "fixture-secret-key", sessionToken: "fixture-session" } }, models: [{ id: "prod", options: { bedrockModelId: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/team" } }] }), fetch: async (url, init) => {
      expect(decodeURIComponent(url)).toContain("/model/arn:aws:bedrock:")
      const auth = new Headers(init.headers)
      if (token) expect(auth.get("authorization")).toBe(`Bearer ${token}`)
      else { expect(auth.get("authorization")).toContain("/us-east-1/bedrock/aws4_request"); expect(auth.get("x-amz-security-token")).toBe("fixture-session") }
      return bedrockResponse()
    } })
    await collect(adapter.stream(request({ model: "prod" })))
    token = `${KEY}-rotated`; await collect(adapter.stream(request({ model: "prod" })))
    expect(calls).toBe(0)
    token = undefined; await collect(adapter.stream(request({ model: "prod" })))
    expect(calls).toBe(1)
  })

  test("stream failures and HTTP failures never echo credentials or provider user content", async () => {
    for (const status of [401, 403, 400, 429, 503]) {
      const adapter = createApiProvider({ provider: resolved(), fetch: async () => new Response(`${KEY} private user content`, { status }) })
      try { await collect(adapter.stream(request())); throw new Error("expected failure") }
      catch (error) { expect(String(error)).not.toContain(KEY); expect(String(error)).not.toContain("private user"); expect(error instanceof RetryableProviderError).toBe(status === 429 || status === 503) }
    }
    const frames = [bedrockFrame("validationException", { message: `${KEY} private user content` }, true)]
    await expect(collect(createApiProvider({ provider: resolved(), fetch: async () => bedrockResponse(frames) }).stream(request()))).rejects.toThrow("validationException")
    const corrupt = bedrockFrame("messageStop", { stopReason: "end_turn" }); corrupt[corrupt.length - 1]! ^= 1
    await expect(collect(createApiProvider({ provider: resolved(), fetch: async () => bedrockResponse([corrupt]) }).stream(request()))).rejects.toThrow("checksum")
    await expect(collect(createApiProvider({ provider: resolved(), fetch: async () => bedrockResponse([bedrockFinish()[0]!]) }).stream(request()))).rejects.toBeInstanceOf(RetryableProviderError)
    const throttle = createApiProvider({ provider: resolved(), fetch: async () => new Response("private", { status: 429, headers: { "retry-after": "2" } }) })
    try { await collect(throttle.stream(request())) } catch (error) { expect(error).toMatchObject({ retryAfterMs: 2000 }) }
  })

  test("idle stall retries, cancellation closes the reader and length finish is retained", async () => {
    let cancelled = false
    const provider = createApiProvider({ provider: resolved(), idleTimeoutMs: 15, fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true } })) })
    await expect(collect(provider.stream(request()))).rejects.toBeInstanceOf(RetryableProviderError)
    expect(cancelled).toBe(true)
    const abort = new AbortController()
    const stopped = createApiProvider({ provider: resolved(), fetch: async () => { setTimeout(() => abort.abort(), 10); return new Response(new ReadableStream({ cancel() { cancelled = true } })) } })
    expect(await collect(stopped.stream(request({ signal: abort.signal })))).toEqual([])
    const length = createApiProvider({ provider: resolved(), fetch: async () => bedrockResponse(bedrockFinish("max_tokens")) })
    expect((await collect(length.stream(request()))).at(-1)).toEqual({ type: "finish", reason: "length" })
    const redacted = createApiProvider({ provider: resolved(), fetch: async () => bedrockResponse([
      bedrockFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { redactedContent: "YQ==" } } }),
      bedrockFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { redactedContent: "Yg==" } } }),
      ...bedrockFinish(),
    ]) })
    expect((await collect(redacted.stream(request()))).at(-2)).toMatchObject({ type: "reasoning_state", state: { blocks: [{ reasoningContent: { redactedContent: "YWI=" } }] } })
  })

  test("authenticated Bedrock control plane lists streaming text models and refuses redirects", async () => {
    const models = await fetchProviderModels({ provider: resolved(), fetch: async (url, init) => {
      expect(url).toBe("https://bedrock.us-east-1.amazonaws.com/foundation-models?byOutputModality=TEXT")
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEY}`)
      expect(init.redirect).toBe("error")
      return Response.json({ modelSummaries: [{ modelId: "amazon.nova-lite-v1:0", modelName: "Nova Lite", responseStreamingSupported: true, inputModalities: ["TEXT", "IMAGE"], outputModalities: ["TEXT"] }, { modelId: "embeddings", responseStreamingSupported: false }, { modelId: "picture", responseStreamingSupported: true, outputModalities: ["IMAGE"] }] })
    } })
    expect(models).toEqual([{ id: "amazon.nova-lite-v1:0", name: "Nova Lite", images: true }])
  })
})
