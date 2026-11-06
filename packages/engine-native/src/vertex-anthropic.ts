import { createAnthropicProvider } from "./anthropic-messages"
import { vertexEndpoint, vertexAnthropicRouting, VERTEX_ANTHROPIC_MODEL } from "./provider-endpoints"
import type { ResolvedProvider } from "./provider-factory"
import { scrub, type Fetch } from "./provider-http"
import type { ModelProvider } from "./provider"

export { isVertexType, VERTEX_ANTHROPIC_MODEL, vertexAnthropicRouting } from "./provider-endpoints"

/** Vertex uses Messages SSE with Google bearer auth and a publisher model in the URL. */
export function createVertexAnthropicProvider(input: { provider: ResolvedProvider; fetch?: Fetch; idleTimeoutMs?: number }): ModelProvider {
  const { provider } = input
  const routing = vertexAnthropicRouting(provider.vertex)
  if (!routing.project || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(routing.project)) throw new Error("[PROVIDER]: Vertex needs a valid GCP project")
  if (!/^(global|[a-z]+(?:-[a-z0-9]+)+)$/.test(routing.location)) throw new Error("[PROVIDER]: invalid Vertex location")
  const baseUrl = vertexEndpoint(provider.baseUrl)
  const messages = createAnthropicProvider({
    id: provider.id, model: provider.models[0]?.id ?? "", baseUrl, apiKey: () => undefined,
    idleTimeoutMs: input.idleTimeoutMs ?? (provider.chunkTimeout === false ? 0 : provider.chunkTimeout ?? 60_000),
    takesImages: (model) => provider.models.find((entry) => entry.id === model)?.images !== false,
  })
  return {
    id: provider.id, model: messages.model,
    async *stream(request) {
      const model = (request.model ?? messages.model).trim()
      if (!VERTEX_ANTHROPIC_MODEL.test(model)) throw new Error("[PROVIDER]: invalid Vertex Anthropic model id")
      request.signal.throwIfAborted()
      if (!provider.googleToken) throw new Error("[AUTH]: Vertex ADC is unavailable")
      const token = await provider.googleToken(request.signal)
      if (!/^[\x21-\x7E]{1,16384}$/.test(token)) throw new Error("[AUTH]: Vertex ADC access token is invalid")
      request.signal.throwIfAborted()
      const quota = provider.vertex?.quotaProject ?? provider.googleQuotaProject?.()
      const headers = new Headers({ ...provider.headers, ...request.headers })
      headers.delete("x-api-key")
      headers.delete("anthropic-version")
      headers.delete("x-goog-api-key")
      headers.delete("x-goog-user-project")
      headers.set("authorization", `Bearer ${token}`)
      if (quota) headers.set("x-goog-user-project", quota)
      const url = `${baseUrl}/projects/${encodeURIComponent(routing.project!)}/locations/${routing.location}/publishers/anthropic/models/${model}:streamRawPredict`
      const doFetch = request.fetch ?? input.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))
      try {
        yield* messages.stream({
          ...request, model, headers: Object.fromEntries(headers),
          transformBody: async (built) => {
            const body = { ...((await request.transformBody?.(built)) ?? built), anthropic_version: "vertex-2023-10-16", stream: true }
            delete (body as Record<string, unknown>).model
            return body
          },
          fetch: async (_, init) => {
            const sent = new Headers(init.headers)
            sent.delete("anthropic-version")
            sent.delete("x-api-key")
            return doFetch(url, { ...init, headers: sent, redirect: "error" })
          },
        })
      } catch (error) {
        if (error instanceof Error) error.message = scrub(error.message.replace("rejected the API key (check it with providers.set)", "rejected ADC credentials (check Google IAM and model access)"), [token])
        throw error
      }
    },
  }
}
