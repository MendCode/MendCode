import { describe, expect, test } from "bun:test"
import { createApiProvider, createResponsesProvider, type ModelEvent, type ModelRequest, type ResolvedProvider } from "../src"

function sse(events: unknown[]) {
  const bytes = new TextEncoder().encode(events.map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join(""))
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close() } })
}
const done = () => new Response(sse([{ type: "response.output_text.delta", delta: "ok" }, { type: "response.completed", response: {} }]), { status: 200 })
const request = (parameters?: ModelRequest["parameters"]): ModelRequest => ({ system: "be brief", messages: [{ role: "user", content: "hi" }], tools: [], ...(parameters ? { parameters } : {}), signal: new AbortController().signal })
async function drain(stream: AsyncIterable<ModelEvent>) { for await (const _ of stream) void _ }

function responses(tier: () => "priority" | undefined) {
  const bodies: Array<Record<string, unknown>> = []
  const provider = createResponsesProvider({
    id: "openai", model: "gpt-test", baseUrl: "https://api.example/v1/", headers: async () => ({ authorization: "Bearer t" }), serviceTier: tier,
    fetch: async (_url, init) => { bodies.push(JSON.parse(String(init.body))); return done() },
  })
  return { provider, bodies }
}

describe("fast service tier (/fast)", () => {
  test("priority adds service_tier to the Responses body, read on every request", async () => {
    let tier: "priority" | undefined
    const { provider, bodies } = responses(() => tier)
    await drain(provider.stream(request()))
    tier = "priority"
    await drain(provider.stream(request()))
    tier = undefined
    await drain(provider.stream(request()))
    expect(bodies.map((body) => body.service_tier)).toEqual([undefined, "priority", undefined])
  })

  test("the session's own fast wins over the setting both ways", async () => {
    const off = responses(() => "priority")
    await drain(off.provider.stream({ ...request(), fast: false }))
    const on = responses(() => undefined)
    await drain(on.provider.stream({ ...request(), fast: true }))
    expect([off.bodies[0]!.service_tier, on.bodies[0]!.service_tier]).toEqual([undefined, "priority"])
  })

  test("an explicit service_tier parameter wins over the toggle", async () => {
    const { provider, bodies } = responses(() => "priority")
    await drain(provider.stream(request({ service_tier: "flex" })))
    expect(bodies[0]!.service_tier).toBe("flex")
  })

  test("the API-key OpenAI provider forwards the toggle", async () => {
    const bodies: Array<Record<string, unknown>> = []
    let tier: "priority" | undefined = "priority"
    const resolved: ResolvedProvider = { id: "openai", type: "openai", baseUrl: "https://api.example/v1", apiKey: () => "sk-test-fixture-000000000000", keyRequired: true, models: [{ id: "gpt-test" }], serviceTier: () => tier }
    const provider = createApiProvider({ provider: resolved, fetch: async (_url, init) => { bodies.push(JSON.parse(String(init.body))); return done() } })
    await drain(provider.stream({ ...request(), model: "gpt-test" }))
    tier = undefined
    await drain(provider.stream({ ...request(), model: "gpt-test" }))
    expect(bodies.map((body) => body.service_tier)).toEqual(["priority", undefined])
  })
})
