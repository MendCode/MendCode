// Search over the reference cards (`mendcode docs --search <words>`). No imports: the terminal reads it at startup and the card generator
// builds its index with the same functions, so a word is cut the same way when the index is written and when it is read.

/** What a search needs of a card; `terms` is the index the generator wrote (see `cardTerms`). */
export type SearchCard = { topic: string; summary: string; aliases: readonly string[]; text: string; terms: string }
export type SearchHit = { topic: string; summary: string; score: number; line: string }

/** Most words of a query that count, and most cards a search prints. */
export const SEARCH_MAX_WORDS = 8
export const SEARCH_MAX_HITS = 5
/** Most characters of the matching line printed under a hit. */
export const SEARCH_LINE_CHARS = 150
/** Most terms the index keeps per card (the most frequent first). */
const TERMS_MAX = 160

const STOP = new Set((
  "the and for with from that this these those you your are was were has have had not but all any can will would should could into onto over out off about how what which when where why who " +
  "make made set get got let show tell give want need like please just also then than them they their there here its via use used using one two per each every some more most only very " +
  "que los las una unos unas del por con para como mas pero mis tus sus"
).split(" "))

/** A word reduced to its stem, so `agents`, `agent` and `agenting` meet: plural and `-ing`/`-ed` endings come off, nothing smarter. */
export function stem(word: string): string {
  let result = word
  if (result.length > 4 && result.endsWith("ies")) result = `${result.slice(0, -3)}y`
  else if (result.length > 4 && /(?:ches|shes|sses|xes)$/.test(result)) result = result.slice(0, -2)
  else if (result.length > 3 && result.endsWith("s") && !result.endsWith("ss") && !result.endsWith("us")) result = result.slice(0, -1)
  if (result.length > 5 && result.endsWith("ing")) result = result.slice(0, -3)
  else if (result.length > 4 && result.endsWith("ed")) result = result.slice(0, -2)
  return result
}

/**
 * The words of a text, lowercase: letters and digits, with `-` and `_` inside a word, and the parts of a hyphenated word on their own too.
 * A setting name written in camelCase (`contextWindow`, `compactAtTokens`) also gives its parts, so it meets the plain words of a card;
 * a capitalised name (`MendCode`, `PreToolUse`) stays whole.
 */
export function wordsOf(text: string): string[] {
  const found: string[] = []
  for (const [raw] of text.matchAll(/[A-Za-z0-9][A-Za-z0-9_-]*[A-Za-z0-9]|[A-Za-z0-9]/g)) {
    const word = raw.toLowerCase()
    found.push(word)
    if (/[-_]/.test(word)) for (const part of word.split(/[-_]+/)) if (part && part !== word) found.push(part)
    if (/^[a-z]+[A-Z]/.test(raw)) for (const part of raw.split(/(?<=[a-z0-9])(?=[A-Z])/)) found.push(part.toLowerCase())
  }
  return found
}

/** The stems of a query that can match: stop words and one-letter words dropped, repeats merged, at most `SEARCH_MAX_WORDS`. */
export function queryStems(words: readonly string[]): string[] {
  const stems = new Set<string>()
  for (const word of words.flatMap(wordsOf)) {
    if (word.length < 2 || STOP.has(word)) continue
    stems.add(stem(word))
    if (stems.size >= SEARCH_MAX_WORDS) break
  }
  return [...stems]
}

/** The index of one card: the stems of the words of its summary and text (not its topic or aliases, which are matched whole), the most frequent first. */
export function cardTerms(card: { summary: string; text: string }): string {
  const counts = new Map<string, number>()
  for (const word of wordsOf(`${card.summary}\n${card.text}`)) {
    if (word.length < 3 || STOP.has(word) || /^\d+$/.test(word)) continue
    const key = stem(word)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, TERMS_MAX).map(([key]) => key).sort().join(" ")
}

/** Points per kind of match, per query word: a card's own name beats a word of its summary beats a word somewhere in its text. */
const POINTS = { name: 12, partOfName: 6, summary: 4, text: 2 } as const

function scoreCard(card: SearchCard, stems: readonly string[]): number {
  const names = [card.topic, ...card.aliases]
  const nameStems = new Set(names.map((name) => stem(name)))
  const nameParts = new Set(names.flatMap((name) => wordsOf(name)).map(stem))
  const summary = new Set(wordsOf(card.summary).map(stem))
  const terms = new Set(card.terms.split(" "))
  let score = 0, matched = 0
  for (const word of stems) {
    const points = nameStems.has(word) ? POINTS.name : nameParts.has(word) ? POINTS.partOfName : summary.has(word) ? POINTS.summary : terms.has(word) ? POINTS.text : 0
    if (points) { score += points; matched++ }
  }
  // Every word found is worth more than one word found twice: the bonus rewards a card that answers the whole request.
  return matched > 1 ? score + matched * 2 : score
}

/** The line of the card's text that holds most of the query words, cut around the first of them. */
function bestLine(card: SearchCard, stems: readonly string[]): string {
  let best = "", bestCount = 0
  for (const raw of card.text.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    const present = new Set(wordsOf(line).map(stem))
    const count = stems.filter((word) => present.has(word)).length
    if (count > bestCount) { best = line; bestCount = count }
  }
  if (!best) return ""
  if (best.length <= SEARCH_LINE_CHARS) return best
  const first = wordsOf(best).map(stem).findIndex((word) => stems.includes(word))
  const at = first < 0 ? 0 : Math.max(0, best.toLowerCase().indexOf(wordsOf(best)[first]!) - 40)
  const start = at === 0 ? 0 : best.indexOf(" ", at) + 1
  const slice = best.slice(start, start + SEARCH_LINE_CHARS)
  return `${start > 0 ? "..." : ""}${slice.slice(0, slice.lastIndexOf(" ") > 60 ? slice.lastIndexOf(" ") : slice.length)}...`
}

/** The cards that answer the words, best first (ties by topic), at most `limit`. */
export function searchCards(query: readonly string[], cards: readonly SearchCard[], limit = SEARCH_MAX_HITS): SearchHit[] {
  const stems = queryStems(query)
  if (!stems.length) return []
  return cards
    .map((card, at) => ({ card, at, score: scoreCard(card, stems) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .slice(0, limit)
    .map(({ card, score }) => ({ topic: card.topic, summary: card.summary, score, line: bestLine(card, stems) }))
}
