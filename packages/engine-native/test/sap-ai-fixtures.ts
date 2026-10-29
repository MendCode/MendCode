import type { ProviderModel } from "@mendcode/protocol"
import type { Fetch, ModelEvent, ModelRequest, ResolvedProvider } from "../src"

export const SAP_URL = "http://127.0.0.1:18318/v2"
export const SAP_SECRET = "sap-fixture-client-secret-0123456789"
export const SAP_TOKEN = "sap-fixture-access-token-0123456789"
export const SAP_SERVICE = { clientid: "sap-fixture-client", clientsecret: SAP_SECRET, url: "http://127.0.0.1:18319", serviceurls: { AI_API_URL: "http://127.0.0.1:18318" } }
export const SAP_KEY = JSON.stringify(SAP_SERVICE, null, 2)
export const SAP_MODELS: ProviderModel[] = [
  { id: "chat-fixture", name: "SAP chat fixture", context: 128_000, images: true, tool_call: true, outputLimit: 4096 },
  { id: "text-fixture", name: "SAP text fixture", images: false, tool_call: false },
]
export const sapResolved = (over: Partial<ResolvedProvider> = {}): ResolvedProvider => ({ id: "sap-ai-core", type: "openai-compatible", baseUrl: SAP_URL, apiKey: () => SAP_KEY, keyRequired: true, models: SAP_MODELS, sapAi: { deploymentId: "deployment-fixture", resourceGroup: "test" }, ...over })
export const sapRequest = (over: Partial<ModelRequest> = {}): ModelRequest => ({ system: "Be brief", messages: [{ role: "user", content: "Read a.ts" }], tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }], signal: new AbortController().signal, ...over })
export async function collectSap(stream: AsyncIterable<ModelEvent>) {
  const events: ModelEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}
export const sapSse = (chunks: unknown[], done = true) => new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : ""), { headers: { "content-type": "text/event-stream" } })
export const sapDone = () => sapSse([{ final_result: { choices: [{ index: 0, delta: { content: "Done" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } } }])
export const sapFake: Fetch = async (url) => {
  if (url.endsWith("/oauth/token")) return Response.json({ access_token: SAP_TOKEN, token_type: "Bearer", expires_in: 3600 })
  if (url.endsWith("/models")) return Response.json({ resources: [
    { model: "chat-fixture", displayName: "SAP chat fixture", allowedScenarios: [{ scenarioId: "orchestration" }], versions: [{ isLatest: true, capabilities: ["text-generation"], inputTypes: ["text", "image"], contextLength: 128_000 }] },
    { model: "text-fixture", displayName: "SAP text fixture", versions: [{ isLatest: true, capabilities: ["text-generation"], inputTypes: ["text"] }] },
    { model: "embedding-fixture", versions: [{ capabilities: ["embedding"] }] },
  ] })
  if (url.endsWith("/lm/deployments")) return Response.json({ resources: [{ id: "deployment-fixture", scenarioId: "orchestration", status: "RUNNING", createdAt: "2026-01-01" }] })
  return sapDone()
}
