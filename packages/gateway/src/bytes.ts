import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

/** base64url without padding, the encoding WebAuthn and the gateway's wire use for every binary value. */
export const toB64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url")

/** Strict decode: only the base64url alphabet, bounded length; anything else is `undefined`, never a partial value. */
export function fromB64url(text: unknown, maxBytes = 64 * 1024): Buffer | undefined {
  if (typeof text !== "string" || text.length === 0 || text.length > Math.ceil(maxBytes * 4 / 3) + 4 || !/^[A-Za-z0-9_-]+={0,2}$/.test(text)) return undefined
  const bytes = Buffer.from(text, "base64url")
  return bytes.byteLength > maxBytes ? undefined : bytes
}

export const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest()

/** Hex SHA-256: how secrets are kept (codes, tokens, session ids). The value itself is never stored. */
export const digest = (secret: string) => sha256(secret).toString("hex")

/** Constant-time equality that is false (not a throw) for different lengths. */
export function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.byteLength !== b.byteLength) return false
  return timingSafeEqual(a, b)
}

/** Constant-time comparison of two strings by their SHA-256, so length differences take no shortcut either. */
export const sameSecret = (a: string, b: string) => timingSafeEqual(sha256(a), sha256(b))

/** A fresh secret: 32 random bytes as base64url (256 bits). */
export const secret = (bytes = 32) => randomBytes(bytes).toString("base64url")

/** Crockford base32 without I, L, O, U: what people read aloud and type (device codes, account ids). */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
export function readableCode(length: number) {
  const out: string[] = []
  // Rejection sampling keeps every symbol equally likely (256 is a multiple of 32, so no byte is rejected).
  for (const byte of randomBytes(length)) out.push(CROCKFORD[byte % 32]!)
  return out.join("")
}

/** Normalizes what a person typed for a readable code: case, spaces, dashes and the look-alike letters. */
export const normalizeCode = (text: string) => text.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0")
