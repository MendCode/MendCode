/** 3725 -> "1h 2m 5s", 3600 -> "1h", 59 -> "59s", 0 -> "0s": units that are zero are left out. Whole non-negative seconds only. */
export function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return `${hours}h ${minutes}m ${seconds}s`
}

const NUMERALS: ReadonlyArray<readonly [number, string]> = [
  [1000, "M"],
  [500, "D"],
  [100, "C"],
  [50, "L"],
  [10, "X"],
  [5, "V"],
  [1, "I"],
]

/** 4 -> "IV", 1994 -> "MCMXCIV". Only 1..3999 is valid; anything else throws RangeError. */
export function toRoman(value: number): string {
  if (!Number.isInteger(value) || value < 1 || value > 3999) throw new RangeError("roman numerals cover 1..3999")
  let rest = value
  let out = ""
  for (const [amount, numeral] of NUMERALS) {
    while (rest >= amount) {
      out += numeral
      rest -= amount
    }
  }
  return out
}
