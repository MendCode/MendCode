import { readFileSync } from "node:fs"
import path from "node:path"
import { HttpServerConfig } from "@mendcode/protocol"

export type HttpOptions = Partial<HttpServerConfig>

/** Startup validation stays eager without loading the HTTP routes. */
export function httpConfig(dir: string, flags: HttpOptions = {}): HttpServerConfig {
  let value: unknown = {}
  try { value = JSON.parse(readFileSync(path.join(dir, "remote.json"), "utf8")).server ?? {} } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("invalid remote.json server")
  }
  const parsed = HttpServerConfig.safeParse({ ...(value as object), ...flags })
  if (!parsed.success) throw new Error("invalid HTTP server configuration (loopback only)")
  if (parsed.data.mdns) throw new Error("mDNS is unavailable for the loopback server; remove server.mdns or set it to false")
  for (const origin of parsed.data.cors) {
    const url = new URL(origin)
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin || url.username || url.password) throw new Error("CORS entries must be exact HTTP origins")
  }
  return { ...parsed.data, hostname: parsed.data.hostname === "localhost" ? "127.0.0.1" : parsed.data.hostname }
}
