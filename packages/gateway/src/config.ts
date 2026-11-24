import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * `<state>/gateway.json`, written by `gateway setup`. The origin is the one public address browsers and devices use;
 * WebAuthn binds every passkey to `rpId` (the host name), so changing the domain means registering passkeys again.
 */
export type GatewayListen = { unix: string } | { port: number }
export type GatewayConfig = {
  version: 1
  origin: string
  rpId: string
  name: string
  listen: GatewayListen
  /** The header the edge proxy sets to the client address; read only because nothing but that proxy can reach the listener. */
  clientIpHeader?: "x-real-ip" | "x-forwarded-for"
  /** Per-account daemon sockets live at `<runtimeRoot>/<account>/http.sock`. */
  runtimeRoot: string
}

export const GATEWAY_CONFIG_FILE = "gateway.json"
export const DEFAULT_STATE_DIR = "/var/lib/mendcode-gateway"
export const DEFAULT_RUNTIME_ROOT = "/run/mendcode"
export const DEFAULT_USERS_ROOT = "/var/lib/mendcode-users"
export const GATEWAY_SOCKET = "/run/mendcode-gateway/gateway.sock"

const HOST = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/

/** A public DNS name (at least one dot, no IP literal, no wildcard, lower case). */
export function validDomain(domain: string) {
  return HOST.test(domain) && !/^\d+(\.\d+){3}$/.test(domain)
}

export function parseGatewayConfig(value: unknown): GatewayConfig {
  const fail = (what: string): never => { throw new TypeError(`[GATEWAY]: invalid gateway.json: ${what}`) }
  if (!value || typeof value !== "object") fail("not an object")
  const config = value as Record<string, unknown>
  const allowed = new Set(["version", "origin", "rpId", "name", "listen", "clientIpHeader", "runtimeRoot"])
  for (const key of Object.keys(config)) if (!allowed.has(key)) fail(`unknown key ${key}`)
  if (config.version !== 1) fail("version must be 1 (run `gateway setup` again with this release)")
  if (typeof config.rpId !== "string" || !(validDomain(config.rpId) || config.rpId === "localhost")) fail("rpId")
  let origin: URL
  try { origin = new URL(String(config.origin)) } catch { return fail("origin") }
  if (origin.origin !== config.origin || origin.hostname !== config.rpId || (origin.protocol !== "https:" && !(origin.protocol === "http:" && config.rpId === "localhost"))) fail("origin must be https://<rpId>")
  if (typeof config.name !== "string" || !/^[\w .-]{1,64}$/.test(config.name)) fail("name")
  const listen = config.listen as Record<string, unknown> | undefined
  if (!listen || typeof listen !== "object") fail("listen")
  else if ("unix" in listen) { if (typeof listen.unix !== "string" || !path.isAbsolute(listen.unix) || listen.unix.length > 100 || Object.keys(listen).length !== 1) fail("listen.unix") }
  else if (!Number.isInteger(listen.port) || (listen.port as number) < 1 || (listen.port as number) > 65535 || Object.keys(listen).length !== 1) fail("listen.port")
  if (config.clientIpHeader !== undefined && config.clientIpHeader !== "x-real-ip" && config.clientIpHeader !== "x-forwarded-for") fail("clientIpHeader")
  if (typeof config.runtimeRoot !== "string" || !path.isAbsolute(config.runtimeRoot) || config.runtimeRoot.length > 60) fail("runtimeRoot")
  return config as unknown as GatewayConfig
}

export function readGatewayConfig(stateDir: string): GatewayConfig {
  let text: string
  try { text = readFileSync(path.join(stateDir, GATEWAY_CONFIG_FILE), "utf8") } catch { throw new Error(`[GATEWAY]: ${path.join(stateDir, GATEWAY_CONFIG_FILE)} is missing; run \`gateway setup\` first`) }
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new TypeError("[GATEWAY]: invalid gateway.json: not JSON") }
  return parseGatewayConfig(value)
}
