import { describe, expect, test } from "bun:test"
import { notifyTimeout } from "../src/orders/checkout-notify"
import { CHECKOUT_REQUEST_TIMEOUT_MS, checkoutTimeout, createCheckoutRequest } from "../src/payments/checkout-client"

describe("checkout client", () => {
  test("requests carry the configured timeout", () => {
    expect(createCheckoutRequest("cart_1")).toEqual({ cartId: "cart_1", timeoutMs: CHECKOUT_REQUEST_TIMEOUT_MS })
  })

  test("the timeout error names the limit", () => {
    expect(checkoutTimeout().message).toBe(`checkout request timed out after ${CHECKOUT_REQUEST_TIMEOUT_MS}ms`)
  })

  test("the notification error is a different message", () => {
    expect(notifyTimeout().message).toContain("checkout notification")
  })
})
