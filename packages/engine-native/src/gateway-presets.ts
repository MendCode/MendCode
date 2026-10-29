import { outboundEndpoint } from "./endpoint-policy"
import { createChatCompletionsProvider } from "./openai-compatible"
import type { ModelProvider } from "./provider"
import type { Fetch } from "./provider-http"

/**
 * Hosted and local OpenAI-compatible hosts that need nothing beyond Chat Completions: one guarded transport serves all
 * of them instead of one module each. The guard is the shared outbound policy (HTTPS, or HTTP on loopback only, no
 * credentials/query/fragment in the URL), the current key as the only Authorization, and redirects refused.
 * `keyless` hosts (a local server) send a Bearer header only when a key exists.
 */
export const GATEWAY_PRESETS: Readonly<Record<string, { label: string; keyEnv?: string; keyless?: true }>> = {
  fireworks: { label: "Fireworks", keyEnv: "FIREWORKS_API_KEY" },
  huggingface: { label: "Hugging Face", keyEnv: "HF_TOKEN" },
  baseten: { label: "Baseten", keyEnv: "BASETEN_API_KEY" },
  moonshotai: { label: "Moonshot AI", keyEnv: "MOONSHOT_API_KEY" },
  minimax: { label: "MiniMax", keyEnv: "MINIMAX_API_KEY" },
  xiaomi: { label: "Xiaomi MiMo", keyEnv: "XIAOMI_API_KEY" },
  zai: { label: "Z.AI", keyEnv: "ZHIPU_API_KEY" },
  "opencode-go": { label: "OpenCode Go", keyEnv: "OPENCODE_GO_API_KEY" },
  "ant-ling": { label: "Ant Ling", keyEnv: "ANT_LING_API_KEY" },
  nearai: { label: "NEAR AI", keyEnv: "NEARAI_API_KEY" },
  foundry: { label: "Microsoft Foundry", keyEnv: "AZURE_AI_FOUNDRY_API_KEY" },
  "atomic-chat": { label: "Atomic Chat", keyless: true },
}

export const isGatewayPreset = (id: string) => Object.hasOwn(GATEWAY_PRESETS, id)

const label = (id: string) => GATEWAY_PRESETS[id]?.label ?? id

export const gatewayUrl = (id: string, value: string): URL => outboundEndpoint(value, label(id))

export function gatewayHeaders(headers: HeadersInit | undefined, key: string | undefined): Headers {
  const merged = new Headers(headers)
  merged.delete("authorization")
  if (key) merged.set("authorization", `Bearer ${key}`)
  return merged
}

const missingKey = (id: string) => `[AUTH]: no API key for ${id}; set ${GATEWAY_PRESETS[id]?.keyEnv ?? "its key variable"} or use providers.set`

/** Chat Completions through the shared guard; refuses to send without a key unless the host is a local server. */
export function createGatewayProvider(options: Parameters<typeof createChatCompletionsProvider>[0]): ModelProvider {
  const id = options.id
  const keyless = GATEWAY_PRESETS[id]?.keyless === true
  const transport = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))
  const token = async (key?: string) => {
    const value = key ?? await options.apiKey?.()
    if (!value && !keyless) throw new Error(missingKey(id))
    return value || undefined
  }
  const guarded = (doFetch: Fetch, key?: string): Fetch => async (url, init) => {
    gatewayUrl(id, url)
    return doFetch(url, { ...init, headers: gatewayHeaders(init.headers, await token(key)), redirect: "error" })
  }
  const adapter = createChatCompletionsProvider({ ...options, requireKey: !keyless, fetch: guarded(transport) })
  return {
    ...adapter,
    async *stream(request) {
      gatewayUrl(id, options.baseUrl)
      const key = await token()
      yield* adapter.stream({
        ...request,
        fetch: guarded(request.fetch ?? transport, key),
        transformBody: async (body) => ({ ...await request.transformBody?.(body) ?? body, stream: true, stream_options: { include_usage: true } }),
      })
    },
    probe: () => {
      try { gatewayUrl(id, options.baseUrl) } catch { return Promise.resolve(false) }
      return adapter.probe!()
    },
  }
}
