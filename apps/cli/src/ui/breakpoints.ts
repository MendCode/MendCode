/**
 * The terminal's responsive breakpoints (specs/master-plan.md section 52), in one place. Pages ask `isWide(width)`
 * instead of carrying their own `WIDE_WIDTH`, so a layout change for a width class moves with the spec.
 *
 *   compact  < 70
 *   normal   70 to 109
 *   wide     110 to 149
 *   xl       150 and up
 */
export const BREAKPOINTS = { normal: 70, wide: 110, xl: 150 } as const

export type Breakpoint = "compact" | "normal" | "wide" | "xl"

export function breakpointOf(width: number): Breakpoint {
  if (width >= BREAKPOINTS.xl) return "xl"
  if (width >= BREAKPOINTS.wide) return "wide"
  if (width >= BREAKPOINTS.normal) return "normal"
  return "compact"
}

export const isCompact = (width: number) => width < BREAKPOINTS.normal
/** Wide or xl: a page shows its detail beside its list. */
export const isWide = (width: number) => width >= BREAKPOINTS.wide
export const isXl = (width: number) => width >= BREAKPOINTS.xl

/**
 * Not a spec breakpoint: the companion pet needs this many columns to sit beside the prompt. Kept here so every
 * width threshold of the terminal lives in one file.
 */
export const PET_MIN_WIDTH = 80
