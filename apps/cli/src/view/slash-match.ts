/**
 * How a typed `/query` matches a command, best first: the name, an alias, a prefix of either, the start of a later word of the
 * name (`/dir` finds `/add-dir`), the first letters of its words (`/pm` finds `/prompt-mode`), a run inside it, a one-typo form
 * of it, and last the summary's words. A scattered subsequence is not a match: `/env` finds nothing in a catalog that has no
 * `env`, not the two dozen commands whose summaries hold an e, an n and a v.
 */
export type SlashTarget = { name: string; aliases: readonly string[]; summary: string }
export type SlashMatch = { tier: number; /** The alias that matched, when the name did not. */ via?: string }

export const SLASH_TIERS = { exact: 0, alias: 1, prefix: 2, aliasPrefix: 3, word: 4, initials: 5, inside: 6, typo: 7, summary: 8 } as const
/** The loosest tiers are capped so a short query cannot list half the catalog. */
export const SLASH_TIER_CAPS: ReadonlyArray<{ tiers: readonly number[]; max: number }> = [
  { tiers: [SLASH_TIERS.initials, SLASH_TIERS.inside], max: 8 },
  { tiers: [SLASH_TIERS.typo], max: 3 },
  { tiers: [SLASH_TIERS.summary], max: 5 },
]

/** Words of a summary that say nothing about the command: typing `/thi` is not asking for every "this session". */
const FILLER = new Set(["this", "that", "the", "its", "and", "for", "from", "with", "into", "your", "all", "any", "one"])

const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)

/** Whether the query is cut into prefixes of consecutive words (`cwin` is `c`ontext + `win`dow), skipping none of the order. */
function initialsOf(query: string, parts: readonly string[], from = 0): boolean {
  if (!query) return true
  for (let at = from; at < parts.length; at++) {
    const part = parts[at]!
    for (let take = Math.min(query.length, part.length); take >= 1; take--) if (part.startsWith(query.slice(0, take)) && initialsOf(query.slice(take), parts, at + 1)) return true
  }
  return false
}

/** Edit distance with one adjacent swap counting once, giving up above `limit`. */
function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1
  let before: number[] = []
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let best = Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, before[j - 2]! + 1)
      row.push(best)
    }
    before = previous
    previous = row
  }
  return previous[b.length]!
}

/** The typos a query of this length forgives: none under four letters, one under eight, two above. */
const forgiven = (length: number) => (length < 4 ? 0 : length < 8 ? 1 : 2)

function nameTier(query: string, name: string, alias: boolean): number | undefined {
  const lower = name.toLowerCase()
  if (lower === query) return alias ? SLASH_TIERS.alias : SLASH_TIERS.exact
  if (lower.startsWith(query)) return alias ? SLASH_TIERS.aliasPrefix : SLASH_TIERS.prefix
  const parts = words(lower)
  if (parts.slice(1).some((part) => part.startsWith(query))) return SLASH_TIERS.word
  if (query.length >= 2 && parts.length > 1 && initialsOf(query, parts)) return SLASH_TIERS.initials
  if (query.length >= 3 && lower.includes(query)) return SLASH_TIERS.inside
  const limit = forgiven(query.length)
  if (limit && (distance(query, lower, limit) <= limit || distance(query, lower.slice(0, query.length), limit) <= limit)) return SLASH_TIERS.typo
  return undefined
}

/** The best way the command matches the lowercase query, or undefined. */
export function slashMatch(query: string, command: SlashTarget): SlashMatch | undefined {
  let best: SlashMatch | undefined
  const consider = (tier: number | undefined, via?: string) => {
    if (tier !== undefined && (!best || tier < best.tier)) best = { tier, ...(via ? { via } : {}) }
  }
  consider(nameTier(query, command.name, false))
  for (const alias of command.aliases) consider(nameTier(query, alias, true), alias)
  if (best && best.tier <= SLASH_TIERS.aliasPrefix) return best
  if (query.length >= 3 && words(command.summary).some((word) => word.startsWith(query) && !FILLER.has(word))) consider(SLASH_TIERS.summary)
  return best
}
