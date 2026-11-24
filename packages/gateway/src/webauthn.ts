import { constants, createPublicKey, verify } from "node:crypto"
import { fromB64url, sameBytes, sha256, toB64url } from "./bytes"
import { decodeCbor, decodeCborExact, type CborValue } from "./cbor"

/**
 * Passkey (WebAuthn Level 2/3) ceremonies, verified step by step as the specification lists them (§7.1 registration,
 * §7.2 authentication). Every signature check is node:crypto's; this file only parses and compares. Attestation is
 * requested as "none" and only "none" is accepted: the gateway trusts the passkey a signed-in admin invited, not a vendor.
 */
export type RelyingParty = { id: string; origin: string; name: string }
export type PasskeyAlgorithm = -7 | -8 | -257
export type StoredPasskey = { id: string; publicKey: JsonWebKey; alg: PasskeyAlgorithm; counter: number }
export type WebAuthnFailure =
  | "malformed" | "type" | "challenge" | "origin" | "cross_origin" | "rp_id" | "user_present" | "user_verified"
  | "flags" | "attestation" | "credential" | "algorithm" | "signature" | "counter" | "user_handle"
export type Verified<T> = ({ ok: true } & T) | { ok: false; reason: WebAuthnFailure }

/** ES256 first (every platform authenticator), then Ed25519 and RS256 (Windows Hello). */
export const PASSKEY_ALGORITHMS: PasskeyAlgorithm[] = [-7, -8, -257]
const FLAG = { up: 0x01, uv: 0x04, be: 0x08, bs: 0x10, at: 0x40, ed: 0x80 } as const
const TIMEOUT_MS = 300_000

export function registrationOptions(input: { rp: RelyingParty; userId: Uint8Array; userName: string; challenge: Uint8Array; exclude: string[] }) {
  return {
    rp: { id: input.rp.id, name: input.rp.name },
    user: { id: toB64url(input.userId), name: input.userName, displayName: input.userName },
    challenge: toB64url(input.challenge),
    pubKeyCredParams: PASSKEY_ALGORITHMS.map((alg) => ({ type: "public-key", alg })),
    timeout: TIMEOUT_MS,
    attestation: "none",
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
    excludeCredentials: input.exclude.map((id) => ({ type: "public-key", id })),
  }
}

export function authenticationOptions(input: { rp: RelyingParty; challenge: Uint8Array; allow?: string[] }) {
  return { challenge: toB64url(input.challenge), rpId: input.rp.id, timeout: TIMEOUT_MS, userVerification: "required", allowCredentials: (input.allow ?? []).map((id) => ({ type: "public-key", id })) }
}

type ClientData = { type: string; challenge: string; origin: string; crossOrigin?: boolean; topOrigin?: string }

function clientData(encoded: unknown): { json: Buffer; data: ClientData } | undefined {
  const json = fromB64url(encoded, 4096)
  if (!json) return undefined
  try {
    const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(json)) as ClientData
    if (!data || typeof data.type !== "string" || typeof data.challenge !== "string" || typeof data.origin !== "string") return undefined
    return { json, data }
  } catch { return undefined }
}

/** Steps shared by both ceremonies: type, challenge, origin and the cross-origin flags of the client data. */
function checkClientData(data: ClientData, input: { type: string; challenge: Uint8Array; rp: RelyingParty }): WebAuthnFailure | undefined {
  if (data.type !== input.type) return "type"
  const challenge = fromB64url(data.challenge, 1024)
  if (!challenge || !sameBytes(challenge, input.challenge)) return "challenge"
  if (data.origin !== input.rp.origin) return "origin"
  if (data.crossOrigin === true || data.topOrigin !== undefined) return "cross_origin"
  return undefined
}

type AuthData = { rpIdHash: Buffer; flags: number; counter: number; credentialId?: Buffer; publicKey?: CborValue }

function parseAuthData(bytes: Buffer): AuthData {
  if (bytes.byteLength < 37) throw new RangeError("[WEBAUTHN]: authenticator data too short")
  const flags = bytes[32]!
  const counter = bytes.readUInt32BE(33)
  let at = 37
  let credentialId: Buffer | undefined
  let publicKey: CborValue | undefined
  if (flags & FLAG.at) {
    if (bytes.byteLength < at + 18) throw new RangeError("[WEBAUTHN]: attested credential data truncated")
    at += 16 // AAGUID: not used, attestation is "none".
    const length = bytes.readUInt16BE(at)
    at += 2
    if (length < 16 || length > 1023 || bytes.byteLength < at + length) throw new RangeError("[WEBAUTHN]: credential id length")
    credentialId = bytes.subarray(at, at + length)
    at += length
    const key = decodeCbor(bytes, at)
    publicKey = key.value
    at = key.end
  }
  if (flags & FLAG.ed) at = decodeCbor(bytes, at).end
  if (at !== bytes.byteLength) throw new RangeError("[WEBAUTHN]: trailing authenticator data")
  return { rpIdHash: bytes.subarray(0, 32), flags, counter, ...(credentialId ? { credentialId } : {}), ...(publicKey !== undefined ? { publicKey } : {}) }
}

function checkAuthData(auth: AuthData, rp: RelyingParty): WebAuthnFailure | undefined {
  if (!sameBytes(auth.rpIdHash, sha256(rp.id))) return "rp_id"
  if (!(auth.flags & FLAG.up)) return "user_present"
  if (!(auth.flags & FLAG.uv)) return "user_verified"
  if (auth.flags & FLAG.bs && !(auth.flags & FLAG.be)) return "flags"
  return undefined
}

const bytesOf = (map: Map<number | string, CborValue>, key: number, length?: number) => {
  const value = map.get(key)
  if (!(value instanceof Uint8Array) || (length !== undefined && value.byteLength !== length)) throw new TypeError("[WEBAUTHN]: COSE key field")
  return toB64url(value)
}

/** A COSE_Key (RFC 9053) as a JWK; the key is then imported once so an invalid point or modulus fails here. */
export function coseToJwk(value: CborValue | undefined): { jwk: JsonWebKey; alg: PasskeyAlgorithm } | undefined {
  if (!(value instanceof Map)) return undefined
  try {
    const kty = value.get(1), alg = value.get(3), crv = value.get(-1)
    let jwk: JsonWebKey
    if (kty === 2 && alg === -7 && crv === 1) jwk = { kty: "EC", crv: "P-256", x: bytesOf(value, -2, 32), y: bytesOf(value, -3, 32) }
    else if (kty === 1 && alg === -8 && crv === 6) jwk = { kty: "OKP", crv: "Ed25519", x: bytesOf(value, -2, 32) }
    else if (kty === 3 && alg === -257) {
      const n = value.get(-1)
      if (!(n instanceof Uint8Array) || n.byteLength < 256 || n.byteLength > 1024) return undefined
      jwk = { kty: "RSA", n: toB64url(n), e: bytesOf(value, -2) }
    } else return undefined
    createPublicKey({ key: jwk, format: "jwk" })
    return { jwk, alg: alg as PasskeyAlgorithm }
  } catch { return undefined }
}

export function verifySignature(input: { publicKey: JsonWebKey; alg: PasskeyAlgorithm; data: Buffer; signature: Buffer }) {
  try {
    const key = createPublicKey({ key: input.publicKey, format: "jwk" })
    if (input.alg === -8) return verify(null, input.data, key, input.signature)
    if (input.alg === -257) return verify("sha256", input.data, { key, padding: constants.RSA_PKCS1_PADDING }, input.signature)
    return verify("sha256", input.data, { key, dsaEncoding: "der" }, input.signature)
  } catch { return false }
}

/** Registration (§7.1). `response` is the JSON a browser's PublicKeyCredential gives, with binary fields as base64url. */
export function verifyRegistration(input: { rp: RelyingParty; challenge: Uint8Array; response: unknown }): Verified<{ credential: StoredPasskey }> {
  const response = (input.response as { id?: unknown; type?: unknown; response?: { clientDataJSON?: unknown; attestationObject?: unknown } } | null)
  if (!response || response.type !== "public-key" || !response.response) return { ok: false, reason: "malformed" }
  const client = clientData(response.response.clientDataJSON)
  if (!client) return { ok: false, reason: "malformed" }
  const failure = checkClientData(client.data, { type: "webauthn.create", challenge: input.challenge, rp: input.rp })
  if (failure) return { ok: false, reason: failure }
  const attestation = fromB64url(response.response.attestationObject, 16 * 1024)
  if (!attestation) return { ok: false, reason: "malformed" }
  let auth: AuthData
  try {
    const object = decodeCborExact(attestation)
    if (!(object instanceof Map)) return { ok: false, reason: "malformed" }
    const statement = object.get("attStmt")
    if (object.get("fmt") !== "none" || !(statement instanceof Map) || statement.size !== 0) return { ok: false, reason: "attestation" }
    const authData = object.get("authData")
    if (!(authData instanceof Uint8Array)) return { ok: false, reason: "malformed" }
    auth = parseAuthData(Buffer.from(authData))
  } catch { return { ok: false, reason: "malformed" } }
  const authFailure = checkAuthData(auth, input.rp)
  if (authFailure) return { ok: false, reason: authFailure }
  if (!auth.credentialId || auth.publicKey === undefined) return { ok: false, reason: "credential" }
  const id = toB64url(auth.credentialId)
  if (typeof response.id !== "string" || response.id !== id) return { ok: false, reason: "credential" }
  const key = coseToJwk(auth.publicKey)
  if (!key) return { ok: false, reason: "algorithm" }
  return { ok: true, credential: { id, publicKey: key.jwk, alg: key.alg, counter: auth.counter } }
}

/** Authentication (§7.2) against one stored passkey. `userHandle`, when the authenticator sends it, must be the account's. */
export function verifyAuthentication(input: { rp: RelyingParty; challenge: Uint8Array; response: unknown; credential: StoredPasskey; userId: Uint8Array }): Verified<{ counter: number }> {
  const response = (input.response as { id?: unknown; type?: unknown; response?: { clientDataJSON?: unknown; authenticatorData?: unknown; signature?: unknown; userHandle?: unknown } } | null)
  if (!response || response.type !== "public-key" || !response.response) return { ok: false, reason: "malformed" }
  if (response.id !== input.credential.id) return { ok: false, reason: "credential" }
  const client = clientData(response.response.clientDataJSON)
  const authBytes = fromB64url(response.response.authenticatorData, 8 * 1024)
  const signature = fromB64url(response.response.signature, 1024)
  if (!client || !authBytes || !signature) return { ok: false, reason: "malformed" }
  if (response.response.userHandle !== undefined && response.response.userHandle !== null && response.response.userHandle !== "") {
    const handle = fromB64url(response.response.userHandle, 64)
    if (!handle || !sameBytes(handle, input.userId)) return { ok: false, reason: "user_handle" }
  }
  const failure = checkClientData(client.data, { type: "webauthn.get", challenge: input.challenge, rp: input.rp })
  if (failure) return { ok: false, reason: failure }
  let auth: AuthData
  try { auth = parseAuthData(authBytes) } catch { return { ok: false, reason: "malformed" } }
  const authFailure = checkAuthData(auth, input.rp)
  if (authFailure) return { ok: false, reason: authFailure }
  if (!verifySignature({ publicKey: input.credential.publicKey, alg: input.credential.alg, data: Buffer.concat([authBytes, sha256(client.json)]), signature })) return { ok: false, reason: "signature" }
  // §7.2 step 21: a counter that does not rise (when either side counts) means a cloned authenticator.
  if ((auth.counter > 0 || input.credential.counter > 0) && auth.counter <= input.credential.counter) return { ok: false, reason: "counter" }
  return { ok: true, counter: auth.counter }
}
