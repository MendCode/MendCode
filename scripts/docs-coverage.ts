// Docs coverage: every thing a user can ask their MendCode to do or configure, and the one reference card that answers it, or the reason it has none.
// `bun scripts/docs-coverage.ts` prints the table; `--missing` lists what has no card; `--before` counts what no card mentions at all (the map is not read).
// The map is packages/daemon/cards/coverage.json, next to the card files; packages/daemon/test/doc-coverage.test.ts keeps it true.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { SLASH_COMMANDS } from "../apps/cli/src/view/commands"
import { GROUPS } from "../apps/cli/src/view/customize-page"
import { EXPERIMENTAL_FLAGS, FEATURES, FEATURE_IDS } from "../packages/protocol/src/wire"
import { Settings } from "../packages/protocol/src/queries"
import { CARDS_DIR, slashCommands } from "../packages/daemon/src/operator-guide"
import { docCards, parseCardSource, type Card } from "../packages/daemon/src/doc-cards"

export const COVERAGE_FILE = `${CARDS_DIR}/coverage.json`
export const KINDS = ["feature", "flag", "command", "group", "setting", "tool", "file", "doc"] as const
export type Kind = (typeof KINDS)[number]
/** `cards`: card topic -> the items it answers, as `kind:name` words. `internal`: items no card is for, each group with its reason. */
export type CoverageMap = {
  cards: Record<string, string>
  internal: Array<{ reason: string; items: string }>
  /** Cards another change is rewriting: the item must still map to exactly one card, but the card's text is not read. */
  deferred?: { cards: string[]; reason: string }
}
export type Item = `${Kind}:${string}`

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name)
    if (statSync(file).isDirectory()) { if (name !== "node_modules") yield* sourceFiles(file) }
    else if (file.endsWith(".ts") && !file.endsWith(".d.ts")) yield file
  }
}
const sourceRoots = (root: string) => [...readdirSync(path.join(root, "packages")).map((name) => path.join(root, "packages", name, "src")), path.join(root, "apps/cli/src")].filter((dir) => existsSync(dir))

/** The model tools of the code: a tool is declared with `defineTool`, as a `Tool` object, with a `spec(...)` or as `name` then `description`. */
const TOOL_DECLARATIONS = [/(?:defineTool(?:<[^>]*>)?\(\{|:\s*Tool\s*=\s*\{)\s*\n?\s*name:\s*"([a-z][a-z0-9_]*)"/g, /\bname:\s*"([a-z][a-z0-9_]*)",?\s*\n?\s*description:/g, /\bspec\(\s*"([a-z][a-z0-9_]*)"/g]
/** Files whose `name`/`description` pairs are agents or tickets, not tools. */
const NOT_TOOL_FILES = new Set(["packages/daemon/src/agents.ts", "packages/daemon/src/http.ts"])

/** Every item of the code, by kind. Reads the source tree for the tools and the config files; the rest are the code's own lists. */
export function coverageSources(root: string): Record<Kind, string[]> {
  const tools = new Set<string>()
  const files = new Set<string>()
  for (const dir of sourceRoots(root)) for (const file of sourceFiles(dir)) {
    const text = readFileSync(file, "utf8")
    const relative = path.relative(root, file)
    if (!NOT_TOOL_FILES.has(relative)) for (const pattern of TOOL_DECLARATIONS) for (const match of text.matchAll(pattern)) tools.add(match[1]!)
    for (const match of text.matchAll(/"([a-z][a-z0-9-]*\.json)"/g)) files.add(match[1]!)
  }
  const docs = readdirSync(path.join(root, "docs")).filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3))
  return {
    feature: [...FEATURE_IDS],
    flag: EXPERIMENTAL_FLAGS.map((flag) => flag.id),
    command: SLASH_COMMANDS.map((command) => command.name),
    group: GROUPS.map((group) => group.title),
    setting: Object.keys((Settings as unknown as { shape: Record<string, unknown> }).shape).filter((key) => !key.startsWith("$")),
    tool: [...tools].sort(),
    file: [...files].sort(),
    doc: docs,
  }
}

export const itemName = (item: string) => item.slice(item.indexOf(":") + 1)
export const itemKind = (item: string) => item.slice(0, item.indexOf(":")) as Kind
const words = (text: string) => text.split(/\s+/).filter(Boolean)

/** The checked-in map, parsed. */
export function readCoverage(root: string): CoverageMap {
  return JSON.parse(readFileSync(path.join(root, COVERAGE_FILE), "utf8")) as CoverageMap
}

/** Commands that open every setting say nothing about the one feature that names them as its switch. */
const GENERIC_SWITCH = new Set(["/customize", "/tier", "/settings", "/experimental"])

/** Whether a card's text names the item, in the way a model would find it there. Docs are named in a card's header instead. */
export function cardMentions(item: string, text: string, source = ""): boolean {
  const kind = itemKind(item), name = itemName(item)
  const lower = text.toLowerCase()
  const word = (value: string) => new RegExp(`(?<![\\w])${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`, "i").test(text)
  switch (kind) {
    case "command": return slashCommands(text).includes(name)
    case "group": return lower.includes(name.toLowerCase())
    case "feature": {
      const spec = FEATURES[name as keyof typeof FEATURES]
      if (word(name) || lower.includes(spec.label.toLowerCase())) return true
      // The feature's own switch: a slash command or a setting path it names, or the flag that carries it.
      const own = [...spec.own.matchAll(/\/[a-z][a-z-]*(?: [a-z_]+)?|[A-Za-z_]+(?:\.[A-Za-z_]+)+|[A-Z_]{6,}|\b[a-z]+[A-Z][A-Za-z]+\b/g)].map((match) => match[0]).filter((token) => !GENERIC_SWITCH.has(token.split(" ")[0]!))
      return own.some((token) => token.startsWith("/") ? word(token) : lower.includes(token.toLowerCase())) || (spec.flag !== undefined && word(spec.flag))
    }
    case "file": return word(name)
    // A key that is also a common word (tier, tools, shell, models) counts only as the card's own `[[setting:key]]`; a distinctive one by its name.
    case "setting": return source.includes(`[[setting:${name}]]`) || /[A-Z_]/.test(name) && word(name)
    default: return word(name)
  }
}

export type Row = { kind: Kind; total: number; mapped: number; internal: number; missing: string[] }

/** Per kind: how many items there are, how many a card answers, how many are excluded, and which are neither. */
export function coverageTable(root: string, map: CoverageMap, cards: readonly Card[]): Row[] {
  const sources = coverageSources(root)
  const inCard = new Set(Object.values(map.cards).flatMap(words))
  const excluded = new Set(map.internal.flatMap((entry) => words(entry.items)))
  const documented = new Set(cards.flatMap((card) => docsOf(root, card.topic)))
  return KINDS.map((kind) => {
    const names = sources[kind]
    const covered = (name: string) => kind === "doc" ? documented.has(name) : inCard.has(`${kind}:${name.replaceAll(" ", "_")}`)
    return {
      kind,
      total: names.length,
      mapped: names.filter((name) => covered(name)).length,
      internal: names.filter((name) => !covered(name) && excluded.has(`${kind}:${name.replaceAll(" ", "_")}`)).length,
      missing: names.filter((name) => !covered(name) && !excluded.has(`${kind}:${name.replaceAll(" ", "_")}`)),
    }
  })
}

/** The authored file of a card, placeholders unfilled. */
export const cardSource = (root: string, topic: string) => readFileSync(path.join(root, CARDS_DIR, `${topic}.md`), "utf8")

/** The `docs:` header of a card source. */
export function docsOf(root: string, topic: string): string[] {
  return parseCardSource(topic, cardSource(root, topic)).docs
}

/** Items no card text mentions: the measure before a map exists (docs: not in any card's header). */
export function unmentioned(root: string, cards: readonly Card[]): Record<Kind, { total: number; missing: string[] }> {
  const sources = coverageSources(root)
  const texts = cards.map((card) => ({ text: card.text, source: cardSource(root, card.topic) }))
  const documented = new Set(cards.flatMap((card) => docsOf(root, card.topic)))
  const result = {} as Record<Kind, { total: number; missing: string[] }>
  for (const kind of KINDS) {
    const missing = sources[kind].filter((name) => kind === "doc" ? !documented.has(name) : !texts.some((card) => cardMentions(`${kind}:${name}`, card.text, card.source)))
    result[kind] = { total: sources[kind].length, missing }
  }
  return result
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, "..")
  const cards = docCards(root).cards
  if (process.argv.includes("--before")) {
    const before = unmentioned(root, cards)
    for (const kind of KINDS) console.log(`${kind.padEnd(8)} ${String(before[kind].total).padStart(4)} items · ${String(before[kind].missing.length).padStart(4)} no card mentions${process.argv.includes("--missing") ? `: ${before[kind].missing.join(" ")}` : ""}`)
  } else {
    const rows = coverageTable(root, readCoverage(root), cards)
    console.log("kind      items  card  internal  neither")
    for (const row of rows) console.log(`${row.kind.padEnd(8)} ${String(row.total).padStart(6)} ${String(row.mapped).padStart(5)} ${String(row.internal).padStart(9)} ${String(row.missing.length).padStart(8)}${process.argv.includes("--missing") && row.missing.length ? `  ${row.missing.join(" ")}` : ""}`)
    const sum = (pick: (row: Row) => number) => rows.reduce((total, row) => total + pick(row), 0)
    console.log(`total    ${String(sum((row) => row.total)).padStart(6)} ${String(sum((row) => row.mapped)).padStart(5)} ${String(sum((row) => row.internal)).padStart(9)} ${String(sum((row) => row.missing.length)).padStart(8)}`)
  }
}
