import { afterEach, expect, test } from "bun:test"
import { join } from "node:path"
import { createMcpClient, createMcpManager, createRemoteMcpClient } from "../src"
import { listAllPrompts, promptText } from "../src/prompts"
import { McpError } from "../src/client"
import { fakeConfig, tempDir } from "./helpers"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

test("MCP prompts are bounded, paginated, and tolerate a server without prompts", async () => {
  const requests: unknown[] = []
  expect(await listAllPrompts(async (params) => { requests.push(params); return params ? { prompts: [{ name: "second" }] } : { prompts: [{ name: "first" }], nextCursor: "next" } })).toHaveLength(2)
  expect(requests).toEqual([undefined, { cursor: "next" }])
  expect(await listAllPrompts(async () => { throw new McpError("unsupported", -32601) })).toEqual([])
  expect(await listAllPrompts(async () => ({ prompts: Array.from({ length: 201 }, (_, index) => ({ name: `prompt-${index}` })) }))).toHaveLength(200)
  await expect(listAllPrompts(async () => ({ prompts: [], nextCursor: "same" }))).rejects.toThrow("repeated")
  await expect(listAllPrompts(async () => ({ tools: [] }))).rejects.toThrow("invalid")
})

test("prompt content preserves text message order and refuses media, empty and oversized results", () => {
  expect(promptText({ messages: [{ role: "user", content: { type: "text", text: "Question" } }, { role: "assistant", content: { type: "text", text: "Evidence" } }] })).toBe("Question\n\nEvidence")
  for (const result of [{}, { messages: [] }, { messages: [{ content: { type: "image", data: "data" } }] }, { messages: [{ content: { type: "text", text: "x".repeat(32_001) } }] }]) expect(() => promptText(result)).toThrow()
})

test("catalog text projection preserves embedded text without weakening strict command validation", () => {
  const result = { messages: [{ role: "user", content: { type: "text", text: "Review" } }, { role: "assistant", content: { type: "resource", resource: { uri: "docs://focus", text: "Evidence" } } }, { role: "user", content: { type: "image", data: "AAAA", mimeType: "image/png" } }] }
  expect(promptText(result, true)).toBe("Review\nEvidence")
  expect(() => promptText(result)).toThrow("text prompt messages")
  for (const content of [{ type: "image", data: "data" }, { type: "resource", resource: { blob: "AAAA" } }]) expect(() => promptText({ messages: [{ role: "user", content }] }, true)).toThrow("32000")
  expect(() => promptText({ messages: [{ role: "user", content: { type: "resource", resource: { text: "x".repeat(32_001) } } }] }, true)).toThrow("32000")
})

test("manager preserves structured prompt media and forwards cancellation through both prompt APIs", async () => {
  const signals: Array<AbortSignal | undefined> = []
  const manager = createMcpManager({
    configLoader: () => ({ servers: { docs: { command: process.execPath, args: [join(import.meta.dir, "fixtures/fake-catalog.ts")] } }, errors: [] }),
    clientFactory: (input) => {
      const client = createMcpClient(input)
      const text = client.getPrompt!.bind(client), structured = client.getPromptResult!.bind(client)
      client.getPrompt = (name, args, signal) => { signals.push(signal); return text(name, args, signal) }
      client.getPromptResult = (name, args, signal) => { signals.push(signal); return structured(name, args, signal) }
      return client
    },
  })
  cleanups.push(() => manager.stop())
  const signal = new AbortController().signal
  const input = { directory: tempDir(), server: "docs", name: "Review code", args: { target: "app.ts" }, signal }
  expect(await manager.getPrompt(input)).toBe("Review app.ts\nFocus: correctness")
  const result = await manager.getPromptResult(input)
  expect(result.messages.at(-1)?.content).toEqual({ type: "image", data: "AAAA", mimeType: "image/png" })
  expect(() => promptText(result)).toThrow("text prompt messages")
  expect(signals).toEqual([signal, signal])
})

test("manager prompt discovery is lazy, uses stdio pagination, caches metadata, and invalidates it", async () => {
  const directory = tempDir()
  const manager = createMcpManager({ configLoader: () => ({ servers: { local: fakeConfig(), off: fakeConfig({ enabled: false }) }, errors: [] }) })
  cleanups.push(() => manager.stop())
  expect(manager.cachedPrompts(directory)).toEqual([])
  expect(manager.running()).toEqual([])
  const listed = await manager.listPrompts(directory)
  expect(listed.issues).toEqual([])
  expect(listed.prompts.map((entry) => entry.prompt.name)).toEqual(["audit", "explain"])
  expect(manager.cachedPrompts(directory)).toEqual(listed.prompts)
  expect(manager.running().map((entry) => entry.server)).toEqual(["local"])
  expect(await manager.getPrompt({ directory, server: "local", name: "audit", args: { scope: "two words" } })).toBe("Inspect two words")
  await expect(manager.getPrompt({ directory, server: "off", name: "audit", args: {} })).rejects.toThrow()
  manager.invalidate(directory)
  expect(manager.cachedPrompts(directory)).toEqual([])
})

test("remote prompt transport binds arguments with JSON-RPC without a real network service", async () => {
  const requests: Array<{ method: string; params?: Record<string, unknown> }> = []
  const client = createRemoteMcpClient({ name: "remote", config: { url: "https://fixture.invalid/mcp", oauth: false }, fetch: async (_url, init) => {
    const request = JSON.parse(String(init?.body))
    requests.push(request)
    if (request.id === undefined) return new Response(null, { status: 202 })
    const result = request.method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: { prompts: {} }, serverInfo: { name: "fixture", version: "1" } } : request.method === "tools/list" ? { tools: [] } : request.method === "prompts/list" ? { prompts: [{ name: "audit" }] } : { messages: [{ role: "user", content: { type: "text", text: "Remote evidence" } }] }
    return Response.json({ jsonrpc: "2.0", id: request.id, result })
  } })
  cleanups.push(() => client.close())
  expect(await client.listPrompts!()).toMatchObject([{ name: "audit" }])
  expect(await client.getPrompt!("audit", { scope: "files" })).toBe("Remote evidence")
  expect(requests).toContainEqual(expect.objectContaining({ method: "prompts/get", params: { name: "audit", arguments: { scope: "files" } } }))
})
