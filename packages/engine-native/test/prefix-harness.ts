import type { PromptCacheMode } from "@mendcode/protocol"
import { defineTool, type Tool } from "@mendcode/tools"
import { z } from "zod"
import { createAnthropicProvider, createChatCompletionsProvider, createNativeEngine, createResponsesProvider, memoryHistory, type ModelProvider, type SystemContext } from "../src"
import { fakeServer, sse } from "./fake-server"
import { ids, turn } from "./harness"

/**
 * Records the exact request body of every model call a real adapter sends to a local fake host (127.0.0.1, no network),
 * for a scripted multi-step conversation, and measures how much of one request the next one repeats. Providers cache by
 * prefix (Anthropic: tools, system, messages; OpenAI and Chat Completions hosts: tools, then the messages with the system
 * first), so a request that does not start with the whole previous one loses the cache from the first byte that differs.
 */
export type Adapter = "responses" | "anthropic" | "chat"
export const ADAPTERS: readonly Adapter[] = ["responses", "anthropic", "chat"]

export type Step = { text?: string; calls?: Array<{ name: string; args: Record<string, unknown> }>; usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number; reasoning?: number } }
export type Turn = { text: string; steps: Step[] }

const KEY = "sk-ant-test-0123456789abcdefghijklmnop"

function encode(adapter: Adapter, step: Step, index: number): Response {
  const usage = { cacheRead: 0, cacheWrite: 0, reasoning: 0, ...step.usage ?? { input: 100, output: 10 } }
  const calls = (step.calls ?? []).map((call, order) => ({ ...call, id: `call_${index}_${order}` }))
  if (adapter === "responses") {
    return sse([
      ...(step.text ? [{ type: "response.output_text.delta", delta: step.text }] : []),
      // `tool_search` (the neutral name, never a wire function name) is the model's client-executed search: its arguments are an object.
      ...calls.map((call) => ({ type: "response.output_item.done", item: call.name === "tool_search" ? { type: "tool_search_call", call_id: call.id, execution: "client", arguments: call.args, status: "completed" } : { type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) } })),
      { type: "response.completed", response: { usage: { input_tokens: usage.input + usage.cacheRead, output_tokens: usage.output, input_tokens_details: { cached_tokens: usage.cacheRead }, output_tokens_details: { reasoning_tokens: usage.reasoning } } } },
    ])
  }
  if (adapter === "anthropic") {
    let block = 0
    return sse([
      { type: "message_start", message: { usage: { input_tokens: usage.input, output_tokens: 1, cache_read_input_tokens: usage.cacheRead, cache_creation_input_tokens: usage.cacheWrite } } },
      ...(step.text ? [{ type: "content_block_start", index: block, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: block, delta: { type: "text_delta", text: step.text } }, { type: "content_block_stop", index: block++ }] : []),
      ...calls.flatMap((call) => [{ type: "content_block_start", index: block, content_block: { type: "tool_use", id: call.id, name: call.name } }, { type: "content_block_delta", index: block, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.args) } }, { type: "content_block_stop", index: block++ }]),
      { type: "message_delta", delta: { stop_reason: calls.length ? "tool_use" : "end_turn" }, usage: { output_tokens: usage.output } },
      { type: "message_stop" },
    ], { named: true })
  }
  return sse([
    ...(step.text ? [{ choices: [{ index: 0, delta: { content: step.text } }] }] : []),
    ...(calls.length ? [{ choices: [{ index: 0, delta: { tool_calls: calls.map((call, order) => ({ index: order, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })) } }] }] : []),
    { choices: [{ index: 0, delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }] },
    { choices: [], usage: { prompt_tokens: usage.input + usage.cacheRead, completion_tokens: usage.output, prompt_cache_hit_tokens: usage.cacheRead, prompt_cache_miss_tokens: usage.input } },
    "[DONE]",
  ])
}

function providerFor(adapter: Adapter, url: string, clientToolSearch = false): ModelProvider {
  if (adapter === "responses") return createResponsesProvider({ id: "openai", model: "gpt-test", baseUrl: `${url}/v1`, headers: async () => ({ authorization: "Bearer t" }), authHint: "set OPENAI_API_KEY", clientToolSearch })
  if (adapter === "anthropic") return createAnthropicProvider({ id: "anthropic", model: "claude-test", apiKey: () => KEY, baseUrl: `${url}/v1` })
  return createChatCompletionsProvider({ id: "deepseek", model: "deepseek-chat", baseUrl: `${url}/v1`, apiKey: () => KEY, requireKey: true })
}

/** A deterministic read-only tool with a result of a realistic size. */
export const fileTool = (name: string, size = 1500): Tool => defineTool({
  name,
  description: `${name} fixture`,
  permission: "read",
  args: z.object({ path: z.string().optional() }),
  execute: async ({ path }) => ({ output: `${name} ${path ?? "."}\n${"line of source code\n".repeat(Math.ceil(size / 20))}`, truncated: false, title: `${name} ${path ?? ""}`, isError: false }),
})

export type Recorded = { turn: number; step: number; body: Record<string, any>; headers: Record<string, string> }

export async function recordLineage(input: {
  adapter: Adapter
  turns: Turn[]
  /** The system prompt of each call, as the daemon builds it (it may depend on the user's latest prompt). */
  system?: (cwd: string, context?: SystemContext) => string
  tools?: Tool[]
  cwd?: string
  promptCache?: PromptCacheMode
  history?: ReturnType<typeof memoryHistory>
  engineOptions?: Partial<Parameters<typeof createNativeEngine>[0]>
  /** Responses only: `tool_search` as the API's client-executed tool search (the ChatGPT backend's default). */
  clientToolSearch?: boolean
  /** Runs after the turns on the same engine and session (a compaction); its model calls answer with `steps`, recorded as one more turn. */
  after?: { steps: Step[]; run(engine: ReturnType<typeof createNativeEngine>, sessionId: ReturnType<typeof ids<"session">>): Promise<void> }
}): Promise<Recorded[]> {
  const script = [...input.turns.flatMap((entry, turnIndex) => entry.steps.map((step, stepIndex) => ({ step, turnIndex, stepIndex }))), ...(input.after?.steps ?? []).map((step, stepIndex) => ({ step, turnIndex: input.turns.length, stepIndex }))]
  const server = fakeServer((_request, index) => encode(input.adapter, script[index]!.step, index))
  try {
    const engine = createNativeEngine({
      provider: providerFor(input.adapter, server.url, input.clientToolSearch),
      tools: input.tools ?? [fileTool("read"), fileTool("grep")],
      history: input.history ?? memoryHistory(),
      cwdFor: () => input.cwd ?? "/repo",
      system: input.system ?? (() => "You are a coding agent."),
      compactionPrompt: "Summarize",
      promptCache: () => input.promptCache ?? "legacy",
      ...input.engineOptions,
    })
    const sessionId = ids("session")
    for (const entry of input.turns) await engine.runTurn(turn({ text: entry.text, sessionId, mode: () => "full" }).input)
    await input.after?.run(engine, sessionId)
    return server.requests.map((request, index) => ({ turn: script[index]!.turnIndex, step: script[index]!.stepIndex, body: request.body, headers: request.headers }))
  } finally {
    server.stop()
  }
}

const withoutMarks = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, item) => key === "cache_control" ? undefined : item))

/** The request split the way a provider's cache sees it: the tool list, the system prompt, then one entry per message. */
export function prefixParts(adapter: Adapter, body: Record<string, any>) {
  if (adapter === "responses") return { tools: JSON.stringify(body.tools ?? []), system: String(body.instructions ?? ""), messages: (body.input as unknown[]).map((item) => JSON.stringify(item)) }
  if (adapter === "anthropic") return { tools: JSON.stringify(withoutMarks(body.tools ?? [])), system: JSON.stringify(withoutMarks(body.system ?? [])), messages: (body.messages as unknown[]).map((item) => JSON.stringify(withoutMarks(item))) }
  const [first, ...rest] = body.messages as Array<{ role: string }>
  const hasSystem = first?.role === "system"
  return { tools: JSON.stringify(body.tools ?? []), system: hasSystem ? JSON.stringify(first) : "", messages: (hasSystem ? rest : [first!, ...rest]).map((item) => JSON.stringify(item)) }
}

export type PrefixReport = {
  previousBytes: number
  sharedBytes: number
  share: number
  /** `tools`, `system`, `messages[i]`, or `none` when the whole previous request is a prefix of the next. */
  firstDifference: string
}

const common = (a: string, b: string) => {
  let index = 0
  const limit = Math.min(a.length, b.length)
  while (index < limit && a[index] === b[index]) index++
  return index
}

/** How many bytes of `previous` the next request repeats from the start, and which part first differs. */
export function comparePrefix(adapter: Adapter, previous: Record<string, any>, next: Record<string, any>): PrefixReport {
  const a = prefixParts(adapter, previous), b = prefixParts(adapter, next)
  const bytes = (text: string) => Buffer.byteLength(text)
  const previousBytes = bytes(a.tools) + bytes(a.system) + a.messages.reduce((sum, message) => sum + bytes(message), 0)
  const toolShare = common(a.tools, b.tools)
  // The tool list is one JSON array: any change to it (even an added tool) changes the bytes before the system prompt.
  if (a.tools !== b.tools) return { previousBytes, sharedBytes: bytes(a.tools.slice(0, toolShare)), share: bytes(a.tools.slice(0, toolShare)) / previousBytes, firstDifference: "tools" }
  let shared = bytes(a.tools)
  const systemShare = common(a.system, b.system)
  if (a.system !== b.system) return { previousBytes, sharedBytes: shared + bytes(a.system.slice(0, systemShare)), share: (shared + bytes(a.system.slice(0, systemShare))) / previousBytes, firstDifference: "system" }
  shared += bytes(a.system)
  for (let index = 0; index < a.messages.length; index++) {
    const left = a.messages[index]!, right = b.messages[index]
    if (right === undefined) return { previousBytes, sharedBytes: shared, share: shared / previousBytes, firstDifference: `messages[${index}] missing` }
    const same = common(left, right)
    if (left !== right) return { previousBytes, sharedBytes: shared + bytes(left.slice(0, same)), share: (shared + bytes(left.slice(0, same))) / previousBytes, firstDifference: `messages[${index}]` }
    shared += bytes(left)
  }
  return { previousBytes, sharedBytes: shared, share: 1, firstDifference: "none" }
}

/** Reports for every pair of consecutive calls of a lineage. */
export function lineageReport(adapter: Adapter, calls: Recorded[]) {
  return calls.slice(1).map((call, index) => ({ from: `${calls[index]!.turn}.${calls[index]!.step}`, to: `${call.turn}.${call.step}`, crossTurn: call.turn !== calls[index]!.turn, ...comparePrefix(adapter, calls[index]!.body, call.body) }))
}

/** A scripted conversation: a three-step turn (two tool steps and an answer), then a two-step turn. */
export const CONVERSATION: Turn[] = [
  { text: "Fix the pagination bug in src/paginate.ts", steps: [
    { text: "Looking.", calls: [{ name: "read", args: { path: "src/paginate.ts" } }, { name: "grep", args: { path: "test" } }], usage: { input: 3000, output: 40 } },
    { calls: [{ name: "read", args: { path: "test/paginate.test.ts" } }], usage: { input: 400, output: 20, cacheRead: 3000 } },
    { text: "Fixed it.", usage: { input: 400, output: 20, cacheRead: 3400 } },
  ] },
  { text: "Now add a test for the empty page", steps: [
    { calls: [{ name: "read", args: { path: "test/paginate.test.ts" } }], usage: { input: 500, output: 20, cacheRead: 3800 } },
    { text: "Added.", usage: { input: 400, output: 20, cacheRead: 4300 } },
  ] },
]
