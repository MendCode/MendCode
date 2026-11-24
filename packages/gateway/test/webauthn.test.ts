import { describe, expect, test } from "bun:test"
import { generateKeyPairSync, randomBytes } from "node:crypto"
import { decodeCborExact } from "../src/cbor"
import { verifyAuthentication, verifyRegistration, type StoredPasskey } from "../src/webauthn"
import { encodeCbor, fakeAuthenticator } from "./fake-authenticator"

const rp = { id: "code.example.test", origin: "https://code.example.test", name: "MendCode" }
const userId = Buffer.from("a1b2c3d4e5")
const challengeOf = () => randomBytes(32)
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url")

function registered(alg: -7 | -8 = -7) {
  const authenticator = fakeAuthenticator({ alg, userId, rpId: rp.id, origin: rp.origin })
  const challenge = challengeOf()
  const result = verifyRegistration({ rp, challenge, response: authenticator.create({ challenge: b64(challenge) }) })
  if (!result.ok) throw new Error(result.reason)
  return { authenticator, credential: result.credential as StoredPasskey }
}

describe("passkey registration (WebAuthn §7.1)", () => {
  test("a real ES256 and a real Ed25519 passkey register with attestation none", () => {
    expect(registered(-7).credential.alg).toBe(-7)
    expect(registered(-8).credential.alg).toBe(-8)
  })
  const failures: [string, Parameters<ReturnType<typeof fakeAuthenticator>["create"]>[1], string][] = [
    ["a get assertion offered as a registration", { type: "webauthn.get" }, "type"],
    ["another challenge (a replay of an older ceremony)", { challenge: b64(randomBytes(32)) }, "challenge"],
    ["a page on another origin", { origin: "https://evil.example.test" }, "origin"],
    ["an origin that differs only by scheme", { origin: "http://code.example.test" }, "origin"],
    ["a cross-origin iframe", { crossOrigin: true }, "cross_origin"],
    ["another relying party id", { rpId: "example.test" }, "rp_id"],
    ["no user presence", { flags: 0x04 | 0x40 }, "user_present"],
    ["no user verification (no PIN or biometric)", { flags: 0x01 | 0x40 }, "user_verified"],
    ["backup state without backup eligibility", { flags: 0x01 | 0x04 | 0x10 | 0x40 }, "flags"],
    ["a vendor attestation format", { fmt: "packed" }, "attestation"],
  ]
  for (const [name, bend, reason] of failures) test(`refuses ${name}`, () => {
    const authenticator = fakeAuthenticator({ userId, rpId: rp.id, origin: rp.origin })
    const challenge = challengeOf()
    const result = verifyRegistration({ rp, challenge, response: authenticator.create({ challenge: b64(challenge) }, bend) })
    expect(result).toEqual({ ok: false, reason: reason as never })
  })
  test("refuses malformed input without throwing", () => {
    const challenge = challengeOf()
    for (const response of [null, {}, { type: "public-key", response: {} }, { type: "public-key", response: { clientDataJSON: "!!", attestationObject: "AA" } }]) expect(verifyRegistration({ rp, challenge, response }).ok).toBe(false)
  })
  test("refuses an attestation object with bytes after it, and a credential id that does not match", () => {
    const authenticator = fakeAuthenticator({ userId, rpId: rp.id, origin: rp.origin })
    const challenge = challengeOf()
    const response = authenticator.create({ challenge: b64(challenge) })
    const padded = { ...response, response: { ...response.response, attestationObject: b64(Buffer.concat([Buffer.from(response.response.attestationObject, "base64url"), Buffer.from([0])])) } }
    expect(verifyRegistration({ rp, challenge, response: padded })).toEqual({ ok: false, reason: "malformed" })
    expect(verifyRegistration({ rp, challenge, response: { ...response, id: b64(randomBytes(32)) } })).toEqual({ ok: false, reason: "credential" })
  })
})

describe("passkey sign-in (WebAuthn §7.2)", () => {
  test("a fresh assertion verifies and returns the rising counter", () => {
    const { authenticator, credential } = registered()
    const challenge = challengeOf()
    expect(verifyAuthentication({ rp, challenge, credential, userId, response: authenticator.get({ challenge: b64(challenge) }) })).toEqual({ ok: true, counter: 1 })
    const ed = registered(-8)
    const second = challengeOf()
    expect(verifyAuthentication({ rp, challenge: second, credential: ed.credential, userId, response: ed.authenticator.get({ challenge: b64(second) }) }).ok).toBe(true)
  })
  const failures: [string, Parameters<ReturnType<typeof fakeAuthenticator>["get"]>[1], string][] = [
    ["a registration offered as an assertion", { type: "webauthn.create" }, "type"],
    ["an assertion for another challenge (replay)", { challenge: b64(randomBytes(32)) }, "challenge"],
    ["a phishing origin", { origin: "https://code.example.test.evil.test" }, "origin"],
    ["another relying party id", { rpId: "evil.test" }, "rp_id"],
    ["no user verification", { flags: 0x01 }, "user_verified"],
    ["a signature by another key", { signWith: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey }, "signature"],
    ["a tampered signature", { tamper: true }, "signature"],
    ["a user handle of another account", { userHandle: b64(Buffer.from("zzzzzzzzzz")) }, "user_handle"],
  ]
  for (const [name, bend, reason] of failures) test(`refuses ${name}`, () => {
    const { authenticator, credential } = registered()
    const challenge = challengeOf()
    expect(verifyAuthentication({ rp, challenge, credential, userId, response: authenticator.get({ challenge: b64(challenge) }, bend) })).toEqual({ ok: false, reason: reason as never })
  })
  test("refuses a counter that does not rise (a cloned authenticator), after checking the signature", () => {
    const { authenticator, credential } = registered()
    const challenge = challengeOf()
    expect(verifyAuthentication({ rp, challenge, credential: { ...credential, counter: 5 }, userId, response: authenticator.get({ challenge: b64(challenge) }, { counter: 5 }) })).toEqual({ ok: false, reason: "counter" })
    expect(verifyAuthentication({ rp, challenge, credential: { ...credential, counter: 5 }, userId, response: authenticator.get({ challenge: b64(challenge) }, { counter: 4 }) })).toEqual({ ok: false, reason: "counter" })
    // An authenticator that never counts (synced passkeys report 0) is accepted while both sides stay at zero.
    expect(verifyAuthentication({ rp, challenge, credential, userId, response: authenticator.get({ challenge: b64(challenge) }, { counter: 0 }) }).ok).toBe(true)
  })
  test("refuses an assertion made by another credential", () => {
    const { credential } = registered()
    const other = registered()
    const challenge = challengeOf()
    expect(verifyAuthentication({ rp, challenge, credential, userId, response: other.authenticator.get({ challenge: b64(challenge) }) })).toEqual({ ok: false, reason: "credential" })
  })
})

describe("the CBOR subset", () => {
  test("decodes maps with integer keys and refuses tags, floats, indefinite lengths, duplicate keys and trailing bytes", () => {
    expect(decodeCborExact(encodeCbor(new Map<number, number>([[1, 2], [-1, 3]])))).toEqual(new Map([[1, 2], [-1, 3]]))
    for (const bad of [[0xc0, 0x00], [0xfb, 0, 0, 0, 0, 0, 0, 0, 0], [0x5f, 0xff], [0xa2, 0x01, 0x00, 0x01, 0x00], [0x00, 0x00], [0x5a, 0xff, 0xff, 0xff, 0xff]]) expect(() => decodeCborExact(Uint8Array.from(bad))).toThrow()
  })
  test("refuses nesting deeper than 8", () => {
    expect(() => decodeCborExact(Uint8Array.from([...Array(12).fill(0x81), 0x00]))).toThrow()
  })
})
