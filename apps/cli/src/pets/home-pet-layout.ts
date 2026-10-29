import type { Span } from "../ui/theme"

/**
 * What the start screen needs of a pet mascot before the pet system (`home-pet.ts`) and the pet's sheet have loaded: the
 * boxes of each `mascotSize` and the title's tint. Imports nothing at run time, so the home reserves the pet's place and
 * tints its title from the first frame (the picture then arrives into that place, instead of after the ASCII mascot), and
 * the startup graph stays without the pet system.
 */
export const HOME_PET_SIZES = { small: { cols: 24, rows: 12 }, medium: { cols: 32, rows: 16 }, large: { cols: 44, rows: 22 } } as const
export type HomePetSize = keyof typeof HOME_PET_SIZES
/** The sizes from the largest down: a box that does not fit gives way to the next smaller one. */
export const HOME_PET_ORDER: readonly HomePetSize[] = ["large", "medium", "small"]

/** The boxes to try for `size` while the pet's own proportions are not known yet: the wanted one first, then the smaller ones. */
export const reservedHomePetBoxes = (size: HomePetSize): Array<{ cols: number; rows: number }> => HOME_PET_ORDER.slice(HOME_PET_ORDER.indexOf(size)).map((name) => ({ ...HOME_PET_SIZES[name] }))

/** `text` in a color that runs from `from` to `to` across `width` cells (#rrggbb), one span per run of equal color. */
export function gradientSpans(text: string, width: number, from: string, to: string): Span[] {
  const channels = (hex: string) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16))
  const [a, b] = [channels(from), channels(to)]
  const spans: Span[] = []
  ;[...text].forEach((char, at) => {
    // Eight steps are enough for a soft ramp and keep the row to a handful of escape sequences.
    const step = Math.min(7, Math.floor(at / Math.max(1, width) * 8)) / 7
    const fgHex = `#${a.map((value, i) => Math.round(value + (b[i]! - value) * step).toString(16).padStart(2, "0")).join("")}`
    const last = spans[spans.length - 1]
    if (last && last.fgHex === fgHex) last.text += char
    else spans.push({ text: char, fgHex })
  })
  return spans
}
