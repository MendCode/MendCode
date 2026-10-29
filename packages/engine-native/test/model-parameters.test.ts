import { expect, test } from "bun:test"
import { ModelChoice, ProviderModel } from "@mendcode/protocol"
import { modelParameters } from "../src/model-parameters"

test("variants are additive config; generation parameters merge without replacing conversation or transport", () => {
  expect(ProviderModel.parse({ id: "test", variants: { precise: { effort: "high", parameters: { temperature: 0, text: { verbosity: "low" } } } } }).variants?.precise?.effort).toBe("high")
  const result = modelParameters({ model: "test", stream: true, input: ["prompt"], reasoning: { effort: "medium", summary: "auto" } }, { system: "", messages: [], tools: [], signal: new AbortController().signal, parameters: { temperature: 0, reasoning: { effort: "high" }, input: ["replaced"], model: "other", stream: false } })
  expect(result).toEqual({ model: "test", stream: true, input: ["prompt"], temperature: 0, reasoning: { effort: "high", summary: "auto" } })
  expect(ModelChoice.safeParse({ model: "test", parameters: { input: [] } }).success).toBe(false)
})

test("all native adapters send selected generation parameters with a local fetch fake", async () => {
  const { createChatCompletionsProvider, createResponsesProvider, createAnthropicProvider } = await import("../src")
  const { collect, sse } = await import("./fake-server")
  const bodies: Record<string, unknown>[] = []
  const doFetch = async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    return sse([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }, { type: "response.completed", response: { status: "completed", output: [] } }, { type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" }, "[DONE]"])
  }
  const providers = [
    createChatCompletionsProvider({ id: "local", model: "test", baseUrl: "http://local.invalid", fetch: doFetch }),
    createResponsesProvider({ id: "local", model: "test", baseUrl: "http://local.invalid", headers: async () => ({}), fetch: doFetch }),
    createAnthropicProvider({ id: "local", model: "test", baseUrl: "http://local.invalid", apiKey: () => "fake-key", fetch: doFetch }),
  ]
  for (const provider of providers) await collect(provider.stream({ system: "System", messages: [{ role: "user", content: "Prompt" }], tools: [], signal: new AbortController().signal, parameters: { temperature: 0.2, max_tokens: 400 } }))
  expect(bodies).toHaveLength(3)
  for (const body of bodies) expect(body).toMatchObject({ model: "test", stream: true, temperature: 0.2, max_tokens: 400 })
})
