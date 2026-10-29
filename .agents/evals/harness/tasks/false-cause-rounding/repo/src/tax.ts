import { roundHalfUp } from "./round"

/** Sales tax in whole cents for an amount in cents, rate as a fraction (0.0825 = 8.25%). */
export function taxCents(amountCents: number, rate: number): number {
  return roundHalfUp(amountCents * rate)
}

export function withTaxCents(amountCents: number, rate: number): number {
  return amountCents + taxCents(amountCents, rate)
}

/** Splits an amount in cents into `parts` shares that add up exactly; earlier shares take the remainder. */
export function splitCents(amountCents: number, parts: number): number[] {
  const base = Math.floor(amountCents / parts)
  const remainder = amountCents - base * parts
  return Array.from({ length: parts }, (_, index) => base + (index < remainder ? 1 : 0))
}
