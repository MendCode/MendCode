import type { Database } from "bun:sqlite"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { SessionId } from "@mendcode/protocol"

const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
/** Distinct secrets one session keeps; past it a pasted secret is redacted instead of stored, so the list and the cache stay bounded. */
export const MAX_SECRETS_PER_SESSION = 256
/** A PEM private key is the longest thing the detectors produce (12 000 characters plus its armor). */
export const MAX_SECRET_CHARS = 16_384

export type SecretsErrorCode = "key_missing" | "key_invalid" | "key_mismatch" | "limit" | "too_long" | "unknown_session"

/** A secrets failure the caller can tell apart (a lost or wrong key file is not a bug in the data). */
export class SecretsError extends Error {
  constructor(
    readonly code: SecretsErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "SecretsError"
  }
}

export type StoredSecret = { n: number; kind: string; tail: string; createdAt: number }
export type SecretValue = { n: number; kind: string; value: string }

type Row = { n: number; kind: string; iv: Uint8Array; ciphertext: Uint8Array; tail: string; created_at: number }

/** The last characters kept for display; a short value shows fewer so the tail never gives away half of it. */
export function secretTail(value: string) {
  const chars = [...value]
  return chars.slice(chars.length >= 12 ? -4 : -2).join("")
}

/** Where the key lives: `<dataDir>/keys/secrets.key`, 32 random bytes, mode 0600 in a 0700 directory. */
export const secretsKeyPath = (dataDir: string) => path.join(dataDir, "keys", "secrets.key")

function seal(key: Buffer, value: string, aad: string) {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(Buffer.from(aad))
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
  return { iv, ciphertext: Buffer.concat([body, cipher.getAuthTag()]) }
}

function open(key: Buffer, row: { iv: Uint8Array; ciphertext: Uint8Array }, aad: string): string {
  const bytes = Buffer.from(row.ciphertext)
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(row.iv))
  decipher.setAAD(Buffer.from(aad))
  decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES))
  return Buffer.concat([decipher.update(bytes.subarray(0, bytes.length - TAG_BYTES)), decipher.final()]).toString("utf8")
}

const aadOf = (sessionId: string, n: number) => `${sessionId}:${n}`
/** A forgotten secret keeps its row with nothing in it, so its number is never given to another value. */
const isForgotten = (row: { ciphertext: Uint8Array }) => row.ciphertext.byteLength === 0

/**
 * Secrets the user pasted, encrypted at rest with AES-256-GCM. The key is a file next to the database and never
 * inside it; it is created the first time a secret is stored and never replaced while encrypted rows exist. The
 * row's session and number are authenticated data, so rows cannot be moved between sessions.
 */
export function createSecrets({ db, dir, now }: { db: Database; dir: string; now: () => number }) {
  const keyFile = secretsKeyPath(dir)
  let cachedKey: Buffer | undefined

  const hasEncryptedRows = () => db.query("SELECT 1 FROM secrets WHERE length(ciphertext) > 0 LIMIT 1").get() !== null

  function loadKey(): Buffer {
    if (cachedKey) return cachedKey
    if (existsSync(keyFile)) {
      const bytes = readFileSync(keyFile)
      if (bytes.length !== KEY_BYTES) throw new SecretsError("key_invalid", `[SECRETS]: ${keyFile} holds ${bytes.length} bytes, not ${KEY_BYTES}; restore the original key file, stored secrets cannot be read without it`)
      // A key someone else can read protects nothing.
      if ((statSync(keyFile).mode & 0o077) !== 0) chmodSync(keyFile, 0o600)
      return (cachedKey = bytes)
    }
    if (hasEncryptedRows()) throw new SecretsError("key_missing", `[SECRETS]: ${keyFile} is missing but encrypted secrets exist; restore the key file (a new key would make them unreadable)`)
    const folder = path.dirname(keyFile)
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    chmodSync(folder, 0o700)
    const fresh = randomBytes(KEY_BYTES)
    writeFileSync(keyFile, fresh, { mode: 0o600, flag: "wx" })
    chmodSync(keyFile, 0o600)
    return (cachedKey = fresh)
  }

  function decrypt(sessionId: string, row: Row): string {
    try {
      return open(loadKey(), row, aadOf(sessionId, row.n))
    } catch (error) {
      if (error instanceof SecretsError) throw error
      throw new SecretsError("key_mismatch", `[SECRETS]: secret ${row.n} of ${sessionId} does not decrypt with ${keyFile}; the key file is not the one that encrypted it`)
    }
  }

  const rowsOf = (sessionId: string) => db.query<Row, [string]>("SELECT n, kind, iv, ciphertext, tail, created_at FROM secrets WHERE session_id = ? ORDER BY n").all(sessionId)
  const insert = db.query("INSERT INTO secrets(session_id, n, kind, iv, ciphertext, tail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")

  function valuesOf(sessionId: SessionId): SecretValue[] {
    return rowsOf(sessionId)
      .filter((row) => !isForgotten(row))
      .map((row) => ({ n: row.n, kind: row.kind, value: decrypt(sessionId, row) }))
  }

  return {
    /**
     * Stores `value` for the session and returns its number; the same value in the same session is the same number.
     * Throws a SecretsError for a value over MAX_SECRET_CHARS, a session at MAX_SECRETS_PER_SESSION, an unknown
     * session, or a key file that is lost or wrong.
     */
    add(input: { sessionId: SessionId; kind: string; value: string }): { n: number; created: boolean } {
      if (input.value.length > MAX_SECRET_CHARS) throw new SecretsError("too_long", `[SECRETS]: a secret is limited to ${MAX_SECRET_CHARS} characters`)
      return db.transaction(() => {
        if (db.query("SELECT 1 FROM sessions WHERE id = ?").get(input.sessionId) === null) throw new SecretsError("unknown_session", `[SECRETS]: unknown session ${input.sessionId}`)
        const rows = rowsOf(input.sessionId)
        for (const row of rows) if (!isForgotten(row) && decrypt(input.sessionId, row) === input.value) return { n: row.n, created: false }
        if (rows.filter((row) => !isForgotten(row)).length >= MAX_SECRETS_PER_SESSION) throw new SecretsError("limit", `[SECRETS]: a session keeps at most ${MAX_SECRETS_PER_SESSION} secrets`)
        const n = (rows.at(-1)?.n ?? 0) + 1
        const sealed = seal(loadKey(), input.value, aadOf(input.sessionId, n))
        insert.run(input.sessionId, n, input.kind.slice(0, 64), sealed.iv, sealed.ciphertext, secretTail(input.value), now())
        return { n, created: true }
      })()
    },
    /** Marker number, kind, tail and time of each live secret; needs no key. */
    list(sessionId: SessionId): StoredSecret[] {
      return rowsOf(sessionId)
        .filter((row) => !isForgotten(row))
        .map((row) => ({ n: row.n, kind: row.kind, tail: row.tail, createdAt: row.created_at }))
    },
    /** Every live secret of the session, decrypted. Throws a SecretsError when the key file is lost or wrong. */
    values: valuesOf,
    reveal(sessionId: SessionId, n: number): string | undefined {
      const row = rowsOf(sessionId).find((entry) => entry.n === n && !isForgotten(entry))
      return row ? decrypt(sessionId, row) : undefined
    },
    /** Erases one value (its number stays taken). False when the session has no such secret. */
    forget(sessionId: SessionId, n: number): boolean {
      return db.query("UPDATE secrets SET iv = x'', ciphertext = x'', tail = '' WHERE session_id = ? AND n = ? AND length(ciphertext) > 0").run(sessionId, n).changes > 0
    },
    /** A fork keeps the same numbers: every row is re-encrypted for the new session. Returns how many live secrets came along. */
    copy(from: SessionId, to: SessionId): number {
      let copied = 0
      for (const row of rowsOf(from)) {
        if (isForgotten(row)) {
          insert.run(to, row.n, row.kind, row.iv, row.ciphertext, row.tail, row.created_at)
          continue
        }
        const sealed = seal(loadKey(), decrypt(from, row), aadOf(to, row.n))
        insert.run(to, row.n, row.kind, sealed.iv, sealed.ciphertext, row.tail, row.created_at)
        copied++
      }
      return copied
    },
  }
}
export type SecretsStore = ReturnType<typeof createSecrets>
