import { clampInt, fmtMoney } from "./util"

export type CartItem = { name: string; priceCents: number; quantity: number }

export function cartTotalCents(items: readonly CartItem[]): number {
  return items.reduce((sum, item) => sum + item.priceCents * clampInt(item.quantity, 0, 99), 0)
}

export function cartSummary(items: readonly CartItem[]): string {
  const count = items.reduce((sum, item) => sum + clampInt(item.quantity, 0, 99), 0)
  return `${count} item${count === 1 ? "" : "s"}, ${fmtMoney(cartTotalCents(items))}`
}
