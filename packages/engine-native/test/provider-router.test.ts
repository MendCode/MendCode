import { describe, expect, test } from "bun:test"
import { createProviderRouter, splitModelId, type ModelEvent, type ModelProvider, type ModelRequest } from "../src"

/** A provider that records the model it was asked for and answers with its own name. */
function named(id: string, extra: Partial<ModelProvider> = {}) {
  const models: Array<string | undefined> = []
  const provider: ModelProvider = {
    id,
    model: `${id}-default`,
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      models.push(request.model)
      yield { type: "text", delta: id }
      yield { type: "finish", reason: "stop" }
    },
    ...extra,
  }
  return { provider, models }
}

const request = (model?: string): ModelRequest => ({ system: "", messages: [{ role: "user", content: "hi" }], tools: [], ...(model ? { model } : {}), signal: new AbortController().signal })
const text = async (stream: AsyncIterable<ModelEvent>) => {
  let out = ""
  for await (const event of stream) if (event.type === "text") out += event.delta
  return out
}

describe("splitModelId", () => {
  test("splits at the first colon only", () => {
    expect(splitModelId("anthropic:claude-sonnet-5-5")).toEqual({ providerId: "anthropic", model: "claude-sonnet-5-5" })
    expect(splitModelId("openrouter:google/gemini-3-pro")).toEqual({ providerId: "openrouter", model: "google/gemini-3-pro" })
    expect(splitModelId("ollama:llama3:8b")).toEqual({ providerId: "ollama", model: "llama3:8b" })
  })
  test("ids without a namespace, or with an empty side, have none", () => {
    expect(splitModelId("gpt-6-luna")).toBeUndefined()
    expect(splitModelId(":x")).toBeUndefined()
    expect(splitModelId("x:")).toBeUndefined()
  })
})

describe("createProviderRouter", () => {
  test("a namespaced model goes to its provider with the namespace removed", async () => {
    const chatgpt = named("chatgpt")
    const anthropic = named("anthropic")
    const openrouter = named("openrouter")
    const router = createProviderRouter({ fallback: chatgpt.provider, providers: { anthropic: anthropic.provider, openrouter: openrouter.provider } })
    expect(await text(router.stream(request("anthropic:claude-sonnet-5-5")))).toBe("anthropic")
    expect(await text(router.stream(request("openrouter:google/gemini-3-pro")))).toBe("openrouter")
    expect(anthropic.models).toEqual(["claude-sonnet-5-5"])
    expect(openrouter.models).toEqual(["google/gemini-3-pro"])
    expect(chatgpt.models).toEqual([])
  })

  test("a model without a namespace, and a request without a model, use the fallback unchanged", async () => {
    const chatgpt = named("chatgpt")
    const router = createProviderRouter({ fallback: chatgpt.provider, providers: { anthropic: named("anthropic").provider } })
    expect(await text(router.stream(request("gpt-6-luna")))).toBe("chatgpt")
    expect(await text(router.stream(request()))).toBe("chatgpt")
    expect(chatgpt.models).toEqual(["gpt-6-luna", undefined])
    expect(router.id).toBe("chatgpt")
    expect(router.model).toBe("chatgpt-default")
  })

  test("an unregistered namespace is an error, never a call to the fallback", async () => {
    const chatgpt = named("chatgpt")
    const router = createProviderRouter({ fallback: chatgpt.provider, providers: {} })
    await expect(text(router.stream(request("mystery:model")))).rejects.toThrow('no provider "mystery" for model mystery:model')
    expect(chatgpt.models).toEqual([])
  })

  test("a providers function is asked on every call, so additions apply at once", async () => {
    const table: Record<string, ModelProvider> = {}
    const router = createProviderRouter({ fallback: named("chatgpt").provider, providers: () => table })
    await expect(text(router.stream(request("groq:llama")))).rejects.toThrow("no provider")
    table.groq = named("groq").provider
    expect(await text(router.stream(request("groq:llama")))).toBe("groq")
  })

  test("idFor names the provider that serves a model, for usage and hooks", () => {
    const router = createProviderRouter({ fallback: named("chatgpt").provider, providers: { anthropic: named("anthropic").provider } })
    expect(router.idFor?.("anthropic:x")).toBe("anthropic")
    expect(router.idFor?.("gpt-6-luna")).toBe("chatgpt")
    expect(router.idFor?.(undefined)).toBe("chatgpt")
    expect(router.idFor?.("ghost:x")).toBe("chatgpt")
  })

  test("probe asks the provider of the latest call", async () => {
    const probed: string[] = []
    const chatgpt = named("chatgpt", { probe: async () => (probed.push("chatgpt"), true) })
    const anthropic = named("anthropic", { probe: async () => (probed.push("anthropic"), false) })
    const router = createProviderRouter({ fallback: chatgpt.provider, providers: { anthropic: anthropic.provider } })
    await text(router.stream(request("anthropic:x")))
    expect(await router.probe!()).toBe(false)
    await text(router.stream(request("gpt-6-luna")))
    expect(await router.probe!()).toBe(true)
    expect(probed).toEqual(["anthropic", "chatgpt"])
    // A call waiting on Anthropic probes Anthropic though another session's call went to ChatGPT since.
    expect(await router.probe!("anthropic:x")).toBe(false)
    expect(probed.at(-1)).toBe("anthropic")
    expect(await router.probe!("nobody:x")).toBe(false)
  })

  test("the request is passed through untouched apart from the model", async () => {
    let seen: ModelRequest | undefined
    const target: ModelProvider = {
      id: "p",
      model: "m",
      async *stream(r) {
        seen = r
        yield { type: "finish", reason: "stop" }
      },
    }
    const router = createProviderRouter({ fallback: named("chatgpt").provider, providers: { p: target } })
    const original = { ...request("p:m1"), effort: "high" as const, cacheKey: "s1", system: "sys" }
    await text(router.stream(original))
    expect(seen).toEqual({ ...original, model: "m1" })
  })
})
