import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"

export const OPERATOR_GUIDE_TEMPLATE = "packages/daemon/prompts/operator-guide.template.md"
export const OPERATOR_GUIDE_FILE = "packages/daemon/prompts/operator-guide.md"
/** The reference cards `mendcode docs` prints (doc-cards.ts); the guide only names their topics. */
export const CARDS_DIR = "packages/daemon/cards"

/** A slash command written in backticks (`/tier `, `/tier`): how the docs and the authored templates cite one. */
const SLASH = /`\/([a-z][a-z0-9-]*)(?=[ `\[|<])/g
/** A slash command in running text (`/theme <name>`, `(/tier)`): not a path (`/bin/sh`, `a/b`) and not a URL. */
const SLASH_IN_TEXT = /(?<![\w/.:~<>-])\/([a-z][a-z0-9-]*)(?![\w/.-]*\/)(?=[\s,;:)"'`]|\.(?:\s|$)|$)/g

export const readRepoFile = (root: string, file: string) => readFileSync(path.join(root, file), "utf8")

/** Every doc in docs/, joined: what a template may name must be written somewhere in it. */
export const docsCorpus = (root: string) => readdirSync(path.join(root, "docs")).filter((name) => name.endsWith(".md")).map((name) => readRepoFile(root, `docs/${name}`)).join("\n")

/** The slash commands a text names, in backticks or in running text. */
export function slashCommands(text: string) {
  return [...new Set([...text.matchAll(SLASH), ...text.matchAll(SLASH_IN_TEXT)].map((match) => match[1]!))]
}

/** Everything the template may name must exist in the docs: a slash command, a `docs/*.md` path, a `[[setting:name]]` key. */
export function validateTemplate({ template, corpus, root, label }: { template: string; corpus: string; root: string; label: string }) {
  const problems: string[] = []
  const documented = new Set([...corpus.matchAll(SLASH)].map((match) => match[1]!))
  for (const name of slashCommands(template)) if (!documented.has(name)) problems.push(`slash command /${name} is not in docs/`)
  for (const [, name] of template.matchAll(/\[\[setting:([A-Za-z_][\w]*)\]\]/g)) if (!corpus.includes(name!)) problems.push(`setting ${name} is not in docs/`)
  for (const [file] of template.matchAll(/docs\/[\w-]+\.md/g)) if (!readdirSync(path.join(root, "docs")).includes(path.basename(file))) problems.push(`${file} does not exist`)
  if (problems.length) throw new Error(`[GUIDE]: ${label} names things the docs do not: ${problems.join("; ")}`)
}

/** The card topics, from the files of the cards folder (a card is a file: adding one adds a topic). */
export const cardTopics = (root: string) => readdirSync(path.join(root, CARDS_DIR)).filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3)).sort()

/**
 * The operator's guide `full` mode sends: the authored template with the card topics filled in, validated against the docs. It cites no
 * repository path (a user's machine has none); `{{program}}` is left for the runtime, which knows the name the user typed.
 */
export function operatorGuide(root: string) {
  const template = readRepoFile(root, OPERATOR_GUIDE_TEMPLATE)
  validateTemplate({ template, corpus: docsCorpus(root), root, label: OPERATOR_GUIDE_TEMPLATE })
  return template.replace("{{topics}}", () => cardTopics(root).join(", ")).replace(/\[\[setting:([A-Za-z_]\w*)\]\]/g, "`$1`")
}
