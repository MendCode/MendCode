import { roundHalfUp } from "./round"

/** Formats an integer amount of cents for display, e.g. 1999 -> "$19.99". */
export function formatPrice(cents: number, symbol = "$"): string {
  const sign = cents < 0 ? "-" : ""
  const dollars = roundHalfUp(Math.abs(cents) / 100)
  return `${sign}${symbol}${dollars.toFixed(2)}`
}

export function formatRange(minCents: number, maxCents: number, symbol = "$"): string {
  return `${formatPrice(minCents, symbol)} - ${formatPrice(maxCents, symbol)}`
}
