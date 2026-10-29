const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "[::1]", "localhost"])

export const isLoopbackHostname = (hostname: string) => LOOPBACK_HOSTS.has(hostname)

/**
 * One outbound-endpoint policy for every provider: HTTPS to any host, plain HTTP only to a literal loopback host,
 * and never credentials, a query or a fragment inside the URL. It governs where MendCode SENDS requests; anything
 * that LISTENS on a port (REST, PTY, OAuth callbacks) keeps its own, stricter loopback-bind rules.
 */
export function outboundEndpoint(value: string, label: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new Error(`[PROVIDER]: ${label} endpoint must be an absolute HTTPS URL, or HTTP on loopback`) }
  const schemeAllowed = url.protocol === "https:" || url.protocol === "http:" && isLoopbackHostname(url.hostname)
  if (!schemeAllowed || url.username || url.password || url.search || url.hash) {
    throw new Error(`[PROVIDER]: ${label} endpoint requires HTTPS, or HTTP only on loopback, without credentials, query or fragment`)
  }
  return url
}
