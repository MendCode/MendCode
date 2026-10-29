/**
 * Shipping price table (public rate card):
 *
 *   up to and including 500 g ........ 4.99
 *   over 500 g, up to 2 kg inclusive . 8.99
 *   over 2 kg, up to 5 kg inclusive .. 14.99
 *   over 5 kg ........................ 29.99
 *
 * Prices are in cents. Weights are in grams and must be positive.
 */
export function shippingCents(weightGrams: number): number {
  if (!Number.isFinite(weightGrams) || weightGrams <= 0) throw new RangeError("weight must be a positive number of grams")
  if (weightGrams < 500) return 499
  if (weightGrams < 2000) return 899
  if (weightGrams < 5000) return 1499
  return 2999
}

export function orderTotalCents(itemsCents: readonly number[], weightGrams: number): number {
  return itemsCents.reduce((sum, cents) => sum + cents, 0) + shippingCents(weightGrams)
}
