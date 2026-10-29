import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { MODEL_ROLES, PROMPT_FAMILIES, PROMPT_MODES, TIERS } from "@mendcode/protocol/wire"
import { cardTerms } from "./doc-search"
import { CARDS_DIR, cardTopics, docsCorpus, readRepoFile, validateTemplate } from "./operator-guide"

/** The checked-in cards `mendcode docs` prints, embedded in the binary (`bun scripts/self-knowledge.ts` regenerates it). */
export const CARDS_FILE = "packages/daemon/cards/cards.generated.json"
export const CARDS_REGENERATE = "bun scripts/self-knowledge.ts"
/** A card is read by a model in one go, so it stays short. Tests hold every card to it. */
export const CARD_BUDGET = { summary: 80, text: 3_000 } as const

/** One reference card: `text` still carries `{{program}}`, which the command fills with the name the user typed. `terms` is the search index of the card (doc-search.ts). */
export type Card = { topic: string; summary: string; aliases: string[]; text: string; terms: string }
export type CardIndex = { revision: string; cards: Card[] }

const TOPIC = /^[a-z][a-z0-9-]{0,39}$/

/** A card source: a header (`summary`, `docs`, `aliases`) between `---` lines, then the text. */
export function parseCardSource(topic: string, source: string) {
  const head = /^---\n([\s\S]*?)\n---\n/.exec(source.replace(/\r\n?/g, "\n"))
  if (!head) throw new TypeError(`[CARDS]: ${topic}: a card file starts with a --- header`)
  const fields: Record<string, string> = {}
  for (const line of head[1]!.split("\n")) {
    const colon = line.indexOf(":")
    if (colon > 0) fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
  }
  const list = (value: string | undefined) => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean)
  return { topic, summary: fields.summary ?? "", docs: list(fields.docs), aliases: list(fields.aliases), text: source.replace(/\r\n?/g, "\n").slice(head[0].length).trim() }
}

/** The build-time values a card may name: they come from the code constants, so a card is exact for the version it ships in. */
const PLACEHOLDERS: Record<string, string> = {
  modes: PROMPT_MODES.join(", "),
  families: ["auto", ...PROMPT_FAMILIES].join(", "),
  tiers: TIERS.join("|"),
  roles: MODEL_ROLES.join(", "),
}

function fill(text: string) {
  return text
    .replace(/\{\{(modes|families|tiers|roles)\}\}/g, (_, key: string) => PLACEHOLDERS[key]!)
    .replace(/\[\[setting:([A-Za-z_]\w*)\]\]/g, "$1")
}

/** The cards of the cards folder, validated against the docs and each other, with a revision that changes whenever a card or a doc it stands on does. */
export function docCards(root: string): CardIndex {
  const corpus = docsCorpus(root)
  const topics = cardTopics(root)
  const docFiles = new Set(readdirSync(path.join(root, "docs")))
  const sources = topics.map((topic) => ({ raw: readRepoFile(root, `${CARDS_DIR}/${topic}.md`), topic }))
  const parsed = sources.map(({ raw, topic }) => parseCardSource(topic, raw))
  const claimed = new Map<string, string>(topics.map((topic) => [topic, topic]))
  const cards: Card[] = []
  const used = new Set<string>()
  for (const card of parsed) {
    const where = `[CARDS]: ${card.topic}`
    if (!TOPIC.test(card.topic)) throw new Error(`${where}: a topic is lowercase letters, digits and hyphens (up to 40)`)
    if (!card.summary || card.summary.length > CARD_BUDGET.summary || /[\n{]/.test(card.summary)) throw new Error(`${where}: summary is one plain line of at most ${CARD_BUDGET.summary} characters`)
    if (!card.docs.length) throw new Error(`${where}: docs names the docs/ files the card stands on`)
    for (const doc of card.docs) {
      if (!docFiles.has(`${doc}.md`)) throw new Error(`${where}: docs/${doc}.md does not exist`)
      used.add(doc)
    }
    for (const alias of card.aliases) {
      if (!TOPIC.test(alias)) throw new Error(`${where}: alias ${alias} is not a valid topic word`)
      if (claimed.has(alias)) throw new Error(`${where}: alias ${alias} is already the topic or alias of ${claimed.get(alias)}`)
      claimed.set(alias, card.topic)
    }
    validateTemplate({ template: card.text, corpus, root, label: `${CARDS_DIR}/${card.topic}.md` })
    if (/docs\/[\w-]+\.md/.test(card.text)) throw new Error(`${where}: a card cites no repository path: the user's machine has none`)
    const text = fill(card.text)
    if (text.length > CARD_BUDGET.text) throw new Error(`${where}: ${text.length} characters, over the ${CARD_BUDGET.text} budget`)
    cards.push({ topic: card.topic, summary: card.summary, aliases: card.aliases, text, terms: cardTerms({ summary: card.summary, text }) })
  }
  const hash = createHash("sha256")
  for (const { raw, topic } of sources) hash.update(topic).update("\0").update(raw).update("\0")
  for (const doc of [...used].sort()) hash.update(readFileSync(path.join(root, `docs/${doc}.md`))).update("\0")
  return { revision: hash.digest("hex").slice(0, 16), cards }
}

/** The index file's text: stable keys and a trailing newline, so the stale check is a plain comparison. */
export const cardIndexText = (index: CardIndex) => `${JSON.stringify(index, null, 1)}\n`
