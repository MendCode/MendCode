import { fmtMoney, padRight } from "./util"

export type LineItem = { description: string; quantity: number; unitCents: number }

export function lineTotalCents(item: LineItem): number {
  return item.quantity * item.unitCents
}

export function invoiceTotalCents(items: readonly LineItem[]): number {
  return items.reduce((sum, item) => sum + lineTotalCents(item), 0)
}

export function renderInvoice(items: readonly LineItem[], currency = "USD"): string {
  const rows = items.map((item) => `${padRight(item.description, 20)}${item.quantity} x ${fmtMoney(item.unitCents, currency)} = ${fmtMoney(lineTotalCents(item), currency)}`)
  rows.push(`Total: ${fmtMoney(invoiceTotalCents(items), currency)}`)
  return rows.join("\n")
}
