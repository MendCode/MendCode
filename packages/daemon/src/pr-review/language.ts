/**
 * The language a review's prose is written in (`template.language`, docs/pr-review.md). Reviews are public, so they never follow the
 * language of whoever runs the reviewer (their chats, memory, CLAUDE.md/AGENTS.md or harness settings): the repository's value decides.
 * It is a language name (default English), or `auto`: the language of the pull request's author, judged once per pull request from
 * the PR's own title and description (the author's first text) and kept with the PR's review state, so every later review, verify,
 * re-check, fix and command reply on that PR reads in the same language even after more pushes or an edited description.
 *
 * `auto` is resolved here, deterministically, rather than left to each model ("write in the language of the description"): the
 * fix, explain and verify prompts do not carry the description, a harness setting (Claude Code's `language`) needs a name, and a
 * per-prompt judgement could differ between the review and its verify. The detection is small and dependency-free: the share of a
 * non-Latin script, else function words and spelling marks of common Latin-script languages. Short, empty, mixed or unclear text
 * is English.
 *
 * No imports: config.ts and template.ts both build on this module.
 */

/** The review prose's language when the repository names none. */
export const REVIEW_LANGUAGE = "English"
/** `template.language: auto`: the pull request author's language, resolved once per pull request. */
export const AUTO_LANGUAGE = "auto"
/** A language name as `template.language` takes it (and as review state keeps it): letters first, then letters, marks, spaces, `()-`. */
export const LANGUAGE_NAME = /^\p{L}[\p{L}\p{M} ()-]{0,39}$/u

export const isAutoLanguage = (language: string | undefined): boolean => language?.trim().toLowerCase() === AUTO_LANGUAGE
const isLanguageName = (language: unknown): language is string => typeof language === "string" && LANGUAGE_NAME.test(language) && !isAutoLanguage(language)

/** The language a prompt or a harness setting names: an unresolved `auto` is English, never the word "auto". */
export const spokenLanguage = (language: string | undefined): string => !language || isAutoLanguage(language) ? REVIEW_LANGUAGE : language

/** Below this many letters, or this many words for a Latin-script text, the text is too short to judge. */
const MIN_LETTERS = 12
const MIN_WORDS = 4
/** The best Latin-script language needs this many points, and this many times the runner-up's. */
const MIN_SCORE = 4
const MARGIN = 1.5
/** Bounded work: only the start of a very long description is read. */
const MAX_TEXT = 8_000

/** Scripts whose letters name one language (or a family, named by its most common language). */
const SCRIPTS: ReadonlyArray<{ pattern: RegExp; language: (text: string) => string; share: number }> = [
  // CJK writes a word in one to three characters: a smaller share of the letters already says the text is in it.
  { pattern: /\p{Script=Hangul}/gu, language: () => "Korean", share: 0.25 },
  { pattern: /[\p{Script=Hiragana}\p{Script=Katakana}]/gu, language: () => "Japanese", share: 0.15 },
  { pattern: /\p{Script=Han}/gu, language: (text) => /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text) ? "Japanese" : "Chinese", share: 0.25 },
  { pattern: /\p{Script=Cyrillic}/gu, language: (text) => /[іїєґІЇЄҐ]/u.test(text) ? "Ukrainian" : "Russian", share: 0.5 },
  { pattern: /\p{Script=Arabic}/gu, language: (text) => /[پچژگ]/u.test(text) ? "Persian" : "Arabic", share: 0.5 },
  { pattern: /\p{Script=Hebrew}/gu, language: () => "Hebrew", share: 0.5 },
  { pattern: /\p{Script=Greek}/gu, language: () => "Greek", share: 0.5 },
  { pattern: /\p{Script=Devanagari}/gu, language: () => "Hindi", share: 0.5 },
  { pattern: /\p{Script=Thai}/gu, language: () => "Thai", share: 0.5 },
]

const words = (list: string) => new Set(list.split(" "))
/** Frequent function words; a word shared by several languages counts for each, so only the distinctive ones separate them. */
const LATIN: ReadonlyArray<{ language: string; words: ReadonlySet<string>; marks?: RegExp; suffix?: RegExp }> = [
  { language: "English", words: words("the and is are was were this that these those with for from of to in on it its be by an as not when which will would should can could does do did have has had we you our your into adds add fixes fix now also only so but or if all there than then what why how been being after before because without about") },
  { language: "Spanish", words: words("el la los las del de que en y es por para con una un se no al lo como más pero sus su este esta esto estos estas cuando también porque ya sin sobre hay ser son está están desde entre donde muy todo todos ahora así si sí hace agrega añade corrige cambia elimina usa ahora cuál qué cómo"), marks: /[ñ¿¡]/gu, suffix: /(?:ción|ciones|mente)$/u },
  { language: "Portuguese", words: words("o os as do da dos das de que em e é não para por com um uma se no na nos nas ao como mais mas seu sua este esta isso isto quando também porque já sem sobre há ser são está estão foi pelo pela ou muito agora então adiciona corrige remove usa"), marks: /[ãõ]/gu, suffix: /(?:ção|ções|mente)$/u },
  { language: "French", words: words("le la les des du de et est un une que qui en pour avec dans sur pas ne ce cette ces il elle nous vous sont au aux par plus mais ou où être été aussi quand parce très sans ajoute corrige supprime lors afin"), marks: /[êœ]|\b[ldjnsc]['’]/gu },
  { language: "German", words: words("der die das und ist sind nicht ein eine einen dem den des mit für von zu auf im auch wenn dass oder aber wird werden es sich bei nach noch nur wie wir kann fügt hinzu behebt jetzt beim"), marks: /[ßäöü]/gu, suffix: /(?:ung|heit|keit|lich)$/u },
  { language: "Italian", words: words("il lo la gli le di del della dei delle che è e per con un una non in si da al alla come più ma anche questo questa quando perché sono essere stato aggiunge corregge nel nella sul ora"), suffix: /(?:zione|zioni)$/u },
  { language: "Dutch", words: words("de het een en is van dat die niet met voor op te zijn ook maar als bij wordt worden naar dit deze er nu toe voegt kan wij"), suffix: /(?:ij|lijk)$/u },
]

/** Prose only: code, links, markup, paths, mentions and references are no language of the author's. */
function prose(text: string): string {
  return text.slice(0, MAX_TEXT)
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
    .replace(/(`{3,}|~{3,})[\s\S]*?(?:\1|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\b(?:https?|ftp):\/\/\S+/gi, " ")
    .replace(/\S*[/\\]\S*|\S+\.[A-Za-z0-9]{1,5}\b/g, " ")
    .replace(/[@#][\w-]+/g, " ")
    .replace(/\b\w*[_\d]\w*\b/g, " ")
}

/**
 * The language `text` is written in, or undefined when it is too short, mixed or unclear. A non-Latin script decides by its share
 * of the letters; otherwise each Latin-script language scores its function words, spelling marks and word endings, and the best
 * one must clearly lead. English wins only by leading too: an unclear text is undefined, which callers read as English.
 */
export function detectLanguage(text: string): string | undefined {
  const clean = prose(text)
  const letters = clean.match(/\p{L}/gu)?.length ?? 0
  if (letters < MIN_LETTERS) return undefined
  for (const script of SCRIPTS) {
    const count = clean.match(script.pattern)?.length ?? 0
    if (count && count / letters >= script.share) return script.language(clean)
  }
  const tokens = (clean.toLowerCase().match(/[\p{L}\p{M}'’]+/gu) ?? []).map((token) => token.replace(/^['’]+|['’]+$/g, "")).filter(Boolean)
  if (tokens.length < MIN_WORDS) return undefined
  const [best, second] = scoreLatin(clean, tokens) as [{ language: string; score: number }, { language: string; score: number }]
  if (best.score < MIN_SCORE || best.score < MARGIN * second.score) return undefined
  return best.language
}

/** Each Latin-script language's score for `text` (function words, word endings, spelling marks), best first. */
export function latinScores(text: string): Array<{ language: string; score: number }> {
  const clean = prose(text)
  return scoreLatin(clean, (clean.toLowerCase().match(/[\p{L}\p{M}'’]+/gu) ?? []).map((token) => token.replace(/^['’]+|['’]+$/g, "")).filter(Boolean))
}

function scoreLatin(clean: string, tokens: readonly string[]): Array<{ language: string; score: number }> {
  return LATIN.map((entry) => {
    let score = 0
    for (const token of tokens) {
      if (entry.words.has(token)) score += 1
      if (entry.suffix?.test(token) && token.length > 5) score += 1
    }
    score += 2 * (clean.toLowerCase().match(entry.marks ?? /$^/gu)?.length ?? 0)
    return { language: entry.language, score }
  }).sort((a, b) => b.score - a.score)
}

/** The language of a pull request's author from its title and description; English when they say too little or nothing clear. */
export function pullRequestLanguage(pullRequest: { title?: string | undefined; body?: string | undefined } | undefined): string {
  return detectLanguage(`${pullRequest?.title ?? ""}\n\n${pullRequest?.body ?? ""}`) ?? REVIEW_LANGUAGE
}

/**
 * The language of one pull request's reviews. A named `configured` language is used as it is (nothing to keep). `auto` uses the
 * language already kept for this PR (`stored`, from its review state or its last review's marker), else detects it from the PR's
 * title and description; `stored` in the answer is what the PR's state keeps from now on, so later heads read in the same language.
 */
export function resolveReviewLanguage({ configured, stored, pullRequest }: { configured?: string | undefined; stored?: string | undefined; pullRequest?: { title?: string | undefined; body?: string | undefined } | undefined }): { language: string; stored?: string } {
  // No config read (a checkout without the base commit): the default, English, never `auto`.
  const named = configured ?? REVIEW_LANGUAGE
  if (!isAutoLanguage(named)) return { language: named }
  const language = isLanguageName(stored) ? stored : pullRequestLanguage(pullRequest)
  return { language, stored: language }
}

/** `config` with its review language resolved: every prompt and harness setting built from it then names a real language. */
export function withReviewLanguage<C extends { template: { language: string } }>(config: C, language: string): C {
  return config.template.language === language ? config : { ...config, template: { ...config.template, language } }
}

/** The hidden marker a review body carries for a resolved `auto` language, so a hosted runner with no local state keeps it. */
export const languageMarker = (language: string) => `<!-- mendcode:language=${language} -->`
/** Only the marker right before the body's head marker (template.ts writes it there), so model-written text above cannot set it. */
const LANGUAGE_MARKER = /<!-- mendcode:language=([^<>\n]{1,40}) -->\s*<!-- mendcode:review head=/gu

/** The language the newest marked review body kept (`bodies` oldest first), or undefined. A marker that is no language name is ignored. */
export function languageFromMarkers(bodies: readonly string[]): string | undefined {
  for (const body of [...bodies].reverse()) {
    const found = [...body.matchAll(LANGUAGE_MARKER)].map((match) => match[1]!).filter(isLanguageName).at(-1)
    if (found) return found
  }
  return undefined
}
