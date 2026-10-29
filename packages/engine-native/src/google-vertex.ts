import type { VertexOptions } from "@mendcode/protocol"
import { createGeminiProvider } from "./google-gemini"
import type { ResolvedProvider } from "./provider-factory"
import type { Fetch } from "./provider-http"

type Env = Record<string, string | undefined>

export function vertexRouting(options: VertexOptions = {}, env: Env = {}) {
  return {
    project: options.project ?? env.GOOGLE_CLOUD_PROJECT ?? env.GCP_PROJECT ?? env.GCLOUD_PROJECT,
    location: options.location ?? env.GOOGLE_VERTEX_LOCATION ?? env.GOOGLE_CLOUD_LOCATION ?? env.VERTEX_LOCATION ?? "us-central1",
  }
}

/** Custom endpoints are explicit; HTTP is confined to loopback. No credential-bearing URL or redirect. */
export function vertexEndpoint(value: string): string {
  try {
    const url = new URL(value)
    if (url.username || url.password || url.search || url.hash || !(url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error()
    return value.replace(/\/+$/, "")
  } catch { throw new Error("[PROVIDER]: Vertex endpoint requires HTTPS or loopback HTTP without credentials, query or fragment") }
}

export function vertexBaseUrl(location: string) {
  if (!/^(global|[a-z]+(?:-[a-z0-9]+)+)$/.test(location)) throw new Error("[PROVIDER]: invalid Vertex location")
  return `https://${location === "global" ? "" : `${location}-`}aiplatform.googleapis.com/v1`
}

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
