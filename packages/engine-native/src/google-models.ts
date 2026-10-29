import type { ProviderModel } from "@mendcode/protocol"
import { authHeaders, safeMessage, type ResolvedProvider } from "./provider-factory"
import { httpFailure, joinUrl, type Fetch } from "./provider-http"
import { geminiVariants } from "./provider-presets"

type RemoteModel = { name?: unknown; displayName?: unknown; inputTokenLimit?: unknown; supportedGenerationMethods?: unknown }

/** Gemini's paginated catalog uses resource names rather than OpenAI's `data[].id`. */
export async function fetchGeminiModels(input: { provider: ResolvedProvider; fetch?: Fetch; timeoutMs: number; maxModels: number }): Promise<ProviderModel[]> {
  const { provider } = input
  const doFetch: Fetch = input.fetch ?? ((url, init) => fetch(url, init))
  const key = provider.apiKey()
  if (!key) throw new Error(`[AUTH]: no API key for ${provider.id}; set it with providers.set or the provider's environment variable`)
  const signal = AbortSignal.timeout(input.timeoutMs)
  const models = new Map<string, ProviderModel>()
  const tokens = new Set<string>()
  let pageToken: string | undefined
  for (let page = 0; page < 10; page++) {
    const query = new URLSearchParams({ pageSize: String(Math.min(input.maxModels, 1000)), ...(pageToken ? { pageToken } : {}) })
    let response: Response
    try {
      response = await doFetch(joinUrl(provider.baseUrl, `/models?${query}`), { method: "GET", headers: { accept: "application/json", ...authHeaders(provider, key) }, redirect: "error", signal })
    } catch (error) {
      throw new Error(`[PROVIDER]: ${provider.id} ${signal.aborted ? "model list timed out" : safeMessage(error, key)}`)
    }
    if (!response.ok) throw await httpFailure({ providerId: provider.id, response, secrets: [key] })
    const payload = await response.json().catch(() => undefined) as { models?: unknown; nextPageToken?: unknown } | undefined
    if (!Array.isArray(payload?.models)) throw new Error(`[PROVIDER]: ${provider.id} /models answered without a model list`)
    for (const raw of payload.models as RemoteModel[]) {
      if (!raw || typeof raw.name !== "string") continue
      const id = raw.name.replace(/^models\//, "")
      if (!/^gemini-[A-Za-z0-9._-]+$/.test(id) || id.length > 66 || /(embedding|image|tts|audio|live|robotics)/i.test(id)) continue
      if (!Array.isArray(raw.supportedGenerationMethods) || !raw.supportedGenerationMethods.includes("generateContent")) continue
      const context = typeof raw.inputTokenLimit === "number" && Number.isFinite(raw.inputTokenLimit) && raw.inputTokenLimit > 0 ? Math.floor(raw.inputTokenLimit) : undefined
      const name = typeof raw.displayName === "string" && raw.displayName ? raw.displayName.slice(0, 100) : undefined
      const variants = geminiVariants(id)
      models.set(id, { id, ...(name ? { name } : {}), ...(context ? { context } : {}), images: true, effort: /^gemini-(2\.5|3)/.test(id), ...(Object.keys(variants).length ? { variants } : {}) })
    }
    if (!payload.nextPageToken || models.size >= input.maxModels) return [...models.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, input.maxModels)
    if (typeof payload.nextPageToken !== "string" || payload.nextPageToken.length > 2048 || tokens.has(payload.nextPageToken)) throw new Error(`[PROVIDER]: ${provider.id} invalid model pagination`)
    pageToken = payload.nextPageToken
    tokens.add(pageToken)
  }
  throw new Error(`[PROVIDER]: ${provider.id} model pagination exceeded 10 pages`)
}
