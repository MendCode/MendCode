import type { Order } from "./ingest"

/** Revenue per UTC calendar day (`YYYY-MM-DD`), in cents. */
export function dailyTotals(orders: readonly Order[]): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const order of orders) {
    const day = order.createdAt.toISOString().slice(0, 10)
    totals[day] = (totals[day] ?? 0) + order.amountCents
  }
  return totals
}

export function grandTotal(totals: Record<string, number>): number {
  return Object.values(totals).reduce((sum, cents) => sum + cents, 0)
}
