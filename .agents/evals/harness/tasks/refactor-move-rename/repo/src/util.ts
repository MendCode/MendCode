const SYMBOLS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" }

/** "1234567" cents -> "$12,345.67". Negative amounts keep the sign in front of the symbol. */
export function fmtMoney(cents: number, currency = "USD"): string {
  const sign = cents < 0 ? "-" : ""
  const abs = Math.abs(Math.round(cents))
  const whole = Math.floor(abs / 100)
  const fraction = String(abs % 100).padStart(2, "0")
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return `${sign}${SYMBOLS[currency] ?? `${currency} `}${grouped}.${fraction}`
}

export function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

export function padRight(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length)
}
