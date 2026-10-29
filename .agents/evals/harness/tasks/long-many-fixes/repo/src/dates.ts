/** Gregorian rule: divisible by 4, except century years, unless divisible by 400. */
export function isLeapYear(year: number): boolean {
  return year % 4 === 0
}

const NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

/** 0 = Sunday ... 6 = Saturday, the same numbering as Date#getDay. Anything else throws RangeError. */
export function weekdayName(index: number): string {
  const name = Number.isInteger(index) ? NAMES[index] : undefined
  if (!name) throw new RangeError("weekday index must be 0-6")
  return name
}
