import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { FEISHU_REQUEST_MAX_AGE_SECONDS, verifyFeishuRequest, verifyFeishuToken } from "../src/feishu-security"

describe("Feishu webhook security", () => {
  test("accepts a fresh request with the official SHA-256 signature shape", () => {
    const now = 1_800_000_000_000
    const timestamp = String(now / 1_000)
    const nonce = "nonce"
    const encryptKey = "encrypt-key"
    const body = JSON.stringify({ schema: "2.0", header: { token: "verify" } })
    const signature = createHash("sha256").update(timestamp + nonce + encryptKey + body).digest("hex")

    expect(verifyFeishuRequest({ body, timestamp, nonce, signature, encryptKey, now })).toBe(true)
    expect(verifyFeishuToken(JSON.parse(body), "verify")).toBe(true)
  })

  test("rejects stale, malformed, and tampered requests", () => {
    const now = 1_800_000_000_000
    const timestamp = String(now / 1_000 - FEISHU_REQUEST_MAX_AGE_SECONDS - 1)
    expect(
      verifyFeishuRequest({
        body: "{}",
        timestamp,
        nonce: "nonce",
        signature: "0".repeat(64),
        encryptKey: "encrypt-key",
        now,
      }),
    ).toBe(false)
    expect(
      verifyFeishuRequest({
        body: "{}",
        timestamp: String(now / 1_000),
        nonce: "nonce",
        signature: "not-hex",
        encryptKey: "encrypt-key",
        now,
      }),
    ).toBe(false)
    expect(verifyFeishuToken({ header: { token: "wrong" } }, "verify")).toBe(false)
  })
})
