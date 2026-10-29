const STRICT_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

/** Parses an order timestamp from the feed. Returns undefined when it is not a valid instant. */
export function parseTimestamp(raw: string): Date | undefined {
  if (!STRICT_UTC.test(raw)) return undefined
  const time = Date.parse(raw)
  return Number.isNaN(time) ? undefined : new Date(time)
}
