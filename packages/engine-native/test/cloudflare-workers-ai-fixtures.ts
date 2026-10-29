import type { ModelEvent, ModelRequest, ResolvedProvider } from "../src"

export const CF_ID = "cloudflare-workers-ai"
export const CF_URL = "http://127.0.0.1:1234/client/v4/accounts/local-account/ai/v1"
export const CF_TOKEN = "cloudflare-local-fixture-private-0123456789"
export const CF_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
export const CF_MODELS = [{ id: CF_MODEL, name: "Llama 3.3 70B", context: 24_000, images: false, tool_call: true }]
export const cfResolved = (over: Partial<ResolvedProvider> = {}): ResolvedProvider => ({ id: CF_ID, type: "openai-compatible", baseUrl: CF_URL, apiKey: () => CF_TOKEN, keyRequired: true, models: CF_MODELS, ...over })
export const cfRequest = (over: Partial<ModelRequest> = {}): ModelRequest => ({ system: "Be brief", messages: [{ role: "user", content: "Read a.ts" }], tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }], signal: new AbortController().signal, ...over })
export async function collectCf(stream: AsyncIterable<ModelEvent>) {
  const events: ModelEvent[] = []
  for await (const event of stream) if (event.type !== "tool_input") events.push(event)
  return events
}
export const cfSse = (chunks: unknown[]) => new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
export const cfDone = () => cfSse([{ choices: [{ delta: { content: "Done" }, finish_reason: "stop" }] }, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 1 } }])
