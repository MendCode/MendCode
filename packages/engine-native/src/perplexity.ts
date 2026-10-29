import { outboundEndpoint } from "./endpoint-policy"

/** Sonar is opt-in: it needs an explicit enable and a Bearer key; the default is the public Sonar API. */
export const perplexityUrl = (value: string): URL => outboundEndpoint(value, "Perplexity Sonar")

/** Sonar has search built in, but no client function calls or OpenAI stream-options field. */
export function perplexityBody(body: Record<string, unknown>): Record<string, unknown> {
  const { tools: _tools, tool_choice: _choice, parallel_tool_calls: _parallel, stream_options: _stream, reasoning_effort: _effort, prompt_cache_key: _cache, ...rest } = body
  const messages = Array.isArray(rest.messages) ? rest.messages as Record<string, unknown>[] : []
  return { ...rest, messages: messages.map(({ tool_calls: _calls, tool_call_id: _id, ...message }) => message.role === "tool" ? { role: "user", content: `Tool result: ${message.content ?? ""}` } : { ...message, content: message.content ?? "(tool call)" }) }
}

/** Preserve provider citation numbers; repeated cumulative SSE lists must never duplicate sources. */
export function perplexitySources() {
  let citations: unknown[] = []
  let results: unknown[] = []
  return {
    update(chunk: { citations?: unknown; search_results?: unknown }) {
      if (Array.isArray(chunk.citations) && chunk.citations.length) citations = chunk.citations.slice(0, 100)
      if (Array.isArray(chunk.search_results) && chunk.search_results.length) results = chunk.search_results.slice(0, 100)
    },
    text(secrets: readonly string[]) {
      const sources = citations.length ? citations : results.map((result) => result && typeof result === "object" ? (result as { url?: unknown }).url : undefined)
      const rows = sources.flatMap((value, index) => {
        if (typeof value !== "string" || value.length > 2048 || /[\s<>\\\x00-\x1f\x7f-\x9f]/.test(value) || secrets.some((secret) => secret && value.includes(secret))) return []
        try {
          const url = new URL(value)
          return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? [`[${index + 1}]: ${url.href}`] : []
        } catch { return [] }
      })
      return rows.length ? `\n\n${rows.join("\n")}` : ""
    },
  }
}
