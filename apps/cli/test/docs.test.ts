import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { startDaemon } from "@mendcode/daemon"
import { createFauxEngine } from "@mendcode/engine-faux"
import { PROGRAM_NAME } from "@mendcode/program"
import { DOCS_USAGE, parseDocsCommand, resolveDocsWords } from "../src/docs-args"
import { CARDS, DOCS_OUTPUT_BUDGET, SEARCH_LINE_SHARE, VERSION_NOTE, findCard, nearestTopics, runDocsCommand, searchText, topicList } from "../src/docs-run"
import { searchCards } from "../../../packages/daemon/src/doc-search"
import { NEEDS_SETTINGS, liveLines } from "../src/docs-live"
import { THEMES } from "../src/themes"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const temp = () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-docs-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Runs the command with captured output; `live` stands in for the daemon unless a test wants the real lookup. */
async function run(argv: string[], options: { dataDir?: string; cwd?: string; live?: Parameters<typeof runDocsCommand>[1]["live"] } = {}) {
  const command = parseDocsCommand(argv)!
  let out = "", err = ""
  const code = await runDocsCommand(command, { dataDir: options.dataDir ?? temp(), cwd: options.cwd ?? temp(), out: { write: (text) => void (out += text) }, err: { write: (text) => void (err += text) }, live: options.live ?? (async () => ({ settings: undefined, prompt: undefined })) })
  return { code, out, err }
}

describe("docs: parsing", () => {
  test("only the word docs starts it, with its words and the data dir flags", () => {
    expect(parseDocsCommand(["docs"])).toEqual({ help: false, words: [] })
    expect(parseDocsCommand(["docs", "theme"])).toEqual({ help: false, words: ["theme"] })
    expect(parseDocsCommand(["docs", "theme", "--dir", "/tmp/x"])).toEqual({ help: false, words: ["theme"], dir: "/tmp/x" })
    expect(parseDocsCommand(["docs", "packages", "prompt-modes", "layout", "extensions"])).toEqual({ help: false, words: ["packages", "prompt-modes", "layout", "extensions"] })
    expect(parseDocsCommand(["--data-dir=/tmp/y", "docs"])).toEqual({ help: false, words: [], dir: "/tmp/y" })
    expect(parseDocsCommand(["docs", "--help"])).toEqual({ help: true, words: [] })
    expect(parseDocsCommand(["session", "docs"])).toBeUndefined()
    expect(parseDocsCommand(["run", "docs"])).toBeUndefined()
    expect(parseDocsCommand([])).toBeUndefined()
  })
  test("too many words, unknown flags and a flag without a value are usage errors", () => {
    expect(parseDocsCommand(["docs", ...Array.from({ length: 8 }, (_, at) => `t${at}`)])!.error).toBeUndefined()
    expect(parseDocsCommand(["docs", ...Array.from({ length: 9 }, (_, at) => `t${at}`)])!.error).toMatch(/at most 8 words/)
    expect(parseDocsCommand(["docs", "--json"])!.error).toMatch(/unknown flag/)
    expect(parseDocsCommand(["docs", "--dir"])!.error).toMatch(/needs a value/)
  })
  test("the word after commands is a command name unless it is a topic; a slash always makes it a command", () => {
    const topics = new Set(["commands", "footer", "tiers", "layout"])
    const resolve = (...words: string[]) => resolveDocsWords(words, (word) => topics.has(word), (word) => word === "commands")
    expect(resolve("commands", "changes")).toEqual([{ kind: "command", name: "changes" }])
    expect(resolve("commands")).toEqual([{ kind: "topic", word: "commands" }])
    expect(resolve("commands", "footer")).toEqual([{ kind: "topic", word: "commands" }, { kind: "topic", word: "footer" }])
    expect(resolve("commands", "/footer")).toEqual([{ kind: "command", name: "footer" }])
    expect(resolve("layout", "commands", "changes", "tiers")).toEqual([{ kind: "topic", word: "layout" }, { kind: "command", name: "changes" }, { kind: "topic", word: "tiers" }])
    expect(resolve("tiers", "balanced")).toEqual([{ kind: "topic", word: "tiers" }, { kind: "topic", word: "balanced" }])
    expect(resolve("footer", "commands")).toEqual([{ kind: "topic", word: "footer" }, { kind: "topic", word: "commands" }])
  })
})

describe("docs: the list and the cards", () => {
  test("no topic lists every topic with one line each, and exits 0", async () => {
    const { code, out, err } = await run(["docs"])
    expect({ code, err }).toEqual({ code: 0, err: "" })
    const lines = out.trimEnd().split("\n")
    expect(lines).toHaveLength(CARDS.cards.length + 1)
    for (const card of CARDS.cards) expect(lines.filter((line) => line.startsWith(`  ${card.topic} `))).toHaveLength(1)
    expect(out).toBe(topicList(PROGRAM_NAME))
    // About 85 characters per topic line; 53 topics fit.
    expect(out.length).toBeLessThan(4_600)
  })
  test("the set covers what a user asks a model to change", () => {
    const topics = CARDS.cards.map((card) => card.topic)
    for (const topic of ["settings", "theme", "keys", "extensions", "footer", "commands", "tiers", "prompt-modes", "models", "permissions", "tools", "skills", "agents", "hooks", "mcp", "packages"]) expect(topics).toContain(topic)
  })
  test("a topic prints its card: a header line, the text with the program name filled in, exit 0", async () => {
    const { code, out } = await run(["docs", "extensions"])
    expect(code).toBe(0)
    const card = findCard("extensions")!
    expect(out.startsWith(`${PROGRAM_NAME} docs extensions: ${card.summary}\n\n`)).toBe(true)
    expect(out).toContain(card.text.replaceAll("{{program}}", PROGRAM_NAME))
    expect(out).not.toContain("{{program}}")
  })
  test("an alias prints the same card, and the lookup ignores case", async () => {
    const place = { dataDir: temp(), cwd: temp() }
    const [byAlias, byName] = [await run(["docs", "Themes"], place), await run(["docs", "theme"], place)]
    expect(byAlias.out).toBe(byName.out)
    expect(findCard("keybindings")?.topic).toBe("keys")
    expect(findCard("statusline")?.topic).toBe("footer")
    expect(findCard("nope")).toBeUndefined()
  })
  test("only unknown topics: one line each on stderr, then the topic list, exit 2, nothing on stdout", async () => {
    const { code, out, err } = await run(["docs", "nope"])
    expect(code).toBe(2)
    expect(out).toBe("")
    expect(err.split("\n")[0]).toBe('no card "nope"')
    expect(err).toBe(`no card "nope"\n${topicList(PROGRAM_NAME)}`)
    const two = await run(["docs", "nope", "nada"])
    expect(two.code).toBe(2)
    expect(two.err.split("\n").slice(0, 2)).toEqual(['no card "nope"', 'no card "nada"'])
  })
  test("several topics print each card in order, and a topic given twice (or by alias) prints once", async () => {
    const place = { dataDir: temp(), cwd: temp() }
    const { code, out, err } = await run(["docs", "packages", "prompt-modes", "extensions"], place)
    expect({ code, err }).toEqual({ code: 0, err: "" })
    const headers = [...out.matchAll(new RegExp(`^${PROGRAM_NAME} docs ([a-z-]+):`, "gm"))].map((match) => match[1])
    expect(headers).toEqual(["packages", "prompt-modes", "extensions"])
    const again = await run(["docs", "footer", "statusline", "footer"], place)
    expect([...again.out.matchAll(new RegExp(`^${PROGRAM_NAME} docs ([a-z-]+):`, "gm"))]).toHaveLength(1)
    expect(await run(["docs", "footer"], place)).toMatchObject({ out: again.out })
  })
  test("an unknown topic among known ones does not fail the call: the cards print, the word is named with its nearest topics, exit 0", async () => {
    const place = { dataDir: temp(), cwd: temp() }
    const { code, out, err } = await run(["docs", "theme", "layot", "footer", "zzzz"], place)
    expect({ code, err }).toEqual({ code: 0, err: "" })
    expect(out).toContain(`${PROGRAM_NAME} docs theme:`)
    expect(out).toContain(`${PROGRAM_NAME} docs footer:`)
    expect(out).toMatch(/^no card "layot" · nearest: layout/m)
    expect(out).toMatch(/^no card "zzzz"$/m)
    expect(out.indexOf("docs theme:")).toBeLessThan(out.indexOf('no card "layot"'))
    expect(out.indexOf('no card "layot"')).toBeLessThan(out.indexOf("docs footer:"))
  })
  test("the nearest topics come from the slash menu's matching, at most three, aliases and summaries included", () => {
    expect(nearestTopics("layot")).toEqual(["layout"])
    expect(nearestTopics("stylesheet")).toEqual([])
    expect(nearestTopics("footr")[0]).toBe("footer")
    expect(nearestTopics("per").length).toBeLessThanOrEqual(3)
    expect(nearestTopics("quota")).toEqual(["usage"])
  })
  test("the synonyms people type reach the cards they want", () => {
    for (const [word, topic] of [["statusline", "footer"], ["panel", "layout"], ["sidebar", "layout"], ["quota", "usage"], ["limits", "usage"], ["usage", "usage"], ["cost", "budgets"]] as const) expect([word, findCard(word)?.topic]).toEqual([word, topic])
  })
  test("`docs commands NAME` still prints one command alone, next to other topics", async () => {
    const live = async () => ({ settings: { tier: "balanced" }, prompt: undefined })
    const one = await run(["docs", "commands", "changes"], { live })
    expect(one.out).toContain("/changes")
    expect(one.out).not.toContain(`${PROGRAM_NAME} docs commands:`)
    const both = await run(["docs", "commands", "changes", "layout"], { live })
    expect(both.out).toContain("/changes")
    expect(both.out).toContain(`${PROGRAM_NAME} docs layout:`)
    const card = await run(["docs", "commands", "footer"], { live })
    expect(card.out).toContain(`${PROGRAM_NAME} docs commands:`)
    expect(card.out).toContain(`${PROGRAM_NAME} docs footer:`)
    const slash = await run(["docs", "commands", "/footer"], { live })
    expect(slash.out).not.toContain(`${PROGRAM_NAME} docs footer:`)
    expect(slash.out).toContain("/footer")
  })
  test("a long call is bounded: whole cards while they fit, the rest named with how to ask again", async () => {
    const topics = CARDS.cards.map((card) => card.topic)
    const { code, out } = await run(["docs", ...topics.slice(0, 8)])
    expect(code).toBe(0)
    const cut = /^cut at \d+ characters, not printed: (.*) · run \S+ docs (.*) again$/m.exec(out)
    const body = cut ? out.slice(0, cut.index) : out
    expect(body.length).toBeLessThanOrEqual(DOCS_OUTPUT_BUDGET + 3_500)
    const printed = [...out.matchAll(new RegExp(`^${PROGRAM_NAME} docs ([a-z-]+):`, "gm"))].map((match) => match[1])
    expect(printed.length + (cut ? cut[1]!.split(", ").length : 0)).toBe(8)
    expect(printed.length).toBeGreaterThan(0)
    if (cut) expect(cut[2]).toBe(cut[1]!.split(", ").join(" "))
  })
  test("usage errors exit 64 and --help prints the usage", async () => {
    expect(await run(["docs", ...Array.from({ length: 9 }, (_, at) => `t${at}`)])).toMatchObject({ code: 64 })
    expect(await run(["docs", "--json"])).toMatchObject({ code: 64, out: "" })
    const help = await run(["docs", "--help"])
    expect(help).toMatchObject({ code: 0, out: DOCS_USAGE })
  })
  test("every card is small, plain text and names its change by command, file or slash command", () => {
    for (const card of CARDS.cards) {
      expect(card.text.length).toBeLessThanOrEqual(3_000)
      expect(card.text).not.toMatch(/\[\[setting:|docs\/[\w-]+\.md/)
      expect(card.text).toMatch(/\{\{program\}\}|\.json|\.md|\.ts|\/[a-z-]+/)
    }
  })
})

describe("docs: search", () => {
  test("--search takes plain words, in any position among the flags, and nothing else", () => {
    expect(parseDocsCommand(["docs", "--search", "pause", "agent"])).toEqual({ help: false, words: ["pause", "agent"], search: true })
    expect(parseDocsCommand(["docs", "pause", "agent", "--search", "--dir", "/tmp/x"])).toEqual({ help: false, words: ["pause", "agent"], dir: "/tmp/x", search: true })
    expect(parseDocsCommand(["docs", "--search"])!.error).toMatch(/--search needs words/)
    expect(DOCS_USAGE).toContain("docs --search WORDS")
  })
  test("it prints up to five cards best first, each with its summary and the line that answers, and exits 0", async () => {
    const { code, out, err } = await run(["docs", "--search", "pause", "agent"])
    expect({ code, err }).toEqual({ code: 0, err: "" })
    const rows = out.slice(0, out.indexOf("The best one follows whole")).split("\n").filter((line) => /^ {2}\S/.test(line))
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThanOrEqual(5)
    expect(rows[0]).toMatch(/^ {2}subagents · /)
    expect(out.split("\n")[0]).toBe(`${PROGRAM_NAME} docs --search pause agent: ${rows.length} cards, best first`)
    expect(out).not.toContain("{{program}}")
    // The best card follows whole, so one call is enough to act on.
    const list = out.slice(0, out.indexOf("The best one follows whole"))
    expect(list.length).toBeLessThan(2_000)
    expect(out).toContain(`\n${PROGRAM_NAME} docs subagents: `)
    expect(out.length).toBeLessThan(2_000 + 3_600)
  })
  test("a search with no hit is an unknown-topic error: the topic list on stderr, exit 2", async () => {
    const { code, out, err } = await run(["docs", "--search", "zzzzqq", "xxyyzz"])
    expect({ code, out }).toEqual({ code: 2, out: "" })
    expect(err.split("\n")[0]).toBe('no card answers "zzzzqq xxyyzz"')
    // Where a model would go looking elsewhere, it is told a source tree on the machine may not be this program.
    expect(err.split("\n")[1]).toBe(VERSION_NOTE)
    expect(VERSION_NOTE).toMatch(/installed version; a MendCode source tree on this machine may be another version/)
    expect(err).toContain(topicList(PROGRAM_NAME))
  })
  test("the matching line follows only a real alternative: not the best card (printed whole below) and not a weak match", () => {
    for (const words of [["context", "compaction"], ["global", "contextWindow", "settings"], ["settings", "config", "file"]]) {
      const hits = searchCards(words, CARDS.cards)
      const rows = searchText(PROGRAM_NAME, words)!.split("\n")
      for (const [at, hit] of hits.entries()) {
        const row = rows.indexOf(`  ${hit.topic} · ${hit.summary}`)
        expect([words.join(" "), hit.topic, row > 0]).toEqual([words.join(" "), hit.topic, true])
        const hasLine = rows[row + 1]!.startsWith("    ")
        expect([words.join(" "), hit.topic, hasLine]).toEqual([words.join(" "), hit.topic, at > 0 && hit.line !== "" && hit.score >= hits[0]!.score * SEARCH_LINE_SHARE])
      }
    }
    // "context compaction": the answer is the compaction card; usage is the one alternative worth a line, the three weak matches are named only.
    const list = searchText(PROGRAM_NAME, ["context", "compaction"])!
    expect(list.split("\n").filter((line) => line.startsWith("    "))).toHaveLength(1)
    expect(list.length).toBeLessThan(800)
  })
  test("an unknown topic with several words points to the search instead of guessing", async () => {
    const { code, out } = await run(["docs", "theme", "dark", "mode", "toggle"])
    expect(code).toBe(0)
    expect(out).toContain(`${PROGRAM_NAME} docs theme:`)
    expect(out).toMatch(new RegExp(`docs --search (dark|mode|toggle)`))
  })
  test("the synonyms users type reach their card by the alias table", () => {
    for (const [word, topic] of [["worktree", "git"], ["subagent", "subagents"], ["resume", "sessions"], ["cron", "loops"], ["telegram", "remote"], ["websearch", "web"], ["lsp", "codegraph"], ["jev", "reasoning"], ["headless", "automation"]]) expect([word, findCard(word!)?.topic]).toEqual([word, topic])
  })
})

describe("docs: live lines of the feature cards", () => {
  const context = (settings?: Record<string, unknown>) => ({ dataDir: temp(), cwd: temp(), settings, prompt: undefined })
  test("a card about features says on or off with the reason and the switch, and without a daemon it says nothing is known", () => {
    expect(liveLines("git", context({ tier: "minimalist" })).join("\n")).toMatch(/off \(tier minimalist\) · \/tier balanced includes it/)
    expect(liveLines("git", context({ tier: "balanced" })).join("\n")).toContain("worktreeGcDays off (default)")
    expect(liveLines("git", context(undefined)).join("\n")).toContain("no daemon running")
    expect(liveLines("memory", context({ tier: "balanced", memoryUse: true })).join("\n")).toMatch(/memoryUse true · memoryGenerate false \(default\)/)
  })
  test("a feature that its tier only allows says what else turns it on", () => {
    expect(liveLines("computer", context({ tier: "full" })).join("\n")).toMatch(/allowed \(tier full\)/)
    expect(liveLines("reasoning", context({ tier: "full" })).join("\n")).toMatch(/Adaptive reasoning \(JEV\): on|Adaptive reasoning \(JEV\): allowed/)
  })
  test("settings that may carry secrets print their shape, never a value", () => {
    const lines = liveLines("web", context({ tier: "balanced", proxy: { url: "http://user:pw@proxy:3128" }, web: { blockDomains: ["x.com"] } })).join("\n")
    expect(lines).toContain("web rules: blockDomains · proxy: set")
    expect(lines).not.toContain("pw@")
  })
})

describe("docs: live lines", () => {
  test("theme: the real built-in list, the theme in force from the profile and the theme files of the data dir and the project", async () => {
    const dataDir = temp(), cwd = temp()
    mkdirSync(path.join(dataDir, "themes"), { recursive: true })
    writeFileSync(path.join(dataDir, "themes", "forest.json"), "{}")
    mkdirSync(path.join(cwd, ".mendcode", "themes"), { recursive: true })
    writeFileSync(path.join(cwd, ".mendcode", "themes", "dusk.json"), "{}")
    mkdirSync(path.join(dataDir, "tui"), { recursive: true })
    writeFileSync(path.join(dataDir, "tui", "profile.json"), JSON.stringify({ theme: "dracula" }))
    const { out } = await run(["docs", "theme"], { dataDir, cwd })
    expect(out).toContain("On this machine now:")
    expect(out).toContain("- current theme: dracula")
    for (const theme of THEMES) expect(out).toContain(theme.name)
    expect(out).toContain("system")
    expect(out).toMatch(/theme files, user \(.*\): forest/)
    expect(out).toMatch(/theme files, project \(.*\): dusk/)
    expect(out).toContain("no daemon running")
  })
  test("theme: the daemon's setting is the fallback when the profile names none", () => {
    const lines = liveLines("theme", { dataDir: temp(), cwd: temp(), settings: { theme: "nord" }, prompt: undefined })
    expect(lines[0]).toBe("current theme: nord")
    expect(lines.join("\n")).not.toContain("no daemon running")
  })
  test("keys: the user's bindings and the problems of the file are read with the real parser", async () => {
    const dataDir = temp()
    writeFileSync(path.join(dataDir, "keybindings.json"), JSON.stringify({ f4: "command:usage", "alt+q": null, "ctrl+c": "palette", "ctrl+g": "no.such.action" }))
    const { out } = await run(["docs", "keys"], { dataDir })
    expect(out).toContain("your bindings: f4 -> command:usage, alt+q -> unbound")
    expect(out).toContain("problem: keybindings.json: ctrl+c is reserved")
    expect(out).toContain("unknown action")
    expect((await run(["docs", "keys"])).out).toContain("none: every default applies")
  })
  test("key-actions: every action of this version, once, with its default keys, and the prompt's editing actions in one line", async () => {
    const { out } = await run(["docs", "key-actions"])
    expect(out).toContain("Actions of this version:")
    for (const row of ["permission.next: shift+tab", "palette: ctrl+p", "editor.open: ctrl+x e", "dock: ctrl+t"]) expect(out).toContain(`- ${row}`)
    expect(out).toContain("prompt editing, as edit.<name>:")
    expect(out).not.toMatch(/\\u00|\x1b/)
    expect(out.length).toBeLessThan(4_000)
  })
  test("folders: tools, skills, commands, agents and extensions list what the data dir and the project hold", async () => {
    const dataDir = temp(), cwd = temp()
    mkdirSync(path.join(dataDir, "skills", "release-notes"), { recursive: true })
    writeFileSync(path.join(dataDir, "skills", "release-notes", "SKILL.md"), "x")
    mkdirSync(path.join(cwd, ".mendcode", "commands"), { recursive: true })
    writeFileSync(path.join(cwd, ".mendcode", "commands", "audit.md"), "x")
    expect((await run(["docs", "skills"], { dataDir, cwd })).out).toMatch(/skills: release-notes/)
    expect((await run(["docs", "commands"], { dataDir, cwd })).out).toMatch(/\.mendcode\/commands: audit/)
    expect((await run(["docs", "tools"], { dataDir, cwd })).out).toMatch(/tools: none/)
  })
  test("footer, hooks and mcp: the files that exist, and what they declare", async () => {
    const dataDir = temp(), cwd = temp()
    writeFileSync(path.join(dataDir, "statusline.json"), "{}")
    writeFileSync(path.join(dataDir, "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [], Stop: [] } }))
    writeFileSync(path.join(dataDir, "mcp.json"), JSON.stringify({ servers: { docs: { command: "x" } } }))
    expect((await run(["docs", "footer"], { dataDir, cwd })).out).toContain(`statusline.json: ${path.join(dataDir, "statusline.json")}`)
    expect((await run(["docs", "hooks"], { dataDir, cwd })).out).toContain("events: PreToolUse, Stop")
    expect((await run(["docs", "mcp"], { dataDir, cwd })).out).toContain("servers: docs")
    writeFileSync(path.join(dataDir, "mcp.json"), "not json")
    expect((await run(["docs", "mcp"], { dataDir, cwd })).out).toContain("unreadable")
  })
  test("daemon facts come from the injected lookup: tier, permission and prompt mode", async () => {
    const live = async ({ topic }: { topic: string }) => ({ settings: topic === "prompt-modes" ? undefined : { tier: "balanced", defaultPermission: "smart", budgets: { mode: "api-usage", warnUsd: 1 } }, prompt: topic === "prompt-modes" ? { mode: "focus", focusID: "auto", resolvedFocus: "claude" } : undefined })
    expect((await run(["docs", "tiers"], { live })).out).toContain("- tier: balanced")
    expect((await run(["docs", "permissions"], { live })).out).toContain("- defaultPermission: smart")
    expect((await run(["docs", "budgets"], { live })).out).toContain('budgets: {"mode":"api-usage","warnUsd":1}')
    expect((await run(["docs", "prompt-modes"], { live })).out).toContain("this project: mode focus, family auto (resolves to claude)")
    expect((await run(["docs", "tiers"])).out).toContain("none set")
  })
  test("the compaction card reads the two saved settings that move the compaction point, set or not", async () => {
    const set = async () => ({ settings: { compactAtTokens: 450_000, compaction: { threshold: 90, auto: false } }, prompt: undefined })
    const out = (await run(["docs", "compaction"], { live: set })).out
    expect(out).toContain("- compactAtTokens: 450000")
    expect(out).toContain('- compaction: {"threshold":90,"auto":false}')
    const unset = (await run(["docs", "compaction"], { live: async () => ({ settings: {}, prompt: undefined }) })).out
    expect(unset).toContain("- compactAtTokens: not set (each model compacts at a percentage of its window)")
    expect(unset).toContain("- compaction: not set (automatic at 90 percent of the window, or earlier to leave room for the reply)")
    expect((await run(["docs", "compaction"])).out).toContain("(no daemon running: daemon settings not shown)")
    expect(NEEDS_SETTINGS.has("compaction")).toBe(true)
  })
  test("the models card reads the windows kept per model (modelContext), set or not", async () => {
    const set = async () => ({ settings: { modelContext: { "chatgpt/gpt-6-astra": { window: 500_000 }, "openai/gpt-6-luna": { window: 300_000, compactAt: 250_000 } } }, prompt: undefined })
    expect((await run(["docs", "models"], { live: set })).out).toContain("- modelContext: chatgpt/gpt-6-astra window 500000 · openai/gpt-6-luna window 300000, compactAt 250000")
    expect((await run(["docs", "models"], { live: async () => ({ settings: {}, prompt: undefined }) })).out).toContain("- modelContext: not set (every model uses the model list's window)")
    expect(NEEDS_SETTINGS.has("models")).toBe(true)
  })
  test("a provider that throws costs only its live lines, never the card", () => {
    expect(liveLines("keys", { dataDir: "\0bad", cwd: "\0bad", settings: undefined, prompt: undefined }).length).toBeGreaterThanOrEqual(0)
    expect(liveLines("no-such-topic", { dataDir: temp(), cwd: temp(), settings: undefined, prompt: undefined })).toEqual([])
  })
})

describe("docs: usage and the footer name their data source", () => {
  const NOW = 1_800_000_000_000
  const snapshot = (provider: string, usedPercent: number, patch: Record<string, unknown> = {}) => ({ provider, windows: [{ id: "w", label: "7d", usedPercent, resetsAt: NOW + 5 * 86_400_000 }], fetchedAt: NOW - 120_000, source: "t", ...patch })

  test("the footer card sends the model to the built-in segments and MendCode's own readings, and forbids another program's files", () => {
    const text = findCard("footer")!.text
    expect(text.indexOf("A. Settings only")).toBeGreaterThan(-1)
    expect(text.indexOf("A. Settings only")).toBeLessThan(text.indexOf("B. A script"))
    expect(text.indexOf("B. A script")).toBeLessThan(text.indexOf("C. An extension"))
    expect(text).toMatch(/Use what is built in first/)
    expect(text).toMatch(/map each part to a built-in segment/)
    expect(text).toMatch(/MendCode's own readings/)
    expect(text).toMatch(/Never read another program's files or caches/)
    expect(text).toMatch(/tell the user which parts have no source \(shown as unavailable\)/)
    expect(text).toMatch(/Apply at once, do not ask first/)
    expect(text).toContain('footerRows [["directory","text:tagline"],["model","effort","context","cache","tokens"],["quota:codex"],["quota:claude"],["codegraph"]]')
    expect(text).toContain("{{program}} docs usage")
    expect(text).toContain("quotaView")
    expect(text).toContain("MENDCODE_USAGE_JSON")
  })

  test("the usage card names the source of each number, the staleness rule and the unknown rule", () => {
    const text = findCard("usage")!.text
    expect(text).toMatch(/MendCode's own readings are the only source/)
    expect(text).toMatch(/Never read another program's cache or login files/)
    expect(text).toMatch(/unknown: show n\/a, never 0% or 100%/)
    expect(text).toMatch(/older than 15 minutes.*stale/s)
    expect(text).toMatch(/does not refresh Claude's/)
    expect(text).toContain("api.usage()")
    expect(text).toContain("usedPercent + leftPercent = 100")
    for (const word of ["quota", "limits", "rate-limits"]) expect(findCard(word)?.topic).toBe("usage")
  })

  test("live: per provider and window, what is left and used, the reset, and a fresh or stale reading with its age", () => {
    const lines = liveLines("usage", { dataDir: temp(), cwd: temp(), settings: undefined, prompt: undefined, now: NOW, quotas: [snapshot("codex", 8), snapshot("claude", 60, { fetchedAt: NOW - 3 * 3_600_000 })] })
    expect(lines[0]).toBe("codex 7d: 92% left (8% used) · resets in 5d · fresh: observed 2m ago")
    expect(lines[1]).toMatch(/^claude 7d: 40% left \(60% used\) · resets in 5d · STALE: observed 3h ago, older than 15m or its window ended/)
    expect(lines[2]).toBe("a provider or window not listed is unknown (heard from: codex, claude): show it as unavailable, never as 0% or 100%")
  })

  test("live: no reading says every window is unknown; no daemon says nothing is known", () => {
    expect(liveLines("usage", { dataDir: temp(), cwd: temp(), settings: undefined, prompt: undefined, now: NOW, quotas: [] })[0]).toBe("no provider has reported a quota window yet: every window is unknown")
    expect(liveLines("usage", { dataDir: temp(), cwd: temp(), settings: undefined, prompt: undefined, now: NOW })[0]).toMatch(/^provider quota: not known \(no daemon is running/)
    expect(liveLines("usage", { dataDir: temp(), cwd: temp(), settings: undefined, prompt: undefined, now: NOW, quotas: [snapshot("codex", 8, { windows: [{ id: "w", label: "7d", usedPercent: 8, resetsAt: NOW - 1 }] })] })[0]).toContain("window already reset")
  })

  test("live: the quota refresh probe is off for a provider the profile does not list, and says nothing is sent", () => {
    const lines = liveLines("usage", { dataDir: temp(), cwd: temp(), settings: undefined, prompt: undefined, now: NOW, quotas: [] })
    expect(lines).toContain("codex refresh: off, nothing is sent")
    expect(lines).toContain("claude refresh: off, nothing is sent")
  })

  test("live: a listed provider shows its interval, the daemon's state, the last probe and the probes of today, and the cost", () => {
    const dataDir = temp()
    mkdirSync(path.join(dataDir, "tui"), { recursive: true })
    writeFileSync(path.join(dataDir, "tui", "profile.json"), JSON.stringify({ quotaRefresh: [{ provider: "codex", everyMinutes: 15 }, { provider: "claude", everyMinutes: 30, model: "claude-haiku" }] }))
    const base = { dataDir, cwd: temp(), settings: undefined, prompt: undefined, now: NOW, quotas: [] as never[] }
    const lines = liveLines("usage", { ...base, refresh: [{ provider: "codex", everyMinutes: 15, state: "on", lastProbeAt: NOW - 4 * 60_000, probesToday: 3 }, { provider: "claude", everyMinutes: 30, model: "claude-haiku", state: "stopped", probesToday: 3, lastError: "Claude Code reported no rate limits" }] })
    expect(lines).toContain("codex refresh: on, every 15 min · running · last probe 4m ago · 3 probes today (each spends some of the quota it measures)")
    expect(lines.find((line) => line.startsWith("claude refresh:"))).toMatch(/every 30 min on claude-haiku · STOPPED \(Claude Code reported no rate limits\); edit quotaRefresh to start again · no probe yet · 3 probes today/)
    // Without a daemon the setting is still shown, with the honest "no probe has run".
    expect(liveLines("usage", { ...base, quotas: undefined }).filter((line) => line.includes("refresh:"))).toEqual(expect.arrayContaining([expect.stringContaining("the daemon is not running: no probe has run")]))
  })

  test("the card prints the live lines through the command, from a daemon's quotas", async () => {
    const live = async () => ({ settings: undefined, prompt: undefined, quotas: [snapshot("codex", 8, { fetchedAt: Date.now() })] })
    const { out } = await run(["docs", "usage"], { live })
    expect(out).toContain("On this machine now:")
    expect(out).toMatch(/- codex 7d: 92% left \(8% used\)/)
  })
})

describe("docs: with a daemon that already runs", () => {
  test("the card carries its real settings; with none running it says so and still prints", async () => {
    const dataDir = temp(), cwd = temp()
    const none = await runDocsCommand(parseDocsCommand(["docs", "tiers"])!, { dataDir, cwd, out: { write: () => {} }, err: { write: () => {} } })
    expect(none).toBe(0)
    const daemon = await startDaemon({ dir: dataDir, socketPath: path.join(dataDir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
    cleanups.push(() => daemon.stop())
    let out = ""
    const code = await runDocsCommand(parseDocsCommand(["docs", "prompt-modes"])!, { dataDir, cwd, out: { write: (text) => void (out += text) }, err: { write: () => {} } })
    expect(code).toBe(0)
    expect(out).toMatch(/this project: mode focus, family auto/)
    let permissions = ""
    await runDocsCommand(parseDocsCommand(["docs", "permissions"])!, { dataDir, cwd, out: { write: (text) => void (permissions += text) }, err: { write: () => {} } })
    expect(permissions).toContain("On this machine now:")
    expect(permissions).not.toContain("no daemon running")
    let usage = ""
    await runDocsCommand(parseDocsCommand(["docs", "usage"])!, { dataDir, cwd, out: { write: (text) => void (usage += text) }, err: { write: () => {} } })
    expect(usage).toContain("- no provider has reported a quota window yet: every window is unknown")
  })
})
