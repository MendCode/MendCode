import { detectLanguage, isAutoLanguage, latinScores } from "./pr-review/language"

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

/**
 * The language of the user's message, or undefined when it is not clear. The short-message words only decide among the languages
 * the full word lists rank first: "rename tu title chat para que…" ties Spanish and Portuguese there, and its "tu" must not make it French.
 */
export function messageLanguage(text: string): string | undefined {
  const detected = detectLanguage(text)
  if (detected) return detected
  const short = shortLanguage(text)
  if (!short) return undefined
  const scores = latinScores(text)
  const top = scores[0]?.score ?? 0
  return top === 0 || scores.some((entry) => entry.language === short && entry.score === top) ? short : undefined
}

/** The line for one turn: `setting` is the `language` setting (or a run's fixed language), `text` the user's latest message. */
export function replyLanguageLine(setting: string | undefined, text: string, remembered?: string): string {
  const named = setting?.trim()
  if (named && !isAutoLanguage(named)) return `Reply in ${named}.`
  const detected = messageLanguage(text) ?? remembered
  return detected ? `Reply in ${detected}.` : UNSURE_LINE
}

/**
 * A wake-up an engine sends in the user's place: Claude Code's `<task-notification>` and the like, a tagged block in English
 * whatever the user writes. It says nothing about the user's language.
 */
export function isMachineNotice(text: string): boolean {
  const tag = /^\s*<([a-z][\w-]*)[^>]*>[\s\S]*<\/\1>\s*$/i.exec(text)?.[1]?.toLowerCase()
  return tag !== undefined && MACHINE_ENVELOPES.test(tag)
}

/** The envelopes engines wrap their own wake-ups in; a user's `<request>…</request>` is the user's words. */
const MACHINE_ENVELOPES = /^(?:task-notification|system-reminder|local-command-[a-z-]+|command-[a-z-]+|bash-[a-z-]+|monitor-[a-z-]+|user-prompt-submit-hook|cross-session-message)$/

/**
 * `replyLanguageLine` per session: the language last found in the user's own words is kept, so a notice or a message too short or
 * mixed to judge keeps the replies where the user left them instead of following the notice's English or a guess.
 */
export function createReplyLanguage() {
  const last = new Map<string, string>()
  return (sessionId: string, setting: string | undefined, text: string): string => {
    if (isMachineNotice(text)) return replyLanguageLine(setting, "", last.get(sessionId))
    const detected = messageLanguage(text)
    if (detected) {
      last.delete(sessionId)
      last.set(sessionId, detected)
      // Bounded: the oldest sessions are forgotten first.
      if (last.size > 500) last.delete(last.keys().next().value!)
    }
    return replyLanguageLine(setting, text, last.get(sessionId))
  }
}
