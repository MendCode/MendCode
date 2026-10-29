import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createApiProvider } from "../src/provider-factory"
import type { ModelEvent, ModelRequest } from "../src/provider"
import { RetryableProviderError } from "../src/provider"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
async function fixture(parts: Record<string, unknown>[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-sdk-")); dirs.push(dir)
  const module = path.join(dir, "sdk.ts")
  writeFileSync(module, `export const calls = []
export const options = []
export function createAcme(config) {
  options.push(config)
  return { languageModel(model) {
    return { specificationVersion: "v3", provider: "acme.chat", async doStream(input) {
      calls.push({model, ...input})
      return { stream: new ReadableStream({start(controller) {
        for (const part of ${JSON.stringify(parts)}) controller.enqueue(part)
        controller.close()
      }}) }
    } }
  } }
}`)
  let key = "first-key"
  const provider = createApiProvider({ provider: { id: "acme", type: "openai-compatible", baseUrl: "https://acme.example/v1", keyRequired: true, apiKey: () => key, models: [{ id: "model", images: true }], npm: pathToFileURL(module).href } })
  const request: ModelRequest = { system: "system", messages: [], tools: [], signal: new AbortController().signal }
  const collect = async (input = request) => { const events: ModelEvent[] = []; for await (const event of provider.stream(input)) events.push(event); return events }
  const inspect = async () => await import(pathToFileURL(module).href) as { calls: Record<string, unknown>[]; options: Record<string, unknown>[] }
  return { provider, request, collect, inspect, rotate: (value: string) => { key = value } }
}
const finish = { type: "finish", finishReason: { unified: "tool-calls", raw: "tools" }, usage: { inputTokens: { total: 42, cacheRead: 12, cacheWrite: 4 }, outputTokens: { total: 8, reasoning: 3 } } }

describe("B10 installed AI SDK v3 bridge", () => {
  test("maps text, signed reasoning, tool calls, token usage and finish into native events", async () => {
    const h = await fixture([{ type: "text-delta", id: "text", delta: "answer" }, { type: "reasoning-start", id: "r" }, { type: "reasoning-delta", id: "r", delta: "think" }, { type: "reasoning-end", id: "r", providerMetadata: { acme: { signature: "signed" } } }, { type: "tool-call", toolCallId: "call", toolName: "read", input: '{"path":"file"}' }, finish])
    const events = await h.collect()
    expect(events).toContainEqual({ type: "text", delta: "answer" })
    expect(events).toContainEqual({ type: "tool_call", call: { callId: "call", name: "read", args: { path: "file" } } })
    expect(events).toContainEqual({ type: "usage", usage: { input: 26, output: 8, reasoning: 3, cacheRead: 12, cacheWrite: 4 } })
    expect(events).toContainEqual({ type: "reasoning_state", state: { provider: "acme", model: "model", blocks: [{ type: "reasoning", text: "think", providerOptions: { acme: { signature: "signed" } } }] } })
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool_calls" })
  })
  test("replays tools and files, isolates generation options and reads rotated credentials each request", async () => {
    const h = await fixture([finish])
    const signal = new AbortController().signal
    await h.collect({ ...h.request, signal, model: "other", maxOutputTokens: 9, effort: "high", cacheKey: "cache", parameters: { temperature: 0.2, custom: true, providerOptions: { acme: { extra: 1 } } }, tools: [{ name: "read", description: "Read file", parameters: { type: "object" } }], messages: [{ role: "user", content: "hello", images: [{ mime: "image/png", base64: "YQ==" }], documents: [{ mime: "application/pdf", name: "note.pdf", base64: "Yg==" }] }, { role: "assistant", content: "calling", toolCalls: [{ callId: "call", name: "read", args: { path: "file" } }] }, { role: "tool", callId: "call", name: "read", isError: true, output: "denied" }] })
    const sdk = await h.inspect(), call = sdk.calls[0]!
    expect(call).toMatchObject({ model: "other", abortSignal: signal, temperature: 0.2, maxOutputTokens: 9, providerOptions: { acme: { custom: true, extra: 1, reasoningEffort: "high", promptCacheKey: "cache" } }, tools: [{ type: "function", name: "read", inputSchema: { type: "object" } }] })
    expect(call.prompt).toMatchObject([{ role: "system", content: "system" }, { role: "user", content: [{ type: "text", text: "hello" }, { type: "file", mediaType: "image/png" }, { type: "file", filename: "note.pdf" }] }, { role: "assistant", content: [{ type: "text" }, { type: "tool-call", input: { path: "file" } }] }, { role: "tool", content: [{ type: "tool-result", output: { type: "error-text", value: "denied" } }] }])
    h.rotate("rotated-key"); await h.collect()
    expect(sdk.options.map((item) => item.apiKey)).toEqual(["first-key", "rotated-key"])
    expect(sdk.options[0]).toMatchObject({ name: "acme", baseURL: "https://acme.example/v1" })
  })
  test("scrubs provider errors and refuses incomplete streams and invalid tools", async () => {
    for (const parts of [[{ type: "error", error: "first-key unredacted content" }], [{ type: "text-delta", delta: "partial" }], [{ type: "tool-call", toolCallId: "c", toolName: "read", input: "bad JSON first-key" }]]) {
      const h = await fixture(parts)
      await expect(h.collect()).rejects.toThrow("SDK request failed")
      try { await h.collect() } catch (error) { expect(String(error)).not.toContain("first-key"); expect(String(error)).not.toContain("unredacted") }
    }
  })
  test("an aborted request loads no module and returns a cancellation error", async () => {
    const h = await fixture([finish]), controller = new AbortController(); controller.abort()
    await expect(h.collect({ ...h.request, signal: controller.signal })).rejects.toThrow("request cancelled")
    expect((await h.inspect()).options).toHaveLength(0)
  })
  test("SDK retryable errors retain the engine retry contract without exposing provider content", async () => {
    const h = await fixture([{ type: "error", error: { isRetryable: true, message: "first-key private request" } }])
    try { await h.collect(); throw new Error("unexpected success") } catch (error) {
      expect(error).toBeInstanceOf(RetryableProviderError)
      expect(String(error)).not.toContain("first-key")
      expect(String(error)).not.toContain("private request")
    }
  })
})
