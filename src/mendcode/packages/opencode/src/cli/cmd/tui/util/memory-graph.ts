import { Locale } from "@/util/locale"

export type CompactMemoryGraphSnapshot = {
  action?: string
  query?: string
  health?: { graphHealth?: string; connectedFacts?: number; isolatedFacts?: number; orphanLinks?: number }
  facts: Array<{
    id: string
    text: string
    scope: string
    categoryIDs: string[]
    retrievalPriority?: number
    materialized?: boolean
  }>
  links: Array<{ from: string; to: string; kind: string }>
  categories: Array<{ id: string; label: string; count: number }>
}

export function compactMemoryGraphSnapshot(value: unknown): CompactMemoryGraphSnapshot | undefined {
  if (!value || typeof value !== "object") return
  const record = value as Partial<CompactMemoryGraphSnapshot>
  if (!Array.isArray(record.facts) || !Array.isArray(record.links) || !Array.isArray(record.categories)) return
  return record as CompactMemoryGraphSnapshot
}

export function compactMemoryGraphRows(snapshot: CompactMemoryGraphSnapshot, width: number) {
  const factByID = new Map(snapshot.facts.map((fact) => [fact.id, fact]))
  const terms = snapshot.query?.toLowerCase().split(/\s+/).filter(Boolean) ?? []
  const preferred = snapshot.facts.find((fact) => terms.length && terms.every((term) => fact.text.toLowerCase().includes(term)))
  const validLinks = snapshot.links.filter((candidate) => factByID.has(candidate.from) && factByID.has(candidate.to))
  const link = validLinks.find((candidate) => candidate.from === preferred?.id || candidate.to === preferred?.id) ?? validLinks[0]
  const linkedIDs = new Set(validLinks.flatMap((candidate) => [candidate.from, candidate.to]))
  const isolated = snapshot.facts
    .filter((fact) => !linkedIDs.has(fact.id))
    .toSorted((a, b) => (a.retrievalPriority ?? 99) - (b.retrievalPriority ?? 99) || a.id.localeCompare(b.id))[0]
  const focused = link ? factByID.get(link.from) : preferred ?? isolated ?? snapshot.facts[0]
  const rows = link
    ? [
      `From · ${factByID.get(link.from)!.text}`,
      `Relation · ${link.kind}`,
      `To · ${factByID.get(link.to)!.text}`,
    ]
    : focused
      ? [`Memory · ${focused.text}`, `Relation · isolated (${focused.scope})`]
      : ["No materialized memories in this graph snapshot"]
  return [...new Set(rows)].map((row) => Locale.truncate(row.replace(/\s+/g, " ").trim(), Math.max(12, width)))
}
