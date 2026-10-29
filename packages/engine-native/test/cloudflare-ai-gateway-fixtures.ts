import type { ModelEvent, ModelRequest, ResolvedProvider } from "../src"

export const AIG_ID = "cloudflare-ai-gateway"
export const AIG_URL = "http://127.0.0.1:1234/v1/local-account/local-gateway/compat"
export const AIG_TOKEN = "gateway-local-fixture-private-0123456789"
export const AIG_MODEL = "anthropic/claude-fixture"
export const AIG_MODELS = [{ id: AIG_MODEL, name: "Claude fixture", context: 200_000, images: true, tool_call: true }, { id: "openai/text-fixture", name: "Text fixture", images: false, tool_call: true }]
export const aigResolved = (over: Partial<ResolvedProvider> = {}): ResolvedProvider => ({ id: AIG_ID, type: "openai-compatible", baseUrl: AIG_URL, apiKey: () => AIG_TOKEN, keyRequired: true, models: AIG_MODELS, ...over })
export const aigRequest = (over: Partial<ModelRequest> = {}): ModelRequest => ({ system: "Be brief", messages: [{ role: "user", content: "Read a.ts" }], tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }], signal: new AbortController().signal, ...over })
export async function collectAig(stream: AsyncIterable<ModelEvent>) {
  const events: ModelEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}
export const aigSse = (chunks: unknown[]) => new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
export const aigDone = () => aigSse([{ choices: [{ delta: { content: "Done" }, finish_reason: "stop" }] }, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 1 } }])
