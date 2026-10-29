/** Number formatting shared by the footer (eager) and the usage/storage pages (lazy). */

export function thousands(value: number) {
  return Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

function scaled(value: number) {
  return value < 100 ? value.toFixed(1).replace(/\.0$/, "") : String(Math.round(value))
}

/** 1,204 / 12.4K / 812K / 12.4M / 1.2B. */
export function compact(value: number) {
  if (value < 10_000) return thousands(value)
  const units = [{ suffix: "K", size: 1e3 }, { suffix: "M", size: 1e6 }, { suffix: "B", size: 1e9 }]
  let index = value < 1e6 ? 0 : value < 1e9 ? 1 : 2
  let text = scaled(value / units[index]!.size)
  if (Number(text) >= 1000 && index < 2) {
    index += 1
    text = scaled(value / units[index]!.size)
  }
  return `${text}${units[index]!.suffix}`
}
