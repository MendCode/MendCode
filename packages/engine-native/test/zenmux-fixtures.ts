import type { Fetch, ModelEvent, ModelRequest, ResolvedProvider } from "../src"
import type { ProviderModel } from "@mendcode/protocol"

export const ZENMUX_TOKEN = "zenmux-local-fixture-private-0123456789"
export const ZENMUX_URL = "http://127.0.0.1:1234/v1"
export const ZENMUX_MODELS: ProviderModel[] = [
  { id: "vendor/reasoning-fixture", name: "Reasoning fixture", context: 128_000, effort: true, images: true, tool_call: true, outputLimit: 4096 },
  { id: "vendor/text-fixture", name: "Text fixture", images: false, effort: false, tool_call: false },
]
export const zenmuxResolved = (over: Partial<ResolvedProvider> = {}): ResolvedProvider => ({ id: "zenmux", type: "openai-compatible", baseUrl: ZENMUX_URL, apiKey: () => ZENMUX_TOKEN, keyRequired: true, models: ZENMUX_MODELS, ...over })
export const zenmuxRequest = (over: Partial<ModelRequest> = {}): ModelRequest => ({ system: "Be brief", messages: [{ role: "user", content: "Read a.ts" }], tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }], signal: new AbortController().signal, ...over })
export async function collectZenmux(stream: AsyncIterable<ModelEvent>) {
  const events: ModelEvent[] = []
  for await (const event of stream) if (event.type !== "tool_input") events.push(event)
  return events
}
export const zenmuxSse = (chunks: unknown[]) => new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
export const zenmuxDone = () => zenmuxSse([{ choices: [{ delta: { content: "Done" }, finish_reason: "stop" }] }])
export const zenmuxFake: Fetch = async (_url, init) => init.method === "GET"
  ? Response.json({ data: [
    { id: "vendor/reasoning-fixture", display_name: "Reasoning fixture", context_length: 128_000, max_output: 4096, input_modalities: ["text", "image"], output_modalities: ["text"], capabilities: { reasoning: true }, supported_parameters: ["tools"] },
    { id: "vendor/text-fixture", name: "Text fixture", input_modalities: ["text"], output_modalities: ["text"], capabilities: { reasoning: false }, supported_parameters: ["temperature"] },
  ] })
  : zenmuxDone()
