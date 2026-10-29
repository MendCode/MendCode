/** How long an abandoned cart (including one stuck mid-checkout) is kept. */
export const CART_EXPIRY_TTL_MS = 1_800_000
export const CART_EXPIRY_SWEEP_MS = 60_000

export function isExpired(createdAtMs: number, nowMs: number): boolean {
  return nowMs - createdAtMs > CART_EXPIRY_TTL_MS
}
