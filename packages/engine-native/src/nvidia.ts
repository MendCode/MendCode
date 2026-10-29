import { outboundEndpoint } from "./endpoint-policy"
import { createChatCompletionsProvider } from "./openai-compatible"
import type { ModelProvider } from "./provider"
import type { Fetch } from "./provider-http"

/** v1's NVIDIA attribution; the current token always wins over header hooks. */
export const NVIDIA_HEADERS = {
  "HTTP-Referer": "https://mendcode.ai/",
  "X-Title": "opencode",
} as const

export const nvidiaUrl = (value: string): URL => outboundEndpoint(value, "NVIDIA")

export function nvidiaHeaders(headers: HeadersInit | undefined, key: string): Headers {
  const merged = new Headers(NVIDIA_HEADERS)
  new Headers(headers).forEach((value, name) => merged.set(name, value))
  merged.set("authorization", `Bearer ${key}`)
  return merged
}

/** Opt-in NIM Chat Completions through an authenticated local proxy; no SDK loading. */
export function createNvidiaProvider(options: Parameters<typeof createChatCompletionsProvider>[0]): ModelProvider {
  const transport = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))
  const guarded = (doFetch: Fetch, key?: string): Fetch => async (url, init) => {
    nvidiaUrl(url)
    const token = key ?? await options.apiKey?.()
    if (!token) throw new Error("[AUTH]: no API key for nvidia; set NVIDIA_API_KEY or use providers.set")
    return doFetch(url, { ...init, headers: nvidiaHeaders(init.headers, token), redirect: "error" })
  }
  const adapter = createChatCompletionsProvider({ ...options, requireKey: true, fetch: guarded(transport) })
  return {
    ...adapter,
    async *stream(request) {
      nvidiaUrl(options.baseUrl)
      const key = await options.apiKey?.()
      if (!key) throw new Error("[AUTH]: no API key for nvidia; set NVIDIA_API_KEY or use providers.set")
      yield* adapter.stream({
        ...request,
        fetch: guarded(request.fetch ?? transport, key),
        transformBody: async (body) => ({ ...await request.transformBody?.(body) ?? body, stream: true, stream_options: { include_usage: true } }),
      })
    },
    probe: () => {
      try { nvidiaUrl(options.baseUrl) } catch { return Promise.resolve(false) }
      return adapter.probe!()
    },
  }
}
