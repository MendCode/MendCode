import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Settings } from "../../protocol/src/queries"
import { EXPERIMENTAL_FLAGS } from "@mendcode/protocol/wire"
import { CUSTOMIZE_ROWS } from "../../../apps/cli/src/view/customize-page"
import { cardMentions, cardSource, coverageSources, coverageTable, docsOf, itemKind, itemName, KINDS, readCoverage } from "../../../scripts/docs-coverage"
import { docCards } from "../src/doc-cards"

const repo = path.resolve(import.meta.dir, "../../..")
const cards = docCards(repo).cards
const map = readCoverage(repo)
const sources = coverageSources(repo)
const words = (text: string) => text.split(/\s+/).filter(Boolean)
const mapped = Object.entries(map.cards).flatMap(([topic, items]) => words(items).map((item) => ({ topic, item })))
const excluded = map.internal.flatMap((entry) => words(entry.items))
const knownItems = new Set(KINDS.flatMap((kind) => sources[kind].map((name) => `${kind}:${name.replaceAll(" ", "_")}`)))

describe("docs coverage: every thing a user can ask about has one card or a stated reason", () => {
  test("no tier feature, experimental flag, slash command, customize group, daemon setting, model tool, config file or doc is left without a card or an internal exclusion", () => {
    const table = coverageTable(repo, map, cards)
    expect(table.map((row) => [row.kind, row.missing])).toEqual(KINDS.map((kind) => [kind, []]))
  })
  test("an item belongs to exactly one place: one card, or the internal list", () => {
    const places = [...mapped.map((entry) => entry.item), ...excluded]
    const seen = new Set<string>()
    const twice = places.filter((item) => seen.size === seen.add(item).size)
    expect(twice).toEqual([])
  })
  test("the map names only things that exist, and only cards that exist", () => {
    const stale = [...mapped.map((entry) => entry.item), ...excluded].filter((item) => !knownItems.has(item) && !(itemKind(item) === "doc" && sources.doc.includes(itemName(item))))
    expect(stale).toEqual([])
    const topics = new Set(cards.map((card) => card.topic))
    expect(Object.keys(map.cards).filter((topic) => !topics.has(topic))).toEqual([])
    expect(map.deferred?.cards.filter((topic) => !topics.has(topic)) ?? []).toEqual([])
  })
  test("every exclusion states its reason", () => {
    for (const entry of map.internal) expect(entry.reason.length).toBeGreaterThan(20)
    expect(map.internal.every((entry) => words(entry.items).length > 0)).toBe(true)
  })
  test("the card a thing maps to names it, in the way a model would find it there", () => {
    const deferred = new Set(map.deferred?.cards ?? [])
    const unnamed = mapped.filter(({ topic, item }) => itemKind(item) !== "doc" && !deferred.has(topic)).filter(({ topic, item }) => {
      const card = cards.find((entry) => entry.topic === topic)!
      const name = itemKind(item) === "group" ? itemName(item).replaceAll("_", " ") : itemName(item)
      return !cardMentions(`${itemKind(item)}:${name}`, card.text, cardSource(repo, topic))
    })
    expect(unnamed.map(({ topic, item }) => `${item} -> ${topic}`)).toEqual([])
  })
  test("a doc counts as covered when a card stands on it, and no card stands on a doc that does not exist", () => {
    for (const card of cards) for (const doc of docsOf(repo, card.topic)) expect([card.topic, doc, sources.doc.includes(doc)]).toEqual([card.topic, doc, true])
  })
})

describe("docs cards keep their promises", () => {
  test("every `docs TOPIC` a card points to is a card or an alias of one", () => {
    const known = new Set(cards.flatMap((card) => [card.topic, ...card.aliases]))
    const dangling = cards.flatMap((card) => [...card.text.matchAll(/ docs ([a-z][a-z-]*)/g)].map((match) => match[1]!).filter((word) => !known.has(word) && !["commands", "NAME", "WORDS"].includes(word)).map((word) => `${card.topic} -> ${word}`))
    expect(dangling).toEqual([])
  })
  test("every [[setting:key]] names a daemon setting, a terminal profile row or an experimental flag", () => {
    const settings = new Set(Object.keys((Settings as unknown as { shape: Record<string, unknown> }).shape))
    const known = new Set([...settings, ...CUSTOMIZE_ROWS, ...EXPERIMENTAL_FLAGS.map((flag) => flag.id)])
    const unknown = cards.flatMap((card) => [...cardSource(repo, card.topic).matchAll(/\[\[setting:([A-Za-z_]+)\]\]/g)].map((match) => match[1]!).filter((key) => !known.has(key)).map((key) => `${card.topic} -> ${key}`))
    expect(unknown).toEqual([])
  })
})
