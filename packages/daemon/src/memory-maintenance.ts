import type { MemoryEntry, Settings } from "@mendcode/protocol"
import { normalizeMemoryText } from "./memory-duplicates"

/** Days an agent proposal waits in Pending before it expires (`memoryPendingDays`). */
export const PENDING_EXPIRY_DAYS = 14

/**
 * Agent proposals that waited longer than the limit without a decision: a new memory is archived (restorable) and a Dream revision is
 * dropped. Assistant action drafts are never touched. `days` 0 turns expiry off.
 */
export function expiredPending(entries: MemoryEntry[], input: { now: number; days: number | undefined }): Array<{ memoryId: MemoryEntry["memoryId"]; action: "archive" | "delete" }> {
  const days = input.days ?? PENDING_EXPIRY_DAYS
  if (days <= 0) return []
  const cutoff = input.now - days * 86_400_000
  return entries
    .filter((entry) => entry.status === "pending" && entry.source === "agent" && !entry.details?.action && entry.createdAt < cutoff)
    .map((entry) => ({ memoryId: entry.memoryId, action: entry.kind === "update" || entry.kind === "archive" ? "delete" as const : "archive" as const }))
}

/** Deterministic maintenance only: no inference, no removal of user or pinned facts. */
export function memoryMaintenance(entries: MemoryEntry[], policy: Settings["memoryMaintenance"]) {
  const retained = new Map<string, MemoryEntry>()
  const duplicates: Array<{ memoryId: MemoryEntry["memoryId"]; canonicalId: MemoryEntry["memoryId"] }> = []
  for (const entry of [...entries].filter((memory) => memory.status !== "archived").sort((a, b) => Number(b.source === "user" || b.pinned === true) - Number(a.source === "user" || a.pinned === true) || Number(b.status === "saved") - Number(a.status === "saved") || a.createdAt - b.createdAt || a.memoryId.localeCompare(b.memoryId))) {
    if (entry.kind === "update" || entry.kind === "archive") continue
    const text = normalizeMemoryText(entry.text)
    const key = JSON.stringify([entry.scope, entry.profile ?? "", entry.directory ?? "", entry.sessionId ?? "", text])
    const canonical = retained.get(key)
    if (canonical && entry.source === "agent" && !entry.pinned) duplicates.push({ memoryId: entry.memoryId, canonicalId: canonical.memoryId })
    else if (!canonical) retained.set(key, entry)
  }
  return { policy: policy ?? "disabled", duplicates: policy === "disabled" || policy === undefined ? [] : duplicates }
}
