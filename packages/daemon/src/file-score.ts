/**
 * Fuzzy ranking for the `@` mention file picker. Pure and allocation-light in the hot path so it stays
 * well under 10 ms for 50k candidate paths: each `IndexedEntry` precomputes its lowercase path, basename
 * and segments once at index-build time, and `scoreFileEntry` never allocates on a non-matching entry.
 */

export type FileKind = "file" | "dir"
export type IndexedEntry = { path: string; kind: FileKind; pathLower: string; baseLower: string; segmentsLower: readonly string[] }

/** Precomputes the lowercase fields `scoreFileEntry` and the daemon's listing need, once per entry. */
export function indexEntry(entryPath: string, kind: FileKind): IndexedEntry {
  const pathLower = entryPath.toLowerCase()
  const slash = pathLower.lastIndexOf("/")
  const baseLower = slash === -1 ? pathLower : pathLower.slice(slash + 1)
  return { path: entryPath, kind, pathLower, baseLower, segmentsLower: pathLower.split("/") }
}

/** Greedy earliest-first subsequence match: every character of `query` appears in order in `text`. */
function subsequenceSpan(text: string, query: string): number | undefined {
  let qi = 0
  let first = -1
  let last = -1
  for (let ti = 0; ti < text.length && qi < query.length; ti++) {
    if (text[ti] !== query[qi]) continue
    if (first === -1) first = ti
    last = ti
    qi++
  }
  return qi < query.length ? undefined : last - first + 1
}

/**
 * Higher is better; `undefined` means no match. Tiers, best first: the basename starts with `query`;
 * a path segment (a directory name) starts with it; `query`'s characters appear in order anywhere in
 * the path (a fuzzy subsequence). Within a tier, a shorter path and then alphabetical order win ties
 * (applied by the caller's sort, not encoded in the score, so it stays comparable across tiers).
 */
export function scoreFileEntry(entry: IndexedEntry, query: string): number | undefined {
  if (!query) return 0
  if (entry.baseLower.startsWith(query)) return 3_000_000 - entry.baseLower.length
  for (const segment of entry.segmentsLower) {
    if (segment.startsWith(query)) return 2_000_000 - entry.pathLower.length
  }
  const span = subsequenceSpan(entry.pathLower, query)
  if (span === undefined) return undefined
  return 1_000_000 - span * 100 - entry.pathLower.length
}

/** Ranks and caps `entries` for `query`; ties break on shorter, then alphabetically earlier, path. */
export function rankEntries(entries: readonly IndexedEntry[], query: string, limit: number): IndexedEntry[] {
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) return entries.slice(0, limit)
  const scored: Array<{ entry: IndexedEntry; score: number }> = []
  for (const entry of entries) {
    const score = scoreFileEntry(entry, trimmed)
    if (score !== undefined) scored.push({ entry, score })
  }
  scored.sort((a, b) => b.score - a.score || a.entry.path.length - b.entry.path.length || a.entry.path.localeCompare(b.entry.path))
  return scored.slice(0, limit).map((s) => s.entry)
}
