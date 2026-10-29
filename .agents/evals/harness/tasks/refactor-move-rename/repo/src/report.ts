import { fmtMoney, padRight } from "./util"

export type LedgerEntry = { month: string; revenueCents: number; costCents: number }

export function monthlyReport(entries: readonly LedgerEntry[]): string[] {
  return entries.map((entry) => `${padRight(entry.month, 10)}${fmtMoney(entry.revenueCents)} in, ${fmtMoney(entry.costCents)} out, net ${fmtMoney(entry.revenueCents - entry.costCents)}`)
}

export function bestMonth(entries: readonly LedgerEntry[]): string | undefined {
  let best: LedgerEntry | undefined
  for (const entry of entries) if (!best || entry.revenueCents - entry.costCents > best.revenueCents - best.costCents) best = entry
  return best?.month
}
