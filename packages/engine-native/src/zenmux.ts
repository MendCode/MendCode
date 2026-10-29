import { outboundEndpoint } from "./endpoint-policy"
import { createChatCompletionsProvider } from "./openai-compatible"
import type { ModelProvider } from "./provider"
import type { Fetch } from "./provider-http"

/** v1's Zenmux attribution. Authentication always uses the current proxy token. */
export const ZENMUX_HEADERS = {
  "HTTP-Referer": "https://mendcode.ai/",
  "X-Title": "opencode",
} as const

export const zenmuxUrl = (value: string): URL => outboundEndpoint(value, "Zenmux")

export function zenmuxHeaders(headers: HeadersInit | undefined, key: string): Headers {
  const merged = new Headers(ZENMUX_HEADERS)
  new Headers(headers).forEach((value, name) => merged.set(name, value))
  merged.set("authorization", `Bearer ${key}`)
  return merged
}

/** Authenticated local Chat Completions; no SDK loading or automatic requests. */
export function createZenmuxProvider(options: Parameters<typeof createChatCompletionsProvider>[0]): ModelProvider {
  const transport = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))
  const guarded = (doFetch: Fetch, key?: string): Fetch => async (url, init) => {
    zenmuxUrl(url)
    const token = key ?? await options.apiKey?.()
    if (!token) throw new Error("[AUTH]: no API key for zenmux; set ZENMUX_API_KEY or use providers.set")
    return doFetch(url, { ...init, headers: zenmuxHeaders(init.headers, token), redirect: "error" })
  }
  const adapter = createChatCompletionsProvider({ ...options, requireKey: true, fetch: guarded(transport) })
  return {
    ...adapter,
    async *stream(request) {
      zenmuxUrl(options.baseUrl)
      const key = await options.apiKey?.()
      if (!key) throw new Error("[AUTH]: no API key for zenmux; set ZENMUX_API_KEY or use providers.set")
      yield* adapter.stream({
        ...request,
        fetch: guarded(request.fetch ?? transport, key),
        transformBody: async (body) => ({ ...await request.transformBody?.(body) ?? body, stream: true, stream_options: { include_usage: true } }),
      })
    },
    probe: () => {
      try { zenmuxUrl(options.baseUrl) } catch { return Promise.resolve(false) }
      return adapter.probe!()
    },
  }
}
