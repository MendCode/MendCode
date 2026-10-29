import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { SLASH_GROUPS, SLASH_LAYOUTS, TUI_DEFAULTS, tuiProblems } from "@mendcode/protocol/wire"
import { SLASH_COMMANDS, DIAGNOSTIC_COMMANDS, gatedHint, gatedMatches, parseSlash, slashSuggestions } from "../src/view/commands"
import { createSlashMenuState, renderSlashMenu, slashMenuModel, slashMenuWindow } from "../src/view/slash-menu"
import { createBindings } from "../src/ui/keymap"
import { noteSlashRecent, readSlashRecents, saveSlashRecent, slashRecentsPath } from "../src/view/slash-recents"
import { DEFAULT_TUI_PROFILE, readTuiProfile, writeTuiProfile } from "../src/view/tui-profile"
import { CUSTOMIZE_ROWS, customizePageKey } from "../src/view/customize-page"
import { renderSlashEditor, slashEditorKey } from "../src/view/slash-menu-editor"
import { textWidth } from "../src/view/wrap"
import { appHarness, extension, scratch } from "./extensions-harness"
import { appHarness as sessionHarness, cleanTemps, tempDir } from "./session-ui-harness"

const made: ReturnType<typeof scratch>[] = []
function temporary() { const dir = scratch(); made.push(dir); return dir }
afterEach(() => { for (const dir of made.splice(0)) dir.cleanup(); cleanTemps() })
const plain = (row: { text: string }[]) => row.map((span) => span.text).join("")
const profile = { ...DEFAULT_TUI_PROFILE }
function model(overrides: Partial<Parameters<typeof slashMenuModel>[0]> = {}) {
  return slashMenuModel({ text: "/", custom: [], profile, settings: { tier: "full" }, recents: [], state: createSlashMenuState(), selected: 0, width: 100, height: 12, ascii: false, ...overrides })!
}

test("every catalog entry declares a group, canonical names and aliases are unique", () => {
  const names = new Set<string>()
  for (const command of [...SLASH_COMMANDS, ...DIAGNOSTIC_COMMANDS]) {
    expect(SLASH_GROUPS).toContain(command.group)
    for (const name of [command.name, ...command.aliases]) { expect(names.has(name)).toBe(false); names.add(name) }
  }
})
test("catalog summaries are terse verb-first phrases, at most 48 characters", () => {
  for (const command of [...SLASH_COMMANDS, ...DIAGNOSTIC_COMMANDS, ...slashSuggestions("/panel ")]) {
    expect(command.summary.length).toBeLessThanOrEqual(48)
    expect(command.summary).toMatch(/^(Start|Show|Switch|Change|Connect|Manage|Allow|Toggle|Compact|Undo|Redo|Browse|Select|Rename|Regenerate|Compare|Edit|Jump|Fork|Bookmark|Summarize|Export|Import|Choose|Inspect|Move|Dictate|Save|Attach|Restore|Search|Configure|Tour|Check|Copy|Open|Review|Override|Detach|Pause|Resume|Stop|Propose|Trust|Work|Watch|Pick|Quit|Find|Plan|Build|Run|Customize|Set|Commit|Pair|Replay|Create|Remove|Restart|Reload)\b/)
  }
})
test("unused recents show six labelled suggestions; history keeps the recent label", () => {
  const view = model()
  expect(view.items.map((item) => item.command?.name)).toEqual(["new", "sessions", "model", "changes", "context", "settings"])
  expect(renderSlashMenu(view).map(plain).join("\n")).toContain("[suggested]")
  const used = model({ recents: [{ name: "help", count: 1, last: 1 }] })
  expect(renderSlashMenu(used).map(plain).join("\n")).toContain("[recent]")
  expect(used.items[0]?.command?.name).toBe("help")
})
test("a typed query puts the commands used before first among equal matches, the most used ahead; an exact name still wins", () => {
  const names = (text: string, recents: Array<{ name: string; count: number; last: number }>) => model({ text, recents }).items.map((item) => item.command?.name)
  // Without recents `/s` is shortest name first; with /sessions used it leads, and /settings, used once, follows it.
  expect(names("/s", [])[0]).not.toBe("sessions")
  const used = names("/s", [{ name: "settings", count: 1, last: 5 }, { name: "sessions", count: 31, last: 1 }])
  expect(used.slice(0, 2)).toEqual(["sessions", "settings"])
  // Two equally used: the more recent first.
  expect(names("/se", [{ name: "settings", count: 2, last: 9 }, { name: "sessions", count: 2, last: 1 }]).slice(0, 2)).toEqual(["settings", "sessions"])
  // A used prefix never passes the command the query names exactly.
  expect(names("/pr", [{ name: "providers", count: 50, last: 9 }]).slice(0, 2)).toEqual(["pr", "providers"])
})
test("tabs wrap whole labels and muted counts, retaining the active tab on short screens", () => {
  for (const width of [40, 60, 69, 100]) for (let group = 0; group < SLASH_GROUPS.length; group++) {
    const view = model({ width, state: { group, expanded: [] }, height: 20 })
    const rows = renderSlashMenu(view)
    const header = rows.slice(0, slashMenuWindow(view).header)
    expect(header.map(plain).join("\n")).toContain(`[${group ? SLASH_GROUPS[group] : "suggested"}]`)
    for (const entry of view.groups) expect(header.map(plain).join("\n")).toContain(`${entry.count}`)
    expect(header.flat().some((span) => span.dim && span.fg === "muted")).toBe(true)
    expect(plain(rows[slashMenuWindow(view).header]!)).toContain(view.items[slashMenuWindow(view).first]!.label)
    expect(rows.every((row) => textWidth(plain(row)) === width)).toBe(true)
    const short = model({ width, height: 3, state: { group, expanded: [] } })
    expect(renderSlashMenu(short).map(plain).join("\n")).toContain(`[${group ? SLASH_GROUPS[group] : "suggested"}]`)
  }
})
test("effective command keys are right-aligned and muted, including selected rows", () => {
  const bindings = createBindings()
  bindings.leader.delete("l")
  bindings.direct.set("\x1bk", { action: "command:resume" })
  const view = model({ text: "/sessions", bindings })
  const rows = renderSlashMenu(view)
  expect(plain(rows[0]!).trimEnd()).toEndWith("alt+k")
  expect(rows[0]!.find((span) => span.text.includes("alt+k"))?.dim).toBe(true)
  expect(view.items[0]?.command?.shortcut).toBe("alt+k")
  bindings.direct.delete("\x1bk")
  expect(model({ text: "/sessions", bindings }).items[0]?.command?.shortcut).toBeUndefined()
  expect(model({ text: "/new" }).items[0]?.command?.shortcut).toBe("ctrl+x n")
  const renamed = model({ text: "/sessions", width: 60, profile: { ...profile, slashGroups: [{ id: "session", label: "A very long session name" }] } })
  expect(plain(renderSlashMenu(renamed)[0]!).trimEnd()).toEndWith("ctrl+x l")
})
test("collapsed group markers, counts and previews differ from indented commands", () => {
  const closed = model({ profile: { ...profile, slashMenu: "groups" }, selected: 6 })
  const row = renderSlashMenu(closed).find((row) => plain(row).includes("▸ session"))!
  expect(plain(row)).toContain(String(closed.items[6]!.count))
  expect(row.some((span) => span.dim && span.text.includes("backtrack"))).toBe(true)
  const opened = model({ profile: { ...profile, slashMenu: "groups" }, state: { group: 0, expanded: ["session"] }, selected: 6 })
  const rows = renderSlashMenu(opened).map(plain)
  expect(rows.join("\n")).toContain("▾ session")
  expect(rows.join("\n")).toContain("┃   /backtrack")
  expect(opened.items[7]?.indented).toBe(true)
})
test("aliases resolve without duplicate rows; the commit forms are arguments, not names", () => {
  for (const [typed, name, args] of [["loop", "loops", ""], ["wf run x", "workflows", "run x"], ["commit push hint", "commit", "push hint"], ["commit pr", "commit", "pr"]]) {
    expect(parseSlash("/" + typed)?.command.name).toBe(name)
    expect(parseSlash("/" + typed)?.args).toBe(args)
  }
  for (const removed of ["av", "workflow", "commit-push hint", "commit-pr"]) expect(parseSlash("/" + removed)).toBeUndefined()
  expect(model().catalog.map((entry) => entry.name)).not.toContain("commit-push")
})
test("exact-name and alias search ranks match the existing fuzzy scorer", () => {
  for (const command of SLASH_COMMANDS) {
    for (const name of [command.name, ...command.aliases]) {
      const view = model({ text: "/" + name })
      expect(view.items.slice(0, 10).map((item) => item.command?.name)).toEqual(slashSuggestions("/" + name).map((entry) => entry.name).filter((name) => view.catalog.some((entry) => entry.name === name)))
    }
  }
  const row = renderSlashMenu(model({ text: "/comp" })).flat()
  expect(row.filter((span) => span.underline).map((span) => span.text).join("")).toContain("comp")
})
test("settings and hidden commands are excluded from browsing, discoverable in search", () => {
  for (const layout of SLASH_LAYOUTS) {
    const view = model({ profile: { ...profile, slashMenu: layout }, state: { group: 6, expanded: ["look"] } })
    expect(view.items.filter((item) => item.command?.setting)).toHaveLength(0)
  }
  const view = model({ text: "/timestamps" })
  expect(view.items[0]?.command?.setting).toBe("timestamps")
  expect(renderSlashMenu(view).map(plain).join("\n")).toContain("setting")
  expect(parseSlash("/timestamps")?.command.name).toBe("timestamps")
})
test("tier filtering precedes search, recents, pins and overrides", () => {
  const off = model({ settings: { tier: "minimalist" }, recents: [{ name: "mcps", count: 9, last: 1 }], profile: { ...profile, slashCommands: [{ name: "mcps", pinned: true }] } })
  expect(off.catalog.map((entry) => entry.name)).not.toContain("mcps")
  // Typed exactly, the switched-off command is only its hint row, never a runnable one.
  expect(model({ text: "/mcps", settings: { tier: "balanced" } }).items.filter((item) => !item.gated).map((item) => item.command?.name)).not.toContain("mcps")
  expect(model({ text: "/mcps", settings: { tier: "balanced" } }).items.find((item) => item.gated)?.gated).toBe("off · /tier full")
  expect(model({ text: "/mcps", settings: { tier: "balanced", features: { mcp: true } } }).items[0]?.command?.name).toBe("mcps")
  expect(model({ text: "/panel ", settings: { tier: "balanced" } }).items.map((item) => item.command?.name)).not.toContain("panel galaxy")
  expect(model({ text: "/panel ", settings: { tier: "full" } }).items.map((item) => item.command?.name)).toContain("panel galaxy")
  expect(model({ text: "/panel ", settings: { tier: "full" } }).items.map((item) => item.command?.name)).not.toContain("panel orbit")
})
test("recents combine most used and last used, persist per data dir, tolerate damage and stay bounded", () => {
  const { dataDir } = temporary()
  const other = temporary().dataDir
  for (let n = 0; n < 10; n++) saveSlashRecent(dataDir, "help", n)
  saveSlashRecent(dataDir, "context", 100)
  expect(readSlashRecents(other)).toEqual([])
  expect(readSlashRecents(dataDir).find((entry) => entry.name === "help")?.count).toBe(10)
  const view = model({ recents: readSlashRecents(dataDir) })
  expect(view.items[0]?.command?.name).toBe("context")
  expect(view.items.map((item) => item.command?.name)).toContain("help")
  let recents: ReturnType<typeof readSlashRecents> = []
  for (let n = 0; n < 300; n++) recents = noteSlashRecent(recents, "cmd" + n, n)
  expect(recents).toHaveLength(128)
  writeFileSync(slashRecentsPath(dataDir), "[broken")
  expect(readSlashRecents(dataDir)).toEqual([])
})
describe("built-in layouts", () => {
  for (const slashMenu of SLASH_LAYOUTS) for (const [width, height] of [[60, 20], [100, 30], [180, 50]]) for (const ascii of [false, true]) {
    test(`${slashMenu} ${width}x${height} ascii=${ascii}: fit and following selection`, () => {
      const view = model({ profile: { ...profile, slashMenu }, width, height, ascii, state: { group: 1, expanded: ["session"] }, selected: 14 })
      const rows = renderSlashMenu(view)
      expect(rows.length).toBeLessThanOrEqual(height)
      for (const row of rows) { expect(textWidth(plain(row))).toBe(width); expect(plain(row)).not.toContain("\x1b"); if (ascii) expect(plain(row)).not.toMatch(/[^\x20-\x7e]/) }
      expect(rows.at(-1)!.map((span) => span.text).join("")).toMatch(/\d+.* of \d+/)
      if (slashMenu === "columns" && width < 90) expect(view.layout).toBe("groups")
      const picked = view.items[view.selection]!
      expect(rows.map(plain).join("\n")).toContain(picked.label)
    })
  }
  test("description column aligns and search group stays on the right", () => {
    const rows = renderSlashMenu(model({ profile: { ...profile, slashMenu: "flat" }, selected: 0 }))
    const catalog = model({ profile: { ...profile, slashMenu: "flat" } }).items
    const columns = rows.slice(0, -1).map((row, index) => plain(row).indexOf(catalog[index]!.command!.summary.slice(0, 4)))
    expect(new Set(columns).size).toBe(1)
    const search = renderSlashMenu(model({ text: "/sessions" }))
    expect(plain(search[0]!).trimEnd()).toEndWith("ctrl+x l")
    expect(plain(search[0]!)).toContain("session")
  })
})
test("/customize cycles layouts; command editor regroups, renames, hides, pins and reorders persistently", () => {
  let result = customizePageKey({ row: CUSTOMIZE_ROWS.indexOf("slashMenu") }, "\x1b[C", profile)
  expect(result.action).toMatchObject({ type: "set", patch: { slashMenu: "groups" } })
  const commands = SLASH_COMMANDS.filter((entry) => ["new", "help"].includes(entry.name))
  let current = { ...profile }
  for (const key of ["h", "p", "\x1b[C", "J"]) {
    const result = slashEditorKey({ selected: 0 }, key, current, commands)
    current = { ...current, ...result.patch }
  }
  const resultRename = slashEditorKey({ selected: 0, rename: "Work" }, "\r", current, commands)
  current = { ...current, ...resultRename.patch }
  const { dataDir } = temporary()
  expect(writeTuiProfile(dataDir, current).ok).toBe(true)
  expect(readTuiProfile(dataDir).slashCommands).toEqual(current.slashCommands)
  expect(readTuiProfile(dataDir).slashGroups).toEqual(current.slashGroups)
  expect(tuiProblems({ slashGroups: current.slashGroups, slashCommands: current.slashCommands, slashMenu: "tabs" })).toEqual([])
  expect(TUI_DEFAULTS.slashMenu).toBe(DEFAULT_TUI_PROFILE.slashMenu)
  expect(tuiProblems({ slashCommands: [{ name: "new", order: NaN }], slashGroups: [{ id: "code", label: "\x1bBAD" }] })).toHaveLength(2)
})
test("tabs open recent, tab and arrows navigate, letter switches to global search and Enter runs", async () => {
  const { dataDir } = temporary()
  const h = await appHarness({ dataDir })
  await h.start({ tier: "full", onboarded: true })
  await h.type("/")
  expect(h.text()).toContain("[suggested]")
  await h.key("\x1b[C")
  expect(h.text()).toContain("/copy")
  await h.key("\x1b[C")
  expect(h.text()).toContain("/attach")
  await h.key("\x1b[D")
  // Tab completes the highlighted command; it never changes group.
  await h.key("\t")
  expect(h.app.editor.text).toMatch(/^\/[a-z-]+ ?$/)
  expect(h.app.editor.text.length).toBeGreaterThan(1)
  h.app.editor.clear()
  await h.type("/us")
  expect(h.text()).toContain("/usage")
  expect(h.text()).not.toContain("recent session context")
  await h.key("\r")
  expect(h.app.page).toBe("usage")
  expect(readSlashRecents(dataDir)[0]?.name).toBe("usage")
})
test("groups expand/collapse and columns cycle groups without inserting text", async () => {
  for (const layout of ["groups", "columns"] as const) {
    const { dataDir } = temporary()
    writeTuiProfile(dataDir, { ...profile, slashMenu: layout })
    const h = await appHarness({ dataDir })
    await h.start({ tier: "full", onboarded: true })
    await h.type("/")
    if (layout === "groups") {
      for (let i = 0; i < 6; i++) await h.key("\x1b[B")
      const groupRow = h.rows().findIndex((row) => row.includes("▸ session"))
      await h.key("\x1b[C")
      expect(h.rows().findIndex((row) => row.includes("▾ session"))).toBe(groupRow)
      expect(h.text()).toContain("┃   /backtrack")
      await h.key("\x1b[B")
      expect(h.text()).toContain("/copy")
      await h.key("\x1b[D")
      expect(h.text()).not.toContain("/copy")
    } else {
      await h.key("\x1b[C")
      expect(h.text()).toContain("/copy")
    }
  }
})
test("selecting a partial hidden setting opens /settings at that profile row; typing full command still runs", async () => {
  const { dataDir } = temporary()
  const h = await appHarness({ dataDir })
  await h.start({ onboarded: true })
  await h.type("/timest")
  await h.key("\r")
  expect(h.app.page).toBe("settings")
  expect(h.text()).toContain("Timestamps")
  await h.key("\x1b[C")
  expect(readTuiProfile(dataDir).timestamps).toBe(true)
  await h.key("\x1b")
  await h.type("/timestamps")
  await h.key("\r")
  // The settings row writes the profile; the slash command only this session's screen.
  expect(h.app.accessibility.profile.timestamps).toBe(false)
  expect(readTuiProfile(dataDir).timestamps).toBe(true)
})
test("minimalist default is compact flat; explicit layout survives restart", async () => {
  const { dataDir } = temporary()
  const h = await appHarness({ dataDir })
  await h.start({ tier: "minimalist", onboarded: true })
  await h.type("/")
  expect(h.text()).not.toContain("recent session context")
  await h.key("\x7f")
  await h.type("/tier minimalist\r")
  expect(readTuiProfile(dataDir).slashMenu).toBe("flat")
  const inherited = await appHarness({ dataDir })
  await inherited.start({ tier: "minimalist", onboarded: true })
  await inherited.type("/")
  expect(inherited.text()).not.toContain("recent session context")
  writeTuiProfile(dataDir, { ...profile, slashMenu: "tabs" })
  const next = await appHarness({ dataDir })
  await next.start({ tier: "minimalist", onboarded: true })
  await next.type("/")
  expect(next.text()).toContain("[recent]")
})
test("custom slashMenu view receives immutable inputs; failing view falls back to the built-in layout with one notice", async () => {
  for (const broken of [false, true]) {
    const { dataDir, project, write } = temporary()
    write("data/extensions/menu.ts", extension("menu", broken ? 'api.view("slashMenu", () => { throw new Error("menu broke") })' : 'api.view("slashMenu", ctx => [[{text: "Custom menu: " + ctx.items[ctx.selection]?.label + " / " + ctx.catalog.length}]])'))
    writeTuiProfile(dataDir, { ...profile, slashMenu: "columns" })
    const h = await appHarness({ dataDir, directory: project })
    await h.start({ onboarded: true })
    await h.type("/")
    if (broken) {
      // Three faults open the breaker: the built-in layout (columns here) is back, with one notice, and keys still work.
      expect(h.text()).toContain("suggested")
      expect(h.text()).toContain("┃ /new")
      expect(h.text()).toContain("stopped after 3 faults")
      await h.key("\x1b[B")
      expect(h.text()).toContain("┃ /sessions")
    } else {
      expect(h.text()).toContain("Custom menu:")
      await h.key("\x1b[B")
      expect(h.text()).toContain("Custom menu: /sessions")
      expect(h.text()).not.toContain("tab/←→")
    }
  }
})
test("remote terminal never reads or writes local recents", async () => {
  const dataDir = tempDir()
  const h = sessionHarness({ dataDir, remote: { host: "test.invalid", readOnly: false } })
  h.app.applySettings({ onboarded: true })
  await h.type("/help\r")
  expect(readSlashRecents(dataDir)).toEqual([])
})
test("the commit subcommands dispatch the daemon templates; the old names are no commands and say where they went", async () => {
  for (const [invocation, name, args] of [["commit push hint", "commit-push", "hint"], ["commit pr title", "commit-pr", "title"]]) {
    const { dataDir } = temporary()
    const h = await appHarness({ dataDir })
    await h.start({ onboarded: true })
    await h.type("/" + invocation)
    await h.key("\r")
    expect(h.sent).toContainEqual(expect.objectContaining({ type: "commands.execute", name, args }))
    expect(readSlashRecents(dataDir)[0]?.name).toBe("commit")
    expect(readFileSync(slashRecentsPath(dataDir), "utf8")).not.toContain("hint")
  }
  for (const [invocation, hint] of [["commit-push hint", "/commit-push is now /commit push"], ["commit-pr title", "/commit-pr is now /commit pr"]]) {
    const { dataDir } = temporary()
    const h = await appHarness({ dataDir })
    await h.start({ onboarded: true })
    await h.type("/" + invocation)
    await h.key("\r")
    expect(h.sent.filter((command) => command.type === "commands.execute" || command.type === "user.submit")).toEqual([])
    expect(h.text()).toContain(hint)
  }
})
test("custom command recents and profile changes affect the actual catalog", async () => {
  const { dataDir } = temporary()
  const h = await appHarness({ dataDir, reply: (command) => command.type === "commands.list" ? { ok: true, result: { commands: [{ name: "local-test", description: "Local fixture", argumentHint: "" }] } } : undefined })
  await h.start({ onboarded: true })
  await h.type("/local-test arg")
  await h.key("\r")
  expect(readSlashRecents(dataDir)[0]?.name).toBe("local-test")
  expect(readFileSync(slashRecentsPath(dataDir), "utf8")).not.toContain("arg")
})
test("empty catalog, long group names and last selection stay bounded in every view", () => {
  for (const layout of SLASH_LAYOUTS) {
    const view = model({ profile: { ...profile, slashMenu: layout, slashGroups: SLASH_GROUPS.map((id) => ({ id, label: id + " very long group label".slice(0, 24 - id.length) })) }, width: 60, height: 20, state: { group: 7, expanded: ["setup"] }, selected: 9999 })
    const rows = renderSlashMenu(view)
    expect(rows.every((row) => textWidth(plain(row)) === 60)).toBe(true)
    expect(rows.map(plain).join("\n")).toContain(view.items[view.selection]!.label.slice(0, 10))
  }
  const empty = model({ text: "/xyzxyzxyz" })
  expect(renderSlashMenu(empty).map(plain).join("\n")).toContain("No commands")
})
test("renamed Unicode groups persist, remain ASCII-safe and the last-row rename stays visible", () => {
  const renamed = { ...profile, slashGroups: [{ id: "session" as const, label: "Sesión" }] }
  expect(tuiProblems({ slashGroups: renamed.slashGroups })).toEqual([])
  for (const layout of SLASH_LAYOUTS) {
    const rows = renderSlashMenu(model({ profile: { ...renamed, slashMenu: layout }, width: 100, ascii: true, text: layout === "flat" ? "/sessions" : "/" }))
    expect(rows.map(plain).join("")).not.toMatch(/[^\x20-\x7e]/)
  }
  const rows = renderSlashEditor({ state: { selected: SLASH_COMMANDS.length - 1, rename: "Sesión" }, profile: renamed, width: 60, height: 20 })
  expect(rows.map(plain).join("\n")).toContain("Group name: Sesión_")
  expect(rows.every((row) => textWidth(plain(row)) <= 60)).toBe(true)
})
test("a switched-off command typed exactly by name or alias shows one hint row naming its switch; a prefix shows none", () => {
  const rows = (text: string, settings: Parameters<typeof model>[0]["settings"]) => model({ text, settings }).items
  // Minimalist does not include pr_watch: the row names the tier that does.
  const blocked = rows("/pr-watch", { tier: "minimalist" })
  expect(blocked.filter((item) => item.gated)).toEqual([expect.objectContaining({ label: "/pr", gated: "off · /tier balanced" })])
  expect(blocked.at(-1)?.gated).toBe("off · /tier balanced")
  expect(renderSlashMenu(model({ text: "/pr-watch", settings: { tier: "minimalist" } })).map(plain).join("\n")).toMatch(/\/pr\s+off · \/tier balanced/)
  expect(rows("/pr", { tier: "minimalist" }).filter((item) => item.gated).map((item) => item.label)).toEqual(["/pr"])
  // An override off names the override; a feature's own flag set off names the flag.
  expect(rows("/pr-watch", { tier: "balanced", features: { pr_watch: false } }).find((item) => item.gated)?.gated).toBe("off · /tier pr_watch on")
  expect(gatedHint("threads", { tier: "full", experimental: { thread_tools: false } })).toBe("off · /experimental thread_tools on")
  // On: the normal runnable row, no hint.
  const on = rows("/pr-watch", { tier: "balanced" })
  expect(on[0]).toEqual(expect.objectContaining({ label: "/pr" }))
  expect(on.some((item) => item.gated)).toBe(false)
  expect(gatedHint("pr_watch", { tier: "balanced" })).toBeUndefined()
  // A prefix or a loose match of a switched-off command never lists it.
  for (const text of ["/p", "/pr-w", "/prwatch"]) expect(rows(text, { tier: "minimalist" }).some((item) => item.gated || item.command?.name === "pr")).toBe(false)
  expect(gatedMatches("pr", { tier: "minimalist" }).map((entry) => entry.command.name)).toEqual(["pr"])
})
test("Enter on a switched-off command runs nothing and shows its hint; with the feature on it runs", async () => {
  for (const text of ["/pr-watch", "/pr"]) {
    const { dataDir } = temporary()
    const h = await appHarness({ dataDir })
    await h.start({ tier: "minimalist", onboarded: true })
    await h.type(text)
    expect(h.text()).toMatch(/\/pr\s+off · \/tier balanced/)
    await h.key("\r")
    expect(h.sent.filter((command) => command.type === "pr.watch" || command.type === "user.submit" || command.type === "commands.execute")).toEqual([])
    expect(h.text()).toContain("/pr off · /tier balanced")
  }
  const { dataDir } = temporary()
  const h = await appHarness({ dataDir })
  await h.start({ tier: "balanced", onboarded: true, experimental: { pr_watch: true } })
  await h.type("/pr-watch")
  await h.key("\r")
  expect(h.sent.some((command) => command.type === "pr.watch")).toBe(true)
})
