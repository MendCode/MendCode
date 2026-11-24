import { createPublicKey, verify } from "node:crypto"
import { fromB64url } from "./bytes"

/**
 * A paired device proves itself with an Ed25519 key that never leaves it: the gateway issues a one-use challenge and
 * the device signs this exact text. The origin and device id inside the signed text bind a signature to one gateway
 * and one device, so it cannot be replayed against another site or as another device.
 */
export const DEVICE_SIGNATURE_CONTEXT = "mendcode-gateway-token-v1"
export const deviceSignedText = (input: { origin: string; deviceId: string; challenge: string }) => `${DEVICE_SIGNATURE_CONTEXT}\n${input.origin}\n${input.deviceId}\n${input.challenge}`

/** An Ed25519 public key as the 32 raw bytes in base64url; anything else is refused. */
export function validDevicePublicKey(value: unknown): value is string {
  const raw = fromB64url(value, 64)
  if (!raw || raw.byteLength !== 32) return false
  try { createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: value as string }, format: "jwk" }); return true } catch { return false }
}

export function verifyDeviceSignature(input: { publicKey: string; text: string; signature: unknown }) {
  const signature = fromB64url(input.signature, 128)
  if (!signature || signature.byteLength !== 64) return false
  try { return verify(null, Buffer.from(input.text, "utf8"), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: input.publicKey }, format: "jwk" }), signature) } catch { return false }
}
