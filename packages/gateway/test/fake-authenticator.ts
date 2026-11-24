import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto"

/**
 * A software passkey for tests: it builds the exact bytes a browser and platform authenticator would send (CBOR
 * attestation object, authenticator data, client data JSON) and signs with a real ES256 or Ed25519 key, so the
 * gateway's verifier runs on real cryptography. Each field can be bent to exercise one failure path.
 */
type Cbor = number | string | Uint8Array | boolean | null | Cbor[] | Map<number | string, Cbor>

function head(major: number, value: number) {
  if (value < 24) return Buffer.from([(major << 5) | value])
  if (value < 256) return Buffer.from([(major << 5) | 24, value])
  if (value < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(value, 1); return b }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(value, 1); return b
}
export function encodeCbor(value: Cbor): Buffer {
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value)
  if (typeof value === "string") { const bytes = Buffer.from(value, "utf8"); return Buffer.concat([head(3, bytes.byteLength), bytes]) }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.byteLength), value])
  if (value === false) return Buffer.from([0xf4])
  if (value === true) return Buffer.from([0xf5])
  if (value === null) return Buffer.from([0xf6])
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(encodeCbor)])
  return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [encodeCbor(k), encodeCbor(v)])])
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url")
const sha = (data: Uint8Array | string) => createHash("sha256").update(data).digest()

export type Bend = { type?: string; origin?: string; challenge?: string; crossOrigin?: boolean; rpId?: string; flags?: number; counter?: number; fmt?: string; userHandle?: string; signWith?: KeyObject; tamper?: boolean }

export function fakeAuthenticator(input: { alg?: -7 | -8; userId: Uint8Array; rpId: string; origin: string }) {
  const alg = input.alg ?? -7
  const pair = alg === -7 ? generateKeyPairSync("ec", { namedCurve: "P-256" }) : generateKeyPairSync("ed25519")
  const credentialId = randomBytes(32)
  let counter = 0
  const jwk = pair.publicKey.export({ format: "jwk" }) as { x: string; y?: string }
  const cose = alg === -7
    ? new Map<number, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]])
    : new Map<number, Cbor>([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(jwk.x, "base64url")]])
  function clientData(type: string, challenge: string, bend: Bend) {
    return Buffer.from(JSON.stringify({ type: bend.type ?? type, challenge: bend.challenge ?? challenge, origin: bend.origin ?? input.origin, ...(bend.crossOrigin !== undefined ? { crossOrigin: bend.crossOrigin } : {}) }))
  }
  function authData(bend: Bend, attested: boolean) {
    const count = Buffer.alloc(4)
    count.writeUInt32BE(bend.counter ?? counter)
    const flags = bend.flags ?? (0x01 | 0x04 | (attested ? 0x40 : 0))
    const parts: Uint8Array[] = [sha(bend.rpId ?? input.rpId), Buffer.from([flags]), count]
    if (attested) {
      const length = Buffer.alloc(2)
      length.writeUInt16BE(credentialId.byteLength)
      parts.push(Buffer.alloc(16), length, credentialId, encodeCbor(cose))
    }
    return Buffer.concat(parts)
  }
  return {
    id: b64(credentialId),
    /** What `navigator.credentials.create()` gives, as the page sends it. */
    create(options: { challenge: string }, bend: Bend = {}) {
      const attestationObject = encodeCbor(new Map<string, Cbor>([["fmt", bend.fmt ?? "none"], ["attStmt", new Map()], ["authData", authData(bend, true)]]))
      return { id: b64(credentialId), rawId: b64(credentialId), type: "public-key", response: { clientDataJSON: b64(clientData("webauthn.create", options.challenge, bend)), attestationObject: b64(attestationObject) } }
    },
    /** What `navigator.credentials.get()` gives; the counter rises by one each time unless bent. */
    get(options: { challenge: string }, bend: Bend = {}) {
      if (bend.counter === undefined) counter++
      const data = authData(bend, false)
      const client = clientData("webauthn.get", options.challenge, bend)
      const signed = Buffer.concat([data, sha(client)])
      let signature = alg === -7 ? sign("sha256", signed, bend.signWith ?? pair.privateKey) : sign(null, signed, bend.signWith ?? pair.privateKey)
      if (bend.tamper) { const bent = Buffer.from(signature); bent[bent.length - 1]! ^= 1; signature = bent as typeof signature }
      return { id: b64(credentialId), rawId: b64(credentialId), type: "public-key", response: { clientDataJSON: b64(client), authenticatorData: b64(data), signature: b64(signature), userHandle: bend.userHandle ?? b64(input.userId) } }
    },
    get counter() { return counter },
  }
}
