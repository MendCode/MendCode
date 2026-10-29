import type { RecalledTurn } from "@mendcode/tools"

type Turn = { turn: number; at: number; user: string; assistant: string }

const BM25_K1 = 1.2
const BM25_B = 0.75
/** A word shorter than this says too little to match on ("de", "the", "if"). */
const MIN_TERM = 3

/** English and Spanish words of three letters or more that match nearly every turn, so they never count as a match. */
const STOPWORDS = new Set([
  "the", "and", "for", "that", "this", "with", "from", "are", "was", "but", "not", "you", "have", "has", "its", "can", "will", "all", "any", "now", "then", "than", "into", "about", "what", "why", "how", "again", "please",
  "que", "los", "las", "del", "una", "uno", "por", "para", "con", "sin", "como", "pero", "mas", "esto", "esta", "este", "eso", "ese", "esa", "hay", "muy", "ya", "sobre", "entre", "todo", "tambien", "porque", "cuando", "donde", "sus",
])

/** Lower-case words without accents, so "decisión" in one turn matches "decision" in a request; short and stop words are left out. */
export function terms(text: string): string[] {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().match(/[\p{L}\p{N}_]+/gu)?.filter((word) => word.length >= MIN_TERM && !STOPWORDS.has(word)) ?? []
}

/** The head of `text` within `max` characters, with a marker when it was cut. */
function bounded(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 20)).trimEnd()} […cut]`
}

/**
 * The packed-away turns that best match `query` (BM25 over each turn's request and answer), at most `limit`, each bounded so
 * all of them fit `maxChars`. A turn needs two distinct query words (one when the query has fewer than three), so a request
 * that shares only a common word recalls nothing rather than noise.
 */
export function rankTurns(turns: readonly Turn[], query: string, limit: number, maxChars: number): RecalledTurn[] {
  const wanted = [...new Set(terms(query))]
  if (!wanted.length || !turns.length || limit < 1) return []
  const documents = turns.map((turn) => {
    const words = terms(`${turn.user}\n${turn.assistant}`)
    const counts = new Map<string, number>()
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1)
    return { turn, length: words.length, counts }
  })
  const average = documents.reduce((sum, document) => sum + document.length, 0) / documents.length || 1
  const idf = new Map(wanted.map((word) => {
    const holding = documents.filter((document) => document.counts.has(word)).length
    return [word, Math.log(1 + (documents.length - holding + 0.5) / (holding + 0.5))]
  }))
  const needed = wanted.length < 3 ? 1 : 2
  const scored = documents.flatMap((document) => {
    let score = 0
    let matched = 0
    for (const word of wanted) {
      const count = document.counts.get(word)
      if (!count) continue
      matched++
      score += idf.get(word)! * (count * (BM25_K1 + 1)) / (count + BM25_K1 * (1 - BM25_B + BM25_B * document.length / average))
    }
    return matched >= needed ? [{ turn: document.turn, score }] : []
  }).sort((a, b) => b.score - a.score).slice(0, limit)
  const share = Math.floor(maxChars / Math.max(1, scored.length))
  return scored.map(({ turn, score }) => {
    const user = bounded(turn.user, Math.floor(share / 3))
    return { turn: turn.turn, at: turn.at, user, assistant: bounded(turn.assistant, share - user.length), score: Math.round(score * 100) / 100 }
  })
}
