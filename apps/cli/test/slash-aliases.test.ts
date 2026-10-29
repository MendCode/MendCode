import { afterEach, describe, expect, test } from "bun:test"
import { tuiProblems } from "@mendcode/protocol/wire"
import { DIAGNOSTIC_COMMANDS, SLASH_COMMANDS, parseSlash, slashSuggestions } from "../src/view/commands"
import { createSlashMenuState, renderSlashMenu, slashMenuModel } from "../src/view/slash-menu"
import { expandUserAlias, removedAliasHint, userAliasProblems, userAliases } from "../src/view/slash-aliases"
import { DEFAULT_TUI_PROFILE, readTuiProfile, writeTuiProfile } from "../src/view/tui-profile"
import { appHarness, scratch } from "./extensions-harness"

const made: ReturnType<typeof scratch>[] = []
const temporary = () => { const dir = scratch(); made.push(dir); return dir }
afterEach(() => { for (const dir of made.splice(0)) dir.cleanup() })
const plain = (row: { text: string }[]) => row.map((span) => span.text).join("")

/** The 23 words the owner kept: one other name per command, `/quit` alone has two. `pr-watch` is the feature's own name (docs/pr-watch.md). */
const KEPT = ["pr=pr-watch", "changes=diff", "sessions=resume", "settings=config", "quit=exit", "quit=q", "help=?", "mcps=mcp", "find=search", "usage=stats", "model=models", "theme=themes", "keymap=keybindings", "context=ctx", "memory=mem", "extensions=ext", "packages=pkg", "workflows=wf", "loops=loop", "bg=background", "permissions=perm", "providers=provider", "jump-to-latest=jump"]

describe("the built-in aliases", () => {
  test("only the kept ones exist, at most one per command, `/quit` the one exception", () => {
    const found = SLASH_COMMANDS.flatMap((command) => command.aliases.map((alias) => `${command.name}=${alias}`))
    expect(found.sort()).toEqual([...KEPT].sort())
    for (const command of SLASH_COMMANDS) expect([command.name, command.aliases.length <= (command.name === "quit" ? 2 : 1)]).toEqual([command.name, true])
    expect(SLASH_COMMANDS).toHaveLength(156)
    expect(SLASH_COMMANDS.filter((command) => command.aliases.length)).toHaveLength(22)
  })
  test("the Git page adds one command, /git, with no alias: /changes, /diff, /worktrees and /warp keep their names and their own summaries", () => {
    expect(SLASH_COMMANDS.find((command) => command.name === "git")).toMatchObject({ aliases: [], feature: "git_hub" })
    for (const word of ["changes", "diff", "worktrees", "warp", "git"]) expect([word, parseSlash(`/${word}`)?.command.name]).toEqual([word, word === "diff" ? "changes" : word])
    const summaries = SLASH_COMMANDS.map((command) => command.summary)
    expect(new Set(summaries).size).toBe(summaries.length)
  })
  test("every kept alias resolves to its command with the arguments after it", () => {
    for (const entry of KEPT) {
      const [name, alias] = entry.split("=") as [string, string]
      expect([alias, parseSlash(`/${alias} x y`)?.command.name, parseSlash(`/${alias} x y`)?.args]).toEqual([alias, name, "x y"])
    }
  })
  test("the commit forms are arguments of /commit, not names", () => {
    expect(parseSlash("/commit push hint")).toMatchObject({ command: { name: "commit" }, args: "push hint" })
    expect(parseSlash("/commit-push")).toBeUndefined()
    expect(parseSlash("/commit-pr")).toBeUndefined()
  })
  test("no alias is another command's name, and the diagnostics command keeps its short form", () => {
    const names = new Set(SLASH_COMMANDS.map((command) => command.name))
    for (const command of SLASH_COMMANDS) for (const alias of command.aliases) expect([alias, names.has(alias)]).toEqual([alias, false])
    expect(DIAGNOSTIC_COMMANDS.find((command) => command.name === "diagnostics")?.aliases).toEqual(["diag"])
  })
})

describe("a removed alias", () => {
  const REMOVED = ["mode", "session-history", "branches", "bookmark", "features", "tiers", "warnings", "dictate", "note", "hotkeys", "recall", "tour", "screen-reader", "diagrams", "set-context-window", "detach", "continue", "memories", "memory-manager", "memory-center", "onboarding", "configure", "tui", "customization", "capabilities", "tui-customization", "av", "usage-limit", "workflow", "disk", "prompt-context", "prompt", "modes", "chatinput", "prompt-style", "tui-prompt", "chat-presentation", "render-mode", "message-renderer", "markdown-rendering", "send-scroll", "clear-submit", "toggle-timestamps", "toggle-thinking", "latest", "comment", "replies", "working", "activity-status", "sticky", "project-stats", "project-usage", "commit-push", "commit-pr", "pr-comments", "replay-intro", "pair", "orgs", "switch-org"]
  test("is no command, and its line says where the command is now", () => {
    expect(REMOVED).toHaveLength(59)
    for (const word of REMOVED) {
      const hint = removedAliasHint(`/${word} some arguments`)
      expect([word, parseSlash(`/${word}`)]).toEqual([word, undefined])
      expect(hint).toMatch(new RegExp(`^/${word} is now /`))
      const target = hint!.split(" is now /")[1]!.split(" ")[0]!
      expect([word, SLASH_COMMANDS.some((command) => command.name === target)]).toEqual([word, true])
    }
    expect(removedAliasHint("/tui")).toBe("/tui is now /customize")
    expect(removedAliasHint("/commit-pr")).toBe("/commit-pr is now /commit pr")
  })
  test("is the only thing the hint answers: kept aliases, built-ins, unknown words and plain text get none", () => {
    for (const text of ["/diff", "/changes", "/loop", "/xyz", "hello /tui", "/Users/me/file", "//tui", "/", "/tui:x", "/hasOwnProperty", "/constructor", "/__proto__"]) expect([text, removedAliasHint(text)]).toEqual([text, undefined])
  })
})

describe("aliases of your own", () => {
  const prefs = [{ name: "changes", aliases: ["d"] }, { name: "model", pinned: true, aliases: ["m", "mm"] }]
  test("resolve to their command with the arguments after them", () => {
    expect(expandUserAlias("/d", prefs)).toBe("/changes")
    expect(expandUserAlias("/d src/a.ts", prefs)).toBe("/changes src/a.ts")
    expect(expandUserAlias("/mm\nsecond line", prefs)).toBe("/model\nsecond line")
    expect(expandUserAlias("/changes", prefs)).toBeUndefined()
    expect(expandUserAlias("/dd", prefs)).toBeUndefined()
    expect(expandUserAlias("d", prefs)).toBeUndefined()
    expect(expandUserAlias("/d", [])).toBeUndefined()
  })
  test("never shadow a built-in name or alias, a command of the project, or an unknown command", () => {
    const risky = [{ name: "changes", aliases: ["new", "diff", "d"] }, { name: "no-such-command", aliases: ["ghost"] }, { name: "standup", aliases: ["su", "plan"] }]
    const custom = [{ name: "standup" }, { name: "su" }]
    expect([...userAliases(risky, custom)]).toEqual([["d", "changes"]])
    expect(userAliasProblems(risky, custom)).toEqual([
      "alias new is ignored: /new is a built-in command",
      "alias diff is ignored: /diff is a built-in command",
      "alias ghost is ignored: there is no command no-such-command",
      "alias su is ignored: a command named su exists",
      "alias plan is ignored: /plan is a built-in command",
    ])
  })
  test("can name a command of the project, and a word that used to be a built-in alias", () => {
    const custom = [{ name: "standup" }]
    expect([...userAliases([{ name: "standup", aliases: ["su"] }, { name: "customize", aliases: ["tui"] }], custom)]).toEqual([["su", "standup"], ["tui", "customize"]])
    expect(expandUserAlias("/tui", [{ name: "customize", aliases: ["tui"] }])).toBe("/customize")
    expect(removedAliasHint("/tui")).toBeDefined()
  })
  test("show in the menu: found by typing, ranked first, named next to the command", () => {
    const profile = { ...DEFAULT_TUI_PROFILE, slashCommands: prefs }
    const view = slashMenuModel({ text: "/d", custom: [], profile, settings: { tier: "full" }, recents: [], state: createSlashMenuState(), selected: 0, width: 100, height: 14, ascii: false })!
    expect(view.items[0]?.command?.name).toBe("changes")
    expect(renderSlashMenu(view).map(plain).join("\n")).toContain("d / Review changes")
    const without = slashMenuModel({ text: "/d", custom: [], profile: DEFAULT_TUI_PROFILE, settings: { tier: "full" }, recents: [], state: createSlashMenuState(), selected: 0, width: 100, height: 14, ascii: false })!
    expect(without.items[0]?.command?.name).not.toBe("changes")
    expect(slashSuggestions("/mm", [], view.catalog)[0]?.name).toBe("model")
  })
})

describe("the profile accepts aliases and refuses what would chain, collide or run", () => {
  const check = (slashCommands: unknown) => tuiProblems({ slashCommands })
  test("valid", () => {
    expect(check([{ name: "changes", aliases: ["d"] }, { name: "model", hidden: false, aliases: ["m", "mm", "my-model_2"] }])).toEqual([])
    expect(check([{ name: "changes", aliases: [] }])).toEqual([])
  })
  test("invalid", () => {
    for (const bad of [
      [{ name: "changes", aliases: "d" }],
      [{ name: "changes", aliases: ["D"] }],
      [{ name: "changes", aliases: ["a b"] }],
      [{ name: "changes", aliases: ["../x"] }],
      [{ name: "changes", aliases: ["/d"] }],
      [{ name: "changes", aliases: [""] }],
      [{ name: "changes", aliases: [1] }],
      [{ name: "changes", aliases: ["x".repeat(33)] }],
      [{ name: "changes", aliases: Array.from({ length: 9 }, (_, n) => "a" + n) }],
      [{ name: "changes", aliases: ["d", "d"] }],
      [{ name: "changes", aliases: ["d"] }, { name: "model", aliases: ["d"] }],
      [{ name: "changes", aliases: ["changes"] }],
      [{ name: "changes", aliases: ["model"] }, { name: "model" }],
      [{ name: "a", aliases: ["b"] }, { name: "b", aliases: ["a"] }],
      [{ name: "changes", aliases: ["d"], run: "shell" }],
    ]) expect([JSON.stringify(bad), check(bad).length > 0]).toEqual([JSON.stringify(bad), true])
  })
})

describe("in the running terminal", () => {
  const profile = (slashCommands: unknown[]) => ({ ...DEFAULT_TUI_PROFILE, slashCommands: slashCommands as never })

  test("a user alias runs its command, with arguments, and the history keeps the real name", async () => {
    const { dataDir } = temporary()
    writeTuiProfile(dataDir, profile([{ name: "help", aliases: ["hh"] }]))
    expect(readTuiProfile(dataDir).slashCommands).toEqual([{ name: "help", aliases: ["hh"] }])
    const h = await appHarness({ dataDir })
    await h.start({ onboarded: true })
    await h.type("/hh")
    await h.key("\r")
    expect(h.app.page).toBe("help")
    expect(h.sent.filter((command) => command.type === "user.submit")).toEqual([])
    await h.key("\x1b")
    await h.type("/hh   ")
    await h.key("\r")
    expect(h.app.page).toBe("help")
  })
  test("the same alias applies live when the daemon announces a changed profile, and stops when it is removed", async () => {
    const { dataDir } = temporary()
    const h = await appHarness({ dataDir })
    await h.start({ onboarded: true })
    h.app.onGlobal({ type: "tui.changed", profile: { ...DEFAULT_TUI_PROFILE, slashCommands: [{ name: "help", aliases: ["hh"] }] }, gseq: 1, at: 1 } as never)
    await h.type("/hh")
    await h.key("\r")
    expect(h.app.page).toBe("help")
    await h.key("\x1b")
    expect(h.app.page).toBe("chat")
    h.app.onGlobal({ type: "tui.changed", profile: { ...DEFAULT_TUI_PROFILE, slashCommands: [] }, gseq: 2, at: 2 } as never)
    await h.type("/hh x")
    await h.key("\r")
    expect(h.app.page).toBe("chat")
    expect(h.sent.filter((command) => command.type === "user.submit")).toHaveLength(1)
  })
  test("a removed alias runs nothing, is not sent to the model and says where the command went", async () => {
    const { dataDir } = temporary()
    const h = await appHarness({ dataDir })
    await h.start({ onboarded: true })
    await h.type("/tui")
    await h.key("\r")
    expect(h.text()).toContain("/tui is now /customize")
    expect(h.app.page).toBe("chat")
    expect(h.sent.filter((command) => command.type === "user.submit" || command.type === "commands.execute")).toEqual([])
  })
  test("a word that was never a command is sent as the message it is, without a hint", async () => {
    const { dataDir } = temporary()
    const h = await appHarness({ dataDir })
    await h.start({ onboarded: true })
    await h.type("/xyz")
    await h.key("\r")
    expect(h.text()).not.toContain("is now")
    expect(h.sent.filter((command) => command.type === "user.submit")).toHaveLength(1)
  })
  test("a command of the project with a removed alias's name still runs, and is not answered with the hint", async () => {
    const { dataDir } = temporary()
    const h = await appHarness({ dataDir, reply: (command) => command.type === "commands.list" ? { ok: true, result: { commands: [{ name: "note", description: "Mine", argumentHint: "" }] } } : undefined })
    await h.start({ onboarded: true })
    await h.type("/note")
    await h.key("\r")
    expect(h.text()).not.toContain("is now")
    expect(h.sent).toContainEqual(expect.objectContaining({ type: "commands.execute", name: "note" }))
  })
  test("the menu for a removed alias is empty, the way it is for any word that is no command", async () => {
    const { dataDir } = temporary()
    const h = await appHarness({ dataDir })
    await h.start({ onboarded: true })
    await h.type("/tui")
    expect(h.text()).toContain("No commands")
  })
})
