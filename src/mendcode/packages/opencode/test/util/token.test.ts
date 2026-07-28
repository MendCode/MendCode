import { describe, expect, test } from "bun:test"
import { Token } from "../../src/util/token"

describe("token estimation", () => {
  test("omits binary media payloads from safe JSON estimates", () => {
    const small = Token.estimatePayload({ role: "user", content: [{ type: "file", data: new Uint8Array(200_000) }] })
    const inflated = Token.estimate(JSON.stringify({ role: "user", content: [{ type: "file", data: Object.fromEntries(new Uint8Array(200_000).entries()) }] }))

    expect(small).toBeLessThan(100)
    expect(inflated).toBeGreaterThan(500_000)
  })

  test("omits array buffers and views from safe JSON estimates", () => {
    expect(Token.estimatePayload({ data: new ArrayBuffer(200_000) })).toBeLessThan(100)
    expect(Token.estimatePayload({ data: new DataView(new ArrayBuffer(200_000)) })).toBeLessThan(100)
  })
})
