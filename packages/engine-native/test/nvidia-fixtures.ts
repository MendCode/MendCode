import type { Fetch, ModelEvent, ModelRequest, ResolvedProvider } from "../src"
import type { ProviderModel } from "@mendcode/protocol"

export const NVIDIA_TOKEN = "nvidia-local-fixture-private-0123456789"
export const NVIDIA_URL = "http://127.0.0.1:1234/v1"
export const NVIDIA_MODELS: ProviderModel[] = [
  { id: "nvidia/tool-fixture", name: "NIM tool fixture", context: 128_000, effort: true, images: true, tool_call: true, outputLimit: 4096 },
  { id: "nvidia/text-fixture", name: "NIM text fixture", images: false, effort: false, tool_call: false },
]
export const nvidiaResolved = (over: Partial<ResolvedProvider> = {}): ResolvedProvider => ({ id: "nvidia", type: "openai-compatible", baseUrl: NVIDIA_URL, apiKey: () => NVIDIA_TOKEN, keyRequired: true, models: NVIDIA_MODELS, ...over })
export const nvidiaRequest = (over: Partial<ModelRequest> = {}): ModelRequest => ({ system: "Be brief", messages: [{ role: "user", content: "Read a.ts" }], tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }], signal: new AbortController().signal, ...over })
export async function collectNvidia(stream: AsyncIterable<ModelEvent>) {
  const events: ModelEvent[] = []
  for await (const event of stream) if (event.type !== "tool_input") events.push(event)
  return events
}
export const nvidiaSse = (chunks: unknown[]) => new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
export const nvidiaDone = () => nvidiaSse([{ choices: [{ delta: { content: "Done" }, finish_reason: "stop" }] }])
export const nvidiaFake: Fetch = async (_url, init) => init.method === "GET"
  ? Response.json({ data: [
    { id: "nvidia/tool-fixture", display_name: "NIM tool fixture", context_length: 128_000, max_output: 4096, architecture: { input_modalities: ["text", "image"] }, supported_parameters: ["tools", "reasoning_effort"] },
    { id: "nvidia/text-fixture", name: "NIM text fixture", architecture: { input_modalities: ["text"] }, supported_parameters: ["temperature"] },
  ] })
  : nvidiaDone()
