import type { MemoryEntry } from "@mendcode/protocol"

/** Case, spacing, punctuation and accents do not make a different memory. */
export const normalizeMemoryText = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()

/**
 * The memory a new proposal repeats: same normalized text in any scope the caller can see (user and project) and in any status,
 * archived included, so something the user rejected or Dream archived is not proposed again. Revisions and assistant drafts are
 * not memories of their own.
 */
export function findDuplicate(entries: readonly MemoryEntry[], text: string): MemoryEntry | undefined {
  const key = normalizeMemoryText(text)
  if (!key) return undefined
  return entries.find((entry) => entry.kind !== "update" && entry.kind !== "archive" && !entry.details?.action && normalizeMemoryText(entry.text) === key)
}
