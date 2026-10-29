import { afterAll, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { tuiProblems, TUI_DEFAULTS, TUI_ENUMS } from "@mendcode/protocol/wire"
import { CUSTOMIZE_ROWS, createCustomizePageState, customizePageKey } from "../src/view/customize-page"
import { COMMENT_SENT_LAYOUTS, DEFAULT_TUI_PROFILE, normalizeTuiProfile } from "../src/view/tui-profile"
import { createBindings, KEY_ACTIONS } from "../src/ui/keymap"
import { buildBindings, readKeybindings } from "../src/extensions/keybindings"
import { SLASH_COMMANDS } from "../src/view/commands"
import { cleanTemps, tempDir } from "./session-ui-harness"
import { chat, comment, dragOver, key, scene, screen, typeText } from "./reply-comments-helpers"

afterAll(cleanTemps)

const COMMENT_KEYS = ["comments", "commentKey", "commentHint", "commentHintSeconds", "commentChips", "commentChipStyle", "commentCollapse", "commentMax", "commentMarks", "commentMarkGlyph", "commentReplyKeys", "commentTemplate", "commentEntry", "commentFolded", "commentSentLayout"] as const

describe("the settings", () => {
  test("every comment setting has a default in both contracts, and they agree", () => {
    for (const name of COMMENT_KEYS) {
      expect(name in DEFAULT_TUI_PROFILE).toBe(true)
      expect(name in TUI_DEFAULTS).toBe(true)
      expect(DEFAULT_TUI_PROFILE[name]).toEqual(TUI_DEFAULTS[name as keyof typeof TUI_DEFAULTS])
    }
    expect(DEFAULT_TUI_PROFILE).toMatchObject({ comments: "auto", commentKey: "comment", commentHint: "prompt", commentChips: "above", commentChipStyle: "chips", commentMax: 9, commentMarks: true, commentFolded: true, commentSentLayout: "rail", commentReplyKeys: "jkcd" })
  })

  test("the enums list the same values the profile accepts", () => {
    expect(TUI_ENUMS.comments).toEqual(["auto", "on", "off"])
    expect(TUI_ENUMS.commentHint).toEqual(["prompt", "passage", "off"])
    expect(TUI_ENUMS.commentChips).toEqual(["above", "below", "rule"])
    expect(TUI_ENUMS.commentChipStyle).toEqual(["chips", "numbers", "count"])
    expect(TUI_ENUMS.commentKey).toEqual(["comment", "quote"])
    expect(TUI_ENUMS.commentSentLayout).toEqual(["rail", "stack", "inline"])
    expect(TUI_ENUMS.commentSentLayout).toEqual([...COMMENT_SENT_LAYOUTS])
  })

  test("the sent layout takes its three values and repairs anything else to the default", () => {
    for (const layout of COMMENT_SENT_LAYOUTS) {
      expect(tuiProblems({ commentSentLayout: layout })).toEqual([])
      expect(normalizeTuiProfile({ commentSentLayout: layout }).commentSentLayout).toBe(layout)
    }
    expect(tuiProblems({ commentSentLayout: "grid" }).length).toBeGreaterThan(0)
    expect(normalizeTuiProfile({ commentSentLayout: "grid" }).commentSentLayout).toBe("rail")
    expect(normalizeTuiProfile({ commentSentLayout: 3 }).commentSentLayout).toBe("rail")
    expect(normalizeTuiProfile({}).commentSentLayout).toBe("rail")
  })

  test("what is out of range or malformed is refused", () => {
    expect(tuiProblems({ commentMax: 10 }).length).toBeGreaterThan(0)
    expect(tuiProblems({ commentMax: 0 }).length).toBeGreaterThan(0)
    expect(tuiProblems({ commentCollapse: 5 }).length).toBeGreaterThan(0)
    expect(tuiProblems({ commentHintSeconds: 61 }).length).toBeGreaterThan(0)
    expect(tuiProblems({ commentHint: "somewhere" }).length).toBeGreaterThan(0)
    expect(tuiProblems({ commentReplyKeys: "jjkc" }).length).toBeGreaterThan(0)
    expect(tuiProblems({ commentReplyKeys: "jk" }).length).toBeGreaterThan(0)
    expect(tuiProblems({ commentTemplate: "no placeholder for the comments" }).length).toBeGreaterThan(0)
    expect(tuiProblems({ commentEntry: "{quote} but no words" }).length).toBeGreaterThan(0)
    expect(tuiProblems({ commentMax: 3, commentHintSeconds: 10, commentCollapse: 20, commentReplyKeys: "nplq", commentTemplate: "{comments}\n{note}", commentEntry: "{n}: {quote} {text}" })).toEqual([])
  })

  test("the profile normalizer repairs bad values to the defaults", () => {
    const profile = normalizeTuiProfile({ commentMax: 99, commentHint: "nowhere", commentReplyKeys: "aaaa", commentTemplate: "nope", commentMarkGlyph: "toolong" })
    expect(profile.commentMax).toBe(9)
    expect(profile.commentHint).toBe("prompt")
    expect(profile.commentReplyKeys).toBe("jkcd")
    expect(profile.commentTemplate).toBe("")
    expect(profile.commentMarkGlyph).toBe("")
  })
})

describe("the customize page", () => {
  test("a Comments group lists every setting", () => {
    for (const name of COMMENT_KEYS) expect(CUSTOMIZE_ROWS).toContain(name)
  })

  test("a choice row cycles, a number row takes digits and refuses a wrong one, a toggle flips", () => {
    const state = (row: string) => ({ ...createCustomizePageState(), row: CUSTOMIZE_ROWS.indexOf(row as never) })
    const cycle = customizePageKey(state("commentHint"), "\x1b[C", DEFAULT_TUI_PROFILE)
    expect(cycle.action).toEqual({ type: "set", patch: { commentHint: "passage" } })
    const layout = customizePageKey(state("commentSentLayout"), "\x1b[C", DEFAULT_TUI_PROFILE)
    expect(layout.action).toEqual({ type: "set", patch: { commentSentLayout: "stack" } })
    expect(customizePageKey(state("commentSentLayout"), "\x1b[C", { ...DEFAULT_TUI_PROFILE, commentSentLayout: "inline" }).action).toEqual({ type: "set", patch: { commentSentLayout: "rail" } })
    const toggle = customizePageKey(state("commentMarks"), "\r", DEFAULT_TUI_PROFILE)
    expect(toggle.action).toEqual({ type: "set", patch: { commentMarks: false } })
    let typing = customizePageKey(state("commentMax"), "\r", DEFAULT_TUI_PROFILE)
    typing = customizePageKey({ ...typing.state, typing: "" }, "5", DEFAULT_TUI_PROFILE)
    const saved = customizePageKey(typing.state, "\r", DEFAULT_TUI_PROFILE)
    expect(saved.action).toEqual({ type: "set", patch: { commentMax: 5 } })
    const wrong = customizePageKey({ ...state("commentMax"), typing: "9" }, "9", DEFAULT_TUI_PROFILE)
    const refused = customizePageKey({ ...wrong.state, typing: "0" }, "\r", DEFAULT_TUI_PROFILE)
    expect(refused.action).toEqual({ type: "none" })
    expect(refused.state.error).toContain("1..9")
    const keys = customizePageKey({ ...state("commentReplyKeys"), typing: "jj" }, "\r", DEFAULT_TUI_PROFILE)
    expect(keys.action).toEqual({ type: "none" })
    expect(keys.state.error).toContain("four different letters")
  })

  test("the wording rows are refused without their placeholders", () => {
    const row = CUSTOMIZE_ROWS.indexOf("commentTemplate")
    const bad = customizePageKey({ row, typing: "just text" }, "\r", DEFAULT_TUI_PROFILE)
    expect(bad.action).toEqual({ type: "none" })
    expect(bad.state.error).toContain("{comments}")
    const good = customizePageKey({ row, typing: "Review:\\n{comments}" }, "\r", DEFAULT_TUI_PROFILE)
    expect(good.action).toMatchObject({ type: "set", patch: { commentTemplate: "Review:\\n{comments}" } })
  })
})

describe("the command", () => {
  test("/comments is a command with a setting and no alias", () => {
    const command = SLASH_COMMANDS.find((entry) => entry.name === "comments")
    expect(command).toMatchObject({ setting: "comments" })
    expect(command?.aliases).toEqual([])
  })

  test("/comments list, off, on, clear and settings work in the app", async () => {
    const s = await scene({ width: 120, height: 40 })
    await comment(s, "Use codex for both. Faster, but the plan is never reviewed.", "this one")
    await typeText(s, "/comments list\r")
    expect(screen(s.h).some((row) => row.includes("Comments") && row.includes("1 of 9"))).toBe(true)
    await key(s, "\x1b")
    await typeText(s, "/comments off\r")
    expect(chat(s).some((row) => row.includes("alt+l list"))).toBe(false)
    await typeText(s, "/comments on\r")
    expect(chat(s).some((row) => row.includes("alt+l list"))).toBe(true)
    await typeText(s, "/comments nonsense\r")
    expect(screen(s.h).some((row) => row.includes("usage: /comments"))).toBe(true)
    await typeText(s, "/comments clear\r")
    expect(chat(s).some((row) => row.includes("alt+l list"))).toBe(false)
    await typeText(s, "/comments settings\r")
    expect(screen(s.h).some((row) => row.includes("Comment key"))).toBe(true)
  })

})

describe("the keys", () => {
  test("alt+q and alt+l are the defaults, alt+c is free and bindable, the old quote action stays", () => {
    const bindings = createBindings()
    expect(bindings.direct.get("\x1bq")).toEqual({ action: "selection.comment" })
    expect(bindings.direct.get("\x1bl")).toEqual({ action: "comment.list" })
    expect(bindings.direct.has("\x1bc")).toBe(false)
    for (const action of ["selection.quote", "selection.comment", "comment.list", "comment.reply", "comment.clear"]) expect(KEY_ACTIONS).toContain(action as never)
  })

  test("keybindings.json can bind alt+c to the comment, give the old quote back to alt+q and bind reply and clear", async () => {
    const dir = tempDir()
    writeFileSync(path.join(dir, "keybindings.json"), JSON.stringify({ "alt+c": "selection.comment", "alt+q": "selection.quote", "alt+l": null, "ctrl+g": "comment.reply", "ctrl+b": "comment.clear" }))
    const file = readKeybindings(dir)
    expect(file.problems).toEqual([])
    const { bindings } = buildBindings({ file: file.entries })
    expect(bindings.direct.get("\x1bc")).toEqual({ action: "selection.comment" })
    expect(bindings.direct.get("\x1bq")).toEqual({ action: "selection.quote" })
    expect(bindings.direct.has("\x1bl")).toBe(false)
    expect(bindings.direct.get("\x07")).toEqual({ action: "comment.reply" })
    expect(bindings.direct.get("\x02")).toEqual({ action: "comment.clear" })
  })

  test("with alt+c bound, the offer names alt+c and alt+c comments", async () => {
    const dataDir = tempDir()
    // A hint names the first key still bound, so the defaults go: ctrl+g, and alt+q with the kitty protocol's sequence, which a name does not cover.
    writeFileSync(path.join(dataDir, "keybindings.json"), JSON.stringify({ "alt+c": "selection.comment", "ctrl+g": null, "alt+q": null, "\u001b[113;3u": null }))
    const s = await scene({ width: 120, height: 40 }, { dataDir })
    await dragOver(s, "Use codex for both. Faster, but the plan is never reviewed.")
    const rows = screen(s.h)
    expect(rows.some((row) => row.includes("alt+c"))).toBe(true)
    expect(rows.some((row) => row.includes("alt+q") || row.includes("ctrl+g"))).toBe(false)
    await key(s, "\x1bc")
    expect(screen(s.h).some((row) => row.includes("comment on"))).toBe(true)
  })

  test("commentKey: quote keeps alt+q as the old quote into the prompt", async () => {
    const s = await scene({ width: 120, height: 40 }, { profile: { commentKey: "quote", copyOnSelect: false } })
    await dragOver(s, "Use codex for both. Faster, but the plan is never reviewed.")
    await key(s, "\x1bq")
    expect(s.h.app.editor.text).toContain("> Use codex for both.")
    expect(screen(s.h).some((row) => row.includes("comment on"))).toBe(false)
  })
})

describe("custom marks, chips and reply keys", () => {
  test("a custom mark glyph, chip style numbers and below, and custom reply letters", async () => {
    const s = await scene({ width: 120, height: 40 }, { profile: { commentMarkGlyph: "▌", commentChipStyle: "numbers", commentChips: "below", commentReplyKeys: "npxq" } })
    await comment(s, "Use codex for both. Faster, but the plan is never reviewed.", "this one")
    const rows = screen(s.h)
    expect(rows.some((row) => row.startsWith("1▌"))).toBe(true)
    const chips = rows.findIndex((row) => /\[1\]/.test(row))
    const prompt = rows.findIndex((row) => row.includes("❭"))
    expect(chips).toBeGreaterThan(prompt)
    await key(s, "\x1bq")
    expect(screen(s.h).some((row) => row.includes("n p move") && row.includes("x comment"))).toBe(true)
    await key(s, "p")
    await key(s, "x")
    expect(screen(s.h).some((row) => row.includes("comment on"))).toBe(true)
  })

  test("the rule placement shows only a count pill on the prompt's rule", async () => {
    const s = await scene({ width: 120, height: 40 }, { profile: { commentChips: "rule" } })
    await comment(s, "Use codex for both. Faster, but the plan is never reviewed.", "this one")
    const rows = screen(s.h)
    expect(rows.some((row) => row.includes("1 comment") && row.includes("─"))).toBe(true)
    expect(rows.some((row) => /\[1[ ↑]/.test(row))).toBe(false)
  })
})
