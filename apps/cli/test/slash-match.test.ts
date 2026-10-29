import { describe, expect, test } from "bun:test"
import { SLASH_COMMANDS, slashSuggestions, type SlashCommand } from "../src/view/commands"
import { createSlashMenuState, renderSlashMenu, slashMenuModel } from "../src/view/slash-menu"
import { slashMatch, SLASH_TIERS } from "../src/view/slash-match"
import { DEFAULT_TUI_PROFILE } from "../src/view/tui-profile"

const plain = (row: { text: string }[]) => row.map((span) => span.text).join("")
const names = (text: string, catalog: SlashCommand[] = SLASH_COMMANDS) => slashSuggestions(text, [], catalog).map((command) => command.name)
/** The catalog of a binary that has no `env` command: the report that started this. */
const withoutEnv = SLASH_COMMANDS.filter((command) => command.name !== "env")
const menu = (text: string, profile = DEFAULT_TUI_PROFILE, tier: "minimalist" | "balanced" | "full" = "balanced") => slashMenuModel({ text, custom: [], profile, settings: { tier }, recents: [], state: createSlashMenuState(), selected: 0, width: 100, height: 14, ascii: false })!

describe("a name that matches nothing well lists nothing", () => {
  test("/env against a catalog with no env, /xyz and /gti find no command", () => {
    for (const query of ["/env", "/xyz", "/gti", "/qqq", "/zzzz"]) expect([query, names(query, withoutEnv)]).toEqual([query, []])
  })
  test("the menu shows its empty state, not a counter of unrelated rows", () => {
    for (const query of ["/env", "/xyz", "/gti"]) {
      const view = menu(query, { ...DEFAULT_TUI_PROFILE, slashCommands: [] })
      const filtered = { ...view, catalog: view.catalog.filter((command) => command.name !== "env") }
      const items = slashSuggestions(query, [], filtered.catalog).map((command) => ({ kind: "command" as const, label: `/${command.name}`, group: command.group, command }))
      const rows = renderSlashMenu({ ...filtered, items, selection: 0 }).map(plain)
      expect(rows.join("\n")).toContain("No commands")
      expect(rows.join("\n")).toContain("0 of 0")
    }
  })
  test("in minimalist, where env and the rest are not listed, the real menu is empty for them too", () => {
    for (const query of ["/env", "/chagnes"]) expect(menu(query, DEFAULT_TUI_PROFILE, "minimalist").items).toEqual([])
  })
  test("no query of one to three letters lists a long tail: the loose matches are capped", () => {
    for (const query of ["/a", "/e", "/s", "/t", "/o", "/ab", "/xe", "/ct"]) expect([query, names(query).length <= 40]).toEqual([query, true])
    const loose = (query: string) => SLASH_COMMANDS.filter((command) => (slashMatch(query, command)?.tier ?? 0) >= SLASH_TIERS.initials)
    expect(loose("hi").length).toBeLessThanOrEqual(8 + 3 + 6)
  })
})

describe("what a query finds, best first", () => {
  test("the name, then a prefix, then the start of a later word, then the first letters of its words", () => {
    expect(names("/model")[0]).toBe("model")
    const prefixed = SLASH_COMMANDS.map((command) => command.name).filter((name) => name.startsWith("con")).sort((a, b) => a.length - b.length || a.localeCompare(b))
    expect(names("/con").slice(0, prefixed.length)).toEqual(prefixed)
    expect(names("/con").slice(prefixed.length, prefixed.length + 3)).toEqual(["settings", "ai-config", "debug-config"])
    expect(names("/dir")).toContain("add-dir")
    expect(names("/pm")[0]).toBe("prompt-mode")
    expect(names("/cwin")[0]).toBe("context-window")
  })
  test("an alias that is the whole query beats a prefix of some other name; an alias prefix comes after the name prefixes", () => {
    expect(names("/diff")[0]).toBe("changes")
    expect(names("/ext")[0]).toBe("extensions")
    expect(names("/mem")[0]).toBe("memory")
    const order = names("/s")
    expect(order.indexOf("sandbox")).toBeLessThan(order.indexOf("changes") === -1 ? Infinity : order.indexOf("changes"))
  })
  test("a name match always ranks above a summary match", () => {
    const rank = (query: string) => slashSuggestions(`/${query}`, [], SLASH_COMMANDS).map((command) => slashMatch(query, command)!.tier)
    for (const query of ["theme", "memory", "tool", "view", "mode", "perm", "change", "ses", "git", "diff", "ex"]) {
      const tiers = rank(query)
      expect([query, tiers]).toEqual([query, [...tiers].sort((a, b) => a - b)])
    }
    // "usage" names /usage; /limit mentions "usage limit" in its summary and comes after.
    expect(names("/usage")[0]).toBe("usage")
    expect(names("/usage").indexOf("limit")).toBeGreaterThan(names("/usage").indexOf("usage"))
  })
  test("summary words still find a command, ranked last and capped", () => {
    expect(names("/encrypted")).toContain("env")
    const summary = SLASH_COMMANDS.filter((command) => slashMatch("review", command)?.tier === SLASH_TIERS.summary)
    expect(summary.length).toBeLessThanOrEqual(6)
    expect(names("/credentials")).toEqual(["env"])
  })
  test("a custom command and an extension command are found by name like a built-in", () => {
    const custom: SlashCommand[] = [{ name: "git:pr", group: "more", aliases: [], summary: "Open a pull request", custom: true }, { name: "standup", group: "more", aliases: [], summary: "Write the standup", ext: true }]
    expect(slashSuggestions("/pr", custom).map((command) => command.name)[0]).toBe("pr")
    expect(slashSuggestions("/git", custom).map((command) => command.name)).toContain("git:pr")
    expect(slashSuggestions("/standup", custom)[0]?.name).toBe("standup")
  })
})

describe("a typo of one command still finds it", () => {
  test("a swapped, missing, extra or wrong letter finds the command; short queries forgive nothing", () => {
    for (const [typed, wanted] of [["chagnes", "changes"], ["chnages", "changes"], ["hlep", "help"], ["settngs", "settings"], ["setings", "settings"], ["sesions", "sessions"], ["permisions", "permissions"], ["themee", "theme"], ["agnets", "agents"], ["undoo", "undo"]] as const) {
      expect([typed, names(`/${typed}`)[0]]).toEqual([typed, wanted])
    }
    expect(names("/gti")).toEqual([])
    expect(names("/ne")).not.toContain("tier")
  })
  test("a typo is a candidate only when no better match exists, and at most three come back", () => {
    expect(names("/chagnes")).toEqual(["changes"])
    const typos = SLASH_COMMANDS.filter((command) => slashMatch("modl", command)?.tier === SLASH_TIERS.typo)
    expect(typos.length).toBeLessThanOrEqual(3)
  })
  test("the menu shows the typed command with its group and key", () => {
    const view = menu("/chagnes")
    expect(view.items.map((item) => item.command?.name)).toEqual(["changes"])
    expect(renderSlashMenu(view).map(plain).join("\n")).toContain("/changes")
  })
})

describe("the match names the alias that matched", () => {
  test("only when the name did not", () => {
    const changes = SLASH_COMMANDS.find((command) => command.name === "changes")!
    expect(slashMatch("diff", changes)).toEqual({ tier: SLASH_TIERS.alias, via: "diff" })
    expect(slashMatch("chan", changes)).toEqual({ tier: SLASH_TIERS.prefix })
    expect(slashMatch("zzz", changes)).toBeUndefined()
    const rows = renderSlashMenu(menu("/diff")).map(plain).join("\n")
    expect(rows).toContain("diff / Review changes")
  })
})

describe("cost", () => {
  test("a keystroke over the whole catalog stays far inside a frame", () => {
    const catalog = SLASH_COMMANDS
    const queries = ["c", "ch", "cha", "chag", "chagn", "chagne", "chagnes", "d", "dif", "pm", "cwin", "xyzzy", "environment"]
    const started = performance.now()
    for (let round = 0; round < 200; round++) for (const query of queries) slashSuggestions(`/${query}`, [], catalog)
    const perKeystroke = (performance.now() - started) / (200 * queries.length)
    expect(perKeystroke).toBeLessThan(1)
  })
})
