/** A token count the user typed: `200k`, `1m`, `1.5m`, `128000`, `128,000`. Undefined outside 1,000 to 10,000,000 or when it is not a number. */
export function parseTokenCount(text: string): number | undefined {
  const match = /^(\d[\d,]*(?:\.\d+)?)\s*([km]?)$/i.exec(text.trim())
  if (!match) return undefined
  const base = Number(match[1]!.replace(/,/g, ""))
  const unit = match[2]!.toLowerCase()
  const tokens = Math.round(base * (unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1))
  return Number.isFinite(tokens) && tokens >= 1000 && tokens <= 10_000_000 ? tokens : undefined
}
