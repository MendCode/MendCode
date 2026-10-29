import { outboundEndpoint } from "./endpoint-policy"
import { createChatCompletionsProvider } from "./openai-compatible"
import type { ModelProvider } from "./provider"
import type { Fetch } from "./provider-http"

/** Model Studio (DashScope) is opt-in: it needs an explicit enable and a Bearer key. */
export const alibabaUrl = (value: string): URL => outboundEndpoint(value, "Alibaba")

/** v1 SDK option names map to Model Studio's native fields; Qwen has no OpenAI effort levels. */
export function alibabaBody(body: Record<string, unknown>): Record<string, unknown> {
  const { enableThinking, thinkingBudget, reasoning_effort: _effort, reasoning: _reasoning, prompt_cache_key: _cache, ...rest } = body
  return {
    ...rest,
    ...(enableThinking !== undefined && rest.enable_thinking === undefined ? { enable_thinking: enableThinking } : {}),
    ...(thinkingBudget !== undefined && rest.thinking_budget === undefined ? { thinking_budget: thinkingBudget } : {}),
    stream: true,
    stream_options: { include_usage: true },
  }
}

export function createAlibabaProvider(options: Parameters<typeof createChatCompletionsProvider>[0]): ModelProvider {
  const transport = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))
  const guarded = (doFetch: Fetch, key?: string): Fetch => (url, init) => {
    alibabaUrl(url)
    const headers = new Headers(init.headers)
    if (key) headers.set("authorization", `Bearer ${key}`)
    return doFetch(url, { ...init, headers, redirect: "error" })
  }
  const adapter = createChatCompletionsProvider({ ...options, requireKey: true, fetch: guarded(transport) })
  return {
    ...adapter,
    async *stream(request) {
      alibabaUrl(options.baseUrl)
      const key = await options.apiKey?.()
      if (!key) throw new Error("[AUTH]: no API key for alibaba; set DASHSCOPE_API_KEY or use providers.set")
      yield* adapter.stream({
        ...request,
        fetch: guarded(request.fetch ?? transport, key),
        transformBody: async (body) => alibabaBody(await request.transformBody?.(body) ?? body),
      })
    },
    probe: () => {
      try { alibabaUrl(options.baseUrl) } catch { return Promise.resolve(false) }
      return adapter.probe!()
    },
  }
}
