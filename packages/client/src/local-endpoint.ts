import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

/**
 * How a local client reaches its own daemon. Unix sockets are the default on macOS and Linux; Windows has no
 * reliable Bun listener for them, so the daemon listens on loopback TCP and publishes the port and a per-start
 * secret in `<dir>/mendd.endpoint`. Zod-free: the terminal client and launcher import it.
 */
export const LOCAL_ENDPOINT_FILE = "mendd.endpoint"
export const LOCAL_TRANSPORTS = ["unix", "tcp"] as const
export type LocalTransport = (typeof LOCAL_TRANSPORTS)[number]

export type LocalTcpEndpoint = { transport: "tcp"; hostname: "127.0.0.1"; port: number; token: string; pid: number }

/** `MENDCODE_V2_LOCAL_TRANSPORT=tcp|unix` wins; otherwise Windows uses tcp and everything else unix. */
export function defaultLocalTransport(platform: string = process.platform, env: Record<string, string | undefined> = process.env): LocalTransport {
  const chosen = env.MENDCODE_V2_LOCAL_TRANSPORT
  if (chosen === "tcp" || chosen === "unix") return chosen
  return platform === "win32" ? "tcp" : "unix"
}

export const localEndpointPath = (dir: string) => path.join(dir, LOCAL_ENDPOINT_FILE)

/** Strict parse: anything that is not a loopback endpoint with a usable port and secret is ignored. */
export function parseLocalEndpoint(text: string): LocalTcpEndpoint | undefined {
  let json: unknown
  try { json = JSON.parse(text) } catch { return undefined }
  if (typeof json !== "object" || json === null) return undefined
  const value = json as Record<string, unknown>
  if (value.transport !== "tcp" || value.hostname !== "127.0.0.1") return undefined
  if (typeof value.port !== "number" || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) return undefined
  if (typeof value.token !== "string" || value.token.length < 32 || value.token.length > 256) return undefined
  if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid < 1) return undefined
  return { transport: "tcp", hostname: "127.0.0.1", port: value.port, token: value.token, pid: value.pid }
}

export function readLocalEndpoint(dir: string): LocalTcpEndpoint | undefined {
  try { return parseLocalEndpoint(readFileSync(localEndpointPath(dir), "utf8")) } catch { return undefined }
}

/** Atomic and owner-only (mode 0600 where the OS honors it; on Windows the profile directory's ACL applies). */
export function writeLocalEndpoint(dir: string, endpoint: LocalTcpEndpoint) {
  const file = localEndpointPath(dir)
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(endpoint)}\n`, { mode: 0o600 })
  try { chmodSync(temporary, 0o600) } catch {}
  renameSync(temporary, file)
}

/** Removes the file only when it still holds this daemon's secret, so a newer daemon's endpoint survives. */
export function removeLocalEndpoint(dir: string, token: string) {
  const current = readLocalEndpoint(dir)
  if (current?.token === token && existsSync(localEndpointPath(dir))) rmSync(localEndpointPath(dir), { force: true })
}
