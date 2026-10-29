import { PROGRAM_NAME } from "@mendcode/program"

/** `mendcode docs [topic...]`: the reference cards of this installed version. Reads local files and, when one runs, asks a daemon; never starts one. */
export const DOCS_USAGE = `usage: ${PROGRAM_NAME} docs [topic...]\n  docs                  list the topics, one line each\n  docs --search WORDS   the cards that answer plain words (up to 5, best first, each with its best matching line); then print one with docs TOPIC\n  docs TOPIC [TOPIC...] print each reference card for this installed version, in order: the exact command, file or slash command that makes the change, and live facts of this machine. A word that is no topic is named with its nearest topics and does not stop the others\n  docs commands NAME    one built-in slash command in detail (group, alias, tier, what your profile says); the word after commands is a command name unless it is a topic, and /NAME always is one\n  --dir D | --data-dir D   the data directory the live lines read (default: MENDCODE_V2_DIR or ~/.mendcode-v2)\n  Works offline. Exit codes: 0 at least one card printed · 2 no card printed (the topic list follows) · 64 usage\n`

/** The most words one call takes: the cards are read in one go, so a call that names more is a mistake, not a request. */
export const DOCS_MAX_WORDS = 8

/** `words` are the plain words after `docs`, in order; which are topics and which a command name is decided where the cards are known (`resolveDocsWords`). */
export type DocsCommand = { help: boolean; words: string[]; dir?: string; error?: string; /** `--search`: the words are a query, not topics. */ search?: true }

const VALUES = new Set(["dir", "data-dir"])

export function parseDocsCommand(argv: string[]): DocsCommand | undefined {
  const words: string[] = []
  let dir: string | undefined
  let help = false
  let search = false
  let error: string | undefined
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    if (token === "--help" || token === "-h") help = true
    else if (token === "--search") search = true
    else if (token.startsWith("--")) {
      const [name, inline] = token.slice(2).split(/=(.*)/s, 2)
      if (!VALUES.has(name!)) { error ??= `unknown flag ${token}`; continue }
      const value = inline ?? argv[++index]
      if (!value || value.startsWith("--")) error ??= `--${name} needs a value`
      else dir = value
    } else words.push(token)
  }
  if (words[0] !== "docs") return undefined
  const asked = words.slice(1)
  if (asked.length > DOCS_MAX_WORDS) error ??= `docs takes at most ${DOCS_MAX_WORDS} words`
  if (search && !asked.length && !help) error ??= "--search needs words"
  return { help, words: asked, ...(search ? { search: true as const } : {}), ...(dir ? { dir } : {}), ...(error ? { error } : {}) }
}

/** One thing a call asks for: a card by the word the user typed, or one built-in command in detail. */
export type DocsRequest = { kind: "topic"; word: string } | { kind: "command"; name: string }

/**
 * The words of a call as requests. The word right after `commands` is a command name (`docs commands changes`) unless it names a
 * topic or an alias (`docs commands footer` prints both cards), and a leading slash always makes it a command name (`docs commands /footer`).
 * Anything else is a topic word, so an unknown one is reported while the others still print.
 */
export function resolveDocsWords(words: readonly string[], isTopic: (word: string) => boolean, isCommandsTopic: (word: string) => boolean): DocsRequest[] {
  const requests: DocsRequest[] = []
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!
    const next = words[index + 1]
    if (isCommandsTopic(word) && next !== undefined && (next.startsWith("/") || !isTopic(next))) {
      requests.push({ kind: "command", name: next.replace(/^\//, "") })
      index++
    } else requests.push({ kind: "topic", word })
  }
  return requests
}
