import { chownSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import path from "node:path"
import type { StoredPasskey } from "./webauthn"

/**
 * The gateway's durable state: accounts, their passkeys and paired devices, and pending invites. No secret is kept:
 * passkeys and devices are public keys, invites are SHA-256 hashes of their codes. One file, rewritten whole under an
 * exclusive lock by whoever changes it (the running gateway or a `gateway` admin command), read again when it changes.
 */
export type Scope = "full" | "read-only"
export type Passkey = StoredPasskey & { createdAt: number; lastUsedAt?: number }
export type Device = { id: string; name: string; publicKey: string; scope: Scope; createdAt: number; lastUsedAt?: number; revokedAt?: number }
export type Account = { id: string; name: string; role: "admin" | "user"; status: "invited" | "active" | "disabled"; createdAt: number; passkeys: Passkey[]; devices: Device[] }
export type Invite = { hash: string; accountId: string; createdAt: number; expiresAt: number }
export type GatewayState = { version: 1; accounts: Account[]; invites: Invite[] }

export const STATE_FILE = "accounts.json"
export const ACCOUNT_ID = /^[0-9a-z]{10}$/
export const ACCOUNT_NAME = /^[\w .@+-]{1,64}$/
const LIMITS = { accounts: 1000, passkeys: 16, devices: 32, invites: 1000 }

const empty = (): GatewayState => ({ version: 1, accounts: [], invites: [] })

function validState(value: unknown): value is GatewayState {
  const state = value as GatewayState
  if (!state || state.version !== 1 || !Array.isArray(state.accounts) || !Array.isArray(state.invites) || state.accounts.length > LIMITS.accounts || state.invites.length > LIMITS.invites) return false
  for (const account of state.accounts) {
    if (!account || !ACCOUNT_ID.test(account.id) || !ACCOUNT_NAME.test(account.name) || !["admin", "user"].includes(account.role) || !["invited", "active", "disabled"].includes(account.status)) return false
    if (!Array.isArray(account.passkeys) || !Array.isArray(account.devices) || account.passkeys.length > LIMITS.passkeys || account.devices.length > LIMITS.devices) return false
    if (account.passkeys.some((key) => typeof key.id !== "string" || !key.publicKey || ![-7, -8, -257].includes(key.alg) || !Number.isInteger(key.counter))) return false
    if (account.devices.some((device) => typeof device.id !== "string" || typeof device.publicKey !== "string" || !["full", "read-only"].includes(device.scope))) return false
  }
  return state.invites.every((invite) => /^[a-f0-9]{64}$/.test(invite.hash) && ACCOUNT_ID.test(invite.accountId) && Number.isFinite(invite.expiresAt))
}

/** A short synchronous wait for the lock (admin commands and the gateway rarely overlap; a change takes milliseconds). */
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** The Unix owner the gateway runs as: an admin command run as root hands every file it writes to that user. */
export type FileOwner = { uid: number; gid: number }

export function gatewayState(dir: string, now = Date.now, owner?: FileOwner) {
  const file = path.join(dir, STATE_FILE)
  let cached: { key: string; state: GatewayState } | undefined
  function load(): GatewayState {
    let stat: ReturnType<typeof statSync>
    try { stat = statSync(file) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty()
      throw new Error("[GATEWAY]: state unreadable")
    }
    const key = `${stat.mtimeMs}:${stat.size}:${stat.ino}`
    if (cached?.key === key) return cached.state
    let value: unknown
    try { value = JSON.parse(readFileSync(file, "utf8")) } catch { throw new Error("[GATEWAY]: state is not valid JSON") }
    if (!validState(value)) throw new Error("[GATEWAY]: state has an unexpected shape")
    cached = { key, state: value }
    return value
  }
  return {
    file,
    /** The current state; callers must not change it (use `update`). */
    read: (): GatewayState => load(),
    update<T>(change: (state: GatewayState) => T): T {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const lock = `${file}.lock`
      let fd: number | undefined
      for (let attempt = 0; fd === undefined; attempt++) {
        try { fd = openSync(lock, "wx", 0o600) } catch {
          // A lock left by a crashed writer is broken after 30 s; anything newer is waited for, up to 3 s.
          try { if (now() - statSync(lock).mtimeMs > 30_000) unlinkSync(lock) } catch {}
          if (attempt >= 60) throw new Error("[GATEWAY]: state is busy; try again")
          pause(50)
        }
      }
      try {
        cached = undefined
        const state = structuredClone(load())
        const result = change(state)
        if (!validState(state)) throw new Error("[GATEWAY]: refusing to write an invalid state")
        const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`
        try {
          writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" })
          if (owner) chownSync(temp, owner.uid, owner.gid)
          renameSync(temp, file)
        } finally { try { unlinkSync(temp) } catch {} }
        cached = undefined
        return result
      } finally {
        closeSync(fd)
        try { unlinkSync(lock) } catch {}
      }
    },
  }
}
export type GatewayStore = ReturnType<typeof gatewayState>
