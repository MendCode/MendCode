import { describe, expect, test } from "bun:test"
import { parseSlash, renderSuggestions, runsOnSelect, SLASH_COMMANDS, slashSuggestions } from "../src/view/commands"
import { textWidth } from "../src/view/wrap"

const text = (line: { text: string }[]) => line.map((span) => span.text).join("")

describe("parseSlash", () => {
  test("exact name", () => expect(parseSlash("/new")?.command.name).toBe("new"))
  test("alias resolves to its command", () => {
    expect(parseSlash("/resume")?.command.name).toBe("sessions")
    expect(parseSlash("/q")?.command.name).toBe("quit")
    expect(parseSlash("/?")?.command.name).toBe("help")
  })
  test("args are split off and trimmed", () => {
    const parsed = parseSlash("/usage   30 days  ")
    expect(parsed?.command.name).toBe("usage")
    expect(parsed?.args).toBe("30 days")
    expect(parseSlash("/usage")?.args).toBe("")
  })
  test("unknown, partial and bare slash are not commands", () => {
    expect(parseSlash("/foo")).toBeUndefined()
    expect(parseSlash("/us")).toBeUndefined()
    expect(parseSlash("/")).toBeUndefined()
    expect(parseSlash("/ new")).toBeUndefined()
  })
  test("leading space, double slash and plain text are not commands", () => {
    expect(parseSlash(" /new")).toBeUndefined()
    expect(parseSlash("//new")).toBeUndefined()
    expect(parseSlash("new")).toBeUndefined()
    expect(parseSlash("")).toBeUndefined()
  })
  test("is case-insensitive", () => expect(parseSlash("/NEW")?.command.name).toBe("new"))
})

describe("slashSuggestions", () => {
  const names = (text: string) => slashSuggestions(text).map((c) => c.name)
  test("a bare slash lists every command alphabetically", () => expect(names("/")).toEqual(SLASH_COMMANDS.map((c) => c.name).sort()))
  test("prefix on name ranks first", () => expect(names("/us")[0]).toBe("usage"))
  test("an alias matches", () => expect(names("/resu")[0]).toBe("sessions"))
  test("a name prefix beats a scattered match", () => {
    const found = names("/s")
    expect(found.slice(0, 3)).toEqual(["stop", "setup", "share"])
    for (const prefixed of ["setup", "status"]) expect(found).toContain(prefixed)
    expect(names("/sett")).toContain("settings")
    expect(names("/sto")).toContain("storage")
    // Ten rows only: a scattered match like `model` may not make the list at all, but never comes before a prefix match.
    const scattered = found.indexOf("model")
    expect(scattered === -1 || found.indexOf("setup") < scattered).toBe(true)
  })
  test("matching is tiered: a word-start run or a one-letter slip finds the command, two scattered letters do not", () => {
    expect(names("/lp")).toEqual([])
    expect(names("/lops")).toContain("loops")
    expect(names("/ctx")).toContain("context")
  })
  test("a query never returns more than the ten rows v1 shows", () => expect(names("/e").length).toBeLessThanOrEqual(10))
  test("no matches", () => expect(names("/zzz")).toEqual([]))
  test("empty when not a slash prompt, has a space, or starts with //", () => {
    expect(names("hello")).toEqual([])
    expect(names("/usage 30")).toEqual([])
    expect(names("//")).toEqual([])
    expect(names(" /n")).toEqual([])
    expect(names("")).toEqual([])
  })
  test("a custom command is listed and marked", () => {
    const found = slashSuggestions("/dep", [{ name: "deploy", group: "more", aliases: [], summary: "[env] Ship it", custom: true }])
    expect(found[0]!.name).toBe("deploy")
    expect(text(renderSuggestions(found, 60)[0]!)).toContain(":custom")
  })
  test("Enter and Tab run a command that needs no arguments; the others are inserted as text", () => {
    expect(runsOnSelect(SLASH_COMMANDS.find((c) => c.name === "usage")!)).toBe(true)
    for (const name of ["attach", "remember"]) expect(runsOnSelect(SLASH_COMMANDS.find((c) => c.name === name)!)).toBe(false)
    expect(runsOnSelect({ name: "deploy", group: "more", aliases: [], summary: "", custom: true })).toBe(false)
  })
})

describe("renderSuggestions", () => {
  test("empty input renders nothing", () => expect(renderSuggestions([], 80)).toEqual([]))
  test("draws a ┃ box; the selected row is filled with the primary color across the whole width", () => {
    const lines = renderSuggestions(SLASH_COMMANDS, 80)
    expect(lines).toHaveLength(10)
    expect(lines[0]![1]).toMatchObject({ text: "┃", fg: "border" })
    expect(lines[0]!.filter((span) => span.text.trim() !== "" && span.text !== "┃").every((span) => span.bg === "primary" && span.bold)).toBe(true)
    expect(lines[0]!.at(-1)!.bg).toBe("primary")
    expect(lines[1]!.filter((span) => span.text.trim() !== "" && span.text !== "┃").every((span) => span.bg === "element")).toBe(true)
    expect(text(lines[0]!)).toContain("/new")
    expect(text(lines[0]!)).toContain("Start a session")
  })
  test("the selected index moves the highlight", () => {
    const lines = renderSuggestions(SLASH_COMMANDS, 80, 2)
    expect(lines[2]!.at(-1)!.bg).toBe("primary")
    expect(lines[0]!.at(-1)!.bg).toBe("element")
  })
  test("summaries align in a column", () => {
    const lines = renderSuggestions(SLASH_COMMANDS, 80).map(text)
    expect(new Set(lines.map((line, i) => line.indexOf(SLASH_COMMANDS[i]!.summary))).size).toBe(1)
  })
  test("shows at most ten rows in a window that follows the selection", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ name: `cmd${i}`, group: "more" as const, aliases: [], summary: "s" }))
    expect(renderSuggestions(many, 80)).toHaveLength(10)
    const last = renderSuggestions(many, 80, 19)
    expect(last).toHaveLength(10)
    expect(text(last.at(-1)!)).toContain("/cmd19")
    expect(last.at(-1)!.at(-1)!.bg).toBe("primary")
    expect(text(last[0]!)).toContain("/cmd10")
  })
  test.each([8, 12, 20, 50, 100])("respects width %i", (width) => {
    for (const line of renderSuggestions(SLASH_COMMANDS, width)) expect(textWidth(text(line))).toBeLessThanOrEqual(width)
  })
})
