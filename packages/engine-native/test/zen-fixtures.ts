import type { Fetch, ModelEvent, ModelRequest } from "../src"
import type { ProviderModel } from "@mendcode/protocol"

export const ZEN_TOKEN = "zen-local-fixture-private-0123456789"
export const ZEN_URL = "http://127.0.0.1:1234/zen/v1"
export const ZEN_MODELS: ProviderModel[] = [
  { id: "gpt-fixture", provider: { npm: "@ai-sdk/openai" }, cost: { input: 2, output: 8, cache_read: 1 }, reasoning: true, limit: { context: 200_000, output: 4096 }, images: true },
  { id: "claude-fixture", provider: { npm: "@ai-sdk/anthropic" }, tool_call: true },
  { id: "gemini-fixture", provider: { npm: "@ai-sdk/google" }, images: true },
  { id: "local-fixture", provider: { npm: "@ai-sdk/openai-compatible" }, tool_call: true },
]
export const zenRequest = (model: string): ModelRequest => ({ model, system: "Be brief", messages: [{ role: "user", content: "hi" }], tools: [{ name: "read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }], signal: new AbortController().signal })
export async function collectZen(stream: AsyncIterable<ModelEvent>) {
  const events: ModelEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}
const stream = (chunks: unknown[]) => new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
export const zenFake: Fetch = async (url, init) => {
  if (init.method === "GET") return Response.json({ data: ZEN_MODELS })
  const body = JSON.parse(String(init.body)) as Record<string, unknown>
  const tools = Array.isArray(body.tools) && body.tools.length > 0
  if (url.endsWith("/responses")) return stream([
    { type: "response.reasoning_summary_text.delta", delta: "look" },
    { type: "response.output_text.delta", delta: "hello" },
    ...(tools ? [{ type: "response.output_item.done", item: { type: "function_call", call_id: "call_1", name: "read", arguments: '{"path":"a.ts"}' } }] : []),
    { type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 60 }, output_tokens_details: { reasoning_tokens: 5 } } } },
  ])
  if (url.endsWith("/messages")) return stream([
    { type: "message_start", message: { usage: { input_tokens: 40, cache_read_input_tokens: 60 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 2, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 2, delta: { type: "thinking_delta", thinking: "look" } },
    { type: "content_block_delta", index: 2, delta: { type: "signature_delta", signature: "fixture-signature" } },
    { type: "content_block_stop", index: 2 },
    ...(tools ? [
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_1", name: "read", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"a.ts"}' } },
      { type: "content_block_stop", index: 1 },
    ] : []),
    { type: "message_delta", delta: { stop_reason: tools ? "tool_use" : "end_turn" }, usage: { output_tokens: 20 } },
    { type: "message_stop" },
  ])
  if (url.includes(":streamGenerateContent")) return stream([
    { candidates: [{ content: { parts: [{ text: "look", thought: true }, { text: "hello" }, ...(tools ? [{ functionCall: { id: "call_1", name: "read", args: { path: "a.ts" } }, thoughtSignature: "fixture-signature" }] : [])] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5, cachedContentTokenCount: 60 } },
  ])
  return stream([
    { choices: [{ delta: { reasoning_content: "look", content: "hello" } }] },
    ...(tools ? [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: '{"path":' } }] } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] } }] }] : []),
    { choices: [{ delta: {}, finish_reason: tools ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 5 } } },
  ])
}
