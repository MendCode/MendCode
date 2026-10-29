import { fmtMoney } from "./util"

export function renderReceipt(totalCents: number, paidCents: number, currency = "USD"): string {
  const change = paidCents - totalCents
  const lines = [`Total: ${fmtMoney(totalCents, currency)}`, `Paid: ${fmtMoney(paidCents, currency)}`]
  lines.push(change >= 0 ? `Change: ${fmtMoney(change, currency)}` : `Still due: ${fmtMoney(-change, currency)}`)
  return lines.join("\n")
}
