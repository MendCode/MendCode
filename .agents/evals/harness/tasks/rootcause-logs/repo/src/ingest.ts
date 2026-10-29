import { parseTimestamp } from "./timestamp"

export type Order = { id: string; customer: string; amountCents: number; createdAt: Date }
export type SkipReason = "malformed row" | "duplicate id" | "invalid amount" | "invalid timestamp"
export type Skipped = { id: string; reason: SkipReason; raw: string }
export type IngestResult = { accepted: Order[]; skipped: Skipped[] }

/** Rows are `id,customer,amount_cents,created_at`; the first line may be a header. */
export function ingest(csv: string): IngestResult {
  const accepted: Order[] = []
  const skipped: Skipped[] = []
  const seen = new Set<string>()
  for (const line of csv.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("id,")) continue
    const parts = line.split(",")
    if (parts.length !== 4) {
      skipped.push({ id: parts[0] ?? "", reason: "malformed row", raw: line })
      continue
    }
    const [id, customer, amount, created] = parts as [string, string, string, string]
    if (seen.has(id)) {
      skipped.push({ id, reason: "duplicate id", raw: id })
      continue
    }
    if (!/^\d+$/.test(amount)) {
      skipped.push({ id, reason: "invalid amount", raw: amount })
      continue
    }
    const createdAt = parseTimestamp(created)
    if (!createdAt) {
      skipped.push({ id, reason: "invalid timestamp", raw: created })
      continue
    }
    seen.add(id)
    accepted.push({ id, customer, amountCents: Number(amount), createdAt })
  }
  return { accepted, skipped }
}
