import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { parseRemoteAddress } from "@mendcode/protocol/wire"
import type { PathRule } from "../project-identity"

/** `<data dir>/sync.json` (0600): this machine syncs with a saved remote. Its absence keeps sync off and unloaded. */
export const SYNC_FILE = "sync.json"
/** Written by a daemon the first time a device syncs with it, so a restarted hub keeps honoring the leases it gave. */
export const SYNC_HUB_FILE = "sync-hub.json"

export type SyncConfig = { remote: string; tokenFile: string; pathMap: PathRule[]; memories: boolean; settings: boolean }
export type SyncTarget = { hostname: string; port: number; tls: boolean; token: string; ca?: string }

const fail = (why: string): never => { throw new Error(`[SYNC]: invalid ${SYNC_FILE}: ${why}`) }

export function parseSyncConfig(text: string): SyncConfig {
  let value: unknown
  try { value = JSON.parse(text) } catch { return fail("not JSON") }
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("not an object")
  const entry = value as Record<string, unknown>
  if (Object.keys(entry).some((key) => !["remote", "tokenFile", "pathMap", "memories", "settings"].includes(key))) fail("unknown key")
  if (typeof entry.remote !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(entry.remote)) fail("remote must name a saved remote")
  if (typeof entry.tokenFile !== "string" || !path.isAbsolute(entry.tokenFile)) fail("tokenFile must be an absolute path")
  const rules = entry.pathMap ?? []
  if (!Array.isArray(rules) || rules.length > 64 || rules.some((rule) => !rule || typeof rule.from !== "string" || typeof rule.to !== "string" || !rule.from.startsWith("/") || !rule.to.startsWith("/"))) fail("pathMap must be a list of {from, to} absolute paths")
  for (const key of ["memories", "settings"]) if (entry[key] !== undefined && typeof entry[key] !== "boolean") fail(`${key} must be true or false`)
  return { remote: entry.remote as string, tokenFile: entry.tokenFile as string, pathMap: (rules as PathRule[]).map((rule) => ({ from: rule.from, to: rule.to })), memories: entry.memories !== false, settings: entry.settings !== false }
}

export function readSyncConfig(dir: string): SyncConfig | undefined {
  let text: string
  try { text = readFileSync(path.join(dir, SYNC_FILE), "utf8") } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw new Error(`[SYNC]: cannot read ${SYNC_FILE}`)
  }
  return parseSyncConfig(text)
}

export function writeSyncConfig(dir: string, config: SyncConfig | undefined) {
  const file = path.join(dir, SYNC_FILE)
  if (!config) return rmSync(file, { force: true })
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, file)
}

/** The hub to reach: the saved remote's address and CA (remotes.json), with the sync token. The token never leaves this function's caller. */
export function syncTarget(dir: string, config: SyncConfig): SyncTarget {
  let profiles: { remotes?: Record<string, { connect?: string; ca?: string; tls?: boolean }> }
  try { profiles = JSON.parse(readFileSync(path.join(dir, "remotes.json"), "utf8")) } catch { throw new Error(`[SYNC]: the saved remote ${config.remote} is missing (remotes.json)`) }
  const profile = profiles.remotes?.[config.remote]
  if (!profile?.connect) throw new Error(`[SYNC]: the saved remote ${config.remote} is missing (remotes.json)`)
  const address = parseRemoteAddress(profile.connect)
  let token: string
  let ca: string | undefined
  try {
    token = readFileSync(config.tokenFile, "utf8").trim()
    ca = profile.ca ? readFileSync(profile.ca, "utf8") : undefined
  } catch { throw new Error("[SYNC]: cannot read the sync token file or the remote's CA") }
  if (!token || token.length > 4096) throw new Error("[SYNC]: the sync token file is empty")
  const loopback = address.hostname === "127.0.0.1" || address.hostname === "::1"
  return { hostname: address.hostname, port: address.port, tls: profile.tls === true || Boolean(ca) || !loopback, token, ...(ca ? { ca } : {}) }
}

export const syncConfigured = (dir: string) => existsSync(path.join(dir, SYNC_FILE)) || existsSync(path.join(dir, SYNC_HUB_FILE))
export const markHub = (dir: string) => {
  const file = path.join(dir, SYNC_HUB_FILE)
  if (!existsSync(file)) writeFileSync(file, `${JSON.stringify({ version: 1 })}\n`, { mode: 0o600 })
}
export const unmarkHub = (dir: string) => rmSync(path.join(dir, SYNC_HUB_FILE), { force: true })
