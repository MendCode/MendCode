import { afterEach, describe, expect, test } from "bun:test"
import { TUI_DEFAULTS, TUI_ENUMS, tuiProblems } from "@mendcode/protocol/wire"
import { altWord, configureKeyLabels, keyLabelState, keyText, keyTexts, resetKeyLabels, restoreKeyLabels } from "../src/ui/key-labels"
import { createBindings, DEFAULT_BINDINGS, inlineKeyNames, keyName, keymapHelp, leaderHint } from "../src/ui/keymap"
import { parseKeybindings, parseKeySpec } from "../src/extensions/keybindings"
import { ALT_LABELS, DEFAULT_TUI_PROFILE, normalizeTuiProfile } from "../src/view/tui-profile"
import { customizePageKey, CUSTOMIZE_ROWS } from "../src/view/customize-page"
import { helpKeyRows } from "../src/view/help-page"
import { shortcutEntries } from "../src/view/shortcut-overlay"
import { renderQueuePanel } from "../src/view/queue-panel"
import { railNames, RAIL_NAMES } from "../src/tutorial/tour"
import { cheatSheet } from "../src/tutorial/lessons"
import { keymapRows, filterKeymapRows } from "../src/view/keymap-page"

afterEach(() => resetKeyLabels())

describe("the Alt label", () => {
  test("auto says Option on macOS and Alt everywhere else, the explicit values win on any OS", () => {
    expect(altWord("auto", "darwin")).toBe("opt")
    for (const platform of ["linux", "win32", "freebsd", undefined]) expect(altWord("auto", platform)).toBe("alt")
    for (const platform of ["darwin", "linux", "win32"]) {
      expect(altWord("alt", platform)).toBe("alt")
      expect(altWord("opt", platform)).toBe("opt")
      expect(altWord("symbol", platform)).toBe("⌥")
    }
  })

  test("nothing is configured until the app does it: hints are canonical whatever the host is", () => {
    expect(keyText("alt+q comment")).toBe("alt+q comment")
    expect(keyLabelState()).toEqual({ setting: "auto", platform: undefined, altWorks: false })
  })

  test("opt rewrites every alt+ token and keeps the rest of the hint", () => {
    configureKeyLabels({ setting: "auto", platform: "darwin" })
    expect(keyText("alt+q")).toBe("opt+q")
    expect(keyText("copied 12 chars · alt+q comment")).toBe("copied 12 chars · opt+q comment")
    expect(keyText("alt+enter · ctrl+j")).toBe("opt+enter · ctrl+j")
    expect(keyText("ctrl+alt+x, alt+shift+j, alt+↑ edit, alt+}")).toBe("ctrl+opt+x, opt+shift+j, opt+↑ edit, opt+}")
    expect(keyText("Alt+Enter or Ctrl+J")).toBe("Opt+Enter or Ctrl+J")
    expect(keyTexts(["alt+l", "ctrl+r"])).toEqual(["opt+l", "ctrl+r"])
  })

  test("only the modifier changes: words that contain alt, and text without a plus, are left alone", () => {
    configureKeyLabels({ setting: "opt" })
    for (const text of ["default+alt", "salt+pepper", "alt screen", "[ ] alt · p plan", "--no-alt-screen", "alternative", "ctrl+x · n new session"]) expect(keyText(text)).toBe(text)
  })

  test("the symbol drops the plus and sits next to the key", () => {
    configureKeyLabels({ setting: "symbol" })
    expect(keyText("alt+q")).toBe("⌥q")
    expect(keyText("ctrl+alt+x")).toBe("ctrl+⌥x")
    expect(keyText("alt+shift+j")).toBe("⌥shift+j")
    expect(keyText("alt+↑ edit · ctrl+k drop")).toBe("⌥↑ edit · ctrl+k drop")
  })

  test("alt forced on a Mac keeps the canonical name; opt forced on Linux says opt", () => {
    configureKeyLabels({ setting: "alt", platform: "darwin" })
    expect(keyText("alt+q")).toBe("alt+q")
    configureKeyLabels({ setting: "opt", platform: "linux" })
    expect(keyText("alt+q")).toBe("opt+q")
  })

  test("a platform given as undefined clears it, one left out is kept", () => {
    configureKeyLabels({ platform: "darwin" })
    configureKeyLabels({ setting: "auto" })
    expect(keyLabelState().platform).toBe("darwin")
    configureKeyLabels({ setting: "auto", platform: undefined })
    expect(keyLabelState().platform).toBeUndefined()
    const saved = keyLabelState()
    configureKeyLabels({ setting: "symbol", platform: "darwin" })
    restoreKeyLabels(saved)
    expect(keyLabelState()).toEqual(saved)
  })
})

describe("key hints follow the label, key names stay canonical", () => {
  test("keyName and the bindings keep alt; the help rows, leader hint and keymap help say opt on a Mac", () => {
    expect(keyName("\x1bq")).toBe("alt+q")
    expect(inlineKeyNames(DEFAULT_BINDINGS, "selection.comment")).toEqual(["ctrl+g", "alt+q"])
    configureKeyLabels({ setting: "auto", platform: "darwin" })
    expect(keyName("\x1bq")).toBe("alt+q")
    expect(inlineKeyNames(DEFAULT_BINDINGS, "selection.comment")).toEqual(["ctrl+g", "alt+q"])
    expect(keymapHelp().map((row) => row.keys)).toContain("opt+q")
    expect(keymapHelp().map((row) => row.keys)).not.toContain("alt+q")
    expect(leaderHint()).not.toContain("alt+")
    const rows = helpKeyRows().map(([keys]) => keys)
    expect(rows).toContain("opt+enter / ctrl+j")
    expect(rows.some((keys) => keys.includes("alt+"))).toBe(false)
  })

  test("on Linux and Windows every hint is what it was", () => {
    for (const platform of ["linux", "win32"]) {
      configureKeyLabels({ setting: "auto", platform })
      expect(keymapHelp().map((row) => row.keys)).toContain("alt+q")
      expect(helpKeyRows().map(([keys]) => keys)).toContain("alt+enter / ctrl+j")
    }
  })

  test("the shortcut overlay, the queue panel, the tutorial rail and its cheat sheet", () => {
    const entries = () => shortcutEntries(DEFAULT_BINDINGS, { multiline: false, backtrack: true })
    const queue = () => renderQueuePanel({ previews: ["one"], width: 100, held: false, paused: false } as never).rows.map((row) => row.map((span) => span.text).join("")).join("\n")
    expect(entries().some(([keys]) => keys.includes("alt+"))).toBe(true)
    expect(queue()).toContain("alt+↑ edit")
    expect(railNames().leave).toBe("alt+q")
    expect(cheatSheet(DEFAULT_BINDINGS).find((row) => row.what === "new line")?.keys).toBe("alt+enter")
    configureKeyLabels({ setting: "auto", platform: "darwin" })
    expect(entries().some(([keys]) => keys.includes("alt+"))).toBe(false)
    // Option is not known to work yet: the chord comes first, and the queue names it.
    expect(entries().find(([, what]) => what === "search earlier prompts")?.[0]).toBe("ctrl+x ? · opt+r")
    expect(queue()).toContain("ctrl+x ^ edit")
    configureKeyLabels({ altWorks: true })
    expect(entries().find(([, what]) => what === "search earlier prompts")?.[0]).toBe("opt+r · ctrl+x ?")
    expect(queue()).toContain("opt+↑ edit")
    expect(railNames()).toEqual({ next: "opt+n", back: "opt+b", skip: "opt+s", show: "opt+m", leave: "opt+q" })
    expect(RAIL_NAMES.leave).toBe("alt+q")
    expect(cheatSheet(DEFAULT_BINDINGS).find((row) => row.what === "new line")?.keys).toBe("opt+enter")
  })

  test("/keymap lists the label in use and finds a row by alt or by opt", () => {
    configureKeyLabels({ setting: "auto", platform: "darwin" })
    const rows = keymapRows(createBindings())
    const comment = rows.find((row) => row.action === "selection.comment")!
    // The chord is listed beside the Alt key: the page names every key the action has.
    const alt = comment.keys.find((key) => key.name === "alt+q")
    expect(alt?.spec).toBe("alt+q")
    expect(comment.keys.map((key) => key.name)).toContain("ctrl+x w")
    expect(filterKeymapRows(rows, "opt+q").map((row) => row.action)).toContain("selection.comment")
    expect(filterKeymapRows(rows, "alt+q").map((row) => row.action)).toContain("selection.comment")
  })
})

describe("opt+q is accepted as alt+q in a key file", () => {
  test("every spelling of the modifier gives the key alt gives", () => {
    const alt = parseKeySpec("alt+q")
    expect(alt.ok).toBe(true)
    for (const spec of ["opt+q", "Opt+q", "option+q", " OPTION+q "]) expect(parseKeySpec(spec)).toEqual(alt)
    // The key's own case is whatever alt+ already does with it.
    expect(parseKeySpec("Opt+Q")).toEqual(parseKeySpec("Alt+Q"))
    expect(parseKeySpec("ctrl+opt+x")).toEqual(parseKeySpec("ctrl+alt+x"))
    expect(parseKeySpec("opt+shift+j")).toEqual(parseKeySpec("alt+shift+j"))
    expect(parseKeySpec("option+enter")).toEqual(parseKeySpec("alt+enter"))
    expect(parseKeySpec("option+up")).toEqual(parseKeySpec("alt+up"))
  })

  test("the canonical name stays alt in the parsed target, and a file entry binds the key", () => {
    const parsed = parseKeySpec("opt+q")
    expect(parsed.ok && parsed.target.kind === "direct" && parsed.target.label).toBe("alt+q")
    const file = parseKeybindings(JSON.stringify({ "opt+g": "sidebar.toggle", "option+m": "messages.open", "opt+r": null }))
    expect(file.problems).toEqual([])
    expect(file.entries.map((entry) => entry.target.kind === "direct" ? entry.target.seqs : [])).toEqual([["\x1bg"], ["\x1bm"], ["\x1br"]])
  })

  test("nothing else changes meaning: opt or option alone, as a key or without a key after it, stay unknown", () => {
    for (const spec of ["opt", "option", "opt+", "alt+opt", "opt+opt", "optional+q", "opt q", "⌥q"]) expect(parseKeySpec(spec).ok).toBe(false)
    expect(parseKeySpec("f2").ok).toBe(true)
  })
})

describe("the altLabel setting", () => {
  test("is declared the way its neighbours are: a profile key, the protocol's data, a /customize row", () => {
    expect(DEFAULT_TUI_PROFILE.altLabel).toBe("auto")
    expect(TUI_DEFAULTS.altLabel).toBe("auto")
    expect(TUI_ENUMS.altLabel).toEqual([...ALT_LABELS])
    expect([...ALT_LABELS]).toEqual(["auto", "alt", "opt", "symbol"])
    expect(CUSTOMIZE_ROWS).toContain("altLabel")
  })

  test("an unknown value falls back to auto and is reported as a problem", () => {
    expect(normalizeTuiProfile({ altLabel: "option" }).altLabel).toBe("auto")
    expect(normalizeTuiProfile({ altLabel: 3 }).altLabel).toBe("auto")
    for (const value of ALT_LABELS) expect(normalizeTuiProfile({ altLabel: value }).altLabel).toBe(value)
    expect(tuiProblems({ altLabel: "opt" })).toEqual([])
    expect(tuiProblems({ altLabel: "option" })).toEqual(["altLabel: expected auto|alt|opt|symbol"])
  })

  test("/customize cycles the four values in both directions", () => {
    const press = (key: string, altLabel: (typeof ALT_LABELS)[number]) => customizePageKey({ row: CUSTOMIZE_ROWS.indexOf("altLabel") }, key, { ...DEFAULT_TUI_PROFILE, altLabel }).action
    expect(press("\x1b[C", "auto")).toEqual({ type: "set", patch: { altLabel: "alt" } })
    expect(press("\x1b[C", "alt")).toEqual({ type: "set", patch: { altLabel: "opt" } })
    expect(press("\x1b[C", "opt")).toEqual({ type: "set", patch: { altLabel: "symbol" } })
    expect(press("\x1b[C", "symbol")).toEqual({ type: "set", patch: { altLabel: "auto" } })
    expect(press("\x1b[D", "auto")).toEqual({ type: "set", patch: { altLabel: "symbol" } })
  })
})
