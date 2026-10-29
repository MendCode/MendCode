import { timeoutError } from "../shared/errors"

/** Longest a checkout call to the payment gateway may take before we give up on it. */
export const CHECKOUT_REQUEST_TIMEOUT_MS = 10_000
export const CHECKOUT_REQUEST_RETRIES = 1

export type CheckoutRequest = { cartId: string; timeoutMs: number }

export function createCheckoutRequest(cartId: string): CheckoutRequest {
  return { cartId, timeoutMs: CHECKOUT_REQUEST_TIMEOUT_MS }
}

export function checkoutTimeout(): Error {
  return timeoutError("checkout", CHECKOUT_REQUEST_TIMEOUT_MS)
}
