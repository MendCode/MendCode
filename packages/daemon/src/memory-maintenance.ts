import type { MemoryEntry, Settings } from "@mendcode/protocol"

/** Deterministic maintenance only: no inference, no removal of user or pinned facts. */
export function memoryMaintenance(entries: MemoryEntry[], policy: Settings["memoryMaintenance"]) {
  const retained = new Map<string, MemoryEntry>()
  const duplicates: Array<{ memoryId: MemoryEntry["memoryId"]; canonicalId: MemoryEntry["memoryId"] }> = []
  for (const entry of [...entries].filter((memory) => memory.status !== "archived").sort((a, b) => Number(b.source === "user" || b.pinned === true) - Number(a.source === "user" || a.pinned === true) || Number(b.status === "saved") - Number(a.status === "saved") || a.createdAt - b.createdAt || a.memoryId.localeCompare(b.memoryId))) {
    if (entry.kind === "update" || entry.kind === "archive") continue
    const text = entry.text.toLowerCase().replace(/\s+/g, " ").trim()
    const key = JSON.stringify([entry.scope, entry.profile ?? "", entry.directory ?? "", entry.sessionId ?? "", text])
    const canonical = retained.get(key)
    if (canonical && entry.source === "agent" && !entry.pinned) duplicates.push({ memoryId: entry.memoryId, canonicalId: canonical.memoryId })
    else if (!canonical) retained.set(key, entry)
  }
  return { policy: policy ?? "disabled", duplicates: policy === "disabled" || policy === undefined ? [] : duplicates }
}
