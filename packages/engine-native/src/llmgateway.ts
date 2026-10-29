import { outboundEndpoint } from "./endpoint-policy"
import { createChatCompletionsProvider } from "./openai-compatible"
import type { ModelProvider } from "./provider"
import type { Fetch } from "./provider-http"

/** v1's gateway attribution; credentials always come from the current provider token. */
export const LLMGATEWAY_HEADERS = {
  "HTTP-Referer": "https://mendcode.ai/",
  "X-Title": "opencode",
  "X-Source": "opencode",
} as const

export const llmgatewayUrl = (value: string): URL => outboundEndpoint(value, "LLMGateway")

export function llmgatewayHeaders(headers: HeadersInit | undefined, key: string): Headers {
  const merged = new Headers(LLMGATEWAY_HEADERS)
  new Headers(headers).forEach((value, name) => merged.set(name, value))
  merged.set("authorization", `Bearer ${key}`)
  return merged
}

/** Native Chat Completions with an authenticated, opt-in local gateway. No SDK loading. */
export function createLLMGatewayProvider(options: Parameters<typeof createChatCompletionsProvider>[0]): ModelProvider {
  const transport = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))
  const guarded = (doFetch: Fetch, key?: string): Fetch => async (url, init) => {
    llmgatewayUrl(url)
    const token = key ?? await options.apiKey?.()
    if (!token) throw new Error("[AUTH]: no API key for llmgateway; set LLMGATEWAY_API_KEY or use providers.set")
    return doFetch(url, { ...init, headers: llmgatewayHeaders(init.headers, token), redirect: "error" })
  }
  const adapter = createChatCompletionsProvider({ ...options, requireKey: true, fetch: guarded(transport) })
  return {
    ...adapter,
    async *stream(request) {
      llmgatewayUrl(options.baseUrl)
      const key = await options.apiKey?.()
      if (!key) throw new Error("[AUTH]: no API key for llmgateway; set LLMGATEWAY_API_KEY or use providers.set")
      yield* adapter.stream({
        ...request,
        fetch: guarded(request.fetch ?? transport, key),
        transformBody: async (body) => ({ ...await request.transformBody?.(body) ?? body, stream: true, stream_options: { include_usage: true } }),
      })
    },
    probe: () => {
      try { llmgatewayUrl(options.baseUrl) } catch { return Promise.resolve(false) }
      return adapter.probe!()
    },
  }
}
