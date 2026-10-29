import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import cardIndex from "../cards/cards.generated.json"
import { SEARCH_LINE_CHARS, SEARCH_MAX_HITS, SEARCH_MAX_WORDS, cardTerms, queryStems, searchCards, stem, wordsOf, type SearchCard } from "../src/doc-search"

const repo = path.resolve(import.meta.dir, "../../..")
const cards = cardIndex.cards as SearchCard[]

const small: SearchCard[] = [
  { topic: "alpha", summary: "paint the walls", aliases: ["color"], text: "Paint walls with a brush.\nUse two coats.", terms: cardTerms({ summary: "paint the walls", text: "Paint walls with a brush.\nUse two coats." }) },
  { topic: "beta", summary: "cook dinner", aliases: [], text: "Boil water.\nAdd salt and pasta, then drain the pasta.", terms: cardTerms({ summary: "cook dinner", text: "Boil water.\nAdd salt and pasta, then drain the pasta." }) },
]

describe("doc search: words", () => {
  test("a word loses its plural and -ing/-ed ending, nothing smarter", () => {
    expect(["agents", "agent", "agenting"].map(stem)).toEqual(["agent", "agent", "agent"])
    expect(["queries", "boxes", "passes", "status", "class"].map(stem)).toEqual(["query", "box", "pass", "status", "class"])
    expect(["worked", "tab", "is"].map(stem)).toEqual(["work", "tab", "is"])
  })
  test("a hyphenated word is found whole and by its parts", () => {
    expect(wordsOf("Sub-agents run in the file_viewer")).toEqual(["sub-agents", "sub", "agents", "run", "in", "the", "file_viewer", "file", "viewer"])
  })
  test("a camelCase setting name is found whole and by its parts; a capitalised name stays whole", () => {
    expect(wordsOf("global contextWindow settings")).toEqual(["global", "contextwindow", "context", "window", "settings"])
    expect(wordsOf("compactAtTokens")).toEqual(["compactattokens", "compact", "at", "tokens"])
    expect(wordsOf("MendCode runs PreToolUse hooks")).toEqual(["mendcode", "runs", "pretooluse", "hooks"])
    expect(queryStems(["contextWindow"])).toEqual(["contextwindow", "context", "window"])
  })
  test("what a model typed when it looked for the window and the compaction point finds the card that answers, first", () => {
    const first = (query: string) => searchCards(query.split(" "), cards)[0]!.topic
    for (const query of ["context compaction", "compaction settings", "context window", "context-window reset", "global contextWindow settings", "compactAtTokens", "where does it compact"]) expect([query, first(query)]).toEqual([query, "compaction"])
    expect(first("settings config file")).toBe("settings")
    expect(searchCards(["global", "contextWindow", "settings"], cards).slice(0, 2).map((hit) => hit.topic)).toEqual(["compaction", "settings"])
  })
  test("a query drops stop words and one-letter words, merges repeats, and keeps at most eight stems", () => {
    expect(queryStems(["how", "do", "I", "pause", "the", "agents", "agent"])).toEqual(["do", "pause", "agent"])
    expect(queryStems(["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"])).toHaveLength(SEARCH_MAX_WORDS)
  })
  test("a card's index holds distinct stems, sorted, at most 160", () => {
    const terms = cardTerms({ summary: "Paint walls", text: "Paint paint paint the walls with 2 brushes" }).split(" ")
    expect(terms).toEqual([...terms].sort())
    expect(new Set(terms).size).toBe(terms.length)
    expect(terms).toContain("wall")
    expect(terms).not.toContain("the")
    for (const card of cards) expect(card.terms.split(" ").length).toBeLessThanOrEqual(160)
  })
})

describe("doc search: ranking", () => {
  test("a card's own name beats a word of its summary beats a word in its text", () => {
    expect(searchCards(["color"], small).map((hit) => hit.topic)).toEqual(["alpha"])
    expect(searchCards(["dinner"], small)[0]).toMatchObject({ topic: "beta", score: 4 })
    expect(searchCards(["pasta"], small)[0]).toMatchObject({ topic: "beta", score: 2 })
  })
  test("a card that answers more of the words ranks first, and a miss returns nothing", () => {
    expect(searchCards(["paint", "brush"], small)[0]!.topic).toBe("alpha")
    expect(searchCards(["zzzz"], small)).toEqual([])
    expect(searchCards(["the", "and"], small)).toEqual([])
  })
  test("at most five hits, ties keep the card order, and the matching line is cut to a readable length", () => {
    const many = Array.from({ length: 9 }, (_, at) => ({ ...small[0]!, topic: `card${at}`, aliases: [] }))
    expect(searchCards(["paint"], many).map((hit) => hit.topic)).toEqual(["card0", "card1", "card2", "card3", "card4"])
    expect(SEARCH_MAX_HITS).toBe(5)
    const long = [{ ...small[0]!, text: `${"filler ".repeat(60)}brush ${"tail ".repeat(60)}`, terms: "brush" }]
    expect(searchCards(["brush"], long)[0]!.line.length).toBeLessThanOrEqual(SEARCH_LINE_CHARS + 6)
    expect(searchCards(["brush"], long)[0]!.line).toContain("brush")
  })
  test("the best line is the one with most of the words", () => {
    expect(searchCards(["boil", "water"], small)[0]!.line).toBe("Boil water.")
    expect(searchCards(["pasta", "salt"], small)[0]!.line).toBe("Add salt and pasta, then drain the pasta.")
  })
})

type Request = { id: string; text: string; words: string; expect: string; also: string[]; path: string; wrong: string }
const evalFile = path.join(repo, ".agents/evals/docs-cards/requests.json")

describe("doc search: the 40 requests", () => {
  const requests = existsSync(evalFile) ? (JSON.parse(readFileSync(evalFile, "utf8")) as { requests: Request[] }).requests : []
  const topics = new Set(cards.map((card) => card.topic))
  test("the set is 40 distinct requests, each with a real expected card, a path and a wrong answer", () => {
    expect(requests).toHaveLength(40)
    expect(new Set(requests.map((request) => request.id)).size).toBe(40)
    for (const request of requests) {
      expect([request.id, topics.has(request.expect), request.also.every((topic) => topics.has(topic))]).toEqual([request.id, true, true])
      expect([request.id, request.path.length > 20, request.wrong.length > 10, request.text.length > 3]).toEqual([request.id, true, true, true])
    }
  })
  test("the expected card is in the top three of `docs --search` for every request", () => {
    const missed = requests.filter((request) => !searchCards(request.words.split(/\s+/), cards).slice(0, 3).some((hit) => hit.topic === request.expect))
    expect(missed.map((request) => `${request.id}: ${request.words}`)).toEqual([])
  })
  test("both languages are present, so the set is not only English", () => {
    const spanish = requests.filter((request) => /[áéíóúñ¿]|\b(el|la|los|las|mi|ponme|quiero|como|por)\b/i.test(request.text))
    expect(spanish.length).toBeGreaterThanOrEqual(10)
    expect(requests.length - spanish.length).toBeGreaterThanOrEqual(10)
  })
})
