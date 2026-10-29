import { z } from "zod"
import { defineTool, type Tool, type ToolResult } from "../tool"
import { fail, succeed, truncateText } from "../util"
import { domainAllowed, domainRules } from "../web-policy"
import { clip, envValue, isRecord, requestJson, type FetchLike } from "./api_http"

const DEFAULT_RESULTS = 5
const MAX_RESULTS = 10
const TIMEOUT_MS = 25_000
const MAX_QUERY_CHARS = 400
const TITLE_CHARS = 200
const SNIPPET_CHARS = 400
const DEFAULT_OPENROUTER_WEB_MODEL = "openai/gpt-4o-mini"

export const WEBSEARCH_ENV = {
  exa: "EXA_API_KEY",
  brave: "BRAVE_API_KEY",
  tavily: "TAVILY_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
} as const
/** Model the OpenRouter web plugin runs on when `OPENROUTER_API_KEY` is the only key. */
export const WEBSEARCH_OPENROUTER_MODEL_ENV = "MENDCODE_WEBSEARCH_OPENROUTER_MODEL"

export type SearchResult = { title: string; url: string; snippet: string; date?: string }
type SearchOutcome = { ok: true; results: SearchResult[] } | { ok: false; message: string }
const RECENCY = ["day", "week", "month", "year"] as const
type Recency = (typeof RECENCY)[number]
const RECENCY_DAYS: Record<Recency, number> = { day: 1, week: 7, month: 31, year: 366 }
type SearchInput = { query: string; count: number; key: string; fetch: FetchLike; signal: AbortSignal; env: Record<string, string | undefined>; recency?: Recency | undefined; include: string[]; exclude: string[] }

/** One search backend. Adding a provider means adding an entry to PROVIDERS; order is precedence. */
type Provider = { id: keyof typeof WEBSEARCH_ENV; label: string; search(input: SearchInput): Promise<SearchOutcome> }

const text = (value: unknown): string => (typeof value === "string" ? value : "")

function shape({ title, url, snippet, date }: { title: unknown; url: unknown; snippet: unknown; date?: unknown }): SearchResult | undefined {
  const link = text(url).trim()
  if (!/^https?:\/\//i.test(link)) return undefined
  const result: SearchResult = { title: clip({ text: text(title), max: TITLE_CHARS }) || link, url: link, snippet: clip({ text: text(snippet), max: SNIPPET_CHARS }) }
  const when = text(date).trim()
  if (when) result.date = when.slice(0, 40)
  return result
}

function collect({ items, count, map }: { items: unknown; count: number; map(item: Record<string, unknown>): SearchResult | undefined }): SearchResult[] {
  const seen = new Set<string>()
  const results: SearchResult[] = []
  for (const item of Array.isArray(items) ? items : []) {
    if (!isRecord(item)) continue
    const result = map(item)
    if (!result || seen.has(result.url)) continue
    seen.add(result.url)
    results.push(result)
    if (results.length >= count) break
  }
  return results
}

const exa: Provider = {
  id: "exa",
  label: "Exa",
  async search({ query, count, key, fetch, signal, recency, include, exclude }) {
    const response = await requestJson({
      fetch,
      url: "https://api.exa.ai/search",
      init: {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", "x-api-key": key },
        body: JSON.stringify({
          query, numResults: count, type: "auto", contents: { text: { maxCharacters: 600 } },
          ...(include.length ? { includeDomains: include } : {}),
          ...(exclude.length ? { excludeDomains: exclude } : {}),
          ...(recency ? { startPublishedDate: new Date(Date.now() - RECENCY_DAYS[recency] * 86_400_000).toISOString() } : {}),
        }),
      },
      provider: "Exa",
      secrets: [key],
      signal,
      timeoutMs: TIMEOUT_MS,
    })
    if (!response.ok) return response
    const results = isRecord(response.json) ? response.json.results : undefined
    return {
      ok: true,
      results: collect({
        items: results,
        count,
        map: (item) => {
          const highlights = Array.isArray(item.highlights) ? item.highlights.map(text).join(" ") : ""
          return shape({ title: item.title, url: item.url, snippet: text(item.text) || text(item.summary) || highlights, date: item.publishedDate })
        },
      }),
    }
  },
}

const brave: Provider = {
  id: "brave",
  label: "Brave",
  async search({ query, count, key, fetch, signal, recency, exclude }) {
    const url = new URL("https://api.search.brave.com/res/v1/web/search")
    url.searchParams.set("q", [query, ...exclude.slice(0, 10).map((domain) => `-site:${domain}`)].join(" "))
    url.searchParams.set("count", String(count))
    if (recency) url.searchParams.set("freshness", { day: "pd", week: "pw", month: "pm", year: "py" }[recency])
    const response = await requestJson({
      fetch,
      url: url.toString(),
      init: { method: "GET", headers: { accept: "application/json", "x-subscription-token": key } },
      provider: "Brave",
      secrets: [key],
      signal,
      timeoutMs: TIMEOUT_MS,
    })
    if (!response.ok) return response
    const web = isRecord(response.json) && isRecord(response.json.web) ? response.json.web.results : undefined
    return { ok: true, results: collect({ items: web, count, map: (item) => shape({ title: item.title, url: item.url, snippet: item.description, date: item.page_age ?? item.age }) }) }
  },
}

const tavily: Provider = {
  id: "tavily",
  label: "Tavily",
  async search({ query, count, key, fetch, signal, recency, include, exclude }) {
    const response = await requestJson({
      fetch,
      url: "https://api.tavily.com/search",
      init: {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          query, max_results: count, search_depth: "basic",
          ...(include.length ? { include_domains: include } : {}),
          ...(exclude.length ? { exclude_domains: exclude } : {}),
          ...(recency ? { time_range: recency } : {}),
        }),
      },
      provider: "Tavily",
      secrets: [key],
      signal,
      timeoutMs: TIMEOUT_MS,
    })
    if (!response.ok) return response
    const results = isRecord(response.json) ? response.json.results : undefined
    return { ok: true, results: collect({ items: results, count, map: (item) => shape({ title: item.title, url: item.url, snippet: item.content, date: item.published_date }) }) }
  },
}

/** The OpenRouter `web` plugin grounds a model's answer; the sources it cited are the results. */
const openrouter: Provider = {
  id: "openrouter",
  label: "OpenRouter web plugin",
  async search({ query, count, key, fetch, signal, env }) {
    const base = (envValue({ env, name: "OPENROUTER_BASE_URL" }) ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "")
    const response = await requestJson({
      fetch,
      url: `${base}/chat/completions`,
      init: {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: envValue({ env, name: WEBSEARCH_OPENROUTER_MODEL_ENV }) ?? DEFAULT_OPENROUTER_WEB_MODEL,
          plugins: [{ id: "web", max_results: count }],
          max_tokens: 700,
          messages: [{ role: "user", content: `Web search: ${query}\nList the ${count} most relevant sources as short bullets, each with its link.` }],
        }),
      },
      provider: "OpenRouter",
      secrets: [key],
      signal,
      timeoutMs: TIMEOUT_MS,
    })
    if (!response.ok) return response
    const choices = isRecord(response.json) ? response.json.choices : undefined
    const message = Array.isArray(choices) && isRecord(choices[0]) && isRecord(choices[0].message) ? choices[0].message : undefined
    const annotations = message?.annotations
    return {
      ok: true,
      results: collect({
        items: annotations,
        count,
        map: (item) => {
          const citation = isRecord(item.url_citation) ? item.url_citation : undefined
          return item.type === "url_citation" && citation ? shape({ title: citation.title, url: citation.url, snippet: citation.content, date: citation.date }) : undefined
        },
      }),
    }
  },
}

/**
 * The ChatGPT subscription's own search: the endpoint the Codex CLI calls for its web tool, with the login MendCode already reads. It
 * needs no key, so it is the fallback when no search key is set. The provider's hosted `web_search` (a tool the model runs inside a
 * response) answered every request with a server error from 2026-10-08, while this endpoint kept working: measured with both clients.
 */
export type SubscriptionSearch = {
  /** The backend's base URL (`…/backend-api/codex`). */
  baseUrl: string
  /** The authorization headers of the login; throws when there is none. */
  headers(): Promise<Record<string, string>>
  /** The model the request names (the backend refuses a request without one). */
  model(): string
  /** A login exists, so the tool is worth registering. */
  available(): boolean
}
const SUBSCRIPTION_LABEL = "ChatGPT"
const SUBSCRIPTION_MAX_OUTPUT_TOKENS = 10_000

async function subscriptionSearch({ query, count, recency, fetch, signal, subscription }: Pick<SearchInput, "query" | "count" | "recency" | "fetch" | "signal"> & { subscription: SubscriptionSearch }): Promise<SearchOutcome> {
  let headers: Record<string, string>
  try { headers = await subscription.headers() } catch (error) { return { ok: false, message: error instanceof Error ? error.message.replace(/^\[[A-Z]+\]: /, "") : "no ChatGPT login" } }
  const response = await requestJson({
    fetch,
    url: `${subscription.baseUrl}/alpha/search`,
    init: {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        id: crypto.randomUUID(),
        model: subscription.model(),
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: query }] }],
        commands: { search_query: [{ q: query, ...(recency ? { recency: RECENCY_DAYS[recency] } : {}) }], response_length: "short" },
        settings: { allowed_callers: ["direct"], external_web_access: false },
        max_output_tokens: SUBSCRIPTION_MAX_OUTPUT_TOKENS,
      }),
    },
    provider: SUBSCRIPTION_LABEL,
    secrets: Object.values(headers),
    signal,
    timeoutMs: TIMEOUT_MS,
  })
  if (!response.ok) return response
  return { ok: true, results: collect({ items: isRecord(response.json) ? response.json.results : undefined, count, map: (item) => shape({ title: item.title, url: item.url, snippet: item.snippet }) }) }
}

/** First configured wins. The OpenRouter plugin is last: it is the fallback when it is the only key. */
const PROVIDERS: Provider[] = [exa, brave, tavily, openrouter]

/** The provider a set of environment variables selects, or undefined when no key exists. Never returns the key. */
export function selectWebSearchProvider(env: Record<string, string | undefined>): { id: Provider["id"]; label: string } | undefined {
  const found = PROVIDERS.find((provider) => envValue({ env, name: WEBSEARCH_ENV[provider.id] }))
  return found ? { id: found.id, label: found.label } : undefined
}

const args = z.object({
  query: z.string().trim().min(1).max(MAX_QUERY_CHARS).describe("What to search the web for"),
  numResults: z.number().int().min(1).max(MAX_RESULTS).optional().describe(`How many results to return (default ${DEFAULT_RESULTS}, at most ${MAX_RESULTS})`),
  recency: z.enum(RECENCY).optional().describe("Only results from the last day, week, month or year"),
})

export function formatResults({ query, label, results }: { query: string; label: string; results: SearchResult[] }): string {
  if (results.length === 0) return `No results for "${query}" (${label}). Try different words.`
  const lines = results.flatMap((result, index) => [
    `${index + 1}. ${result.title}`,
    `   ${result.url}${result.date ? `  (${result.date})` : ""}`,
    ...(result.snippet ? [`   ${result.snippet}`] : []),
  ])
  return `${results.length} result${results.length === 1 ? "" : "s"} for "${query}" (${label})\n${lines.join("\n")}`
}

/**
 * `websearch`: a search API the user has a key for (Exa, Brave, Tavily, or the OpenRouter web plugin), else the ChatGPT subscription's
 * own search when there is a login (`subscription`). Returns undefined when there is neither, so the tool is simply not registered.
 * `env` and `fetch` are injectable so tests never touch the network.
 */
export function createWebSearchTool({
  env = process.env,
  fetch = globalThis.fetch as FetchLike,
  subscription,
}: { env?: Record<string, string | undefined>; fetch?: FetchLike; subscription?: SubscriptionSearch } = {}): Tool | undefined {
  if (!selectWebSearchProvider(env) && !subscription?.available()) return undefined
  return defineTool({
    name: "websearch",
    description:
      "Search the web and return titles, links, dates and short snippets. Use it for current information, documentation and facts you cannot read from the project; follow up with webfetch to read a result page.",
    permission: "read",
    args,
    async execute({ query, numResults, recency }, context): Promise<ToolResult> {
      const title = `Search ${query}`.slice(0, 80)
      // Read at call time: a key added or removed while the daemon runs applies to the next call.
      const provider = PROVIDERS.find((candidate) => envValue({ env, name: WEBSEARCH_ENV[candidate.id] }))
      if (!provider && !subscription) return fail({ title, message: "websearch has no API key: set EXA_API_KEY, BRAVE_API_KEY, TAVILY_API_KEY or OPENROUTER_API_KEY" })
      if (context.signal.aborted) return fail({ title, message: "cancelled" })
      const rules = domainRules(context.web)
      const count = numResults ?? DEFAULT_RESULTS
      const label = provider?.label ?? SUBSCRIPTION_LABEL
      const outcome = provider
        ? await provider.search({ query, count, key: envValue({ env, name: WEBSEARCH_ENV[provider.id] }) as string, fetch, signal: context.signal, env, recency, include: rules.allow, exclude: rules.block })
        : await subscriptionSearch({ query, count, recency, fetch, signal: context.signal, subscription: subscription! })
      if (!outcome.ok) return fail({ title, message: `websearch failed: ${outcome.message}` })
      // Providers narrow by domain when they can; every result is checked here as well, so the rules hold for all of them.
      const results = outcome.results.filter((result) => {
        try { return domainAllowed(new URL(result.url).hostname, context.web).ok } catch { return false }
      })
      const note = recency && provider?.id === "openrouter" ? "\n(recency is not supported by this provider; results are not date-limited)" : ""
      const capped = truncateText({ text: formatResults({ query, label, results }) + note, ...(context.outputLimits ? { limits: { maxBytes: 8 * 1024 * 1024, maxLines: 100000 } } : {}) })
      return succeed({ title, output: capped.text, truncated: capped.truncated, meta: { provider: provider?.id ?? "chatgpt", results: results.length } })
    },
  })
}
