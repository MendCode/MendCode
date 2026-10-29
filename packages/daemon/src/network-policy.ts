import { readFileSync, statSync } from "node:fs"
import { rootCertificates } from "node:tls"
import type { Settings } from "@mendcode/protocol"

type Fetch = typeof fetch
type Proxy = NonNullable<Settings["proxy"]>

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])
const MAX_CA_BYTES = 2 * 1024 * 1024

function hostOf(input: Parameters<Fetch>[0]) {
  try {
    return new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).hostname.toLowerCase()
  } catch { return undefined }
}

/** Whether `host` skips the proxy: loopback always, then the `noProxy` entries (`example.com` and `.example.com` cover subdomains, `*` everything). */
export function bypassesProxy(host: string, noProxy: readonly string[] | undefined) {
  if (LOOPBACK.has(host) || host.endsWith(".localhost")) return true
  return (noProxy ?? []).some((entry) => {
    const rule = entry.trim().toLowerCase().replace(/^\*\./, ".")
    if (rule === "*") return true
    if (!rule) return false
    return rule.startsWith(".") ? host.endsWith(rule) || host === rule.slice(1) : host === rule || host.endsWith(`.${rule}`)
  })
}

/**
 * `fetch` that sends the daemon's outbound requests through the `proxy` setting (an http or https proxy URL) and trusts the
 * extra CA bundle in `proxy.caFile` besides the system roots. The setting is read per request, so a change applies to the next one.
 * Nothing is logged: the proxy URL may carry credentials. Without the setting the request is unchanged (Bun still honours `HTTPS_PROXY`).
 */
export function createProxyFetch({ settings, base }: { settings(): Settings; base: Fetch }): Fetch {
  let bundle: { file: string; mtimeMs: number; ca: string[] } | undefined
  function authorities(file: string) {
    const info = statSync(file)
    if (!info.isFile() || info.size > MAX_CA_BYTES) throw new Error("[NETWORK]: proxy.caFile must be a PEM file under 2 MB")
    if (bundle?.file === file && bundle.mtimeMs === info.mtimeMs) return bundle.ca
    bundle = { file, mtimeMs: info.mtimeMs, ca: [...rootCertificates, readFileSync(file, "utf8")] }
    return bundle.ca
  }
  const proxied = ((input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]) => {
    const proxy: Proxy | undefined = settings().proxy
    if (!proxy || (!proxy.url && !proxy.caFile)) return base(input, init)
    const host = hostOf(input)
    const direct = host !== undefined && bypassesProxy(host, proxy.noProxy)
    const extra: Record<string, unknown> = {}
    if (proxy.url && !direct) extra.proxy = proxy.url
    if (proxy.caFile && !direct) {
      try { extra.tls = { ca: authorities(proxy.caFile) } } catch (error) { return Promise.reject(error instanceof Error ? error : new Error("[NETWORK]: proxy.caFile unreadable")) }
    }
    return base(input, { ...init, ...extra } as RequestInit)
  }) as Fetch
  return Object.assign(proxied, base)
}

/** Replaces `globalThis.fetch` once with the proxy-aware version; every provider, search, fetch and MCP request of this process uses it. */
export function installNetworkPolicy({ settings }: { settings(): Settings }) {
  const base = globalThis.fetch
  globalThis.fetch = createProxyFetch({ settings, base })
  return () => { globalThis.fetch = base }
}
