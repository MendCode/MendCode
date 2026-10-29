import type { Fetch, ModelEvent, ModelRequest, ResolvedProvider } from "../src"
import type { ProviderModel } from "@mendcode/protocol"

export const GATEWAY_TOKEN = "gateway-local-fixture-private-0123456789"
export const GATEWAY_URL = "http://127.0.0.1:1234/v1"
export const GATEWAY_MODELS: ProviderModel[] = [
  { id: "reasoning-fixture", name: "Reasoning fixture", context: 128_000, effort: true, images: true, tool_call: true, outputLimit: 4096 },
  { id: "text-fixture", name: "Text fixture", images: false, effort: false, tool_call: false },
]
export const gatewayResolved = (over: Partial<ResolvedProvider> = {}): ResolvedProvider => ({ id: "llmgateway", type: "openai-compatible", baseUrl: GATEWAY_URL, apiKey: () => GATEWAY_TOKEN, keyRequired: true, models: GATEWAY_MODELS, ...over })
export const gatewayRequest = (over: Partial<ModelRequest> = {}): ModelRequest => ({ system: "Be brief", messages: [{ role: "user", content: "Read a.ts" }], tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }], signal: new AbortController().signal, ...over })
export async function collectGateway(stream: AsyncIterable<ModelEvent>) {
  const events: ModelEvent[] = []
  for await (const event of stream) if (event.type !== "tool_input") events.push(event)
  return events
}
export const gatewaySse = (chunks: unknown[]) => new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
export const gatewayDone = () => gatewaySse([{ choices: [{ delta: { content: "Done" }, finish_reason: "stop" }] }])
export const gatewayFake: Fetch = async (_url, init) => init.method === "GET"
  ? Response.json({ data: [
    { id: "reasoning-fixture", display_name: "Reasoning fixture", context_length: 128_000, max_output: 4096, architecture: { input_modalities: ["text", "image"] }, supported_parameters: ["tools", "reasoning_effort"] },
    { id: "text-fixture", name: "Text fixture", architecture: { input_modalities: ["text"] }, supported_parameters: ["temperature"] },
  ] })
  : gatewayDone()
