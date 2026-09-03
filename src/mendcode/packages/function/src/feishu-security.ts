import { createHash, timingSafeEqual } from "node:crypto"

export const FEISHU_REQUEST_MAX_AGE_SECONDS = 300

function constantTimeEqual(left: string, right: string) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function verifyFeishuRequest(input: {
  body: string
  timestamp?: string
  nonce?: string
  signature?: string
  encryptKey: string
  now?: number
}) {
  if (!input.timestamp || !input.nonce || !input.signature || !input.encryptKey) return false
  if (!/^\d+$/.test(input.timestamp) || !/^[a-f0-9]{64}$/i.test(input.signature)) return false

  const now = Math.floor((input.now ?? Date.now()) / 1_000)
  const timestamp = Number(input.timestamp)
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > FEISHU_REQUEST_MAX_AGE_SECONDS) return false

  const expected = createHash("sha256")
    .update(input.timestamp + input.nonce + input.encryptKey + input.body)
    .digest("hex")
  return constantTimeEqual(expected, input.signature.toLowerCase())
}

export function verifyFeishuToken(body: unknown, verificationToken: string) {
  if (!verificationToken || !body || typeof body !== "object") return false
  const record = body as { token?: unknown; header?: { token?: unknown } }
  const token = typeof record.header?.token === "string" ? record.header.token : record.token
  return typeof token === "string" && constantTimeEqual(token, verificationToken)
}
