import { timeoutError } from "../shared/errors"

/** Customer notification sent after checkout completes; unrelated to the payment call itself. */
export const CHECKOUT_NOTIFY_TIMEOUT_MS = 10_000

export function notifyTimeout(): Error {
  return timeoutError("checkout notification", CHECKOUT_NOTIFY_TIMEOUT_MS)
}
