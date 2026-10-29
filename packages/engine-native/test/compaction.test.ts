import { expect, test } from "bun:test"
import { createNativeEngine, memoryHistory } from "../src/engine"
import { checkpointOf, compactionDeadline, NativeCompactionError } from "../src/compaction-checkpoint"
import { compactionThreshold, historyTokens, pruneToolOutputs, recentBudget, splitCompaction, SUMMARY_PREFIX } from "../src/compaction-policy"
import { createResponsesProvider } from "../src/openai-responses"
import { modelParameters } from "../src/model-parameters"
import { createAnthropicProvider } from "../src/anthropic-messages"
import type { ModelEvent, ModelMessage, ModelProvider, ModelRequest } from "../src/provider"
import { createIdFactory, type CompactionConfig, type ModelChoice } from "@mendcode/protocol"
import type { EngineEvent, TurnInput } from "@mendcode/kernel"

const ids = createIdFactory()
const user = (content: string): ModelMessage => ({ role: "user", content })
const assistant = (content: string): ModelMessage => ({ role: "assistant", content, toolCalls: [] })
const conversation = [user("old task"), assistant("old result"), user("recent task"), assistant("recent result"), user("latest constraint"), assistant("latest result")]

function fixture(config: CompactionConfig = {}, extra: Partial<Parameters<typeof createNativeEngine>[0]> = {}, adapters: Partial<ModelProvider> = {}) {
  const history = extra.history ?? memoryHistory()
  const requests: ModelRequest[] = [], nativeRequests: ModelRequest[] = [], events: EngineEvent[] = []
  const provider: ModelProvider = { id: "local", model: "model", async *stream(request) {
    const { signal, turnSignal: _turnSignal, transformBody, ...copy } = request
    requests.push({ ...structuredClone(copy), signal })
    yield { type: "text", delta: "accepted summary" }
    yield { type: "finish", reason: "stop" }
  }, nativeBinding: async (model) => `local:${model ?? "model"}`, compact: async (request) => {
    nativeRequests.push(request)
    return { output: [{ type: "compaction", encrypted_content: "opaque-private-state" }] }
  }, ...adapters }
  const sessionId = ids("session")
  const input: TurnInput = { sessionId, turnId: ids("turn"), signal: new AbortController().signal, text: "next", attachments: [], permissionMode: () => "ask", setPermissionMode: () => {}, newItemId: () => ids("item"), emit: (event) => void events.push(event), ask: async () => ({ kind: "deny" }) }
  const engine = createNativeEngine({ provider, tools: [], history, cwdFor: () => "/local", system: () => "system", compactionPrompt: "summarize", compaction: () => config, ...extra })
  return { history, requests, nativeRequests, events, provider, sessionId, input, engine }
}

test("threshold precedence matches model > provider > global, with absolute triggers capped by input limits", () => {
  const limits = { contextWindow: 200_000, inputLimit: 180_000, provider: { threshold: 90 }, model: { threshold: 80 } }
  expect(compactionThreshold({ threshold: 95 }, limits)).toBe(144_000)
  expect(compactionThreshold({ token_limit: 190_000 }, limits)).toBe(180_000)
  expect(compactionThreshold({ token_limit: 150_000 }, { ...limits, model: { token_limit: 100_000 } })).toBe(100_000)
  expect(compactionThreshold({ threshold: 0 }, { contextWindow: 1000 })).toBe(10)
  expect(compactionThreshold({ threshold: 200 }, { contextWindow: 1000 })).toBe(1000)
  expect(compactionThreshold({}, {})).toBe(160_000)
  expect(compactionThreshold({}, { contextWindow: 200_000 })).toBe(180_000)
  // The default leaves the reply its room: a 128k window packs at 108k (20k free), not at 90%; an input limit needs no reserve.
  expect(compactionThreshold({}, { contextWindow: 128_000 })).toBe(108_000)
  expect(compactionThreshold({}, { contextWindow: 128_000, outputLimit: 8_000 })).toBe(115_200)
  expect(compactionThreshold({ reserved: 40_000 }, { contextWindow: 128_000 })).toBe(88_000)
  expect(compactionThreshold({}, { contextWindow: 128_000, inputLimit: 100_000 })).toBe(90_000)
})

test("recent budget honors reserve, explicit zero and v1 default bounds", () => {
  expect(recentBudget({ reserved: 8000 }, { inputLimit: 10_000 })).toBe(2000)
  expect(recentBudget({}, { contextWindow: 200_000 })).toBe(8000)
  expect(recentBudget({}, { contextWindow: 50_000, outputLimit: 40_000 })).toBe(2500)
  expect(recentBudget({}, { inputLimit: 50_000, outputLimit: 40_000 })).toBe(7500)
  expect(recentBudget({ preserve_recent_tokens: 0 }, {})).toBe(0)
})

test("tail keeps two recent complete turns, attachments and ordered tool pairs; zero disables it", () => {
  const messages: ModelMessage[] = [...conversation.slice(0, 5), { role: "assistant", content: "", toolCalls: [{ callId: "c", name: "read", args: {} }] }, { role: "tool", callId: "c", name: "read", output: "recent data", isError: false }, assistant("result")]
  const split = splitCompaction(messages, {}, {})
  expect(split.head).toEqual(messages.slice(0, 2))
  expect(split.tail).toEqual(messages.slice(2))
  expect(split.tailTurns).toBe(2)
  expect(splitCompaction(messages, { tail_turns: 0 }, {}).tail).toEqual([])
  expect(splitCompaction(messages, { preserve_recent_tokens: 0 }, {}).tail).toEqual([])
})

test("oversized recent turns retain a safe suffix, never an orphan tool result", () => {
  const messages: ModelMessage[] = [user("x".repeat(5000)), { role: "assistant", content: "", toolCalls: [{ callId: "c", name: "read", args: {} }] }, { role: "tool", callId: "c", name: "read", output: "x".repeat(5000), isError: false }, assistant("small final result")]
  const split = splitCompaction(messages, { preserve_recent_tokens: 50 }, {})
  expect(split.tail).toEqual([assistant("small final result")])
  expect(historyTokens(split.tail)).toBeLessThanOrEqual(50)
})

test("pruning protects 40k tool tokens, recent turns, skills and failures and requires a 20k saving", () => {
  const result = (name: string, output: string, isError = false): ModelMessage => ({ role: "tool", callId: name, name, output, isError })
  const large = "x".repeat(100_000)
  const messages = [user("old"), result("skill", large), result("failed", large, true), result("read-old", large), result("read-mid", large), result("read-new", large), user("recent"), result("recent", large), user("latest"), result("latest", large)]
  const pruned = pruneToolOutputs(messages)
  expect(pruned.tokens).toBe(50_000)
  expect(pruned.messages[3]).toMatchObject({ output: "[Old tool output pruned]" })
  expect(pruned.messages[5]).toEqual(messages[5])
  expect(pruned.messages[1]).toEqual(messages[1])
  expect(pruned.messages[2]).toEqual(messages[2])
  expect(pruned.messages[7]).toEqual(messages[7])
  expect(pruneToolOutputs(messages, false).messages).toBe(messages)
  expect(messages[3]).toMatchObject({ output: large })
})

test("context reports effective model thresholds and the same pruned tool results sent to the provider", async () => {
  const h = fixture({ threshold: 95 }, {}, { compactionLimits: () => ({ contextWindow: 200_000, provider: { threshold: 90 }, model: { threshold: 80 } }) })
  const messages: ModelMessage[] = [user("old")]
  const results = (count: number): ModelMessage[] => Array.from({ length: count }, (_, i): ModelMessage[] => [{ role: "assistant", content: "", toolCalls: [{ callId: `read-${i}`, name: "read", args: {} }] }, { role: "tool", callId: `read-${i}`, name: "read", output: "x".repeat(100_000), isError: false }]).flat()
  const toolChars = async () => (await h.engine.contextReport!(h.sessionId)).sections.find((section) => section.id === "history:tool")?.chars
  // 100k tokens of results against a threshold of 160k: below 80 % of it, nothing is pruned.
  const far = [...messages, ...results(4), user("recent"), assistant("recent"), user("latest"), assistant("latest")]
  await h.history.save(h.sessionId, far)
  expect(await toolChars()).toBeGreaterThanOrEqual(400_000)
  // 150k tokens: past 80 % of the threshold, all but the protected 40k are pruned.
  messages.push(...results(6), user("recent"), assistant("recent"), user("latest"), assistant("latest"))
  await h.history.save(h.sessionId, messages)
  const report = await h.engine.contextReport!(h.sessionId)
  expect(report.compactAtTokens).toBe(160_000)
  expect(await toolChars()).toBeLessThan(150_000)
  expect((await h.history.load(h.sessionId))!).toEqual(messages)
})

test("portable default preserves the recent tail and persists a restartable checkpoint", async () => {
  const h = fixture()
  await h.history.save(h.sessionId, conversation)
  expect(await h.engine.compact(h.input)).toEqual({ status: "ok", compacted: true })
  const saved = (await h.history.load(h.sessionId))!
  expect(saved.slice(1)).toEqual(conversation.slice(2))
  expect(checkpointOf(saved)?.tailMessages).toBe(saved.length - 1)
  expect(checkpointOf(saved)).toMatchObject({ version: 1, generation: 1, method: "legacy", tailTurns: 2 })
  expect(h.events.find((event) => event.type === "item.started")).toMatchObject({ meta: { tailTurns: 2, compactionMethod: "legacy" } })
  expect(h.nativeRequests).toHaveLength(0)
})

test("manual instructions and a model override write a portable summary on that model, even when native is preferred", async () => {
  const h = fixture({ strategy: "native" })
  await h.history.save(h.sessionId, conversation)
  const tailored = { ...h.input, instructions: "keep API names", selection: { model: { model: "other-model" } } }
  expect(await h.engine.compact(tailored)).toMatchObject({ compacted: true })
  expect(h.nativeRequests).toHaveLength(0)
  expect(h.requests[0]!.messages.at(-1)).toMatchObject({ content: expect.stringContaining("keep API names") })
  expect(h.requests[0]!.model).toBe("other-model")
  const plain = fixture({ strategy: "native" })
  await plain.history.save(plain.sessionId, conversation)
  await plain.engine.compact(plain.input)
  expect(plain.nativeRequests).toHaveLength(1)
})

test("incremental mode updates the previous accepted baseline, bounds output and keeps the new tail", async () => {
  const config: CompactionConfig = { portable_mode: "incremental", tail_turns: 1, max_summary_tokens: 512 }
  const h = fixture(config)
  await h.history.save(h.sessionId, conversation)
  await h.engine.compact(h.input)
  await h.engine.runTurn(h.input)
  await h.engine.compact(h.input)
  expect(h.requests[2]).toMatchObject({ maxOutputTokens: 512 })
  expect(h.requests[2]!.messages[0]).toMatchObject({ content: expect.stringContaining(SUMMARY_PREFIX) })
  expect(h.requests[2]!.messages.at(-1)).toMatchObject({ content: expect.stringContaining("previous accepted summary") })
  expect(checkpointOf((await h.history.load(h.sessionId))!)).toMatchObject({ generation: 2, method: "incremental" })
})

test("auto compaction can be disabled live without disabling manual compaction", async () => {
  const config: CompactionConfig = { auto: false }
  const h = fixture(config, { compactAtTokens: 100 }, { async *stream(): AsyncIterable<ModelEvent> { yield { type: "usage", usage: { input: 101, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }; yield { type: "text", delta: "summary" }; yield { type: "finish", reason: "stop" } } })
  await h.engine.runTurn(h.input)
  expect(h.engine.needsCompaction(h.sessionId)).toBe(false)
  config.auto = true
  expect(h.engine.needsCompaction(h.sessionId)).toBe(true)
  expect(await h.engine.compact(h.input)).toMatchObject({ compacted: true })
})

test("automatic thresholds count cache writes and reasoning once: reasoning is already a part of output", async () => {
  const usage = { input: 10, output: 10, reasoning: 10, cacheRead: 10, cacheWrite: 10 }
  const run = async (compactAtTokens: number) => {
    const h = fixture({}, { compactAtTokens }, { async *stream(): AsyncIterable<ModelEvent> { yield { type: "usage", usage }; yield { type: "finish", reason: "stop" } } })
    await h.engine.runTurn(h.input)
    return h.engine.needsCompaction(h.sessionId)
  }
  // 10 input + 10 cache read + 10 cache write + 10 output = 40; adding the reasoning again would make 50.
  expect(await run(40)).toBe(true)
  expect(await run(50)).toBe(false)
})

test("native checkpoint survives restart, appends deltas and keeps only one previous opaque generation", async () => {
  const h = fixture({ strategy: "native", tail_turns: 1 })
  await h.history.save(h.sessionId, conversation)
  expect(await h.engine.compact(h.input)).toMatchObject({ compacted: true })
  const restart = fixture({ strategy: "native", tail_turns: 1 }, { history: h.history, provider: h.provider })
  await restart.engine.runTurn({ ...h.input, text: "after restart" })
  expect(h.requests[0]!.nativeContext).toEqual([{ type: "compaction", encrypted_content: "opaque-private-state" }])
  expect(h.requests[0]!.messages.some((message) => message.role === "user" && message.content === "old task")).toBe(false)
  expect(await restart.engine.compact(h.input)).toMatchObject({ compacted: true })
  expect(h.nativeRequests[1]!.nativeContext).toBeDefined()
  expect(checkpointOf((await h.history.load(h.sessionId))!)).toMatchObject({ generation: 2, previous: { binding: "local:model" } })
  expect(JSON.stringify(h.events)).not.toContain("opaque-private-state")
})

test("native compaction of a short history never replays the compacted turns twice", async () => {
  const h = fixture({ strategy: "native" })
  await h.history.save(h.sessionId, conversation.slice(0, 2))
  expect(await h.engine.compact(h.input)).toMatchObject({ compacted: true })
  expect((await h.history.load(h.sessionId))!).toHaveLength(1)
  expect(checkpointOf((await h.history.load(h.sessionId))!)?.tailTurns).toBe(0)
  await h.engine.runTurn(h.input)
  expect(h.requests[0]!.nativeContext).toBeDefined()
  expect(h.requests[0]!.messages).toEqual([user("next")])
})

test("native progress starts before provider work and installation is reported only after persistence", async () => {
  const h = fixture({ strategy: "native" })
  await h.history.save(h.sessionId, conversation)
  h.provider.compact = async () => {
    expect(h.events.find((event) => event.type === "item.started")).toMatchObject({ meta: { compactionMethod: "native" } })
    expect(h.events.some((event) => event.type === "item.completed")).toBe(false)
    return { output: [{ type: "compaction", encrypted_content: "private" }] }
  }
  const replace = h.history.replace
  h.history.replace = async (sessionId, messages) => {
    expect(h.events.some((event) => event.type === "item.completed")).toBe(false)
    await replace(sessionId, messages)
  }
  expect(await h.engine.compact(h.input)).toMatchObject({ compacted: true })
  expect(h.events.find((event) => event.type === "item.completed")).toMatchObject({ status: "ok", text: "Native context checkpoint installed" })
})

for (const changed of ["binding", "system", "tools", "model"] as const) test(`native ${changed} changes replay portable source without sending opaque data`, async () => {
  let binding = "binding", system = "system", model: ModelChoice = { model: "model" }
  const h = fixture({ strategy: "native", tail_turns: 0 }, { system: () => system, modelFor: () => model }, { nativeBinding: async () => binding })
  await h.history.save(h.sessionId, conversation)
  await h.engine.compact(h.input)
  if (changed === "binding") binding = "changed"
  if (changed === "system") system = "changed"
  if (changed === "model") model = { model: "other" }
  // The new engine has a different tool contract even though the transport did not change.
  const engine = changed === "tools" ? fixture({}, { history: h.history, provider: h.provider, subagents: true }).engine : h.engine
  await engine.runTurn(h.input)
  expect(h.requests[0]!.nativeContext).toBeUndefined()
  expect(h.requests[0]!.messages[0]).toEqual(conversation[0])
})

for (const strategy of ["auto", "native"] as const) test(`${strategy} respects an unavailable transport and a different compaction role`, async () => {
  const h = fixture({ strategy }, { modelFor: (_, role) => ({ model: role === "compaction" ? "other" : "model" }) })
  await h.history.save(h.sessionId, conversation)
  const result = await h.engine.compact(h.input)
  expect(result.status).toBe(strategy === "native" ? "error" : "ok")
  expect(h.nativeRequests).toHaveLength(0)
  expect(h.requests).toHaveLength(strategy === "native" ? 0 : 1)
  const unsupported = fixture({ strategy }, {}, { nativeBinding: async () => undefined })
  await unsupported.history.save(unsupported.sessionId, conversation)
  expect((await unsupported.engine.compact(unsupported.input)).status).toBe(strategy === "native" ? "error" : "ok")
  const missing = fixture({ strategy })
  delete missing.provider.compact
  await missing.history.save(missing.sessionId, conversation)
  expect((await missing.engine.compact(missing.input)).status).toBe(strategy === "native" ? "error" : "ok")
})

for (const status of [500, 401, 403]) test(`native HTTP ${status} uses portable fallback only when explicitly allowed and safe`, async () => {
  for (const on_native_error of ["stop", "portable"] as const) {
    const h = fixture({ strategy: "native", on_native_error }, {}, { compact: async () => { throw new NativeCompactionError("http", "provider failure", status) } })
    await h.history.save(h.sessionId, conversation)
    const result = await h.engine.compact(h.input)
    const fallback = on_native_error === "portable" && status === 500
    expect(result.status).toBe(fallback ? "ok" : "error")
    expect(h.requests).toHaveLength(fallback ? 1 : 0)
    if (!fallback) expect(await h.history.load(h.sessionId)).toEqual(conversation)
    else expect(h.events.find((event) => event.type === "item.started" && event.meta?.fallbackReason === "http")).toMatchObject({ meta: { fallbackReason: "http" } })
  }
})

test("a changed history or active model cannot install a stale native result or start fallback", async () => {
  let model: ModelChoice = { model: "model" }
  const h = fixture({ strategy: "native", on_native_error: "portable" }, { modelFor: () => model })
  h.provider.compact = async () => { model = { model: "changed" }; return { output: [{ type: "compaction", encrypted_content: "opaque" }] } }
  await h.history.save(h.sessionId, conversation)
  expect(await h.engine.compact(h.input)).toMatchObject({ status: "error" })
  expect(await h.history.load(h.sessionId)).toEqual(conversation)
  expect(h.requests).toHaveLength(0)
  expect(h.events.find((event) => event.type === "item.completed")).toMatchObject({ status: "error", text: "Native compaction failed" })
  const other = fixture({ strategy: "portable" })
  const original = other.provider.stream
  other.provider.stream = async function*(request) { await other.history.save(other.sessionId, [user("concurrent")]); yield* original(request) }
  await other.history.save(other.sessionId, conversation)
  expect(await other.engine.compact(other.input)).toMatchObject({ status: "error", message: expect.stringContaining("History changed") })
  expect(await other.history.load(other.sessionId)).toEqual([user("concurrent")])
})

test("deadline and cancellation settle an uncooperative adapter and never install a late result", async () => {
  await expect(compactionDeadline(new AbortController().signal, 5, () => new Promise(() => {}))).rejects.toMatchObject({ kind: "timeout" })
  const controller = new AbortController()
  const h = fixture({ strategy: "native", on_native_error: "portable" }, {}, { compact: async () => { controller.abort(); return { output: [{ type: "compaction", encrypted_content: "late" }] } } })
  await h.history.save(h.sessionId, conversation)
  expect(await h.engine.compact({ ...h.input, signal: controller.signal })).toEqual({ status: "ok" })
  expect(await h.history.load(h.sessionId)).toEqual(conversation)
  expect(h.requests).toHaveLength(0)
})

test("Responses compaction authenticates the explicit native call and replays canonical output in streaming calls", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const provider = createResponsesProvider({ id: "openai", model: "model", baseUrl: "https://api.openai.com/v1", headers: async () => ({ authorization: "Bearer local-fake" }), fetch: async (url, init) => {
    calls.push({ url, init })
    if (url.endsWith("/compact")) return Response.json({ output: [{ type: "compaction", encrypted_content: "canonical" }], usage: { input_tokens: 123, output_tokens: 12 } }, { headers: { "x-request-id": "request-1" } })
    return new Response('data: {"type":"response.completed"}\n\n', { headers: { "content-type": "text/event-stream" } })
  } })
  const request: ModelRequest = { system: "system", messages: conversation, tools: [], signal: new AbortController().signal }
  const result = await provider.compact!(request)
  expect(calls[0]!.url).toBe("https://api.openai.com/v1/responses/compact")
  expect(calls[0]!.init.headers).toMatchObject({ authorization: "Bearer local-fake" })
  expect(result).toMatchObject({ requestId: "request-1", usage: { input: 123 } })
  expect(await provider.nativeBinding!("model")).not.toContain("local-fake")
  for await (const event of provider.stream({ ...request, nativeContext: result.output, messages: [user("next")] })) expect(event.type).toBe("finish")
  expect(JSON.parse(calls[1]!.init.body as string).input[0]).toEqual(result.output[0])
})

for (const output of [null, [], [{ role: "assistant" }], [{ type: "compaction", encrypted_content: "" }], [{ type: "compaction", encrypted_content: "x".repeat(4 * 1024 * 1024) }]]) test(`Responses rejects malformed or oversized native output (${JSON.stringify(output).length} bytes)`, async () => {
  const provider = createResponsesProvider({ id: "openai", model: "model", baseUrl: "https://api.openai.com/v1", headers: async () => ({}), fetch: async () => Response.json({ output }) })
  await expect(provider.compact!({ system: "sys", messages: [], tools: [], signal: new AbortController().signal })).rejects.toBeInstanceOf(NativeCompactionError)
})

test("a custom Responses origin cannot become a native transport", async () => {
  let calls = 0
  const provider = createResponsesProvider({ id: "proxy", model: "model", baseUrl: "http://127.0.0.1:9999/v1", headers: async () => ({}), fetch: async () => { calls++; throw new Error("no network") } })
  expect(await provider.nativeBinding!("model")).toBeUndefined()
  await expect(provider.compact!({ system: "sys", messages: [], tools: [], signal: new AbortController().signal })).rejects.toMatchObject({ kind: "unsupported" })
  expect(calls).toBe(0)
})

test("native usage metadata cannot publish invalid token counts", async () => {
  const provider = createResponsesProvider({ id: "openai", model: "model", baseUrl: "https://api.openai.com/v1", headers: async () => ({}), fetch: async () => Response.json({ output: [{ type: "compaction", encrypted_content: "canonical" }], usage: { input_tokens: "not-a-count", output_tokens: -1 } }) })
  expect(await provider.compact!({ system: "sys", messages: [], tools: [], signal: new AbortController().signal })).toMatchObject({ usage: { input: 0, output: 0 } })
})

test("an incremental summary cap cannot be raised by model variant parameters", () => {
  const request: ModelRequest = { system: "sys", messages: [], tools: [], maxOutputTokens: 512, parameters: { max_output_tokens: 10_000 }, signal: new AbortController().signal }
  expect(modelParameters({ max_output_tokens: 512 }, request).max_output_tokens).toBe(512)
  expect(modelParameters({ max_tokens: 512 }, { ...request, parameters: { max_tokens: 10_000 } }).max_tokens).toBe(512)
})

test("a small portable summary disables an incompatible Anthropic thinking budget without network", async () => {
  let sent: Record<string, unknown> = {}
  const provider = createAnthropicProvider({ id: "anthropic", model: "claude-test", apiKey: () => "local-fake", fetch: async (_, init) => {
    sent = JSON.parse(init.body as string)
    return new Response('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\ndata: {"type":"message_stop"}\n\n', { headers: { "content-type": "text/event-stream" } })
  } })
  const request: ModelRequest = { system: "sys", messages: [user("summarize")], tools: [], effort: "high", maxOutputTokens: 512, parameters: { max_tokens: 10_000, thinking: { type: "enabled", budget_tokens: 8000 } }, signal: new AbortController().signal }
  const events: string[] = []
  for await (const event of provider.stream(request)) events.push(event.type)
  expect(events.at(-1)).toBe("finish")
  expect(sent.max_tokens).toBe(512)
  expect(sent.thinking).toBeUndefined()
})

test("configured timeout bounds native work through body consumption and leaves history unchanged", async () => {
  const h = fixture({ strategy: "native", timeout_ms: 1000 }, {}, { compact: () => new Promise(() => {}) })
  await h.history.save(h.sessionId, conversation)
  expect(await h.engine.compact(h.input)).toMatchObject({ status: "error", message: expect.stringContaining("timed out") })
  expect(await h.history.load(h.sessionId)).toEqual(conversation)
  expect(h.requests).toHaveLength(0)
})

test("a summary the model does not finish in time is written locally from the evidence: the compaction ends ok and the history is replaced", async () => {
  const h = fixture({ strategy: "portable", timeout_ms: 1000 }, {}, { stream: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<never>>(() => {}) }) }) as never })
  await h.history.save(h.sessionId, conversation)
  expect(await h.engine.compact(h.input)).toEqual({ status: "ok", compacted: true })
  const saved = (await h.history.load(h.sessionId))!
  expect(saved).not.toEqual(conversation)
  expect(saved[0]).toMatchObject({ role: "user", compaction: expect.anything() })
  expect(JSON.stringify(saved[0])).toContain("did not finish the summary within the time limit")
  // No card is left open (one the request had started closes as an error), and the local summary has its own, marked as the fallback.
  const completed = h.events.filter((event): event is Extract<EngineEvent, { type: "item.completed" }> => event.type === "item.completed")
  const started = h.events.filter((event): event is Extract<EngineEvent, { type: "item.started" }> => event.type === "item.started")
  expect(started.every((item) => completed.some((done) => done.itemId === item.itemId))).toBe(true)
  expect(started.some((event) => event.meta?.summaryFallback === "rescue")).toBe(true)
  expect(completed.at(-1)).toMatchObject({ status: "ok" })
}, 10_000)
