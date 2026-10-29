/**
 * Rounds half away from zero to `digits` decimal places (default: to a whole number).
 * Goes through the decimal string so binary noise cannot flip a tie: 1.005 -> 1.01.
 * Used for tax, discounts and display; callers depend on the whole-number default.
 */
export function roundHalfUp(value: number, digits = 0): number {
  if (!Number.isFinite(value)) return value
  const sign = value < 0 ? -1 : 1
  const shifted = Number(`${Math.abs(value)}e${digits}`)
  return (sign * Number(`${Math.round(shifted)}e-${digits}`)) || 0
}
