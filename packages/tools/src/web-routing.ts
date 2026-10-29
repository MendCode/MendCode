import { redactSecrets } from "@mendcode/protocol"

export type WebRoute = { id: string; endpoint: string; credential?: string }
type Response = { text: string }

/** Daemon-only port: caller must apply existing approvals/domain policy to every destination. No default fallback. */
export function createWebRouting(input: {
  primary: WebRoute
  fallback?: WebRoute
  authorize(route: { id: string; endpoint: string }, query: string): Promise<boolean>
  request(route: WebRoute, query: string, signal: AbortSignal): Promise<Response>
}) {
  const primary = { ...input.primary }
  const fallback = input.fallback ? { ...input.fallback } : undefined
  const safe = (result: Response) => {
    let text = result.text
    for (const key of [primary.credential, fallback?.credential]) if (key) text = text.replaceAll(key, "[redacted]")
    return { text: redactSecrets(text).text.slice(0, 64 * 1024) }
  }
  const validate = (route: WebRoute) => {
    const url = new URL(route.endpoint)
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Invalid route endpoint")
    if (!route.credential) throw new Error("Route credential missing")
  }
  return {
    async fetch(query: string, signal: AbortSignal, options: { fallbackConsent?: { endpoint: string; shareQuery: true } } = {}): Promise<Response & { route: string; fallback: boolean }> {
      if (!query.trim() || query.length > 8_000 || /‹secret:|\[redacted\]/i.test(query) || redactSecrets(query).text !== query || [primary.credential, fallback?.credential].some((key) => key && query.includes(key))) throw new Error("Invalid or private query")
      validate(primary)
      if (signal.aborted || !await input.authorize({ id: primary.id, endpoint: primary.endpoint }, query) || signal.aborted) throw new Error("Route denied")
      try { return { ...safe(await input.request({ ...primary }, query, signal)), route: primary.id, fallback: false } }
      catch {
        if (signal.aborted || !fallback || options.fallbackConsent?.endpoint !== fallback.endpoint || !options.fallbackConsent.shareQuery) throw new Error("Primary route failed; fallback disabled")
        validate(fallback)
        if (!await input.authorize({ id: fallback.id, endpoint: fallback.endpoint }, query) || signal.aborted) throw new Error("Fallback denied")
        try { return { ...safe(await input.request({ ...fallback }, query, signal)), route: fallback.id, fallback: true } }
        catch { throw new Error("Fallback route failed") }
      }
    },
  }
}
