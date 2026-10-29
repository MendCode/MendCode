import type { Line } from "../ui/theme"
import { center } from "./page"

/** Five rows, three cells per digit, one-cell spacing. No logo-font substitutions. */
const DIGITS: Record<string, string[]> = {
  "0": ["███", "█ █", "█ █", "█ █", "███"],
  "1": [" █ ", "██ ", " █ ", " █ ", "███"],
  "2": ["███", "  █", "███", "█  ", "███"],
  "3": ["███", "  █", "███", "  █", "███"],
  "4": ["█ █", "█ █", "███", "  █", "  █"],
  "5": ["███", "█  ", "███", "  █", "███"],
  "6": ["███", "█  ", "███", "█ █", "███"],
  "7": ["███", "  █", "  █", "  █", "  █"],
  "8": ["███", "█ █", "███", "█ █", "███"],
  "9": ["███", "█ █", "███", "  █", "███"],
  ":": [" ", "█", " ", "█", " "],
}

export function clockRows(time: string, width: number): Line[] {
  return Array.from({ length: 5 }, (_, row) => center([{ text: [...time].map((digit) => DIGITS[digit]?.[row] ?? "   ").join(" "), fg: "primary" }], width))
}
