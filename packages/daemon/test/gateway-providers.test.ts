import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { GATEWAY_PRESETS, createProviderRouter, type Fetch, type ModelEvent } from "@mendcode/engine-native"
import { createProviderService, PROVIDERS_FILE } from "../src/providers"

const cleanup: (() => void)[] = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-gateways-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const KEY = "gateway-daemon-key-0123456789"
const request = { system: "", messages: [{ role: "user" as const, content: "hi" }], tools: [], signal: new AbortController().signal }
const collect = async (stream: AsyncIterable<ModelEvent>) => { const events: ModelEvent[] = []; for await (const event of stream) events.push(event); return events }
const hosted = Object.entries(GATEWAY_PRESETS).filter(([, gateway]) => !gateway.keyless && gateway.label !== "Microsoft Foundry")

describe("gateway presets in the daemon", () => {
  for (const [id, gateway] of hosted) {
    test(`${id}: its key variable alone keeps it off; enabling needs a key, then refresh and routing work`, async () => {
      const dir = temp()
      const calls: string[] = []
      const fake: Fetch = async (url, init) => {
        calls.push(url)
        expect(init.redirect).toBe("error")
        expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEY}`)
        return init.method === "GET"
          ? Response.json({ data: [{ id: "vendor/model" }] })
          : new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } })
      }
      const bare = createProviderService({ dir, env: {}, fetch: fake })
      expect(bare.set({ id, enabled: true })).toMatchObject({ ok: false, message: expect.stringContaining("API key") })
      const providers = createProviderService({ dir, env: { [gateway.keyEnv!]: KEY }, fetch: fake })
      expect(providers.list().find((provider) => provider.id === id)).toMatchObject({ enabled: false, hasKey: true, source: "env" })
      expect(providers.models()).toEqual([])
      expect(calls).toEqual([])
      expect(providers.set({ id, enabled: true })).toMatchObject({ ok: true, provider: { enabled: true } })
      expect(await providers.refresh(id)).toMatchObject({ ok: true, provider: { models: [{ id: "vendor/model" }] } })
      const router = createProviderRouter({ fallback: { id: "subscription", model: "default", async *stream() { throw new Error("must not call subscription") } }, providers: providers.runtime })
      expect((await collect(router.stream({ ...request, model: `${id}:vendor/model` }))).at(-1)).toEqual({ type: "finish", reason: "stop" })
      expect(calls.at(-1)!.endsWith("/chat/completions")).toBe(true)
      providers.set({ id, enabled: false })
      await expect(collect(router.stream({ ...request, model: `${id}:vendor/model` }))).rejects.toThrow("disabled")
    })
  }

  test("a saved key lands in providers.json only, and plain-HTTP public endpoints are refused", () => {
    const dir = temp()
    const providers = createProviderService({ dir, env: {} })
    expect(providers.set({ id: "fireworks", apiKey: KEY, enabled: true })).toMatchObject({ ok: true, provider: { enabled: true, hasKey: true } })
    expect(JSON.stringify(providers.list())).not.toContain(KEY)
    expect(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).toContain(KEY)
    expect(providers.set({ id: "fireworks", baseUrl: "http://api.example.com/v1" })).toMatchObject({ ok: false, message: expect.stringContaining("loopback") })
    expect(providers.set({ id: "zai", apiKey: KEY, baseUrl: "https://host.example/v1?token=x" })).toMatchObject({ ok: false })
  })

  test("foundry needs a user endpoint; atomic-chat is a keyless local server that stays off until enabled", () => {
    const dir = temp()
    const providers = createProviderService({ dir, env: { AZURE_AI_FOUNDRY_API_KEY: KEY } })
    expect(providers.list().find((provider) => provider.id === "foundry")).toMatchObject({ enabled: false, baseUrl: "" })
    expect(providers.set({ id: "foundry", enabled: true })).toMatchObject({ ok: false, message: expect.stringContaining("endpoint") })
    expect(providers.set({ id: "foundry", baseUrl: "https://res.services.ai.azure.com/openai/v1", enabled: true })).toMatchObject({ ok: true, provider: { enabled: true, baseUrl: "https://res.services.ai.azure.com/openai/v1" } })
    expect(providers.list().find((provider) => provider.id === "atomic-chat")).toBeUndefined()
    expect(providers.set({ id: "atomic-chat", enabled: true })).toMatchObject({ ok: true, provider: { enabled: true, hasKey: false, baseUrl: "http://127.0.0.1:1337/v1" } })
    expect(providers.set({ id: "atomic-chat", baseUrl: "http://example.com/v1" })).toMatchObject({ ok: false })
  })
})
