import { afterEach, describe, expect, test } from "bun:test"
import { slashSuggestions } from "../src/view/commands"
import { argumentMatches } from "../src/view/slash-arguments"
import { DEFAULT_TUI_PROFILE } from "../src/view/tui-profile"
import { createSlashMenuState, slashMenuModel } from "../src/view/slash-menu"
import { appHarness, scratch } from "./extensions-harness"
import { cleanTemps } from "./session-ui-harness"

const made: Array<ReturnType<typeof scratch>> = []
function temporary() { const dir = scratch(); made.push(dir); return dir }
afterEach(() => { for (const dir of made.splice(0)) dir.cleanup(); cleanTemps() })
const names = (command: string, args: string) => argumentMatches(command, args).map((option) => option.name)
const menu = (text: string, settings: Parameters<typeof slashMenuModel>[0]["settings"] = { tier: "balanced" }) =>
  slashMenuModel({ text, custom: [], profile: DEFAULT_TUI_PROFILE, settings, recents: [], state: createSlashMenuState(), selected: 0, width: 100, height: 14, ascii: false })

async function started() {
  const { dataDir } = temporary()
  const h = await appHarness({ dataDir })
  await h.start({ tier: "balanced", onboarded: true })
  return h
}

describe("argument words", () => {
  test("a blank word lists every word of the command; a partial one puts the exact word, then prefixes, then a word that only contains it", () => {
    expect(names("pr", "")).toEqual(["pr on", "pr off", "pr review", "pr comments", "pr watch", "pr unwatch", "pr check", "pr watch-repo", "pr unwatch-repo", "pr repos", "pr publish", "pr list"])
    expect(names("pr", "watch")).toEqual(["pr watch", "pr watch-repo", "pr unwatch", "pr unwatch-repo"])
    expect(names("pr", "rev")).toEqual(["pr review"])
    expect(names("pr", "zz")).toEqual([])
  })

  test("a word that takes another one leads to that one's words, and a word typed after it is not guessed", () => {
    expect(argumentMatches("pr", "pub")).toEqual([expect.objectContaining({ name: "pr publish", more: true })])
    expect(names("pr", "publish o")).toEqual(["pr publish on", "pr publish off"])
    expect(names("pr", "watch 1")).toEqual([])
    expect(names("pr", "review ")).toEqual([])
  })

  test("a word of any value (a flag, a feature) is followed by its own choices", () => {
    expect(names("experimental", "pr_r")).toEqual(["experimental pr_review"])
    expect(names("experimental", "pr_review ")).toEqual(["experimental pr_review on", "experimental pr_review off", "experimental pr_review toggle"])
    expect(names("tier", "bal")).toEqual(["tier balanced"])
    expect(names("tier", "pr_watch d")).toEqual(["tier pr_watch default"])
  })

  test("the menu shows them under the command's own name or alias, and none for a command that takes no fixed words", () => {
    const viaAlias = slashSuggestions("/pr-watch o").map((command) => command.name)
    expect(viaAlias.slice(0, 2)).toEqual(["pr on", "pr off"])
    expect(viaAlias).toContain("pr comments")
    expect(menu("/pr ")?.items.map((item) => item.label).slice(0, 3)).toEqual(["/pr on", "/pr off", "/pr review"])
    expect(menu("/attach ")).toBeUndefined()
    expect(menu("/pr zz")).toBeUndefined()
  })

  test("a command the tier leaves out lists none of its words, and a word of a feature that is off is left out", () => {
    expect(menu("/pr ", { tier: "minimalist" })).toBeUndefined()
    expect(menu("/panel gal", { tier: "full" })?.items.map((item) => item.label)).toEqual(["/panel galaxy"])
    expect(menu("/panel gal", { tier: "full", features: { panel_orbit: false } })).toBeUndefined()
  })
})

describe("Tab and Enter on argument words", () => {
  test("Tab writes the highlighted word and a space, and the next Tab goes on to the following word", async () => {
    const h = await started()
    await h.type("/pr pub")
    await h.key("\t")
    expect(h.app.editor.text).toBe("/pr publish ")
    await h.key("\t")
    expect(h.app.editor.text).toBe("/pr publish on ")
  })

  test("Tab after the command name opens its words at once", async () => {
    const h = await started()
    await h.type("/experimen")
    await h.key("\t")
    expect(h.app.editor.text).toBe("/experimental ")
    expect(h.text()).toContain("/experimental async_tools   ")
  })

  test("Enter on a half-typed word runs the highlighted one; on a word that needs another it only writes it", async () => {
    const h = await started()
    await h.type("/pr pub")
    await h.key("\r")
    expect(h.app.editor.text).toBe("/pr publish ")
    expect(h.sent.some((command) => command.type === "pr.review")).toBe(false)
    h.app.editor.clear()
    await h.type("/pr o")
    await h.key("\r")
    expect(h.sent).toContainEqual(expect.objectContaining({ type: "settings.set", patch: { experimental: expect.objectContaining({ pr_watch: true, pr_review: true }) } }))
    expect(h.app.editor.text).toBe("")
  })

  test("Enter on a blank word runs the command as typed, not its first word", async () => {
    const h = await started()
    await h.type("/experimental ")
    await h.key("\r")
    expect(h.sent.some((command) => command.type === "settings.set")).toBe(false)
    expect(h.text()).toContain("Experimental features")
  })
})

describe("/pr", () => {
  test("/pr off turns both switches off in one save and says so in one line", async () => {
    const h = await started()
    await h.type("/pr off")
    await h.key("\r")
    const saves = h.sent.filter((command) => command.type === "settings.set")
    expect(saves).toHaveLength(1)
    expect(h.text()).toContain("pr_watch, pr_review off")
  })

  test("/pr comments runs the daemon's pr-comments template with the PR; the old /pr-comments says where it went", async () => {
    const h = await started()
    await h.type("/pr comments 12")
    await h.key("\r")
    expect(h.sent).toContainEqual(expect.objectContaining({ type: "commands.execute", name: "pr-comments", args: "12" }))
    const old = await started()
    await old.type("/pr-comments 12")
    await old.key("\r")
    expect(old.sent.filter((command) => command.type === "commands.execute" || command.type === "user.submit")).toEqual([])
    expect(old.text()).toContain("/pr-comments is now /pr comments")
  })
})
