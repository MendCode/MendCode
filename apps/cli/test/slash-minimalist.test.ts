import { afterEach, describe, expect, test } from "bun:test"
import { MINIMALIST_SLASH, slashTier } from "@mendcode/protocol/wire"
import { SLASH_COMMANDS, editableCatalog, listedBuiltins, parseSlash, slashRefusal, tierListed } from "../src/view/commands"
import { createSlashMenuState, menuCatalog, slashMenuModel } from "../src/view/slash-menu"
import { renderHelpPage } from "../src/view/help-page"
import { renderSlashEditor, slashEditorKey } from "../src/view/slash-menu-editor"
import { DEFAULT_TUI_PROFILE } from "../src/view/tui-profile"
import { appHarness, cleanTemps } from "./session-ui-harness"

afterEach(cleanTemps)

/** pi's built-in slash commands, from its `BUILTIN_SLASH_COMMANDS` (packages/coding-agent/src/core/slash-commands.ts): 24 of them. */
const PI_SLASH = ["settings", "model", "tree", "thinking", "scoped-models", "export", "import", "share", "bug", "copy", "name", "session", "changelog", "hotkeys", "fork", "clone", "trust", "login", "logout", "new", "compact", "resume", "reload", "quit"]
const profile = { ...DEFAULT_TUI_PROFILE }
const minimalist = { tier: "minimalist" as const }
const plain = (rows: Array<Array<{ text: string }>>) => rows.map((row) => row.map((span) => span.text).join("")).join("\n")
const menu = (overrides: Partial<Parameters<typeof slashMenuModel>[0]> = {}) => slashMenuModel({ text: "/", custom: [], profile, settings: minimalist, recents: [], state: createSlashMenuState(), selected: 0, width: 100, height: 40, ascii: false, ...overrides })!
const flat = { ...profile, slashMenu: "flat" as const }
/** The runnable rows: a switched-off command typed exactly is only a hint row that runs nothing. */
const browsed = (view: ReturnType<typeof menu>) => view.items.filter((item) => !item.gated).map((item) => item.command?.name)

describe("the minimalist command set", () => {
  test("is smaller than pi's and every name is a real command", () => {
    expect(PI_SLASH).toHaveLength(24)
    expect(MINIMALIST_SLASH).toHaveLength(21)
    expect(MINIMALIST_SLASH.length).toBeLessThan(PI_SLASH.length)
    expect(new Set(MINIMALIST_SLASH).size).toBe(MINIMALIST_SLASH.length)
    for (const name of MINIMALIST_SLASH) expect(SLASH_COMMANDS.some((command) => command.name === name)).toBe(true)
    for (const name of ["tier", "settings", "help", "model", "connect", "new", "quit", "tree"]) expect(MINIMALIST_SLASH).toContain(name as never)
  })
  test("the menu's catalog, browse list and search list exactly that set", () => {
    const names = (commands: Array<{ name: string }>) => commands.map((command) => command.name).sort()
    expect(names(menuCatalog([], profile, minimalist))).toEqual([...MINIMALIST_SLASH].sort())
    expect(names(menu({ profile: flat }).items.map((item) => item.command!))).toEqual([...MINIMALIST_SLASH].sort())
    for (const hidden of ["review", "changes", "mcps", "fanout", "theme", "timestamps", "init", "env", "privacy"]) expect(browsed(menu({ text: `/${hidden}` }))).not.toContain(hidden)
    expect(browsed(menu({ text: "/tier" }))[0]).toBe("tier")
  })
  test("balanced, full and no tier list what they did before", () => {
    const everything = menuCatalog([], profile, {}).length
    expect(everything).toBeGreaterThan(100)
    expect(menuCatalog([], profile, { tier: "balanced" }).map((command) => command.name)).toContain("review")
    expect(menuCatalog([], profile, { tier: "balanced" }).length).toBeGreaterThan(100)
    expect(menuCatalog([], profile, { tier: "full" }).length).toBeGreaterThanOrEqual(menuCatalog([], profile, { tier: "balanced" }).length)
    for (const settings of [{}, { tier: "balanced" as const }, { tier: "full" as const }]) expect(listedBuiltins(settings).length).toBe(SLASH_COMMANDS.length)
  })
  test("a user's own commands, extension commands and MCP prompts are never tier-hidden", () => {
    const own = { name: "deploy", group: "code" as const, aliases: [], summary: "Run my deploy", custom: true as const }
    expect(menuCatalog([own], profile, minimalist).map((command) => command.name)).toContain("deploy")
    expect(tierListed({ name: "review", ext: true }, minimalist)).toBe(true)
    expect(tierListed({ name: "review", mcp: true }, minimalist)).toBe(true)
    expect(slashRefusal("/deploy", minimalist)).toBeUndefined()
  })
  test("/help lists the same set, with its count", () => {
    const text = plain(renderHelpPage({ width: 100, height: 40, builtin: listedBuiltins(minimalist) }))
    expect(text).toContain(`${MINIMALIST_SLASH.length} commands`)
    expect(text).toContain("/tier")
    expect(text).not.toContain("/review")
    expect(plain(renderHelpPage({ width: 100, height: 40 }))).toContain(`${SLASH_COMMANDS.length} commands`)
  })
})

describe("a command the tier does not list", () => {
  test("answers in one line naming the tier that has it", () => {
    expect(slashRefusal("/review", minimalist)).toBe("/review · balanced · /tier balanced")
    expect(slashRefusal("/review the diff", minimalist)).toBe("/review · balanced · /tier balanced")
    expect(slashRefusal("/changes", minimalist)).toBe("/changes · balanced · /tier balanced")
    expect(slashRefusal("/commit push", minimalist)).toBe("/commit · balanced · /tier balanced")
    expect(slashRefusal("/commit-push", minimalist)).toBeUndefined()
    expect(slashTier("review")).toBe("balanced")
  })
  test("a command of a feature keeps its own, earlier behaviour: hidden from the menu, answered by its handler", () => {
    for (const text of ["/panel", "/mcps", "/fanout", "/voice", "/pet"]) expect(slashRefusal(text, minimalist)).toBeUndefined()
    for (const hidden of ["panel", "mcps", "fanout", "voice", "pet"]) expect(menuCatalog([], profile, minimalist).map((command) => command.name)).not.toContain(hidden)
  })
  test("a listed command, its aliases, other tiers, plain text and unknown names are left alone", () => {
    for (const text of ["/export", "/resume", "/stats", "/q", "/tier balanced", "/?", "/Users/me/notes.md", "// review", "review", "/nothing-like-this"]) expect(slashRefusal(text, minimalist)).toBeUndefined()
    for (const settings of [{}, { tier: "balanced" as const }, { tier: "full" as const }]) expect(slashRefusal("/review", settings)).toBeUndefined()
    expect(parseSlash("/stats")?.command.name).toBe("usage")
  })
})

describe("adding and removing single commands", () => {
  test("hidden:false lists a command in minimalist, in browse, search and help; the tier does not answer for it any more", () => {
    const added = { ...flat, slashCommands: [{ name: "review", hidden: false }, { name: "theme", hidden: false }] }
    expect(browsed(menu({ profile: added }))).toEqual(expect.arrayContaining(["review", "theme", ...MINIMALIST_SLASH]))
    expect(menu({ profile: added }).items).toHaveLength(MINIMALIST_SLASH.length + 2)
    expect(browsed(menu({ profile: added, text: "/review" }))[0]).toBe("review")
    expect(listedBuiltins(minimalist, added.slashCommands).map((command) => command.name)).toContain("review")
    expect(slashRefusal("/review", minimalist, added.slashCommands)).toBeUndefined()
    expect(slashRefusal("/changes", minimalist, added.slashCommands)).toBeDefined()
  })
  test("hidden:true removes a listed command from browsing and keeps it searchable and runnable, as it always did", () => {
    const removed = { ...flat, slashCommands: [{ name: "export", hidden: true }] }
    expect(browsed(menu({ profile: removed }))).not.toContain("export")
    expect(browsed(menu({ profile: removed, text: "/export" }))[0]).toBe("export")
    expect(slashRefusal("/export", minimalist, removed.slashCommands)).toBeUndefined()
  })
  test("a feature switched on by the user brings its command into minimalist; hidden:false for a command whose feature is off does not", () => {
    expect(tierListed({ name: "fanout", feature: "fanout" }, { ...minimalist, features: { fanout: true } })).toBe(true)
    expect(tierListed({ name: "fanout", feature: "fanout" }, { ...minimalist, features: { fanout: false } })).toBe(false)
    expect(browsed(menu({ profile: { ...flat, slashCommands: [{ name: "fanout", hidden: false }] } }))).not.toContain("fanout")
  })
  test("the command editor shows the tier's state and flips it with h, writing hidden only where it differs from the tier", () => {
    const catalog = editableCatalog([], minimalist)
    const at = (name: string, list = catalog) => [...list].sort((a, b) => a.name.localeCompare(b.name)).findIndex((command) => command.name === name)
    expect(catalog.find((command) => command.name === "review")?.tierHidden).toBe(true)
    expect(catalog.find((command) => command.name === "export")?.tierHidden).toBeUndefined()
    const draw = (selected: string, current = profile) => plain(renderSlashEditor({ state: { selected: at(selected) }, profile: current, commands: catalog, width: 90, height: 200 }))
    expect(draw("review")).toMatch(/\/review\s+\S+\s+hidden by tier/)
    expect(draw("export")).toMatch(/\/export\s+\S+\s+shown/)
    const listed = slashEditorKey({ selected: at("review") }, "h", profile, catalog)
    expect(listed.patch?.slashCommands).toEqual([{ name: "review", hidden: false }])
    const withReview = { ...profile, slashCommands: listed.patch!.slashCommands! }
    expect(draw("review", withReview)).toMatch(/\/review\s+\S+\s+shown/)
    expect(slashEditorKey({ selected: at("review") }, "h", withReview, catalog).patch?.slashCommands).toEqual([{ name: "review" }])
    expect(slashEditorKey({ selected: at("export") }, "h", profile, catalog).patch?.slashCommands).toEqual([{ name: "export", hidden: true }])
    const balanced = editableCatalog([], { tier: "balanced" })
    expect(slashEditorKey({ selected: at("review", balanced) }, "h", profile, balanced).patch?.slashCommands).toEqual([{ name: "review", hidden: true }])
  })
})

describe("typing in the app", () => {
  const screen = (h: ReturnType<typeof appHarness>) => h.text().join("\n")
  const start = (settings: Record<string, unknown>, extra: Parameters<typeof appHarness>[0] = {}) => {
    const h = appHarness({ width: 80, height: 24, ...extra })
    h.app.applySettings(settings as never)
    return h
  }

  test("environment commands are tier-hidden and send no environment or privacy requests", async () => {
    for (const name of ["env", "privacy"]) {
      const h = start(minimalist)
      const before = h.sent.length
      await h.type(`/${name}\r`)
      expect(screen(h)).toContain(`/${name} · balanced · /tier balanced`)
      expect(h.app.page).toBe("chat")
      expect(h.sent.slice(before).filter((command) => /^(env\.|privacy\.|user\.submit|prompt\.record)/.test(command.type))).toEqual([])
      expect(tierListed({ name }, minimalist, [{ name, hidden: false }])).toBe(true)
      expect(slashRefusal(`/${name}`, minimalist, [{ name, hidden: false }])).toBeUndefined()
    }
  })
  test("a hidden command typed by hand answers one line, runs nothing and leaves the prompt empty", async () => {
    const h = start(minimalist)
    const before = h.sent.length
    await h.type("/review\r")
    expect(screen(h)).toContain("/review · balanced · /tier balanced")
    expect(h.sent.slice(before).filter((command) => /^(user\.submit|commands\.execute|session\.(create|fork))$/.test(command.type))).toEqual([])
    expect(screen(h)).not.toMatch(/^\s*[┃│]?\s*\/review\s*$/m)
  })
  test("a page command answers the same way, and /tier is the way out", async () => {
    const customize = start(minimalist)
    await customize.type("/customize\r")
    expect(screen(customize)).toContain("/customize · balanced · /tier balanced")
    expect(customize.app.page).toBe("chat")
    const raised = start(minimalist)
    await raised.type("/tier balanced\r")
    expect(raised.sentOf("settings.set").some((command) => (command as unknown as { patch: { tier?: string } }).patch.tier === "balanced")).toBe(true)
  })
  test("the same line in balanced or with no tier is not answered by the tier", async () => {
    for (const settings of [{ tier: "balanced" }, {}]) {
      const h = start(settings)
      await h.type("/customize\r")
      expect(screen(h)).not.toContain("/tier balanced")
      expect(h.app.page).toBe("customize")
    }
  })
  test("a command added back with hidden:false runs in minimalist", async () => {
    const h = start(minimalist, { hostProfile: { ...DEFAULT_TUI_PROFILE, slashCommands: [{ name: "customize", hidden: false }] } })
    await h.type("/customize\r")
    expect(screen(h)).not.toContain("/tier balanced")
    expect(h.app.page).toBe("customize")
  })
  test("from /settings alone a user reaches the command editor, lists a command with h and runs it", async () => {
    const h = start(minimalist)
    await h.type("/settings slashCommands\r")
    expect(h.app.page).toBe("settings")
    await h.type("\r")
    expect(screen(h)).toContain("Customize commands")
    const at = [...editableCatalog([], minimalist)].sort((a, b) => a.name.localeCompare(b.name)).findIndex((command) => command.name === "customize")
    for (let n = 0; n < at; n++) await h.type("\x1b[B")
    expect(screen(h)).toMatch(/> \/customize\s+\S+\s+hidden by tier/)
    await h.type("h")
    expect(screen(h)).toMatch(/> \/customize\s+\S+\s+shown/)
    await h.type("\x1b")
    await h.type("\x1b")
    await h.type("/customize\r")
    expect(screen(h)).not.toContain("/tier balanced")
    expect(h.app.page).toBe("customize")
  })
  test("/help and the command palette list only the set", async () => {
    const help = start(minimalist)
    await help.type("/help\r")
    expect(help.app.page).toBe("help")
    expect(screen(help)).toContain(`${MINIMALIST_SLASH.length} commands`)
    const full = start({ tier: "full" })
    await full.type("/help\r")
    expect(screen(full)).toContain(`${SLASH_COMMANDS.length} commands`)
    const palette = start(minimalist)
    await palette.type("\x10")
    await palette.type("customize")
    expect(screen(palette)).not.toContain("Customize the terminal layout")
    const open = start({})
    await open.type("\x10")
    await open.type("customize")
    expect(screen(open)).toContain("Customize the terminal layout")
  })
})
