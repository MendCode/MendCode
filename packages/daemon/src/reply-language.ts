import { detectLanguage, isAutoLanguage } from "./pr-review/language"

/**
 * The `language` setting (docs/prompt-modes.md) as the one short line an engine adds to each user message, out of the transcript: a long
 * stretch of tool output in another language then does not move the replies to it. A name is used as it is. `auto` (or unset) names
 * the language of the user's latest message, judged here with no model call; when the message is too short or unclear the line asks
 * for the user's own language without naming one.
 */
export const UNSURE_LINE = "Reply in the user's language."

/** Distinctive words of short chat messages ("dime", "hazlo", "merci"), for a message too short for `detectLanguage`. */
const SHORT: ReadonlyArray<{ language: string; words: ReadonlySet<string>; marks?: RegExp }> = [
  { language: "Spanish", words: new Set("dime hazlo hazme sigue dale gracias qué cómo cuál está están pero también ahora ayuda puedes quiero necesito arregla haz mira oye bueno vale listo sí".split(" ")), marks: /[ñ¿¡]/u },
  { language: "Portuguese", words: new Set("você obrigado obrigada faz faça isso então ainda pode tá beleza não".split(" ")), marks: /[ãõ]/u },
  { language: "French", words: new Set("merci oui fais peux pourquoi comment voilà d'accord c'est je tu vous".split(" ")), marks: /[œ]/u },
  { language: "English", words: new Set("the please thanks what why how you it this that do does can yes".split(" ")) },
]

/** The language of a short message: the one with the most distinctive words or marks in it, when it clearly leads. */
function shortLanguage(text: string): string | undefined {
  const sample = text.slice(0, 2_000).toLowerCase()
  const tokens = sample.match(/[\p{L}\p{M}'’]+/gu) ?? []
  const scores = SHORT.map((entry) => ({ language: entry.language, score: tokens.filter((token) => entry.words.has(token)).length + (entry.marks?.test(sample) ? 1 : 0) })).sort((a, b) => b.score - a.score)
  return scores[0]!.score > scores[1]!.score ? scores[0]!.language : undefined
}

/** The language of the user's message, or undefined when it is not clear. */
export function messageLanguage(text: string): string | undefined {
  return detectLanguage(text) ?? shortLanguage(text)
}

/** The line for one turn: `setting` is the `language` setting (or a run's fixed language), `text` the user's latest message. */
export function replyLanguageLine(setting: string | undefined, text: string): string {
  const named = setting?.trim()
  if (named && !isAutoLanguage(named)) return `Reply in ${named}.`
  const detected = messageLanguage(text)
  return detected ? `Reply in ${detected}.` : UNSURE_LINE
}
