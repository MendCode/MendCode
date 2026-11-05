import { createGeminiProvider } from "./google-gemini"
import type { ResolvedProvider } from "./provider-factory"
import type { Fetch } from "./provider-http"

import { vertexRouting, vertexEndpoint } from "./provider-endpoints"
export { vertexRouting, vertexEndpoint, vertexBaseUrl } from "./provider-endpoints"

export function createVertexProvider(input: { provider: ResolvedProvider; fetch?: Fetch; idleTimeoutMs?: number }) {
  const { provider } = input
  const routing = vertexRouting(provider.vertex)
  if (!routing.project || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(routing.project)) throw new Error("[PROVIDER]: Vertex needs a valid GCP project")
  if (!/^(global|[a-z]+(?:-[a-z0-9]+)+)$/.test(routing.location)) throw new Error("[PROVIDER]: invalid Vertex location")
  const baseUrl = vertexEndpoint(provider.baseUrl)
  return createGeminiProvider({
    id: provider.id,
    model: provider.models[0]?.id ?? "",
    baseUrl,
    apiKey: () => undefined,
    authHint: "rejected ADC credentials (check Google IAM and token scopes)",
    bearerToken: async (signal) => {
      if (!provider.googleToken) throw new Error("[AUTH]: Vertex ADC is unavailable")
      return provider.googleToken(signal)
    },
    quotaProject: () => provider.vertex?.quotaProject ?? provider.googleQuotaProject?.(),
    modelPath: (model) => `/projects/${encodeURIComponent(routing.project!)}/locations/${routing.location}/publishers/google/models/${model}`,
    ...(provider.headers ? { headers: provider.headers } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
    idleTimeoutMs: input.idleTimeoutMs ?? (provider.chunkTimeout === false ? 0 : provider.chunkTimeout ?? 60_000),
    takesImages: (model) => provider.models.find((entry) => entry.id === model)?.images !== false,
  })
}
