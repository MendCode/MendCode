import { outboundEndpoint } from "./endpoint-policy"
import { createChatCompletionsProvider } from "./openai-compatible"
import type { ModelProvider } from "./provider"
import type { Fetch } from "./provider-http"

/** v1's Kilo attribution; authentication always uses the current proxy token. */
export const KILO_HEADERS = {
  "HTTP-Referer": "https://mendcode.ai/",
  "X-Title": "opencode",
} as const

export const kiloUrl = (value: string): URL => outboundEndpoint(value, "Kilo")

export function kiloHeaders(headers: HeadersInit | undefined, key: string): Headers {
  const merged = new Headers(KILO_HEADERS)
  new Headers(headers).forEach((value, name) => merged.set(name, value))
  merged.set("authorization", `Bearer ${key}`)
  return merged
}

/** Native Chat Completions for an explicitly enabled, authenticated local proxy. */
export function createKiloProvider(options: Parameters<typeof createChatCompletionsProvider>[0]): ModelProvider {
  const transport = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))
  const guarded = (doFetch: Fetch, key?: string): Fetch => async (url, init) => {
    kiloUrl(url)
    const token = key ?? await options.apiKey?.()
    if (!token) throw new Error("[AUTH]: no API key for kilo; set KILO_API_KEY or use providers.set")
    return doFetch(url, { ...init, headers: kiloHeaders(init.headers, token), redirect: "error" })
  }
  const adapter = createChatCompletionsProvider({ ...options, requireKey: true, fetch: guarded(transport) })
  return {
    ...adapter,
    async *stream(request) {
      kiloUrl(options.baseUrl)
      const key = await options.apiKey?.()
      if (!key) throw new Error("[AUTH]: no API key for kilo; set KILO_API_KEY or use providers.set")
      yield* adapter.stream({
        ...request,
        fetch: guarded(request.fetch ?? transport, key),
        transformBody: async (body) => ({ ...await request.transformBody?.(body) ?? body, stream: true, stream_options: { include_usage: true } }),
      })
    },
    probe: () => {
      try { kiloUrl(options.baseUrl) } catch { return Promise.resolve(false) }
      return adapter.probe!()
    },
  }
}
