import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { SLASH_GROUPS, TIERS, type Tier } from "@mendcode/protocol/wire"
import { parseDocsCommand } from "../src/docs-args"
import { CARDS, runDocsCommand } from "../src/docs-run"
import { SUMMARY_BUDGET } from "../src/docs-commands"
import { SLASH_COMMANDS } from "../src/view/commands"
import { menuCatalog } from "../src/view/slash-menu"
import { DEFAULT_TUI_PROFILE } from "../src/view/tui-profile"

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
const temp = () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-docs-commands-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const profile = (dataDir: string, value: unknown) => {
  mkdirSync(path.join(dataDir, "tui"), { recursive: true })
  writeFileSync(path.join(dataDir, "tui", "profile.json"), typeof value === "string" ? value : JSON.stringify(value))
}

/** Runs `docs commands [name]` the way the CLI does, with the daemon's settings stood in for (`undefined`: no daemon runs). */
async function docs(options: { dataDir?: string; cwd?: string; settings?: Record<string, unknown> | undefined; detail?: string; argv?: string[] } = {}) {
  const argv = options.argv ?? ["docs", "commands", ...(options.detail ? [options.detail] : [])]
  let out = "", err = ""
  const code = await runDocsCommand(parseDocsCommand(argv)!, { dataDir: options.dataDir ?? temp(), cwd: options.cwd ?? temp(), out: { write: (text) => void (out += text) }, err: { write: (text) => void (err += text) }, live: async () => ({ settings: options.settings, prompt: undefined }) })
  return { code, out, err, live: out.includes("On this machine now:") ? out.slice(out.indexOf("On this machine now:")).split("\n").slice(1).filter((line) => line.startsWith("- ")).map((line) => line.slice(2)) : [] }
}

/** The group lines of the live section as name sets (`changes=diff`, `/changes=diff Review…` and `(pinned)` reduce to `changes`). */
function groups(live: string[]) {
  const found = new Map<string, string[]>()
  for (const group of SLASH_GROUPS.filter((id) => id !== "recent")) {
    const line = live.find((entry) => entry.startsWith(`${group}: `))
    expect(line).toBeDefined()
    const body = line!.slice(group.length + 2)
    const items = body === "none" ? [] : body.split(body.includes("; ") || /^\//.test(body) ? "; " : ", ")
    found.set(group, items.map((item) => /^\/?([^=\s(]+)/.exec(item)![1]!))
  }
  return found
}

describe("docs commands: what this install offers", () => {
  for (const tier of TIERS) {
    test(`${tier}: the groups are the menu's own commands, once each, and the tier line counts them`, async () => {
      const { code, live } = await docs({ settings: { tier } })
      expect(code).toBe(0)
      const menu = menuCatalog([], DEFAULT_TUI_PROFILE, { tier }).filter((command) => !command.setting)
      const found = groups(live)
      for (const group of SLASH_GROUPS.filter((id) => id !== "recent")) expect([group, [...found.get(group)!].sort()]).toEqual([group, menu.filter((command) => command.group === group).map((command) => command.name).sort()])
      expect(live[0]).toStartWith(`tier: ${tier} (/tier changes it) · ${menu.length} commands in the menu`)
      const settingRows = menuCatalog([], DEFAULT_TUI_PROFILE, { tier }).filter((command) => command.setting).map((command) => command.name)
      const rowsLine = live.find((line) => line.startsWith("setting rows"))
      expect(settingRows.length ? rowsLine : "none").toBeDefined()
      for (const name of settingRows) expect(rowsLine).toContain(name)
    })
  }
  test("minimalist lists exactly its twenty-one, with a few words about each; balanced and full list names, with the lookup for the rest", async () => {
    const minimalist = await docs({ settings: { tier: "minimalist" } })
    expect(minimalist.live[0]).toContain("21 commands in the menu")
    expect(minimalist.live.join("\n")).toContain("/new Start a session")
    expect(minimalist.live.join("\n")).toContain("/quit=exit=q Quit")
    for (const tier of ["balanced", "full"] as const) {
      const { live, out } = await docs({ settings: { tier } })
      expect(live.join("\n")).not.toContain("/new Start a session")
      expect(live.find((line) => line.startsWith("session: "))).toContain("sessions=resume")
      expect(live.at(-1)).toBe("one command in detail: mendcode docs commands <name>")
      expect(out).toContain("mendcode docs commands <name>")
    }
    expect(minimalist.live.filter((line) => /^(?:session|context|code|agents|setup|look|more): /.test(line)).join("\n").length).toBeLessThanOrEqual(SUMMARY_BUDGET)
  })
  test("a feature that is off leaves its command out, as it leaves the menu: full lists what balanced does not", async () => {
    const balanced = groups((await docs({ settings: { tier: "balanced" } })).live)
    const full = groups((await docs({ settings: { tier: "full" } })).live)
    const all = (map: Map<string, string[]>) => [...map.values()].flat()
    expect(all(balanced)).not.toContain("mcps")
    expect(all(full)).toContain("mcps")
    expect(all(full).length).toBeGreaterThan(all(balanced).length)
    const switched = groups((await docs({ settings: { tier: "balanced", features: { mcp: true } } })).live)
    expect(all(switched)).toContain("mcps")
  })
  test("with no daemon the tier is said to be unknown, not guessed", async () => {
    const { live } = await docs({ settings: undefined })
    expect(live[0]).toContain("tier: not known (no daemon is running")
    expect(live.at(-2)).toBe("no tier is set, so there is no next one")
  })
  test("every built-in command appears in some tier's list, and every alias that is listed is a real one", async () => {
    const seen = new Set<string>()
    for (const tier of TIERS) for (const name of [...groups((await docs({ settings: { tier } })).live).values()].flat()) seen.add(name)
    const rows = new Set(SLASH_COMMANDS.filter((command) => command.setting).map((command) => command.name))
    for (const command of SLASH_COMMANDS) if (!rows.has(command.name)) expect([command.name, seen.has(command.name) || !!command.feature]).toEqual([command.name, true])
    const { live } = await docs({ settings: { tier: "full", features: { mcp: true, subagents: true, packages: true } } })
    const text = live.filter((line) => /^(?:session|context|code|agents|setup|look|more): /.test(line)).join("\n")
    for (const pair of ["changes=diff", "sessions=resume", "settings=config", "quit=exit=q", "help=?", "mcps=mcp", "find=search", "workflows=wf"]) expect(text).toContain(pair)
    for (const gone of ["commit-push", "commit-pr", "customize=tui", " av,", "=continue", "tour"]) expect(text).not.toContain(gone)
  })
})

describe("docs commands: what the user changed", () => {
  const entries = [{ name: "changes", aliases: ["d"], pinned: true }, { name: "fetch", hidden: true }, { name: "worktrees", group: "session", order: 1 }, { name: "tier", hidden: false }]
  test("hidden, pinned, moved and aliased are named, the list is repeated as written and the pinned and moved ones sit where the menu puts them", async () => {
    const dataDir = temp()
    profile(dataDir, { slashCommands: entries })
    const { live } = await docs({ dataDir, settings: { tier: "balanced" } })
    const mine = live.find((line) => line.startsWith("your profile, "))!
    expect(mine).toContain(path.join(dataDir, "tui", "profile.json"))
    expect(mine).toContain("hidden: fetch")
    expect(mine).toContain("pinned: changes")
    expect(mine).toContain("moved: worktrees->session")
    expect(mine).toContain("aliases: d->changes")
    expect(live).toContain(`slashCommands now: ${JSON.stringify(entries)}`)
    const found = groups(live)
    expect(found.get("code")![0]).toBe("changes")
    expect(found.get("session")![0]).toBe("worktrees")
    expect(live.find((line) => line.startsWith("more: "))).toContain("fetch (hidden)")
    expect(live.find((line) => line.startsWith("code: "))).toContain("changes=diff (pinned)")
  })
  test("a profile that does not exist yet says so, and one the terminal would drop is reported with the reason", async () => {
    const dataDir = temp()
    expect((await docs({ dataDir, settings: { tier: "balanced" } })).live.join("\n")).toContain("(not written yet): nothing changed in the commands")
    profile(dataDir, { slashCommands: [{ name: "changes", aliases: ["d"] }, { name: "model", aliases: ["d"] }] })
    const broken = (await docs({ dataDir, settings: { tier: "balanced" } })).live
    expect(broken.find((line) => line.startsWith("problem: slashCommands"))).toContain("used twice")
    expect(broken).toContain("slashCommands now: []")
    profile(dataDir, "{ not json")
    expect((await docs({ dataDir, settings: { tier: "balanced" } })).live.join("\n")).toContain("profile.json is not valid JSON")
  })
  test("an alias the terminal ignores is named with its reason", async () => {
    const dataDir = temp()
    profile(dataDir, { slashCommands: [{ name: "changes", aliases: ["new", "d"] }, { name: "no-such", aliases: ["ghost"] }] })
    const { live } = await docs({ dataDir, settings: { tier: "balanced" } })
    expect(live).toContain("problem: alias new is ignored: /new is a built-in command")
    expect(live).toContain("problem: alias ghost is ignored: there is no command no-such")
    expect(live.join("\n")).not.toContain("alias d is ignored")
  })
  test("the user's own commands are listed from the data dir, the project and the command map of mendcode.json", async () => {
    const dataDir = temp(), cwd = temp()
    mkdirSync(path.join(dataDir, "commands", "git"), { recursive: true })
    writeFileSync(path.join(dataDir, "commands", "standup.md"), "x")
    writeFileSync(path.join(dataDir, "commands", "git", "pr.md"), "x")
    writeFileSync(path.join(dataDir, "mendcode.json"), JSON.stringify({ command: { audit: { template: "x" } } }))
    mkdirSync(path.join(cwd, ".mendcode", "commands"), { recursive: true })
    writeFileSync(path.join(cwd, ".mendcode", "commands", "ship.md"), "x")
    const { live } = await docs({ dataDir, cwd, settings: { tier: "balanced" } })
    expect(live).toContain(`your commands, ${path.join(dataDir, "commands")}: audit, git:pr, standup`)
    expect(live).toContain(`your commands, ${path.join(cwd, ".mendcode", "commands")}: ship`)
  })
  test("a long profile is not repeated; its file is named instead", async () => {
    const dataDir = temp()
    profile(dataDir, { slashCommands: SLASH_COMMANDS.slice(0, 120).map((command) => ({ name: command.name, pinned: true, order: 3 })) })
    const { live } = await docs({ dataDir, settings: { tier: "full" } })
    expect(live.find((line) => line.startsWith("slashCommands now: "))).toBe("slashCommands now: 120 entries, too long to repeat here: read the file")
  })
})

describe("docs commands: what a higher tier adds", () => {
  const added = async (tier: Tier) => {
    return (await docs({ settings: { tier } })).live.find((entry) => entry.startsWith("the next tier") || entry.endsWith("is the highest tier"))!
  }
  test("minimalist names the first of what balanced adds and how many more; balanced names what full adds; full has no next", async () => {
    const minimalist = await added("minimalist")
    const balancedNames = menuCatalog([], DEFAULT_TUI_PROFILE, { tier: "balanced" }).map((command) => command.name)
    const now = new Set(menuCatalog([], DEFAULT_TUI_PROFILE, { tier: "minimalist" }).map((command) => command.name))
    const total = balancedNames.filter((name) => !now.has(name)).length
    expect(minimalist).toStartWith(`the next tier (balanced) would add ${total}: `)
    expect(minimalist).toContain(`and ${total - 60} more`)
    const balanced = await added("balanced")
    expect(balanced).toMatch(/^the next tier \(full\) would add \d+: /)
    for (const name of ["mcps", "pet", "fanout"]) expect(balanced).toContain(name)
    expect(await added("full")).toBe("full is the highest tier")
  })
})

describe("docs commands <name>", () => {
  test("one command: summary, alias, group, the tier that lists it and what the profile says", async () => {
    const dataDir = temp()
    profile(dataDir, { slashCommands: [{ name: "changes", aliases: ["d"], pinned: true }] })
    const { code, out } = await docs({ dataDir, detail: "changes", settings: { tier: "balanced" } })
    expect(code).toBe(0)
    expect(out).toContain("/changes (alias /diff): Review changes and replay hunks · your aliases /d")
    expect(out).toContain("group code · listed from balanced · offered here")
    expect(out).toContain('your profile entry: {"name":"changes","aliases":["d"],"pinned":true}')
    expect(out).not.toContain("On this machine now")
  })
  test("by a built-in alias, by your alias, with or without the slash, and by a name the tier does not offer", async () => {
    const dataDir = temp()
    profile(dataDir, { slashCommands: [{ name: "changes", aliases: ["d"] }] })
    for (const word of ["diff", "/diff", "d", "CHANGES"]) expect((await docs({ dataDir, detail: word, settings: { tier: "balanced" } })).out).toContain("/changes (alias /diff)")
    expect((await docs({ dataDir, detail: "changes", settings: { tier: "minimalist" } })).out).toContain("not offered here")
    expect((await docs({ dataDir, detail: "mcps", settings: { tier: "balanced" } })).out).toContain("needs the mcp feature (off)")
    expect((await docs({ dataDir, detail: "raw", settings: { tier: "balanced" } })).out).toContain("a setting row: found by typing, opens /settings presentation")
  })
  test("a removed alias says where it went; an unknown name says it is none; a word after another topic is one more topic word", async () => {
    expect((await docs({ detail: "tui", settings: { tier: "balanced" } })).out).toBe("/tui is now /customize\n")
    expect((await docs({ detail: "no-such", settings: { tier: "balanced" } })).out).toContain("no built-in command or alias named no-such")
    const other = await docs({ argv: ["docs", "tiers", "balanced"] })
    expect(other.code).toBe(0)
    expect(other.out).toContain("docs tiers:")
    expect(other.out).toContain('no card "balanced"')
  })
})

describe("docs commands: where it reads", () => {
  test("--dir picks the data dir the lines name, whatever the default is", async () => {
    const dataDir = temp()
    profile(dataDir, { slashCommands: [{ name: "changes", pinned: true }] })
    const { live } = await docs({ argv: ["docs", "commands", "--dir", dataDir], dataDir, settings: { tier: "balanced" } })
    expect(live.find((line) => line.startsWith("your profile, "))).toContain(path.join(dataDir, "tui", "profile.json"))
    expect(live.join("\n")).toContain(`your commands, ${path.join(dataDir, "commands")}: none`)
  })
  test("the printed card stays inside the budgets: the static text, and the whole output for any tier", async () => {
    const card = CARDS.cards.find((entry) => entry.topic === "commands")!
    expect(card.text.length).toBeLessThanOrEqual(3_000)
    for (const tier of TIERS) expect((await docs({ settings: { tier } })).out.length).toBeLessThan(6_000)
  })
})
