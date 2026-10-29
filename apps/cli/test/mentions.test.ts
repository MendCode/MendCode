import { describe, expect, test } from "bun:test"
import { commandMentions, findMentionToken, findSlashToken, hoistCommand, renderMentionSuggestions, type MentionEntry } from "../src/view/mentions"
import { textWidth } from "../src/view/wrap"

const text = (line: { text: string }[]) => line.map((span) => span.text).join("")

describe("findMentionToken", () => {
  test("an @ at line start with the cursor right after it is a mention with an empty query", () => {
    expect(findMentionToken("@", 1)).toEqual({ start: 0, query: "" })
  })
  test("an @ preceded by whitespace starts a mention", () => {
    expect(findMentionToken("see @src/app", 12)).toEqual({ start: 4, query: "src/app" })
  })
  test("the query is only what is before the cursor, not the rest of the token", () => {
    expect(findMentionToken("see @src/app.ts more", 8)).toEqual({ start: 4, query: "src" })
  })
  test("an @ preceded by a non-space character (an email-like token) is not a mention", () => {
    expect(findMentionToken("mail me@x.com", 13)).toBeUndefined()
  })
  test("whitespace between @ and the cursor closes the mention", () => {
    expect(findMentionToken("@src is a path", 8)).toBeUndefined()
  })
  test("no @ before the cursor is not a mention", () => {
    expect(findMentionToken("just text", 5)).toBeUndefined()
  })
  test("cursor before any text on the line is not a mention", () => {
    expect(findMentionToken("@src", 0)).toBeUndefined()
  })
  test("indexes graphemes, so an emoji before @ still counts as whitespace-free but does not break the scan", () => {
    expect(findMentionToken("🚀 @src", 6)).toEqual({ start: 2, query: "src" })
  })
})

describe("renderMentionSuggestions", () => {
  const entries: MentionEntry[] = [
    { path: "src/view/mentions.ts", kind: "file" },
    { path: "src/view", kind: "dir" },
    { path: "README.md", kind: "file" },
  ]

  test("empty input renders nothing", () => expect(renderMentionSuggestions([], 80)).toEqual([]))

  test("shows @path for files and @path/ for directories", () => {
    const lines = renderMentionSuggestions(entries, 80)
    expect(text(lines[0]!)).toBe("@src/view/mentions.ts")
    expect(text(lines[1]!)).toBe("@src/view/")
  })

  test("first entry is highlighted by default; selection moves the highlight", () => {
    expect(renderMentionSuggestions(entries, 80)[0]![0]).toMatchObject({ fg: "primary", bold: true })
    const selected = renderMentionSuggestions(entries, 80, 1)
    expect(selected[1]![0]).toMatchObject({ fg: "primary", bold: true })
    expect(selected[0]![0]!.bold).toBeUndefined()
  })

  test("at most 8 rows, in a window that follows the selection", () => {
    const many: MentionEntry[] = Array.from({ length: 20 }, (_, i) => ({ path: `pkg/file-${i}.ts`, kind: "file" }))
    expect(renderMentionSuggestions(many, 80)).toHaveLength(8)
    const last = renderMentionSuggestions(many, 80, 19)
    expect(last).toHaveLength(8)
    expect(text(last.at(-1)!)).toBe("@pkg/file-19.ts")
  })

  test.each([40, 60, 80, 100, 140])("never exceeds width %i", (width) => {
    const many: MentionEntry[] = [{ path: "a/very/long/nested/path/that/keeps/going/and/going/file.ts", kind: "file" }, ...entries]
    for (const line of renderMentionSuggestions(many, width)) expect(textWidth(text(line))).toBeLessThanOrEqual(width)
  })
})

describe("mid-prompt slash commands", () => {
  const commands = [{ name: "review", summary: "Review code", custom: true as const }, { name: "fix", summary: "", custom: true as const }, { name: "model", summary: "built-in" }]
  test("a /name after other text is a token; the prompt's own leading / and paths are not", () => {
    expect(findSlashToken("explain this /rev", 17, true)).toEqual({ start: 13, query: "rev", slash: true })
    expect(findSlashToken("/rev", 4, true)).toBeUndefined()
    expect(findSlashToken("/rev", 4, false)).toEqual({ start: 0, query: "rev", slash: true })
    expect(findSlashToken("open src/a", 10, true)).toBeUndefined()
    expect(findSlashToken("cat /usr/bin", 12, true)).toBeUndefined()
  })
  test("only custom commands and skills are suggested, prefix matches first", () => {
    expect(commandMentions(commands, "").map((entry) => entry.path)).toEqual(["review", "fix"])
    expect(commandMentions(commands, "i").map((entry) => entry.path)).toEqual(["review", "fix"])
    expect(commandMentions(commands, "f")).toEqual([{ path: "fix", kind: "command" }])
  })
  test("sending moves a known command named mid-prompt to the front with the rest as its arguments", () => {
    expect(hoistCommand("explain the parser /review please", commands)).toBe("/review explain the parser please")
    expect(hoistCommand("/fix", commands)).toBeUndefined()
    expect(hoistCommand("look at /usr/bin and /model", commands)).toBeUndefined()
    expect(hoistCommand("broken build\n/fix", commands)).toBe("/fix broken build")
  })
})
