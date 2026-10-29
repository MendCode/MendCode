import { expect, test } from "bun:test"
import { createApiProvider, createNativeEngine, memoryHistory, type AgentProfile, type ModelRequest, type ResolvedProvider } from "../src"
import { limitToolOutput, pruneToolOutputs } from "../src/tool-output"
import { collect, hangingSse, sse } from "./fake-server"
import { callTool, echoTool, scriptedProvider, stop, turn } from "./harness"

function engine(agent: AgentProfile, steps: Parameters<typeof scriptedProvider>[0], extra: Partial<Parameters<typeof createNativeEngine>[0]> = {}) {
  const { provider, requests } = scriptedProvider(steps)
  return { requests, engine: createNativeEngine({ provider, tools: [echoTool], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summary", agents: { primary: () => agent, subagents: () => [] }, ...extra }) }
}
const build: AgentProfile = { name: "build", description: "Build", mode: "primary", prompt: "" }

test("agent options and sampling override the selected variant without changing the conversation", async () => {
  const h = engine({ ...build, model: "local:fast", variant: "quick", temperature: 0.2, top_p: 0.8, options: { seed: 3 } }, [stop("done")], { agentModel: (choice) => ({ ...choice, effort: "low", parameters: { temperature: 0.6, max_tokens: 512 } }) })
  await h.engine.runTurn(turn({ text: "go" }).input)
  expect(h.requests[0]).toMatchObject({ model: "local:fast", effort: "low", parameters: { seed: 3, temperature: 0.2, top_p: 0.8, max_tokens: 512 } })
})

test("agent variant requires its own model and per-turn model selection wins", async () => {
  const h = engine({ ...build, variant: "quick", options: { seed: 4 } }, [stop("done")], { modelFor: () => ({ model: "session-model" }), agentModel: (choice) => { expect(choice.variant).toBeUndefined(); return choice } })
  const t = turn({ text: "go" })
  await h.engine.runTurn({ ...t.input, selection: { model: { model: "turn-model", parameters: { temperature: 0.3 } } } })
  expect(h.requests[0]).toMatchObject({ model: "turn-model", parameters: { seed: 4, temperature: 0.3 } })
})

test("step limit reserves the last call for a tool-less final response, including hosted tools", async () => {
  const h = engine({ ...build, steps: 2 }, [callTool("echo", { text: "worked" }), stop("Work done.")], { hostedTools: () => ["web_search"] })
  expect(await h.engine.runTurn(turn({ text: "go" }).input)).toEqual({ status: "ok" })
  expect(h.requests).toHaveLength(2)
  expect(h.requests[0]!.tools.length).toBeGreaterThan(0)
  expect(h.requests[1]!.tools).toEqual([])
  expect(h.requests[1]!.hostedTools).toBeUndefined()
  expect(h.requests[1]!.messages.at(-1)).toMatchObject({ role: "user", content: expect.stringContaining("text only") })
})

test("a forged tool on the final step never executes", async () => {
  let calls = 0
  const h = engine({ ...build, steps: 1 }, [callTool("echo", { text: "should not run" })], { tools: [{ ...echoTool, execute: async () => { calls++; return { output: "bad", truncated: false, title: "echo", isError: false } } }] })
  expect(await h.engine.runTurn(turn({ text: "go" }).input)).toEqual({ status: "ok" })
  expect(calls).toBe(0)
})

test("tool caps persist a readable output excerpt and send the preview to the next model call", async () => {
  const saved: string[] = []
  const h = engine(build, [callTool("echo", { text: "first\nsecond\nthird" }), stop("done")], { toolOutput: () => ({ max_lines: 1, max_bytes: 16 }), saveToolOutput: async (text, complete) => { saved.push(text); return { path: "/tmp/tool-output-test.txt", complete } } })
  const t = turn({ text: "go" })
  await h.engine.runTurn(t.input)
  expect(saved).toEqual(["echoed first\nsecond\nthird"])
  expect(h.requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", output: expect.stringContaining("echoed first\n\n[Full output saved to:") })
  expect(t.events.find((event) => event.type === "item.completed" && event.meta?.outputPath)).toMatchObject({ meta: { outputPath: "/tmp/tool-output-test.txt", outputComplete: true } })
})

test("UTF-8 byte limits keep characters intact and unchanged outputs preserve identity", () => {
  const raw = { output: "ééé\nlast", truncated: false, title: "test", isError: false }
  expect(limitToolOutput(raw, { max_bytes: 5, max_lines: 20 }).output).toBe("éé")
  expect(limitToolOutput(raw, undefined)).toBe(raw)
})

test("pruning protects recent turns and skills and needs at least 20k reclaimable tokens", () => {
  const tool = (output: string, name = "read"): import("../src").ModelMessage => ({ role: "tool", name, callId: "call", output, isError: false })
  const user = (content: string): import("../src").ModelMessage => ({ role: "user", content })
  const messages = [user("old"), tool("x".repeat(100000)), tool("k".repeat(170000)), tool("skill text", "skill"), user("previous"), tool("recent"), user("current"), tool("new")]
  pruneToolOutputs(messages)
  expect(messages[1]).toMatchObject({ output: expect.stringContaining("Old tool output pruned") })
  expect(messages[3]).toMatchObject({ output: "skill text" })
  expect(messages[5]).toMatchObject({ output: "recent" })
  const small = [user("old"), tool("x".repeat(100)), tool("k".repeat(160000)), user("previous"), user("current")]
  pruneToolOutputs(small)
  expect(small[1]).toMatchObject({ output: "x".repeat(100) })
})

const request: ModelRequest = { system: "sys", messages: [{ role: "user", content: "hi" }], tools: [{ name: "echo", description: "echo", parameters: {} }], signal: new AbortController().signal }
const wire: ResolvedProvider = { id: "local", type: "openai-compatible", baseUrl: "http://local.test/v1", keyRequired: false, apiKey: () => undefined, models: [{ id: "fast" }] }

test("provider/model/request defaults merge, metadata binds caps, headers, capabilities and cost", async () => {
  let body: Record<string, any> = {}, headers = new Headers()
  const provider = createApiProvider({ provider: { ...wire, parameters: { seed: 1, temperature: 0.1 }, headers: { "X-Team": "core" }, models: [{ id: "fast", temperature: false, tool_call: false, modalities: { input: ["text"], output: ["text"] }, limit: { context: 64000, output: 512 }, headers: { "X-Route": "fast" }, options: { seed: 2 }, cost: { input: 2, output: 4, cache_read: 1 } }] }, fetch: async (_url, init) => { body = JSON.parse(String(init?.body)); headers = new Headers(init?.headers); return sse([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 20 } } }, "[DONE]"]) } })
  const events = await collect(provider.stream({ ...request, parameters: { seed: 3, temperature: 0.9, max_tokens: 999 }, messages: [{ role: "user", content: "look", images: [{ mime: "image/png", base64: "AAAA" }] }] }))
  expect(body).toMatchObject({ seed: 3, max_tokens: 512 })
  expect(body.temperature).toBeUndefined()
  expect(body.tools).toBeUndefined()
  expect(JSON.stringify(body.messages)).toContain("image omitted")
  expect(JSON.stringify(body.messages)).not.toContain("AAAA")
  expect(headers.get("X-Route")).toBe("fast")
  expect(headers.get("X-Team")).toBe("core")
  expect(events.find((event) => event.type === "usage")).toMatchObject({ usage: { costMicros: 220 } })
})

test("provider total timeout aborts a request and false removes the total deadline", async () => {
  const fetch = async (_url: unknown, init?: RequestInit): Promise<Response> => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
  const timed = createApiProvider({ provider: { ...wire, timeout: 20 }, fetch })
  await expect(collect(timed.stream(request))).rejects.toThrow("timed out after 20ms")
  const noDeadline = createApiProvider({ provider: { ...wire, timeout: false, chunkTimeout: false }, fetch: async () => { await Bun.sleep(25); return sse([{ choices: [{ delta: { content: "late" }, finish_reason: "stop" }] }, "[DONE]"]) } })
  expect(await collect(noDeadline.stream(request))).toContainEqual({ type: "text", delta: "late" })
})

test("provider chunkTimeout controls stalled streams independently of the total deadline", async () => {
  const provider = createApiProvider({ provider: { ...wire, timeout: false, chunkTimeout: 20 }, fetch: async () => hangingSse([]) })
  await expect(collect(provider.stream(request))).rejects.toThrow("stream stalled")
})
