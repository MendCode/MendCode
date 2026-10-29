import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { isLoopbackHost, parseRemoteAddress } from "@mendcode/protocol/wire"

export const REMOTE_TOKENS_FILE = "remote-tokens.json"
export type RemoteTokenInfo = { name: string; readOnly: boolean; createdAt: number; lastUsedAt?: number }
type Entry = RemoteTokenInfo & { hash: string }
const hashToken = (token: string) => createHash("sha256").update(token).digest()

/** Tokens never enter settings, logs or command replies. Management is local, against an explicit data dir. */
export function remoteTokens(dir: string) {
  const file = path.join(dir, REMOTE_TOKENS_FILE)
  function read(): Entry[] {
    let text: string
    try { text = readFileSync(file, "utf8") } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw new Error("remote token store unreadable")
    }
    let entries: unknown
    try { entries = JSON.parse(text) } catch { throw new Error("invalid remote token store") }
    if (!Array.isArray(entries) || entries.length > 1000 || entries.some((e) => !e || typeof e.name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(e.name) || typeof e.readOnly !== "boolean" || !/^[a-f0-9]{64}$/.test(e.hash) || !Number.isFinite(e.createdAt) || (e.lastUsedAt !== undefined && !Number.isFinite(e.lastUsedAt)))) throw new Error("invalid remote token store")
    chmodSync(file, 0o600)
    return entries as Entry[]
  }
  function update<T>(run: (entries: Entry[]) => T): T {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const lock = `${file}.lock`
    let fd: number
    try { fd = openSync(lock, "wx", 0o600) } catch { throw new Error("remote token store busy") }
    try {
      const entries = read()
      const result = run(entries)
      const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`
      try {
        writeFileSync(temp, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600, flag: "wx" })
        renameSync(temp, file)
      } finally {
        try { unlinkSync(temp) } catch {}
      }
      return result
    } finally {
      closeSync(fd)
      unlinkSync(lock)
    }
  }
  const info = (entry: Entry): RemoteTokenInfo => ({ name: entry.name, readOnly: entry.readOnly, createdAt: entry.createdAt, ...(entry.lastUsedAt === undefined ? {} : { lastUsedAt: entry.lastUsedAt }) })
  return {
    create(input: { name?: string; readOnly?: boolean } = {}) {
      const name = input.name ?? `token-${randomBytes(4).toString("hex")}`
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error("token name must use letters, digits, _ or - (1–64)")
      const token = randomBytes(32).toString("base64url")
      return update((entries) => {
        if (entries.some((e) => e.name === name)) throw new Error("token name already exists")
        if (entries.length >= 1000) throw new Error("remote token limit reached")
        const entry: Entry = { name, readOnly: input.readOnly ?? false, createdAt: Date.now(), hash: hashToken(token).toString("hex") }
        entries.push(entry)
        return { token, ...info(entry) }
      })
    },
    list: () => read().map(info),
    revoke(name: string) {
      return update((entries) => {
        const index = entries.findIndex((e) => e.name === name)
        if (index < 0) throw new Error("unknown token name")
        entries.splice(index, 1)
      })
    },
    authenticate(token: string) {
      const digest = hashToken(token)
      return update((entries) => {
        let matched: Entry | undefined
        for (const entry of entries) if (timingSafeEqual(digest, Buffer.from(entry.hash, "hex"))) matched = entry
        if (!matched) return undefined
        matched.lastUsedAt = Date.now()
        return { ...matched }
      })
    },
    active(peer: { name: string; hash: string; readOnly: boolean }) {
      return read().some((e) => e.name === peer.name && e.hash === peer.hash && e.readOnly === peer.readOnly)
    },
  }
}

/** Backoff is address-scoped, bounded in memory, and successful authentication cannot erase failures. */
export function remoteBackoff(now = Date.now) {
  const failures = new Map<string, { count: number; until: number; expires: number }>()
  return {
    blocked(address: string) {
      const entry = failures.get(address)
      if (entry && now() >= entry.expires) failures.delete(address)
      return entry !== undefined && now() < entry.until
    },
    fail(address: string) {
      const time = now()
      for (const [key, entry] of failures) if (time >= entry.expires) failures.delete(key)
      const count = Math.min(8, (failures.get(address)?.count ?? 0) + 1)
      if (failures.size >= 4096 && !failures.has(address)) failures.delete(failures.keys().next().value!)
      failures.set(address, { count, until: time + Math.min(30_000, 250 * 2 ** (count - 1)), expires: time + 300_000 })
    },
  }
}

export type RemoteListenerOptions = { listen?: string; tlsCert?: string; tlsKey?: string }
/** `<dir>/remote.json` contains listener settings only; flags override it. Validate before opening the store. */
export function remoteListenerConfig(dir: string, flags: RemoteListenerOptions): RemoteListenerOptions {
  let config: RemoteListenerOptions = {}
  try {
    const value = JSON.parse(readFileSync(path.join(dir, "remote.json"), "utf8"))
    if (!value || typeof value !== "object" || Object.keys(value).some((key) => !["listen", "tlsCert", "tlsKey", "server"].includes(key)) || Object.entries(value).some(([key, v]) => key !== "server" && typeof v !== "string")) throw new Error("invalid remote.json")
    config = { ...(value.listen ? { listen: value.listen } : {}), ...(value.tlsCert ? { tlsCert: value.tlsCert } : {}), ...(value.tlsKey ? { tlsKey: value.tlsKey } : {}) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("invalid remote.json")
  }
  return { ...config, ...flags }
}

export function validateRemoteListener(options: RemoteListenerOptions) {
  if (!options.listen) {
    if (options.tlsCert || options.tlsKey) throw new Error("TLS listener needs --listen host:port")
    return undefined
  }
  const address = parseRemoteAddress(options.listen)
  if (Boolean(options.tlsCert) !== Boolean(options.tlsKey)) throw new Error("--tls-cert and --tls-key are required together")
  if (!isLoopbackHost(address.hostname) && (!options.tlsCert || !options.tlsKey)) throw new Error("non-loopback --listen requires --tls-cert and --tls-key")
  return { ...address, ...(options.tlsCert && options.tlsKey ? { tls: { cert: readFileSync(options.tlsCert), key: readFileSync(options.tlsKey) } } : {}) }
}
