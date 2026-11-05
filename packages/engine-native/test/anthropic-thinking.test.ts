import { afterEach, describe, expect, test } from "bun:test"
import { anthropicThinkingStyle, createAnthropicProvider, withoutThinkingBlocks, type ModelMessage, type ModelRequest } from "../src"
import { collect, fakeServer, sse } from "./fake-server"

const KEY = "sk-ant-test-0123456789abcdefghijklmnop"
const stops: Array<() => void> = []
afterEach(() => stops.splice(0).forEach((stop) => stop()))

const FINAL = [
  { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 5, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
  { type: "message_stop" },
]

function setup(handler: Parameters<typeof fakeServer>[0] = () => sse(FINAL, { named: true }), options: { maxTokens?: number } = {}) {
  const server = fakeServer(handler)
  stops.push(server.stop)
  const provider = createAnthropicProvider({ id: "anthropic", model: "claude-test", apiKey: () => KEY, baseUrl: `${server.url}/v1`, ...options })
  return { server, provider }
}

const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({
  system: "be brief",
  messages: [{ role: "user", content: "hi" }],
  tools: [],
  signal: new AbortController().signal,
  ...overrides,
})

/** The request body each (model, effort) pair is sent as. */
async function bodyFor(model: string, effort: ModelRequest["effort"], extra: Partial<ModelRequest> = {}) {
  const { server, provider } = setup()
  await collect(provider.stream(request({ model, effort, ...extra })))
  return server.requests[0]!.body
}

const ADAPTIVE = { type: "adaptive", display: "summarized" }

describe("Anthropic thinking per model", () => {
  test("Opus 5.5: adaptive with the effort, never a budget or disabled; off means the lowest effort", async () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      const body = await bodyFor("claude-opus-5-5", effort)
      expect(body.thinking).toEqual(ADAPTIVE)
      expect(body.output_config).toEqual({ effort })
    }
    for (const effort of [undefined, "none", "minimal"] as const) {
      const body = await bodyFor("claude-opus-5-5", effort)
      expect(body.thinking).toEqual(ADAPTIVE)
      expect(body.output_config).toEqual({ effort: "low" })
    }
  })

  test("Fable 5.1 and Mythos 5.1 take the same adaptive form and cannot be turned off", async () => {
    for (const model of ["claude-fable-5-1", "claude-fable-5", "claude-mythos-5-1"]) {
      expect((await bodyFor(model, "high")).output_config).toEqual({ effort: "high" })
      const off = await bodyFor(model, "none")
      expect(off.thinking).toEqual(ADAPTIVE)
      expect(off.output_config).toEqual({ effort: "low" })
    }
  })

  test("Sonnet 5.5: adaptive with the effort; off is between_tools alone (disabled is a 400)", async () => {
    const on = await bodyFor("claude-sonnet-5-5", "medium")
    expect(on.thinking).toEqual(ADAPTIVE)
    expect(on.output_config).toEqual({ effort: "medium" })
    for (const effort of [undefined, "none", "minimal"] as const) {
      const off = await bodyFor("claude-sonnet-5-5", effort)
      expect(off.thinking).toEqual({ type: "between_tools" })
      expect(off.output_config).toBeUndefined()
    }
  })

  test("Haiku 5.5, Opus 5 and Sonnet 5: adaptive with the effort; off is disabled", async () => {
    for (const model of ["claude-haiku-5-5", "claude-opus-5", "claude-sonnet-5"]) {
      const on = await bodyFor(model, "xhigh")
      expect(on.thinking).toEqual(ADAPTIVE)
      expect(on.output_config).toEqual({ effort: "xhigh" })
      const off = await bodyFor(model, "minimal")
      expect(off.thinking).toEqual({ type: "disabled" })
      expect(off.output_config).toBeUndefined()
    }
  })

  test("Opus 4.8 and 4.7: adaptive when asked; off leaves thinking out (they think only when asked)", async () => {
    for (const model of ["claude-opus-4-8", "claude-opus-4-7"]) {
      expect((await bodyFor(model, "high")).thinking).toEqual(ADAPTIVE)
      const off = await bodyFor(model, undefined)
      expect(off.thinking).toBeUndefined()
      expect(off.output_config).toBeUndefined()
    }
  })

  test("older models keep the token budget: Opus/Sonnet 4.6, Haiku 4.5, dated and unknown ids", async () => {
    for (const model of ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-haiku-4-5@20251001", "claude-opus-4-1-20250805", "claude-sonnet-4-20250514", "claude-3-5-sonnet-latest", "claude-x"]) {
      const body = await bodyFor(model, "medium")
      expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 8_000 })
      expect(body.output_config).toBeUndefined()
      expect((await bodyFor(model, undefined)).thinking).toBeUndefined()
    }
  })

  test("a provider prefix or a context suffix on the id does not change the shape", () => {
    expect(anthropicThinkingStyle("anthropic/claude-opus-5-5")).toEqual({ style: "adaptive", off: "never" })
    expect(anthropicThinkingStyle("anthropic.claude-sonnet-5-5-v1:0")).toEqual({ style: "adaptive", off: "between_tools" })
    expect(anthropicThinkingStyle("claude-opus-5-5[1m]")).toEqual({ style: "adaptive", off: "never" })
    expect(anthropicThinkingStyle("claude-opus-4-5-20251101")).toEqual({ style: "budget" })
  })

  test("a deep adaptive request has room for thinking and the answer; a bounded one keeps its cap and thinks only above the minimum", async () => {
    expect((await bodyFor("claude-opus-5-5", "high")).max_tokens).toBe(64_000)
    expect((await bodyFor("claude-opus-5-5", "low")).max_tokens).toBe(32_000)
    const bounded = await bodyFor("claude-sonnet-5-5", "high", { maxOutputTokens: 300 })
    expect(bounded.max_tokens).toBe(300)
    expect(bounded.thinking).toEqual({ type: "between_tools" })
    const capped = setup(undefined, { maxTokens: 16_000 })
    await collect(capped.provider.stream(request({ model: "claude-opus-5-5", effort: "max" })))
    expect(capped.server.requests[0]!.body.max_tokens).toBe(16_000)
  })

  test("a tool loop whose earlier steps carry no signed reasoning keeps thinking on for an adaptive model", async () => {
    const history: ModelMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ callId: "c1", name: "read", args: "{}" }] },
      { role: "tool", callId: "c1", name: "read", output: "ok", isError: false },
    ]
    const { server, provider } = setup()
    const events = await collect(provider.stream(request({ model: "claude-opus-5-5", effort: "high", messages: history })))
    expect(server.requests[0]!.body.thinking).toEqual(ADAPTIVE)
    expect(events.find((event) => event.type === "usage")).not.toHaveProperty("usage.thinkingDropped")
  })

  test("a variant's own thinking parameters still win over the default", async () => {
    const body = await bodyFor("claude-opus-5-5", "high", { parameters: { thinking: { display: "omitted" } } })
    expect(body.thinking).toEqual({ type: "adaptive", display: "omitted" })
  })
})

describe("preserved thinking", () => {
  const signed: ModelMessage[] = [
    { role: "user", content: "go" },
    { role: "assistant", content: "", toolCalls: [{ callId: "c1", name: "read", args: "{}" }], reasoning: { provider: "anthropic", model: "claude-opus-5-5", blocks: [{ type: "thinking", thinking: "hm", signature: "sig" }] } },
    { role: "tool", callId: "c1", name: "read", output: "ok", isError: false },
  ]

  test("this model's signed thinking goes back unchanged, and another model's is left out", async () => {
    const { server, provider } = setup()
    await collect(provider.stream(request({ model: "claude-opus-5-5", effort: "high", messages: signed })))
    expect(server.requests[0]!.body.messages[1].content[0]).toEqual({ type: "thinking", thinking: "hm", signature: "sig" })
    await collect(provider.stream(request({ model: "claude-sonnet-5-5", effort: "high", messages: signed })))
    expect(JSON.stringify(server.requests[1]!.body.messages)).not.toContain("signature")
  })

  test("a 400 about an invalid thinking signature is retried once without the thinking blocks", async () => {
    const refusal = JSON.stringify({ error: { type: "invalid_request_error", message: "messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation." } })
    const { server, provider } = setup((_, index) => (index === 0 ? new Response(refusal, { status: 400 }) : sse(FINAL, { named: true })))
    const events = await collect(provider.stream(request({ model: "claude-opus-5-5", effort: "high", messages: signed })))
    expect(server.requests).toHaveLength(2)
    expect(JSON.stringify(server.requests[0]!.body.messages)).toContain("signature")
    expect(JSON.stringify(server.requests[1]!.body.messages)).not.toContain("thinking")
    expect(server.requests[1]!.body.thinking).toEqual(ADAPTIVE)
    expect(events.some((event) => event.type === "text")).toBe(true)
  })

  test("any other 400 is final and sent once", async () => {
    const { server, provider } = setup(() => new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "max_tokens too large" } }), { status: 400 }))
    await expect(collect(provider.stream(request({ model: "claude-opus-5-5", effort: "high", messages: signed })))).rejects.toThrow()
    expect(server.requests).toHaveLength(1)
  })

  test("withoutThinkingBlocks drops thinking and redacted_thinking, a turn that was only thinking, and nothing else", () => {
    const body = { messages: [{ role: "user", content: [{ type: "text", text: "a" }] }, { role: "assistant", content: [{ type: "redacted_thinking", data: "x" }, { type: "text", text: "b" }] }, { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "s" }] }] }
    expect(withoutThinkingBlocks(body)).toEqual({ messages: [body.messages[0], { role: "assistant", content: [{ type: "text", text: "b" }] }] })
    const clean = { messages: [{ role: "user", content: "x" }] }
    expect(withoutThinkingBlocks(clean)).toBe(clean)
  })
})
