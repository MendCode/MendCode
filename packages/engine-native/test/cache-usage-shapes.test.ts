import { afterEach, describe, expect, test } from "bun:test"
import { createChatCompletionsProvider, createResponsesProvider, createAnthropicProvider } from "../src"
import { collect, fakeServer, sse } from "./fake-server"

const stops: Array<() => void> = []
afterEach(() => stops.splice(0).forEach((fn) => fn()))
const KEY = "sk-test-0123456789abcdefghijklmnop"

/** The usage a chat host reports, in the shape it sends it (recorded shapes, written down from the hosts' documentation; no host is called). */
async function chatUsage(usage: Record<string, unknown>, id = "deepseek") {
  const server = fakeServer(() => sse([{ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }, { choices: [], usage }, "[DONE]"]))
  stops.push(server.stop)
  const provider = createChatCompletionsProvider({ id, model: "m", baseUrl: `${server.url}/v1`, apiKey: () => KEY, requireKey: true })
  const events = await collect(provider.stream({ system: "s", messages: [{ role: "user", content: "hi" }], tools: [], signal: new AbortController().signal }))
  return events.find((event) => event.type === "usage")
}

describe("cache reads of Chat Completions hosts", () => {
  test("DeepSeek: prompt_cache_hit_tokens are cache reads and the miss is the input", async () => {
    const event = await chatUsage({ prompt_tokens: 20_000, completion_tokens: 300, total_tokens: 20_300, prompt_cache_hit_tokens: 18_944, prompt_cache_miss_tokens: 1_056, completion_tokens_details: { reasoning_tokens: 120 } })
    expect(event).toEqual({ type: "usage", usage: { input: 1_056, output: 300, reasoning: 120, cacheRead: 18_944, cacheWrite: 0 } })
  })

  test("DeepSeek sending both its own counters and prompt_tokens_details counts the hit once", async () => {
    const event = await chatUsage({ prompt_tokens: 20_000, completion_tokens: 300, prompt_cache_hit_tokens: 18_944, prompt_cache_miss_tokens: 1_056, prompt_tokens_details: { cached_tokens: 18_944 } })
    expect(event).toMatchObject({ usage: { input: 1_056, cacheRead: 18_944 } })
  })

  test("GLM (z.ai): prompt_tokens_details.cached_tokens are cache reads", async () => {
    const event = await chatUsage({ prompt_tokens: 12_000, completion_tokens: 200, total_tokens: 12_200, prompt_tokens_details: { cached_tokens: 11_264 } }, "zai")
    expect(event).toEqual({ type: "usage", usage: { input: 736, output: 200, reasoning: 0, cacheRead: 11_264, cacheWrite: 0 } })
  })

  test("a host with no cache counters reports no cache reads, and a count above the prompt is capped to it", async () => {
    expect(await chatUsage({ prompt_tokens: 500, completion_tokens: 5 })).toMatchObject({ usage: { input: 500, cacheRead: 0 } })
    expect(await chatUsage({ prompt_tokens: 500, completion_tokens: 5, prompt_cache_hit_tokens: 900 })).toMatchObject({ usage: { input: 0, cacheRead: 500 } })
  })

  test("what the adapter sends defeats no prefix cache: the same conversation serializes the same bytes twice, system first", async () => {
    const bodies: string[] = []
    const server = fakeServer((request) => { bodies.push(JSON.stringify(request.body)); return sse([{ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }, "[DONE]"]) })
    stops.push(server.stop)
    const provider = createChatCompletionsProvider({ id: "zai", model: "glm", baseUrl: `${server.url}/v1`, apiKey: () => KEY, requireKey: true })
    const request = { system: "SYSTEM", messages: [{ role: "user" as const, content: "hi" }, { role: "assistant" as const, content: "", toolCalls: [{ callId: "c1", name: "read", args: { path: "a" } }] }, { role: "tool" as const, callId: "c1", name: "read", output: "x", isError: false }], tools: [{ name: "read", description: "d", parameters: { type: "object" } }], cacheKey: "ses_1", cacheMode: "smart" as const, signal: new AbortController().signal }
    await collect(provider.stream(request))
    await collect(provider.stream(request))
    expect(bodies[0]).toBe(bodies[1]!)
    const body = JSON.parse(bodies[0]!)
    expect(body.messages[0]).toEqual({ role: "system", content: "SYSTEM" })
    expect(JSON.stringify(body)).not.toMatch(/cache|session|timestamp/i)
  })
})

describe("cache reads of the other adapters", () => {
  test("Responses: cached_tokens are cache reads and the rest is the input; reasoning is a part of output", async () => {
    const server = fakeServer(() => sse([{ type: "response.completed", response: { usage: { input_tokens: 21_000, output_tokens: 700, input_tokens_details: { cached_tokens: 20_224 }, output_tokens_details: { reasoning_tokens: 400 } } } }]))
    stops.push(server.stop)
    const provider = createResponsesProvider({ id: "openai", model: "m", baseUrl: `${server.url}/v1`, headers: async () => ({ authorization: "Bearer t" }) })
    const events = await collect(provider.stream({ system: "s", messages: [{ role: "user", content: "hi" }], tools: [], signal: new AbortController().signal }))
    expect(events.find((event) => event.type === "usage")).toEqual({ type: "usage", usage: { input: 776, output: 700, reasoning: 400, cacheRead: 20_224, cacheWrite: 0 } })
  })

  test("Anthropic: cache_read_input_tokens and cache_creation_input_tokens are the cache read and write", async () => {
    const server = fakeServer(() => sse([{ type: "message_start", message: { usage: { input_tokens: 12, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 700, output_tokens: 1 } } }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 40 } }, { type: "message_stop" }], { named: true }))
    stops.push(server.stop)
    const provider = createAnthropicProvider({ id: "anthropic", model: "claude-test", apiKey: () => KEY, baseUrl: `${server.url}/v1` })
    const events = await collect(provider.stream({ system: "s", messages: [{ role: "user", content: "hi" }], tools: [], signal: new AbortController().signal }))
    expect(events.find((event) => event.type === "usage")).toEqual({ type: "usage", usage: { input: 12, output: 40, reasoning: 0, cacheRead: 9_000, cacheWrite: 700 } })
  })
})
