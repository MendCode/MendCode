import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { cleanTemps, tempDir } from "./session-ui-harness"
import { ALT_L, ALT_Q, CODEX, COMMENT_HINT, CTRL_G, dragOver, ENTER, has, key, prompt, scene, screen, typeText } from "./reply-comments-helpers"
import { buildBindings, parseKeybindings } from "../src/extensions/keybindings"
import { actionHint, COMMENT_KEY, createBindings, DEFAULT_BINDINGS, DIRECT_KEYS, inlineKeyNames, keyName, LEADER_KEY, leaderHint, resolveKey, type LeaderState } from "../src/ui/keymap"
import { configureKeyLabels, resetKeyLabels } from "../src/ui/key-labels"
import { translateKey } from "../src/ui/keyboard-protocol"
import { helpKeyRows } from "../src/view/help-page"
import { COMMENT_TOAST_HINT, REPLY_KEYS } from "../src/view/reply-comments-view"

afterAll(cleanTemps)
afterEach(() => resetKeyLabels())

const LABEL = "comment on the selection (or walk the newest answer)"
const COMPOSING = "enter saves · esc cancels"
const GHOSTTY = { TERM_PROGRAM: "ghostty", TERM: "xterm-ghostty" }
const SIZE = { width: 120, height: 40 }
/** The four label states a hint is drawn in: a Mac before and after Option is known to send Alt, Windows and Linux. */
const PLATFORMS = [
  { name: "mac, Option unknown", platform: "darwin", altWorks: false },
  { name: "mac, Option sends Alt", platform: "darwin", altWorks: true },
  { name: "windows", platform: "win32", altWorks: false },
  { name: "linux", platform: "linux", altWorks: false },
] as const

describe("ctrl+g in the keymap", () => {
  test("the BEL byte resolves to the comment action; alt+q in both encodings and ctrl+x w still do", () => {
    expect(COMMENT_KEY).toBe("\x07")
    expect(keyName(COMMENT_KEY)).toBe("ctrl+g")
    expect(resolveKey({}, "\x07", 0)).toEqual({ kind: "action", action: "selection.comment" })
    for (const alt of ["\x1bq", "\x1b[113;3u"]) expect(resolveKey({}, alt, 0)).toEqual({ kind: "action", action: "selection.comment" })
    const state: LeaderState = {}
    resolveKey(state, LEADER_KEY, 0)
    expect(resolveKey(state, "w", 1)).toEqual({ kind: "action", action: "selection.comment" })
  })

  test("with the keyboard protocol on, ctrl+g reported as CSI u is the same byte, on any layout", () => {
    expect(translateKey("\x1b[103;5u")).toBe("\x07")
    expect(translateKey("\x1b[1087::103;5u")).toBe("\x07")
  })

  test("no other default holds the byte, as a direct, an inline or a chord key", () => {
    expect(Object.keys(DIRECT_KEYS).filter((seq) => seq === "\x07")).toEqual(["\x07"])
    expect(DEFAULT_BINDINGS.inline.has("\x07")).toBe(false)
    expect(DEFAULT_BINDINGS.leader.has("\x07")).toBe(false)
  })

  test("it is the first key of the action, so the copy's defaults name it", () => {
    expect(inlineKeyNames(DEFAULT_BINDINGS, "selection.comment")).toEqual(["ctrl+g", "alt+q"])
    expect(REPLY_KEYS.comment).toBe("ctrl+g")
    expect(REPLY_KEYS.list).toBe("alt+l")
    expect(COMMENT_TOAST_HINT).toBe("ctrl+g comment")
  })
})

describe("the hint names ctrl+g on every platform", () => {
  for (const { name, platform, altWorks } of PLATFORMS) {
    test(`${name}: the comment key is ctrl+g; the list keeps its Alt key or chord`, () => {
      configureKeyLabels({ setting: "auto", platform, altWorks })
      expect(actionHint(DEFAULT_BINDINGS, "selection.comment")).toBe("ctrl+g")
      expect(actionHint(DEFAULT_BINDINGS, "comment.list")).toBe(platform !== "darwin" ? "alt+l" : altWorks ? "opt+l" : "ctrl+x W")
      const rows = helpKeyRows()
      expect(rows).toContainEqual(["ctrl+g", LABEL])
      expect(rows).toContainEqual([platform === "darwin" ? "opt+q" : "alt+q", LABEL])
      expect(rows).toContainEqual(["ctrl+x w", LABEL])
      expect(rows.findIndex(([keys]) => keys === "ctrl+g")).toBeLessThan(rows.findIndex(([keys]) => keys.endsWith("+q") && keys !== "ctrl+g"))
      expect(leaderHint()).toContain(`w ${LABEL}`)
    })

    test(`${name}: the toast after a copy and the pill of a kept selection say ctrl+g comment`, async () => {
      const harness = { platform, env: platform === "darwin" ? GHOSTTY : {} }
      const copied = await scene(SIZE, { harness })
      // A real Alt key is what tells a Mac that Option works.
      if (altWorks) (await key(copied, ALT_L), await key(copied, ALT_L))
      await dragOver(copied, CODEX)
      expect(screen(copied.h).find((row) => row.includes("copied"))).toMatch(/copied \d+ chars · ctrl\+g comment/)
      expect(has(screen(copied.h), "+q")).toBe(false)
      expect(has(screen(copied.h), "ctrl+x w")).toBe(false)
      const kept = await scene(SIZE, { profile: { copyOnSelect: false }, harness })
      if (altWorks) (await key(kept, ALT_L), await key(kept, ALT_L))
      await dragOver(kept, CODEX)
      expect(screen(kept.h).find((row) => row.includes("─") && row.includes("comment"))).toContain("ctrl+g comment")
    })
  }

  test("a key that moved shows where it went: without ctrl+g the hint is alt+q, or the chord on a Mac", () => {
    const { bindings } = buildBindings({ file: parseKeybindings(JSON.stringify({ "ctrl+g": null })).entries })
    expect(inlineKeyNames(bindings, "selection.comment")).toEqual(["alt+q"])
    configureKeyLabels({ setting: "auto", platform: "linux" })
    expect(actionHint(bindings, "selection.comment")).toBe("alt+q")
    configureKeyLabels({ setting: "auto", platform: "darwin", altWorks: false })
    expect(actionHint(bindings, "selection.comment")).toBe("ctrl+x w")
    configureKeyLabels({ setting: "auto", platform: "darwin", altWorks: true })
    expect(actionHint(bindings, "selection.comment")).toBe("opt+q")
  })
})

describe("ctrl+g in a session", () => {
  test("after a copy it opens the comment on that passage, as alt+q does", async () => {
    const s = await scene(SIZE)
    await dragOver(s, CODEX)
    await key(s, CTRL_G)
    expect(has(screen(s.h), COMPOSING)).toBe(true)
    const reference = await scene(SIZE)
    await dragOver(reference, CODEX)
    await key(reference, ALT_Q)
    // The first row names the temporary directory of each scene; the rest is the same screen.
    expect(screen(s.h).slice(1).join("\n")).toBe(screen(reference.h).slice(1).join("\n"))
  })

  test("with nothing selected it opens the reply mode, and pressed there it leaves it", async () => {
    const s = await scene(SIZE)
    await key(s, CTRL_G)
    expect(has(screen(s.h), "reply 6/6")).toBe(true)
    await key(s, CTRL_G)
    expect(has(screen(s.h), "reply 6/6")).toBe(false)
    // alt+q opens it and ctrl+g leaves it: one action, either key.
    await key(s, ALT_Q)
    expect(has(screen(s.h), "reply 6/6")).toBe(true)
    await key(s, CTRL_G)
    expect(has(screen(s.h), "reply 6/6")).toBe(false)
    expect(prompt(s)).toBe("")
  })

  test("while a comment is being typed it does nothing and types nothing", async () => {
    const s = await scene(SIZE)
    await dragOver(s, CODEX)
    await key(s, CTRL_G)
    await typeText(s, "this one")
    const before = screen(s.h).slice(1).join("\n")
    await key(s, CTRL_G)
    expect(screen(s.h).slice(1).join("\n")).toBe(before)
    expect(prompt(s)).toBe("this one")
    await key(s, ENTER)
    expect(has(screen(s.h), "[1 “Use codex")).toBe(true)
  })

  test("commentKey: quote gives alt+q and ctrl+x w back to the quote; ctrl+g still comments", async () => {
    const profile = { commentKey: "quote", copyOnSelect: false } as const
    const quoted = await scene(SIZE, { profile })
    await dragOver(quoted, CODEX)
    await key(quoted, ALT_Q)
    expect(prompt(quoted)).toContain(`> ${CODEX}`)
    expect(has(screen(quoted.h), "comment on")).toBe(false)
    const chorded = await scene(SIZE, { profile })
    await dragOver(chorded, CODEX)
    await key(chorded, LEADER_KEY)
    await key(chorded, "w")
    expect(prompt(chorded)).toContain(`> ${CODEX}`)
    const commented = await scene(SIZE, { profile })
    await dragOver(commented, CODEX)
    expect(screen(commented.h).find((row) => row.includes("─") && row.includes("comment"))).toContain("ctrl+g comment")
    await key(commented, CTRL_G)
    expect(has(screen(commented.h), COMPOSING)).toBe(true)
    expect(prompt(commented)).toBe("")
  })

  test("comments off: ctrl+g says so and quotes nothing; alt+q keeps quoting", async () => {
    const s = await scene(SIZE, { profile: { comments: "off", copyOnSelect: false } })
    await dragOver(s, CODEX)
    await key(s, CTRL_G)
    expect(has(screen(s.h), "comments are off · /comments on")).toBe(true)
    expect(prompt(s)).toBe("")
    await dragOver(s, CODEX)
    await key(s, ALT_Q)
    expect(prompt(s)).toContain(`> ${CODEX}`)
  })

  test("keybindings.json wins: ctrl+g bound to something else runs that, and the hint names a key that still comments", async () => {
    const dataDir = tempDir()
    writeFileSync(path.join(dataDir, "keybindings.json"), JSON.stringify({ "ctrl+g": "help" }))
    const s = await scene(SIZE, { dataDir, harness: { platform: "linux", env: {} } })
    await dragOver(s, CODEX)
    expect(screen(s.h).find((row) => row.includes("copied"))).toMatch(/copied \d+ chars · alt\+q comment/)
    expect(has(screen(s.h), COMMENT_HINT)).toBe(false)
    await key(s, CTRL_G)
    expect(s.h.app.page).toBe("help")
    expect(has(screen(s.h), COMPOSING)).toBe(false)
  })

  test("the keymap editor keeps its own ctrl+g: it asks to reset every binding and no comment mode opens", async () => {
    const s = await scene(SIZE)
    await typeText(s, "/keymap\r")
    expect(s.h.app.page).toBe("keymap")
    await key(s, CTRL_G)
    expect(s.h.app.page).toBe("keymap")
    expect(has(screen(s.h), "ctrl-g again resets every binding")).toBe(true)
    await key(s, "\x1b")
    await key(s, "\x1b")
    expect(s.h.app.page).toBe("chat")
    expect(has(screen(s.h), "reply 6/6")).toBe(false)
  })
})

describe("an extension that registers ctrl+g", () => {
  test("it takes the key, the takeover is reported, and the hint moves to alt+q", () => {
    const run = () => {}
    const { bindings, problems } = buildBindings({ extensions: [{ spec: "ctrl+g", run, owner: "acme" }] })
    expect(problems).toEqual([])
    expect(bindings.direct.get("\x07")).toEqual({ run, owner: "acme", label: "ctrl+g" })
    expect(bindings.overrides).toEqual([{ key: "ctrl+g", owner: "acme", was: LABEL, source: "built-in", wasAction: "selection.comment" }])
    expect(inlineKeyNames(bindings, "selection.comment")).toEqual(["alt+q"])
    expect(resolveKey({}, "\x07", 0, bindings)).toEqual({ kind: "run", run, owner: "acme" })
    expect(resolveKey({}, "\x1bq", 0, bindings)).toEqual({ kind: "action", action: "selection.comment" })
  })

  test("it also wins over the user's own ctrl+g, and says whose it was", () => {
    const { bindings } = buildBindings({ file: parseKeybindings(JSON.stringify({ "ctrl+g": "help" })).entries, extensions: [{ spec: "ctrl+g", run: () => {}, owner: "acme" }] })
    expect(bindings.overrides).toEqual([{ key: "ctrl+g", owner: "acme", was: "help", source: "keybindings.json", wasAction: "help" }])
    expect(createBindings().direct.get("\x07")).toEqual({ action: "selection.comment" })
  })
})

describe("the BEL that ends a terminal reply is not ctrl+g", () => {
  const REPLY = "\x1b]10;rgb:ffff/ffff/ffff\x07"

  test("a reply cut across two reads opens nothing and types nothing", async () => {
    const s = await scene(SIZE)
    const before = screen(s.h).slice(1).join("\n")
    await typeText(s, REPLY.slice(0, 14))
    await typeText(s, REPLY.slice(14))
    expect(prompt(s)).toBe("")
    expect(has(screen(s.h), "reply 6/6")).toBe(false)
    expect(screen(s.h).slice(1).join("\n")).toBe(before)
  })

  test("a reply cut across two reads and then a real ctrl+g: only the key press comments", async () => {
    const s = await scene(SIZE)
    await typeText(s, REPLY.slice(0, 14))
    await typeText(s, `${REPLY.slice(14)}\x07`)
    expect(prompt(s)).toBe("")
    expect(has(screen(s.h), "reply 6/6")).toBe(true)
  })
})
