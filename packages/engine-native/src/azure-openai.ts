import type { AzureOptions } from "@mendcode/protocol"
import { createChatCompletionsProvider } from "./openai-compatible"
import { createResponsesProvider } from "./openai-responses"
import { RetryableProviderError, type ModelProvider } from "./provider"
import type { ResolvedProvider } from "./provider-factory"
import { scrub, type Fetch } from "./provider-http"

/** Explicit gateways are supported, but plaintext credentials may only travel over HTTP on loopback. */
export function azureBaseUrl(value: string): string {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash || !(url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new Error("Azure endpoint must use HTTPS or loopback HTTP, without credentials, query or fragment")
  return url.toString().replace(/\/+$/, "")
}

/** Azure SDK's Responses default and opt-in legacy deployment URLs, expressed through v2's native adapters. */
export function azureUrl(baseUrl: string, model: string, path: string, options: AzureOptions = {}): string {
  const root = azureBaseUrl(baseUrl)
  const base = root.replace(/\/v1$/, "")
  const prefix = /\/openai(?:\/v1)?$/.test(root) ? base : `${base}/openai`
  const url = new URL(options.useDeploymentBasedUrls ? `${prefix}/deployments/${encodeURIComponent(model)}${path}` : `${prefix}/v1${path}`)
  url.searchParams.set("api-version", options.apiVersion ?? "v1")
  return url.toString()
}

export async function azureHeaders(provider: ResolvedProvider, signal: AbortSignal): Promise<{ headers: Record<string, string>; secret: string }> {
  const entra = provider.azure?.auth === "entra"
  const secret = entra ? await provider.azureToken?.(signal) : provider.apiKey()
  if (!secret) throw new Error(`[AUTH]: no ${entra ? "Entra token" : "API key"} for ${provider.id}; use /connect azure`)
  const headers = new Headers(provider.headers)
  headers.delete("api-key")
  headers.delete("authorization")
  headers.set(entra ? "authorization" : "api-key", entra ? `Bearer ${secret}` : secret)
  return { headers: Object.fromEntries(headers.entries()), secret }
}

export function createAzureProvider(input: { provider: ResolvedProvider; fetch?: Fetch; idleTimeoutMs?: number }): ModelProvider {
  const { provider } = input
  azureBaseUrl(provider.baseUrl)
  return {
    id: provider.id, model: provider.models[0]?.id ?? "",
    async *stream(request) {
      const model = request.model ?? provider.models[0]?.id ?? ""
      if (!model) throw new Error(`[PROVIDER]: ${provider.id} needs a deployment id`)
      if (request.signal.aborted) return
      const auth = await azureHeaders(provider, request.signal)
      const chat = provider.azure?.useCompletionUrls === true
      const endpoint = chat ? "/chat/completions" : "/responses"
      const doFetch: Fetch = async (_url, init) => {
        const headers = new Headers(init.headers)
        headers.delete("api-key")
        headers.delete("authorization")
        for (const [name, value] of Object.entries(auth.headers)) headers.set(name, value)
        return (request.fetch ?? input.fetch ?? fetch)(azureUrl(provider.baseUrl, model, endpoint, provider.azure), { ...init, headers, redirect: "error" })
      }
      const common = { id: provider.id, model, baseUrl: provider.baseUrl, fetch: doFetch, ...(input.idleTimeoutMs !== undefined ? { idleTimeoutMs: input.idleTimeoutMs } : {}), takesImages: (id: string) => provider.models.find((entry) => entry.id === id)?.images !== false }
      const adapter = chat ? createChatCompletionsProvider({ ...common, apiKey: () => auth.secret, requireKey: true }) : createResponsesProvider({ ...common, headers: async () => auth.headers, routingHeader: false, hostedTools: [], authHint: "rejected Azure credentials; reconnect with /connect azure" })
      // The wrapper owns the transport: extension/request fetches still pass through Azure URL and auth handling.
      const { fetch: _fetch, ...rest } = request
      try { yield* adapter.stream(rest) } catch (error) {
        const message = scrub((error instanceof Error ? error.message : String(error)).split(auth.secret).join("[redacted:azure-credential]"), [auth.secret])
        if (error instanceof RetryableProviderError) throw new RetryableProviderError(message, error.retryAfterMs, error.kind)
        throw new Error(message)
      }
    },
  }
}
