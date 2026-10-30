import { afterEach, describe, expect, test } from "bun:test"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { FOOTER_ICON_MODES, FOOTER_PRESET_NAMES, FOOTER_PRESETS,PROMPT_FAMILIES, PROMPT_MODES, SLASH_GROUPS, footerSegmentProblem, themeDocument, tuiProblems } from "@mendcode/protocol/wire"
import { loadMcpConfig } from "@mendcode/mcp"
import { loadCustomToolFile } from "../../tools/src/custom-tools"
import { parseAgentFile } from "@mendcode/packages"
import { parseAutomation } from "../../../apps/cli/src/automation"
import { parsePackageFileCommand } from "../../../apps/cli/src/package-file-command"
import { parseKeybindings } from "../../../apps/cli/src/extensions/keybindings"
import { parseSlash } from "../../../apps/cli/src/view/commands"
import { expandUserAlias } from "../../../apps/cli/src/view/slash-aliases"
import { menuCatalog, slashMenuModel } from "../../../apps/cli/src/view/slash-menu"
import { DEFAULT_TUI_PROFILE, readTuiProfile } from "../../../apps/cli/src/view/tui-profile"
import { createTuiControl } from "../src/tui-control"
import { CARDS_FILE, CARDS_REGENERATE, CARD_BUDGET, cardIndexText, docCards, parseCardSource } from "../src/doc-cards"
import { CARDS_DIR, slashCommands } from "../src/operator-guide"
import { CustomizeUiArgs, createCustomizeUiTool } from "../src/customize-ui"
import { readRecipes } from "../src/recipes"
import { readShellHooks } from "../src/shell-hooks"
import { statusScripts } from "../src/status-scripts"

const repo = path.resolve(import.meta.dir, "../../..")
const cleanup: string[] = []
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-cards-")))
  cleanup.push(dir)
  return dir
}
const index = docCards(repo)
const card = (topic: string) => index.cards.find((entry) => entry.topic === topic)!.text

/** The balanced `{...}` that follows `marker` in a card (strings respected): the example a card shows. */
function objectAfter(text: string, marker: string) {
  const start = text.indexOf("{", text.indexOf(marker))
  expect(start).toBeGreaterThan(-1)
  let depth = 0, quote = false
  for (let at = start; at < text.length; at++) {
    const char = text[at]!
    if (quote) { if (char === "\\") at++; else if (char === '"') quote = false; continue }
    if (char === '"') quote = true
    else if (char === "{") depth++
    else if (char === "}" && --depth === 0) return text.slice(start, at + 1)
  }
  throw new Error(`no closed object after ${marker}`)
}
const json = (text: string, marker: string) => JSON.parse(objectAfter(text, marker)) as Record<string, any>
/** An indented block of the card between two `---` lines, dedented: a markdown file with frontmatter. */
function frontmatterFile(text: string, firstKey: string) {
  const lines = text.split("\n")
  const open = lines.findIndex((line, at) => /^\s*---$/.test(line) && lines[at + 1]?.trim().startsWith(firstKey))
  const close = lines.findIndex((line, at) => at > open + 1 && /^\s*---$/.test(line))
  return lines.slice(open, close + 2).map((line) => line.replace(/^ {2}/, "")).join("\n")
}
const layer = (dir: string) => [{ dir, source: "user" as const }]

describe("the generated cards", () => {
  test(`the checked-in index is what the generator produces from the card files and docs/ (${CARDS_REGENERATE})`, () => {
    expect(readFileSync(path.join(repo, CARDS_FILE), "utf8")).toBe(cardIndexText(index))
  })
  test("every card stays inside its budget, has one plain summary line and its docs, and every topic and alias is unique", () => {
    const seen = new Set<string>()
    for (const entry of index.cards) {
      expect(entry.text.length).toBeLessThanOrEqual(CARD_BUDGET.text)
      expect(entry.summary.length).toBeLessThanOrEqual(CARD_BUDGET.summary)
      expect(entry.summary).not.toMatch(/\n|\{\{/)
      for (const word of [entry.topic, ...entry.aliases]) { expect(seen.has(word)).toBe(false); seen.add(word) }
    }
    expect(index.cards.map((entry) => entry.topic)).toEqual([...index.cards.map((entry) => entry.topic)].sort())
  })
  test("only the program name is left to the runtime: every other placeholder was filled, and no card cites a repository path", () => {
    for (const entry of index.cards) {
      expect(entry.text).not.toMatch(/\{\{(?:modes|families|tiers|roles)\}\}|\[\[setting:/)
      expect([...entry.text.matchAll(/\{\{([^}]+)\}\}/g)].map((match) => match[1]).filter((name) => !/^(?:program|cwd|args\.\w+|result\.[\w.]+|item\.\w+)$/.test(name!))).toEqual([])
      expect(entry.text).not.toMatch(/docs\/[\w-]+\.md|packages\/(?:daemon|protocol|engine)|apps\/cli/)
    }
  })
  test("build-time values come from the code: modes, families, tiers and model roles", () => {
    for (const mode of PROMPT_MODES) expect(card("prompt-modes")).toContain(mode)
    for (const family of PROMPT_FAMILIES) expect(card("prompt-modes")).toContain(family)
    for (const tier of ["minimalist", "balanced", "full"]) expect(card("tiers")).toContain(tier)
    for (const role of ["main", "plan", "compaction", "permissionReviewer", "memoryExtractor"]) expect(card("models")).toContain(role)
  })
  test("every slash command a card names is a real command", () => {
    for (const entry of index.cards) for (const name of slashCommands(entry.text)) expect([entry.topic, name, parseSlash(`/${name}`) !== undefined]).toEqual([entry.topic, name, true])
  })
  test("every program command a card names starts with a subcommand this CLI has", () => {
    const own = new Set(["run", "docs", "view", "help", "daemon", "upgrade", "uninstall", "acp", "app-server", "remote", "migrate-v1", "claude"])
    for (const entry of index.cards) for (const [, word] of entry.text.matchAll(/\{\{program\}\} ([a-z][a-z0-9-]*)/g)) {
      expect([entry.topic, word, own.has(word!) || parseAutomation([word!]).ok !== "none"]).toEqual([entry.topic, word, true])
    }
  })
  test("full commands the cards teach parse as written", () => {
    for (const argv of [
      ["control-plane", "tui", "schema"], ["control-plane", "tui", "profile"], ["control-plane", "tui", "apply-preset", "compact"], ["control-plane", "tui", "rollback"],
      ["control-plane", "system", "config-layers"], ["control-plane", "system", "config-paths"], ["control-plane", "permissions", "status"], ["control-plane", "permissions", "set-default", "smart"],
      ["control-plane", "permissions", "set-reviewer-role", "permissionReviewer"], ["control-plane", "models", "status"], ["control-plane", "models", "set-default", "openai", "gpt-6-sol", "--dry-run"],
      ["control-plane", "budget", "status"], ["control-plane", "mcp", "status"], ["theme", "select", "forest", "--scope", "user"], ["theme", "validate", "forest.json"],
      ["theme", "install", "forest.json", "--name", "forest", "--scope", "project"], ["recipe", "list"], ["recipe", "apply", "deep"], ["models", "--verbose"],
      ["package", "install", "github:owner/repo#main", "--replace"], ["package", "list"], ["package", "remove", "acme", "--purge"],
      ["mcp", "add", "docs", "--scope", "project", "--", "bun", "server.ts"], ["mcp", "add", "remote", "--url", "https://mcp.example/mcp", "--no-oauth"], ["mcp", "list"], ["mcp", "debug", "docs"],
      ["agent", "list"], ["memory", "status"], ["memory", "search", "x", "--limit", "5"], ["usage", "--days", "7", "--models"], ["status"],
      ["prompt", "mode", "full", "--focus", "codex"], ["prompt", "cycle-mode"], ["prompt", "build", "--mode", "full", "--show-full"], ["prompt", "sources"],
      ["providers", "login", "--provider", "openai", "--api-key-env", "OPENAI_API_KEY"], ["providers", "list"], ["providers", "logout", "--provider", "openai"],
    ]) expect([argv.join(" "), parseAutomation(argv).ok]).toEqual([argv.join(" "), true])
    expect(parsePackageFileCommand(["package", "new", "acme", "--dir", "."])).toMatchObject({ action: "new", target: "acme", dir: "." })
    expect(parsePackageFileCommand(["package", "check", "./acme"])).toMatchObject({ action: "check", target: "./acme" })
  })
  test("the card source parser needs a header and refuses nothing it cannot read", () => {
    expect(parseCardSource("x", "---\nsummary: s\ndocs: a, b\naliases: c\n---\nText\n")).toEqual({ topic: "x", summary: "s", docs: ["a", "b"], aliases: ["c"], text: "Text" })
    expect(() => parseCardSource("x", "no header")).toThrow("[CARDS]")
  })
})

describe("the generator", () => {
  const copy = () => {
    const dir = temp()
    cpSync(path.join(repo, "docs"), path.join(dir, "docs"), { recursive: true })
    cpSync(path.join(repo, CARDS_DIR), path.join(dir, CARDS_DIR), { recursive: true })
    return dir
  }
  const add = (dir: string, topic: string, source: string) => writeFileSync(path.join(dir, CARDS_DIR, `${topic}.md`), source)
  const good = "---\nsummary: a test topic\ndocs: tiers\n---\nText.\n"
  test("a card is a file: dropping one in adds a topic, with no other change", () => {
    const dir = copy()
    expect(docCards(dir)).toEqual(index)
    add(dir, "zebra", good)
    expect(docCards(dir).cards.map((entry) => entry.topic)).toEqual([...index.cards.map((entry) => entry.topic), "zebra"].sort())
  })
  test("a change to a card or to a doc it stands on changes the revision, so the stale check fails; an unrelated doc does not", () => {
    const dir = copy()
    writeFileSync(path.join(dir, "docs/tiers.md"), readFileSync(path.join(dir, "docs/tiers.md"), "utf8") + "\nA new sentence.\n")
    expect(docCards(dir).revision).not.toBe(index.revision)
    expect(docCards(dir).cards).toEqual(index.cards)
    const other = copy()
    writeFileSync(path.join(other, "docs/security-2026-10-04.md"), readFileSync(path.join(other, "docs/security-2026-10-04.md"), "utf8") + "\nA new sentence.\n")
    expect(docCards(other).revision).toBe(index.revision)
    const edited = copy()
    writeFileSync(path.join(edited, CARDS_DIR, "tiers.md"), readFileSync(path.join(edited, CARDS_DIR, "tiers.md"), "utf8") + "\nMore.\n")
    expect(docCards(edited).revision).not.toBe(index.revision)
  })
  test("it refuses a card that names a command, setting or doc the docs do not have, cites a repository path, or breaks the format", () => {
    const refused = (source: string, topic = "zebra") => {
      const dir = copy()
      add(dir, topic, source)
      return () => docCards(dir)
    }
    expect(refused(good.replace("Text.", "Run `/no-such-command` now."))).toThrow("[GUIDE]")
    expect(refused(good.replace("Text.", "Run /no-such-command now."))).toThrow("[GUIDE]")
    expect(refused(good.replace("Text.", "[[setting:noSuchSettingKey]]"))).toThrow("[GUIDE]")
    expect(refused(good.replace("Text.", "See docs/no-such-doc.md"))).toThrow("[GUIDE]")
    expect(refused(good.replace("Text.", "See docs/tiers.md"))).toThrow("repository path")
    expect(refused(good.replace("docs: tiers", "docs: no-such-doc"))).toThrow("does not exist")
    expect(refused(good.replace("docs: tiers\n", ""))).toThrow("names the docs/")
    expect(refused(good.replace("a test topic", "x".repeat(CARD_BUDGET.summary + 1)))).toThrow("summary")
    expect(refused(good.replace("Text.", "x".repeat(CARD_BUDGET.text + 1)))).toThrow("budget")
    expect(refused(good.replace("---\nsummary", "---\naliases: theme\nsummary"))).toThrow("alias theme")
    expect(refused(good, "Bad_Topic")).toThrow("lowercase")
    expect(refused("no header")).toThrow("header")
  })
  test("it never leaves a card behind that a placeholder could not fill", () => {
    const dir = copy()
    add(dir, "zebra", good.replace("Text.", "Modes {{modes}}, tiers {{tiers}}."))
    const zebra = docCards(dir).cards.find((entry) => entry.topic === "zebra")!
    for (const mode of PROMPT_MODES) expect(zebra.text).toContain(mode)
    expect(zebra.text).not.toContain("{{modes}}")
  })
})

describe("the examples in the cards work as written", () => {
  test("the theme file is a valid theme", () => {
    expect(themeDocument(json(card("theme"), "Write a theme:")).errors).toEqual([])
  })
  test("settings through customize_ui: the profile patches the cards show validate", () => {
    expect(CustomizeUiArgs.safeParse(json(card("theme"), "customize_ui {")).success).toBe(true)
    expect(CustomizeUiArgs.safeParse(json(card("customize"), "customize_ui {")).success).toBe(true)
    expect(CustomizeUiArgs.safeParse({ action: "settings", values: { markdownColors: '{"mdHeading1":"#ff8800"}' } }).success).toBe(true)
  })
  test("the status script file loads, and its output formats parse", () => {
    const dir = temp()
    writeFileSync(path.join(dir, "statusline.json"), JSON.stringify(json(card("footer"), "after /tools trust")))
    const { scripts, problems } = statusScripts(layer(dir))
    expect(problems).toEqual([])
    // The loader resolves `./status.sh` against the folder that holds statusline.json, as the card says.
    expect(scripts).toMatchObject([{ side: "right", command: [path.join(dir, "status.sh")], refreshMs: 5000, timeoutMs: 1500 }])
  })
  test("the footer extension loads, registers its slot and draws a row", async () => {
    const text = card("footer")
    const start = text.indexOf("export default {")
    const source = `${text.slice(start, text.indexOf("\nSlots:", start)).replace(/^ {2}/gm, "")}\n`
    const dir = temp()
    writeFileSync(path.join(dir, "footer.ts"), source)
    const module = (await import(path.join(dir, "footer.ts"))).default as { name: string; tui(api: unknown): void }
    const slots: Array<[string, (context: unknown) => unknown]> = []
    module.tui({ slot: (name: string, draw: (context: unknown) => unknown) => slots.push([name, draw]) })
    expect(module.name).toBe("footer")
    expect(slots.map(([name]) => name)).toEqual(["footer.right"])
    expect(slots[0]![1]({ branch: "main" })).toEqual([[{ text: "main", fg: "muted" }]])
    expect(CustomizeUiArgs.safeParse({ action: "write", file: "footer.ts", content: source }).success).toBe(true)
  })
  test("keybindings.json parses with no problem", () => {
    const line = card("keys").split("\n").find((entry) => entry.trim().startsWith('{ "f4"'))!
    const parsed = parseKeybindings(line)
    expect(parsed.problems).toEqual([])
    expect(parsed.entries.map((entry) => entry.spec)).toEqual(["f4", "ctrl+g", "alt+q", "leader"])
  })
  test("hooks.json and mcp.json load with no problem", async () => {
    const dir = temp()
    writeFileSync(path.join(dir, "hooks.json"), JSON.stringify(json(card("hooks"), "hooks.json in")))
    const hooks = readShellHooks(layer(dir))
    expect(hooks.problems).toEqual([])
    expect(hooks.hooks.map((hook) => hook.event).sort()).toEqual(["PreToolUse", "Stop"])
    writeFileSync(path.join(dir, "mcp.json"), JSON.stringify(json(card("mcp"), '{ "servers"')))
    const mcp = await loadMcpConfig({ directory: dir, userDir: dir, layers: layer(dir), env: { DOCS_TOKEN: "t", REMOTE_TOKEN: "r" } })
    expect(mcp.errors).toEqual([])
    expect(Object.keys(mcp.servers).sort()).toEqual(["docs", "remote"])
  })
  test("the custom tool manifest loads, and its render template binds", async () => {
    const dir = temp()
    const manifest = json(card("tools"), "tools/<name>.json (name")
    mkdirSync(path.join(dir, "tools"))
    writeFileSync(path.join(dir, "tools", "demo.json"), JSON.stringify(manifest))
    const loaded = await loadCustomToolFile({ file: path.join(dir, "tools", "demo.json"), name: "demo", source: "user", directory: dir })
    expect("message" in loaded).toBe(false)
  })
  test("the model recipe, the agent file, the skill file and the command file are read by their loaders", () => {
    const dir = temp()
    mkdirSync(path.join(dir, "recipes"))
    writeFileSync(path.join(dir, "recipes", "deep.json"), JSON.stringify(json(card("models"), "<project>/.mendcode/recipes/<name>.json:")))
    expect(readRecipes(layer(dir))).toMatchObject([{ name: "deep", roles: { main: { model: "gpt-6-sol", effort: "high" } } }])
    const agent = parseAgentFile({ text: frontmatterFile(card("agents"), "name:"), stem: "reviewer", file: "reviewer.md", source: "user" })
    expect(agent).toMatchObject({ agent: { name: "reviewer", mode: "primary", model: "gpt-6-sol", effort: "high", tools: ["read", "grep", "glob"], deny: ["shell"] } })
    expect(frontmatterFile(card("skills"), "name:")).toMatch(/^---\nname: release-notes\ndescription: .*\n---\n/)
    expect(frontmatterFile(card("commands"), "description:")).toMatch(/^---\ndescription: .*\nargument-hint: <branch>\n---\nReview the changes of \$1/)
  })
})

describe("the paths a model takes, end to end", () => {
  const context = (cwd: string) => ({ cwd, signal: new AbortController().signal })
  const reload = async () => ({ revision: 1, errors: [], terminalValidation: "pending" as const })

  test("change my theme to X: the card, then customize_ui settings, which saves the profile and tells every terminal", async () => {
    const dir = temp(), project = temp()
    const emitted: unknown[] = []
    const tool = createCustomizeUiTool(dir, reload, (event) => void emitted.push(event))
    const payload = json(card("theme"), "customize_ui {")
    payload.values.theme = "dracula"
    const result = await tool.execute(CustomizeUiArgs.parse(payload), context(project))
    expect(result.isError).toBe(false)
    expect(JSON.parse(readFileSync(path.join(dir, "tui/profile.json"), "utf8")).theme).toBe("dracula")
    expect(emitted).toMatchObject([{ type: "tui.changed", profile: { theme: "dracula" } }])
  })
  test("make /d open changes, hide one command, pin another: the commands card's call and file entry, taken literally, are read by the terminal", async () => {
    const dir = temp(), project = temp()
    const emitted: unknown[] = []
    const tool = createCustomizeUiTool(dir, reload, (event) => void emitted.push(event))
    const text = card("commands")
    // The call the card shows validates and saves; the terminal reads the alias back from the profile it wrote.
    const call = json(text, "customize_ui {")
    expect(CustomizeUiArgs.safeParse(call).success).toBe(true)
    const saved = await tool.execute(CustomizeUiArgs.parse(call), context(project))
    expect(saved.isError).toBe(false)
    expect(emitted).toMatchObject([{ type: "tui.changed", profile: { slashCommands: [{ name: "changes", aliases: ["d"] }] } }])
    expect(readTuiProfile(dir).slashCommands).toEqual([{ name: "changes", aliases: ["d"] }])
    expect(expandUserAlias("/d src", readTuiProfile(dir).slashCommands)).toBe("/changes src")
    // The entry the card shows for the file, with every key it names, is accepted as written.
    const entry = json(text, '{ "name": "changes", "aliases"')
    expect(Object.keys(entry).sort()).toEqual(["aliases", "group", "hidden", "name", "order", "pinned"])
    mkdirSync(path.join(dir, "tui"), { recursive: true })
    writeFileSync(path.join(dir, "tui/profile.json"), JSON.stringify({ slashCommands: [entry] }))
    const profile = readTuiProfile(dir)
    expect(profile.slashCommands).toEqual([entry as never])
    const minimalist = menuCatalog([], profile, { tier: "minimalist" })
    // hidden: false lists a command the tier leaves out, the way the card says.
    expect(minimalist.map((command) => command.name)).toContain("changes")
    expect(menuCatalog([], DEFAULT_TUI_PROFILE, { tier: "minimalist" }).map((command) => command.name)).not.toContain("changes")
    // hidden: true leaves browsing but not searching; pinned comes first in its group; a moved group places it.
    const hidden = { ...profile, slashCommands: [{ name: "fetch", hidden: true }, { name: "verify", pinned: true }, { name: "review", group: "agents" as const }] }
    const view = (query: string, group = 0) => slashMenuModel({ text: query, custom: [], profile: hidden, settings: { tier: "full" }, recents: [], state: { group, expanded: [] }, selected: 0, width: 100, height: 14, ascii: false })!
    expect(view("/", SLASH_GROUPS.indexOf("more")).items.map((item) => item.command?.name)).not.toContain("fetch")
    expect(view("/fetch").items.map((item) => item.command?.name)).toContain("fetch")
    expect(view("/", SLASH_GROUPS.indexOf("code")).items[0]?.command?.name).toBe("verify")
    expect(view("/", SLASH_GROUPS.indexOf("agents")).items.map((item) => item.command?.name)).toContain("review")
  })
  test("the value the card tells the model to send replaces the whole list, and the profile rolls back as the card says", async () => {
    const dir = temp(), project = temp()
    const tool = createCustomizeUiTool(dir, reload, () => {})
    const first = [{ name: "changes", aliases: ["d"] }, { name: "fetch", hidden: true }]
    await tool.execute(CustomizeUiArgs.parse({ action: "settings", values: { slashCommands: first } }), context(project))
    const second = [...first, { name: "model", pinned: true }]
    await tool.execute(CustomizeUiArgs.parse({ action: "settings", values: { slashCommands: second } }), context(project))
    expect(readTuiProfile(dir).slashCommands).toEqual(second as never)
    expect(card("commands")).toContain("REPLACES the whole list")
    // A value the validator refuses changes nothing.
    expect(CustomizeUiArgs.safeParse({ action: "settings", values: { slashCommands: [{ name: "changes", aliases: ["fetch", "x"] }, { name: "fetch", hidden: true }] } }).success).toBe(false)
    expect(readTuiProfile(dir).slashCommands).toEqual(second as never)
    // "Undo: control-plane tui rollback" restores the previous profile.
    const control = createTuiControl(dir).run({ operation: "rollback" })
    expect(control.profile.slashCommands).toEqual(first)
    expect(readTuiProfile(dir).slashCommands).toEqual(first as never)
    expect(card("commands")).toContain("{{program}} control-plane tui rollback")
  })
  test("multi-row footers are settings: the footer card leads with that, names footerRows, the presets and the icon modes, and what it shows validates", () => {
    const text = card("footer")
    expect(text.indexOf("Multi-row footers are settings")).toBe(0)
    expect(text.slice(0, 160)).toContain("an extension is only for data MendCode does not have")
    for (const word of ["footerRows", "footerIcons", "footerText", "/footer preset", "quotaRefresh", "never in prompt.above", "set it when the user asks for live usage"]) expect(text).toContain(word)
    // Every preset the card lists exists, and every preset that exists is listed.
    const listed = /\/footer preset ([a-z|]+)/.exec(text)![1]!.split("|")
    expect(listed.sort()).toEqual([...FOOTER_PRESET_NAMES].sort())
    expect(FOOTER_ICON_MODES.every((mode) => text.includes(mode))).toBe(true)
    // The example rows and every segment named in the card are accepted by the validation the settings go through.
    const rows = JSON.parse(/footerRows (\[\[.*?\]\]),/.exec(text)![1]!)
    expect(tuiProblems({ footerRows: rows })).toEqual([])
    // The example is the `rows` preset itself, so a model that copies it gets what `/footer preset rows` gives.
    expect(rows).toEqual(FOOTER_PRESETS.rows!.rows)
    const segments = /Segments: ([^\n]*?)\. codegraph shows/.exec(text)![1]!.replace(/\([^)]*\)/g, "").split(/\s+/).filter(Boolean).map((id) => (id === "text:name" ? "text:tagline" : id))
    expect(segments.filter((id) => footerSegmentProblem(id))).toEqual([])
    expect(tuiProblems({ footerIcons: "nerd", footerText: JSON.parse(/footerText (\{.*?\})/.exec(text)![1]!), quotaRefresh: JSON.parse(/quotaRefresh (\[\{.*?\}\])/.exec(card("usage"))![1]!) })).toEqual([])
    // The old claims are gone: the built-in footer is not one row and slots are not limited to four.
    expect(text).not.toMatch(/built-in footer is one row|up to 4 rows (beside|\()/)
    expect(card("usage")).toContain("Set it if the user asks for it")
    // The Claude probe is a whole minimal Claude Code turn, not "one word in"; no token figure that was not measured.
    expect(card("usage")).toContain("one minimal Claude Code turn on Haiku (its own prompt plus one word)")
    expect(card("usage")).not.toMatch(/\b\d+ tokens\b|tiny/)
    expect(card("layout")).toContain("up to 12")
  })
  test("add a footer segment: the card, then customize_ui write of the extension, then the file is where the loader looks", async () => {
    const dir = temp(), project = temp()
    const tool = createCustomizeUiTool(dir, reload, () => {})
    const text = card("footer")
    const start = text.indexOf("export default {")
    const content = `${text.slice(start, text.indexOf("\nSlots:", start)).replace(/^ {2}/gm, "")}\n`
    const result = await tool.execute(CustomizeUiArgs.parse({ action: "write", file: "footer.ts", content }), context(project))
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.output)).toMatchObject({ file: path.join(dir, "extensions", "footer.ts"), errors: [] })
    expect(existsSync(path.join(dir, "extensions", "footer.ts"))).toBe(true)
    // The card's repair path: an exact edit of the written module.
    const edit = await tool.execute(CustomizeUiArgs.parse({ action: "edit", file: "footer.ts", old: 'fg: "muted"', new: 'fg: "success"' }), context(project))
    expect(edit.isError).toBe(false)
    expect(readFileSync(path.join(dir, "extensions", "footer.ts"), "utf8")).toContain('fg: "success"')
  })
})
