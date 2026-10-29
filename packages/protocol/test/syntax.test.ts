import { expect, test } from "bun:test"
import { highlight, isFreshState, lexEntry, sanitizeState, type HighlightState } from "../src/syntax"

const run = (lines: string[], lang: string) => {
  const state: HighlightState = {}
  return lines.map((line) => highlight(line, lang, state))
}

test("prose in Markdown is the text role, never the code role", () => {
  for (const spans of run(["Plain words in a paragraph.", "More, with a 'quote' and numbers 12."], "md")) expect(spans.every((span) => span.fg === "text")).toBe(true)
})

test("a Markdown heading is bold with the marker alone in the accent, a code span is code, a link address is muted", () => {
  const [heading] = run(["### The title"], "md")
  expect(heading).toEqual([{ text: "### ", fg: "heading", bold: true }, { text: "The title", fg: "text", bold: true }])
  const [mixed] = run(["use `bun test` or [the docs](docs/a.md)"], "md")
  expect(mixed!.find((span) => span.text === "`bun test`")?.fg).toBe("code")
  expect(mixed!.find((span) => span.text === "[the docs]")?.fg).toBe("text")
  expect(mixed!.find((span) => span.text === "(docs/a.md)")?.fg).toBe("muted")
})

test("a block comment carried into a window is a comment until it closes", () => {
  const opened: HighlightState = { block: true }
  expect(highlight("const x = 1 // inside", "ts", opened).every((span) => span.fg === "synComment")).toBe(true)
  expect(opened.block).toBe(true)
  const spans = highlight("end */ const y = 2", "ts", opened)
  expect(spans[0]).toMatchObject({ fg: "synComment" })
  expect(spans.some((span) => span.fg === "synKeyword" && span.text.includes("const"))).toBe(true)
  expect(opened.block).toBeFalsy()
})

test("lexEntry gives the state at the end of the lines it was given, and nothing when everything is closed", () => {
  expect(lexEntry(["/* open", "still open"], "ts")).toEqual({ block: true })
  expect(lexEntry(["/* open", "closed */", "const a = 1"], "rust")).toEqual({})
  expect(lexEntry(['x = """', "text"], "py")).toMatchObject({ triple: expect.anything() })
  expect(lexEntry(["```ts", "const a = 1"], "md")).toMatchObject({ fence: { lang: "ts" } })
  expect(lexEntry(["```ts", "const a = 1", "```", "plain"], "md")).toEqual({})
  expect(isFreshState({})).toBe(true)
  expect(isFreshState({ block: true })).toBe(false)
})

test("the state a client gets from the wire is checked: junk becomes a fresh state, a good one passes", () => {
  for (const junk of [undefined, null, 3, "block", [], { block: "yes" }, { fence: { marker: 7 } }, { fence: "x" }]) expect(isFreshState(sanitizeState(junk))).toBe(true)
  expect(sanitizeState({ block: true })).toEqual({ block: true })
  const fence = sanitizeState({ fence: { marker: "```", lang: "ts", inner: {} } })
  expect(fence.fence).toMatchObject({ marker: "```", lang: "ts" })
})

test("a fenced block in Markdown is highlighted with the language of the fence on the lines inside it", () => {
  const rows = run(["```ts", "const answer = 42 // note", "```", "after the fence"], "md")
  expect(rows[1]!.some((span) => span.fg === "synKeyword")).toBe(true)
  expect(rows[1]!.some((span) => span.fg === "synComment")).toBe(true)
  expect(rows[3]!.every((span) => span.fg === "text")).toBe(true)
})
