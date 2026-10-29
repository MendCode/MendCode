import type { ProviderModel, SapAIConfig } from "@mendcode/protocol"
import { outboundEndpoint } from "./endpoint-policy"
import { createChatCompletionsProvider } from "./openai-compatible"
import type { ResolvedProvider } from "./provider-factory"
import { RetryableProviderError, type ModelProvider } from "./provider"
import { httpFailure, joinUrl, type Fetch } from "./provider-http"

const identifier = /^[A-Za-z0-9_.-]{1,128}$/
type ServiceKey = { clientid: string; clientsecret: string; url: string; serviceurls: { AI_API_URL: string } }

/** The AI API and token URLs come from the user's own service key; there is no shared public SAP endpoint. */
export const sapAiUrl = (value: string): URL => outboundEndpoint(value, "SAP AI Core")

/** Parse the v1 service key locally; errors never include its JSON or individual secrets. */
export function parseSapServiceKey(value: string | undefined): ServiceKey {
  let key: ServiceKey
  try {
    key = JSON.parse(value ?? "")
    if (!key || typeof key !== "object" || ![key.clientid, key.clientsecret, key.url, key.serviceurls?.AI_API_URL].every((field) => typeof field === "string" && field.length > 0 && !/[\r\n]/.test(field))) throw new Error()
  } catch { throw new Error("[AUTH]: SAP AI Core needs a JSON service key with clientid, clientsecret, url and serviceurls.AI_API_URL") }
  sapAiUrl(key.url)
  sapAiUrl(key.serviceurls.AI_API_URL)
  return key
}

export function sapAiRoot(baseUrl: string, key: string | undefined): string {
  const service = parseSapServiceKey(key)
  const root = baseUrl || joinUrl(service.serviceurls.AI_API_URL, "/v2")
  return sapAiUrl(root).href.replace(/\/+$/, "")
}

export function sapAiConfig(config: SapAIConfig | undefined): SapAIConfig {
  if (config?.deploymentId && !identifier.test(config.deploymentId) || config?.resourceGroup && !identifier.test(config.resourceGroup)) throw new Error("[PROVIDER]: invalid SAP deployment or resource group")
  return { ...config, resourceGroup: config?.resourceGroup || "default" }
}

/** OAuth tokens stay in memory and are invalidated by service-key rotation. No process.env writes. */
function connection(provider: ResolvedProvider, transport: Fetch) {
  let cached: { key: string; token: string; expires: number } | undefined
  return async (path: string, init: RequestInit): Promise<Response> => {
    const raw = provider.apiKey()
    const service = parseSapServiceKey(raw)
    const root = sapAiRoot(provider.baseUrl, raw)
    const config = sapAiConfig(provider.sapAi)
    init.signal?.throwIfAborted()
    if (!cached || cached.key !== raw || cached.expires <= Date.now()) {
      const url = joinUrl(service.url.replace(/\/oauth\/token\/?$/, ""), "/oauth/token")
      sapAiUrl(url)
      let response: Response
      try {
        response = await transport(url, { method: "POST", redirect: "error", signal: init.signal ?? null, headers: { authorization: `Basic ${Buffer.from(`${service.clientid}:${service.clientsecret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: "grant_type=client_credentials" })
      } catch {
        init.signal?.throwIfAborted()
        throw new RetryableProviderError("[AUTH]: SAP AI Core token exchange failed")
      }
      if (!response.ok) throw await httpFailure({ providerId: "sap-ai-core OAuth", response: new Response(null, { status: response.status, headers: response.headers }) })
      const data = await response.json().catch(() => undefined) as { access_token?: unknown; expires_in?: unknown; token_type?: unknown } | undefined
      if (typeof data?.access_token !== "string" || !/^[\x21-\x7e]+$/.test(data.access_token) || data.token_type !== undefined && String(data.token_type).toLowerCase() !== "bearer") throw new Error("[AUTH]: SAP AI Core returned an invalid access token")
      const seconds = typeof data.expires_in === "number" && Number.isFinite(data.expires_in) && data.expires_in > 0 ? data.expires_in : 60
      cached = { key: raw!, token: data.access_token, expires: Date.now() + Math.max(0, seconds - Math.min(30, seconds / 10)) * 1000 }
    }
    const url = joinUrl(root, path)
    // All paths are constructed here; service replies never choose a destination.
    sapAiUrl(url.split("?")[0]!)
    const headers = new Headers(provider.headers)
    new Headers(init.headers).forEach((value, name) => headers.set(name, value))
    headers.set("authorization", `Bearer ${cached.token}`)
    headers.set("AI-Resource-Group", config.resourceGroup!)
    let response: Response
    try { response = await transport(url, { ...init, headers, redirect: "error" }) } catch {
      init.signal?.throwIfAborted()
      throw new RetryableProviderError("[PROVIDER]: SAP AI Core connection failed")
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) cached = undefined
      throw await httpFailure({ providerId: "sap-ai-core", response: new Response(null, { status: response.status, headers: response.headers }) })
    }
    return response
  }
}

/** Keep the existing Chat Completions parser's tools, usage, abort and runaway guards. */
function normalizedStream(response: Response): Response {
  if (!response.body) throw new Error("[PROVIDER]: SAP AI Core returned no stream")
  const decoder = new TextDecoder(), encoder = new TextEncoder()
  let buffer = ""
  const convert = (block: string) => {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")
    if (!data || data === "[DONE]") return `${block}\n\n`
    let chunk: Record<string, unknown>
    try { chunk = JSON.parse(data) } catch { throw new Error("[PROVIDER]: SAP AI Core returned an invalid stream chunk") }
    if (chunk.error) {
      const error = chunk.error as { code?: unknown }
      return `data: ${JSON.stringify({ error: { code: error.code, message: "SAP orchestration failed" } })}\n\n`
    }
    return `data: ${JSON.stringify(chunk.final_result ?? chunk.orchestration_result ?? {})}\n\n`
  }
  return new Response(response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(bytes, controller) {
      buffer += decoder.decode(bytes, { stream: true })
      let boundary = buffer.search(/\r?\n\r?\n/)
      while (boundary >= 0) {
        controller.enqueue(encoder.encode(convert(buffer.slice(0, boundary))))
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "")
        boundary = buffer.search(/\r?\n\r?\n/)
      }
      if (buffer.length > 1_048_576) throw new Error("[PROVIDER]: SAP AI Core stream chunk exceeds limit")
    },
    flush(controller) {
      buffer += decoder.decode()
      if (buffer.trim()) controller.enqueue(encoder.encode(convert(buffer)))
    },
  })), { headers: { "content-type": "text/event-stream" } })
}

export function createSapAIProvider(input: { provider: ResolvedProvider; fetch?: Fetch; idleTimeoutMs?: number }): ModelProvider {
  const { provider } = input
  const transport: Fetch = input.fetch ?? ((url, init) => fetch(url, init))
  const bridge = (doFetch: Fetch): Fetch => {
    const send = connection(provider, doFetch)
    return async (_url, init) => {
      const config = sapAiConfig(provider.sapAi)
      let deployment = config.deploymentId
      if (!deployment) {
        const reply = await send("/lm/deployments", { method: "GET", signal: init.signal ?? null })
        const data = await reply.json().catch(() => undefined) as { resources?: Array<{ id?: string; scenarioId?: string; status?: string; createdAt?: string }> } | undefined
        deployment = data?.resources?.filter((item) => item.scenarioId === "orchestration" && item.status === "RUNNING" && identifier.test(item.id ?? "")).sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))[0]?.id
        if (!deployment) throw new Error("[PROVIDER]: no running SAP orchestration deployment; set AICORE_DEPLOYMENT_ID")
      }
      const { model, messages, tools, tool_choice, response_format, stream: _stream, stream_options: _options, ...params } = JSON.parse(String(init.body)) as Record<string, unknown>
      const body = { config: { stream: { enabled: true }, modules: { prompt_templating: { model: { name: model, params: { ...params, stream_options: { include_usage: true } } }, prompt: { template: messages, ...(tools ? { tools, tool_choice } : {}), ...(response_format ? { response_format } : {}) } } } } }
      return normalizedStream(await send(`/inference/deployments/${deployment}/v2/completion`, { ...init, body: JSON.stringify(body) }))
    }
  }
  // The service-key JSON must never be put in a Chat Completions auth header.
  const adapter = createChatCompletionsProvider({ id: provider.id, model: provider.models[0]?.id ?? "", baseUrl: provider.baseUrl || "http://127.0.0.1", fetch: bridge(transport), idleTimeoutMs: input.idleTimeoutMs ?? (provider.chunkTimeout === false ? 0 : provider.chunkTimeout ?? 60_000), takesImages: (model) => provider.models.find((item) => item.id === model)?.images !== false })
  return { ...adapter, async *stream(request) {
    sapAiRoot(provider.baseUrl, provider.apiKey())
    yield* adapter.stream({ ...request, ...(request.fetch ? { fetch: bridge(request.fetch) } : {}) })
  } }
}

/** SAP's tenant model discovery, rather than an invented static model list. */
export async function fetchSapAIModels(input: { provider: ResolvedProvider; fetch?: Fetch; timeoutMs?: number }): Promise<ProviderModel[]> {
  const send = connection(input.provider, input.fetch ?? ((url, init) => fetch(url, init)))
  const response = await send("/lm/scenarios/foundation-models/models", { method: "GET", signal: AbortSignal.timeout(input.timeoutMs ?? 10_000) })
  const data = await response.json().catch(() => undefined) as { resources?: Array<{ model?: unknown; displayName?: unknown; allowedScenarios?: Array<{ scenarioId?: string }>; versions?: Array<{ isLatest?: boolean; deprecated?: boolean; capabilities?: string[]; inputTypes?: string[]; contextLength?: number }> }> } | undefined
  if (!Array.isArray(data?.resources)) throw new Error("[PROVIDER]: SAP AI Core returned no model list")
  const models = data.resources.flatMap((item): ProviderModel[] => {
    const version = item.versions?.find((entry) => entry.isLatest && !entry.deprecated) ?? item.versions?.find((entry) => !entry.deprecated)
    if (typeof item.model !== "string" || !item.model || item.model.length > 66 || item.allowedScenarios && !item.allowedScenarios.some((entry) => entry.scenarioId === "orchestration") || !version?.capabilities?.includes("text-generation")) return []
    const context = version.contextLength
    return [{ id: item.model, ...(typeof item.displayName === "string" && item.displayName ? { name: item.displayName.slice(0, 100) } : {}), ...(typeof context === "number" && Number.isFinite(context) && context > 0 ? { context: Math.floor(context) } : {}), ...(version.inputTypes ? { images: version.inputTypes.includes("image") } : {}) }]
  })
  return [...new Map(models.map((model) => [model.id, model])).values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, 400)
}
