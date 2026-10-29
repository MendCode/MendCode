import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { appHarness, plain, tempDir, type Harness } from "./session-ui-harness"
import { ALT_L, ALT_Q, CODEX, comment, dragOver, has, key, scene, screen, typeText } from "./reply-comments-helpers"
import { createBindings } from "../src/ui/keymap"
import { configureKeyLabels, resetKeyLabels } from "../src/ui/key-labels"
import { DEFAULT_TUI_PROFILE, readTuiProfile, writeTuiProfile, type TuiProfile } from "../src/view/tui-profile"
import { CUSTOMIZE_ROWS } from "../src/view/customize-page"
import { isAltSequence, knownLayout, OPTION_BINDINGS, OPTION_LAYOUTS, OPTION_TYPED, optionBindingFor, optionKeyFor } from "../src/view/option-keys"
import { createTerminalSetupState, describeOptionPress, optionFix, optionNotice, renderTerminalSetupPage, type TerminalKind } from "../src/view/terminal-setup-page"
import { layoutFromPreferences, currentLayout } from "../src/ui/keyboard-layout"

afterEach(() => resetKeyLabels())

const GHOSTTY = { TERM_PROGRAM: "ghostty", TERM: "xterm-ghostty" }
const APPLE = { TERM_PROGRAM: "Apple_Terminal", TERM: "xterm-256color" }

function mac(options: { env?: Record<string, string>; platform?: string; profile?: Partial<TuiProfile>; width?: number; height?: number; layout?: () => string | undefined } = {}): Harness {
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, ...options.profile } as TuiProfile)
  const h = appHarness({ dataDir, directory: tempDir(), width: options.width ?? 100, height: options.height ?? 30, mode: "full", env: options.env ?? GHOSTTY, ...(options.layout ? { keyboardLayout: options.layout } : {}), ...(options.platform === "" ? {} : { platform: options.platform ?? "darwin" }) })
  h.app.applySettings({ onboarded: true })
  return h
}
const frame = (h: Harness) => (h.app.render(), h.frames.at(-1)!.map(plain).join("\n"))
/** The notice loads the terminal page's module first, so it lands a moment after the key. */
const settle = () => Bun.sleep(30)
const HINT = "Option typed œ: ran opt+q"
const COMPOSING = "enter saves · esc cancels"
const PASSAGE = CODEX
const macScene = (layout?: () => string | undefined, profile: Partial<TuiProfile> = {}) => scene({ width: 120, height: 40 }, { profile, harness: { platform: "darwin", env: GHOSTTY, ...(layout ? { keyboardLayout: layout } : {}) } })

describe("the layouts' Option characters", () => {
  test("the table is clean: one single non-ASCII character per binding key, none twice in a layout, every id once", () => {
    const ids = OPTION_LAYOUTS.map((layout) => layout.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const layout of OPTION_LAYOUTS) {
      expect(["macos", "unverified"]).toContain(layout.source)
      const chars = Object.values(layout.typed)
      expect(new Set(chars).size).toBe(chars.length)
      for (const [binding, char] of Object.entries(layout.typed)) {
        expect(Object.keys(OPTION_BINDINGS)).toContain(binding)
        expect([...char!]).toHaveLength(1)
        expect(char!.codePointAt(0)!).toBeGreaterThan(0x7f)
        expect(/\s/.test(char!)).toBe(false)
      }
    }
  })

  test("the layouts the Mac ships for the common keyboards are in", () => {
    for (const id of ["ABC", "US", "USInternational-PC", "British", "Spanish-ISO", "LatinAmerican", "German", "French", "Portuguese", "Brazilian-ABNT2"]) expect(knownLayout(id)).toBeDefined()
    expect(knownLayout("com.apple.keylayout.ABC")?.id).toBe("ABC")
  })

  test("a character stands for the key its layout types it with, and for no key on another layout", () => {
    for (const layout of ["ABC", "US", "British", "USInternational-PC"]) {
      expect(optionBindingFor("œ", layout)).toBe("q")
      expect(optionBindingFor("¬", layout)).toBe("l")
      expect(optionBindingFor("®", layout)).toBe("r")
      expect(optionBindingFor("π", layout)).toBe("p")
      expect(optionBindingFor("≤", layout)).toBe(",")
      expect(optionBindingFor("≥", layout)).toBe(".")
      expect(optionBindingFor("’", layout)).toBe("}")
    }
    expect(optionBindingFor("λ", "LatinAmerican")).toBe("l")
    expect(optionBindingFor("º", "Brazilian-ABNT2")).toBe("}")
    expect(optionBindingFor("∞", "German")).toBe(",")
    expect(optionBindingFor("ß", "ABC")).toBe("s")
    expect(optionBindingFor("ß", "Spanish-ISO")).toBe("b")
    // French types œ with Option+O, not Option+Q, so it is a letter there.
    expect(optionBindingFor("œ", "French")).toBeUndefined()
    expect(optionBindingFor("œ", "French-PC")).toBeUndefined()
    // German types @ with Option+L and « with Option+Q: ordinary text, never mapped.
    expect(optionBindingFor("@", "German")).toBeUndefined()
    expect(optionBindingFor("«", "German")).toBeUndefined()
    expect(optionBindingFor("@", "LatinAmerican")).toBeUndefined()
    // A layout the table does not have maps nothing; an unknown one reads as the default.
    expect(optionBindingFor("œ", "Czech")).toBeUndefined()
    expect(optionBindingFor("œ", undefined)).toBe("q")
    expect(optionBindingFor("a", "ABC")).toBeUndefined()
    expect(optionBindingFor("é", "ABC")).toBeUndefined()
  })

  test("every character any layout types is in the page's key check", () => {
    for (const layout of OPTION_LAYOUTS) for (const char of Object.values(layout.typed)) expect(OPTION_TYPED[char!]).toBeDefined()
  })

  test("the layout is read from the preferences file, binary or XML, and only when it is the one", () => {
    const binary = (id: string) => `bplist00\xd2\x01\x02_\x10${String.fromCharCode(id.length)}${id}\x08`
    expect(layoutFromPreferences(binary("com.apple.keylayout.ABC"))).toBe("ABC")
    expect(layoutFromPreferences(binary("com.apple.keylayout.Spanish-ISO"))).toBe("Spanish-ISO")
    expect(layoutFromPreferences(`<dict><key>AppleCurrentKeyboardLayoutInputSourceID</key><string>com.apple.keylayout.German</string></dict>`)).toBe("German")
    expect(layoutFromPreferences(`${binary("com.apple.keylayout.ABC")}${binary("com.apple.keylayout.French")}`)).toBeUndefined()
    expect(layoutFromPreferences("bplist00")).toBeUndefined()
    expect(currentLayout("/home/x", () => binary("com.apple.keylayout.US"))).toBe("US")
    expect(currentLayout("/home/x", () => { throw new Error("ENOENT") })).toBeUndefined()
    expect(currentLayout(undefined)).toBeUndefined()
  })

  test("the keymap still binds the key a character stands for", () => {
    const bindings = createBindings()
    expect(optionKeyFor("œ", "ABC", bindings)).toBe("alt+q")
    expect(optionKeyFor("¬", "ABC", bindings)).toBe("alt+l")
    expect(optionKeyFor("a", "ABC", bindings)).toBeUndefined()
    bindings.direct.delete("\x1bq")
    expect(optionKeyFor("œ", "ABC", bindings)).toBeUndefined()
    expect(optionKeyFor("¬", "ABC", bindings)).toBe("alt+l")
  })

  test("an Alt combination is recognised in the encodings terminals send", () => {
    for (const seq of ["\x1bq", "\x1b,", "\x1b}", "\x1b[113;3u", "\x1b[113;4u", "\x1b[121;7u", "\x1b[1;3A"]) expect(isAltSequence(seq)).toBe(true)
    for (const seq of ["œ", "q", "\x1b", "\x1b[A", "\x1bOP", "\x1b[113;5u", "\r", "\x1b[200~", "\x1b\x1b"]) expect(isAltSequence(seq)).toBe(false)
  })
})

describe("Option typing a character instead of sending Alt", () => {
  test("after a selection, œ is the comment key: it opens the comment, types nothing, and says so once", async () => {
    const s = await macScene()
    await dragOver(s, PASSAGE)
    await key(s, "œ")
    await settle()
    expect(has(screen(s.h), COMPOSING)).toBe(true)
    expect(s.h.app.editor.text).toBe("")
    expect(has(screen(s.h), HINT)).toBe(true)
    expect(has(screen(s.h), "Ghostty: macos-option-as-alt = true")).toBe(true)
    expect(has(screen(s.h), "/terminal-setup")).toBe(true)
  })

  test("the offer after a copy counts the same, with a draft in the prompt", async () => {
    const s = await macScene()
    await typeText(s, "draft ")
    await dragOver(s, PASSAGE)
    expect(has(screen(s.h), "ctrl+g comment")).toBe(true)
    await key(s, "œ")
    expect(has(screen(s.h), COMPOSING)).toBe(true)
    const reference = await macScene()
    await typeText(reference, "draft ")
    await dragOver(reference, PASSAGE)
    await key(reference, ALT_Q)
    expect(s.h.app.editor.text).toBe(reference.h.app.editor.text)
    expect(s.h.app.editor.text).not.toContain("œ")
  })

  test("¬ is the comment list, only when there are comments to list", async () => {
    const s = await macScene()
    await key(s, "¬")
    expect(s.h.app.editor.text).toBe("¬")
    s.h.app.editor.clear()
    // The comment is made with the character too: a real Alt key anywhere in the session would switch the characters off.
    await dragOver(s, PASSAGE)
    await key(s, "œ")
    await typeText(s, "careful")
    await key(s, "\r")
    expect(has(screen(s.h), "ctrl+x W list")).toBe(true)
    expect(has(screen(s.h), "careful")).toBe(false)
    await key(s, "¬")
    expect(s.h.app.editor.text).toBe("")
    expect(has(screen(s.h), "careful")).toBe(true)
  })

  test("the rest of the characters run their key only into an empty prompt, and are typed otherwise", async () => {
    for (const char of ["®", "π"]) {
      const empty = await macScene()
      await key(empty, char)
      expect(empty.h.app.editor.text).toBe("")
    }
    for (const char of ["®", "π", "≤", "≥"]) {
      const typing = await macScene()
      await typeText(typing, "x ")
      await key(typing, char)
      expect(typing.h.app.editor.text).toBe(`x ${char}`)
    }
    // The effort keys need a model list this harness does not have: the character does exactly what the Alt key does there (it throws the same).
    for (const [char, alt] of [["≤", "\x1b,"], ["≥", "\x1b."]] as const) {
      const viaChar = await macScene()
      const viaAlt = await macScene()
      await expect(key(viaAlt, alt)).rejects.toThrow()
      await expect(key(viaChar, char)).rejects.toThrow()
    }
  })

  test("œ into an empty prompt with nothing selected is the key that walks the newest answer", async () => {
    const s = await macScene()
    await key(s, "œ")
    const reference = await macScene()
    await key(reference, ALT_Q)
    expect(s.h.app.editor.text).toBe("")
    expect(has(screen(s.h), "reply")).toBe(has(screen(reference.h), "reply"))
  })

  test("the key named follows the label: alt when the setting says alt", async () => {
    const s = await scene({ width: 120, height: 40 }, { profile: { altLabel: "alt" }, harness: { platform: "darwin", env: GHOSTTY } })
    await dragOver(s, PASSAGE)
    await key(s, "œ")
    await settle()
    expect(has(screen(s.h), "Option typed œ: ran alt+q")).toBe(true)
  })

  test("each terminal gets its own fix in the hint", async () => {
    const apple = await scene({ width: 120, height: 40 }, { harness: { platform: "darwin", env: APPLE } })
    await dragOver(apple, PASSAGE)
    await key(apple, "œ")
    await settle()
    expect(has(screen(apple.h), "Terminal: Use Option as Meta key")).toBe(true)
    const unknown = await scene({ width: 120, height: 40 }, { harness: { platform: "darwin", env: { TERM: "dumb" } } })
    await dragOver(unknown, PASSAGE)
    await key(unknown, "œ")
    await settle()
    expect(has(screen(unknown.h), "turn on Option as Meta/Alt")).toBe(true)
  })

  test("never on Linux or Windows, and never when no platform is known", async () => {
    for (const platform of ["linux", "win32", ""]) {
      const h = mac({ platform })
      await h.app.onKey("œ")
      await settle()
      expect(h.app.editor.text).toBe("œ")
      expect(frame(h)).not.toContain(HINT)
    }
    const s = await scene({ width: 120, height: 40 }, { harness: { platform: "linux", env: GHOSTTY } })
    await dragOver(s, PASSAGE)
    await key(s, "œ")
    expect(has(screen(s.h), COMPOSING)).toBe(false)
  })

  test("never while the user is plainly typing: text already in the prompt, a word, a paste", async () => {
    const typing = mac()
    await typing.type("hola ")
    await typing.app.onKey("œ")
    expect(typing.app.editor.text).toBe("hola œ")
    const word = mac()
    await word.app.onInput("œuvre")
    expect(word.app.editor.text).toBe("œuvre")
    const pasted = mac()
    await pasted.app.onInput("\x1b[200~œ\x1b[201~")
    expect(pasted.app.editor.text).toBe("œ")
    expect(frame(pasted)).not.toContain(HINT)
    const accented = mac()
    for (const char of ["é", "ñ", "ü", "ç", "ø"]) {
      accented.app.editor.clear()
      await accented.app.onKey(char)
      expect(accented.app.editor.text).toBe(char)
    }
  })

  test("never when Option already sent an Alt key in this session", async () => {
    const h = mac()
    await h.app.onKey("\x1bl")
    await h.app.onKey("œ")
    expect(h.app.editor.text).toBe("œ")
    const csi = mac()
    await csi.app.onKey("\x1b[113;3u")
    await csi.app.onKey("œ")
    expect(csi.app.editor.text).toBe("œ")
  })

  test("not in the editors and pages that take the keys themselves", async () => {
    const page = mac()
    await page.type("/help")
    await page.type("\r")
    expect(page.app.page).toBe("help")
    await page.app.onKey("œ")
    expect(page.app.page).toBe("help")
    const vim = mac({ profile: { vimMode: true } })
    await vim.app.onKey("\x1b")
    await vim.app.onKey("œ")
    expect(vim.app.editor.text).toBe("")
  })

  test("while a comment is being written the character is text", async () => {
    const s = await macScene()
    await dragOver(s, PASSAGE)
    await key(s, ALT_Q)
    expect(has(screen(s.h), COMPOSING)).toBe(true)
    await key(s, "œ")
    expect(s.h.app.editor.text).toBe("œ")
  })

  test("the setting off types the character, on any layout", async () => {
    const s = await macScene(undefined, { optionKeys: "off" })
    await dragOver(s, PASSAGE)
    await key(s, "œ")
    expect(has(screen(s.h), COMPOSING)).toBe(false)
    expect(s.h.app.editor.text).toBe("œ")
  })

  test("a key the user unbound is typed", async () => {
    const dataDir = tempDir()
    writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE })
    writeFileSync(path.join(dataDir, "keybindings.json"), JSON.stringify({ "alt+q": null }))
    const h = appHarness({ dataDir, directory: tempDir(), width: 100, height: 30, mode: "full", env: GHOSTTY, platform: "darwin" })
    h.app.applySettings({ onboarded: true })
    await h.app.extensionsReady
    await h.app.onKey("œ")
    expect(h.app.editor.text).toBe("œ")
  })

  test("the layout decides: the same character is a letter on French, and read again at each key", async () => {
    let layout = "French"
    const s = await macScene(() => layout)
    await dragOver(s, PASSAGE)
    await key(s, "œ")
    expect(has(screen(s.h), COMPOSING)).toBe(false)
    expect(s.h.app.editor.text).toBe("œ")
    s.h.app.editor.clear()
    layout = "ABC"
    await dragOver(s, PASSAGE)
    await key(s, "œ")
    expect(has(screen(s.h), COMPOSING)).toBe(true)
    const german = await macScene(() => "German")
    await key(german, "®")
    expect(german.h.app.editor.text).toBe("")
    await key(german, "«")
    expect(german.h.app.editor.text).toBe("«")
    const spanish = await macScene(() => "LatinAmerican")
    await key(spanish, "@")
    expect(spanish.h.app.editor.text).toBe("@")
  })

  test("a layout the table does not have changes nothing, and an unreadable one reads as the default", async () => {
    const czech = await macScene(() => "Czech-QWERTY")
    await dragOver(czech, PASSAGE)
    await key(czech, "œ")
    expect(czech.h.app.editor.text).toBe("œ")
    const unreadable = await macScene(() => undefined)
    await dragOver(unreadable, PASSAGE)
    await key(unreadable, "œ")
    expect(has(screen(unreadable.h), COMPOSING)).toBe(true)
  })

  test("the right panel's key, only with the panel on", async () => {
    const off = await macScene()
    await key(off, "’")
    expect(off.h.app.editor.text).toBe("’")
    const on = await scene({ width: 200, height: 50, sidebar: true }, { harness: { platform: "darwin", env: GHOSTTY } })
    await key(on, "’")
    expect(on.h.app.editor.text).toBe("")
  })

  test("in the tutorial the rail's characters are its keys: œ leaves, and nothing else of the table does", async () => {
    const h = appHarness({ env: { TERM: "xterm-256color" }, directory: "/work/app", width: 130, height: 32, platform: "darwin" })
    await h.type("/tutorial\r")
    for (let waited = 0; h.app.page !== "tutorial" && waited < 2_000; waited += 20) await Bun.sleep(20)
    expect(h.app.page).toBe("tutorial")
    await h.type("®")
    await Bun.sleep(20)
    expect(h.app.page).toBe("tutorial")
    await h.type("œ")
    await Bun.sleep(20)
    expect(h.app.page).toBe("chat")
  })

  test("the comment hint after a copy names ctrl+g on a Mac, before and after Option is known to work; the list's hint still follows Option", async () => {
    const s = await macScene()
    await dragOver(s, PASSAGE)
    expect(has(screen(s.h), "ctrl+g comment")).toBe(true)
    expect(has(screen(s.h), "ctrl+x w")).toBe(false)
    expect(has(screen(s.h), "opt+q")).toBe(false)
    expect(has(screen(s.h), "alt+q")).toBe(false)
    // This comment is made with a real Alt key: from then on Option is known to work and the hints of the Alt keys say so.
    await comment(s, "Before either, tell the user the schema change cannot be undone once the first batch has run.", "careful")
    await dragOver(s, PASSAGE)
    expect(has(screen(s.h), "ctrl+g comment")).toBe(true)
    expect(has(screen(s.h), "opt+q")).toBe(false)
    expect(has(screen(s.h), "opt+l list")).toBe(true)
    expect(has(screen(s.h), "alt+l")).toBe(false)
    expect(has(screen(s.h), "ctrl+x W")).toBe(false)
  })
})

describe("the live surfaces name Option on a Mac and Alt elsewhere", () => {
  test("the slash menu's key column and the shortcut overlay", async () => {
    for (const [platform, word] of [["darwin", "opt"], ["linux", "alt"], ["win32", "alt"]] as const) {
      const h = mac({ platform, width: 120, height: 40 })
      await h.type("/prompt-history")
      // A Mac names the chord until Option is known to send Alt; the other systems keep the Alt key.
      expect(frame(h)).toContain(platform === "darwin" ? "ctrl+x ?" : "alt+r")
      expect(frame(h)).not.toContain(`${word === "opt" ? "alt" : "opt"}+r`)
      if (platform === "darwin") expect(frame(h)).not.toContain("opt+r")
      h.app.editor.clear()
      await h.type("?")
      expect(frame(h)).toContain(`${word}+enter · ctrl+j`)
      expect(frame(h)).not.toContain(`${word === "opt" ? "alt" : "opt"}+enter`)
    }
  })

  test("/keymap and /help", async () => {
    const h = mac({ width: 120, height: 40 })
    await h.type("/keymap")
    await h.type("\r")
    await settle()
    expect(h.app.page).toBe("keymap")
    for (const char of "comment") await h.app.onKey(char)
    expect(frame(h)).toContain("comment on the selection")
    expect(frame(h)).toContain("opt+q")
    expect(frame(h)).not.toContain("alt+q")
    // The first esc clears the filter, the second leaves the page.
    await h.app.onKey("\x1b")
    await h.app.onKey("\x1b")
    expect(h.app.page).toBe("chat")
    await h.type("/help")
    await h.type("\r")
    expect(h.app.page).toBe("help")
    expect(frame(h)).toContain("opt+enter / ctrl+j")
  })

  test("the setting wins over the platform, in the profile and live", async () => {
    const symbol = mac({ platform: "linux", profile: { altLabel: "symbol" }, width: 120, height: 40 })
    await symbol.type("/prompt-history")
    expect(frame(symbol)).toContain("⌥r")
    const forced = mac({ platform: "darwin", profile: { altLabel: "alt" }, width: 120, height: 40 })
    await forced.type("/prompt-history")
    expect(frame(forced)).toContain("alt+r")
  })

  test("/customize changes the label at once and saves it; the daemon's profile push does too", async () => {
    const dataDir = tempDir()
    writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE })
    const h = appHarness({ dataDir, directory: tempDir(), width: 120, height: 40, mode: "full", env: GHOSTTY, platform: "darwin" })
    h.app.applySettings({ onboarded: true })
    await h.type("/customize")
    await h.type("\r")
    for (let i = 0; i < CUSTOMIZE_ROWS.indexOf("altLabel"); i++) await h.app.onKey("\x1b[B")
    expect(frame(h)).toContain("Alt key label")
    expect(frame(h)).toContain("‹ auto ›")
    await h.app.onKey("\x1b[C")
    expect(frame(h)).toContain("‹ alt ›")
    expect(readTuiProfile(dataDir).altLabel).toBe("alt")
    await h.app.onKey("\x1b[C")
    await h.app.onKey("\x1b[C")
    expect(frame(h)).toContain("‹ symbol ›")
    expect(readTuiProfile(dataDir).altLabel).toBe("symbol")
    await h.app.onKey("\x1b")
    await h.type("/prompt-history")
    expect(frame(h)).toContain("⌥r")
    h.app.editor.clear()
    h.app.onGlobal({ type: "tui.changed", gseq: 1, at: 0, profile: { ...DEFAULT_TUI_PROFILE, altLabel: "opt" } } as never)
    await h.type("/prompt-history")
    expect(frame(h)).toContain("opt+r")
    h.app.editor.clear()
    // `auto` on a Mac whose Option is not known to send Alt names the chord.
    h.app.onGlobal({ type: "tui.changed", gseq: 2, at: 0, profile: { ...DEFAULT_TUI_PROFILE } } as never)
    await h.type("/prompt-history")
    expect(frame(h)).toContain("ctrl+x ?")
  })

  test("/customize has the Option characters row, saved and applied at once", async () => {
    const dataDir = tempDir()
    writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE })
    const h = appHarness({ dataDir, directory: tempDir(), width: 120, height: 40, mode: "full", env: GHOSTTY, platform: "darwin" })
    h.app.applySettings({ onboarded: true })
    await h.type("/customize")
    await h.type("\r")
    for (let i = 0; i < CUSTOMIZE_ROWS.indexOf("optionKeys"); i++) await h.app.onKey("\x1b[B")
    expect(frame(h)).toContain("Option characters")
    expect(frame(h)).toContain("‹ auto ›")
    await h.app.onKey("\x1b[C")
    expect(frame(h)).toContain("‹ off ›")
    expect(readTuiProfile(dataDir).optionKeys).toBe("off")
  })
})

describe("the hint text", () => {
  test("names the character, the key that ran and the fix of the terminal", () => {
    const kinds: TerminalKind[] = ["ghostty", "kitty", "wezterm", "alacritty", "iterm2", "apple", "vscode", "zed", "jetbrains", "other"]
    for (const kind of kinds) {
      const notice = optionNotice({ kind, char: "œ", key: "alt+q" })
      expect(notice.message).toBe("Option typed œ: ran alt+q")
      expect(notice.hint).toEndWith(" · /terminal-setup")
      // The toast box cuts a hint at 54 cells (view/toast.ts).
      expect(notice.hint.length).toBeLessThanOrEqual(54)
    }
    expect(optionNotice({ kind: "ghostty", char: "œ", key: "alt+q" }).hint).toBe("Ghostty: macos-option-as-alt = true · /terminal-setup")
    expect(optionNotice({ kind: "kitty", char: "¬", key: "alt+l" }).hint).toBe("kitty: macos_option_as_alt both · /terminal-setup")
    // A terminal that is not a Mac one gets the generic advice rather than nothing.
    expect(optionNotice({ kind: "gnome", char: "œ", key: "alt+q" }).hint).toContain("Option as Meta/Alt")
  })

  test("every Mac terminal MendCode knows has steps a user can follow, and Ghostty has the exact line", () => {
    const ghostty = optionFix("ghostty")
    expect(ghostty.snippet).toEqual(["macos-option-as-alt = true"])
    expect(ghostty.where).toBe("~/.config/ghostty/config")
    for (const kind of ["kitty", "wezterm", "alacritty", "iterm2", "apple", "vscode", "zed", "jetbrains", "other"] as const) {
      const fix = optionFix(kind)
      expect(fix.steps.length + fix.snippet.length).toBeGreaterThan(0)
      expect(fix.where.length).toBeGreaterThan(0)
    }
  })
})

describe("/terminal-setup on a Mac", () => {
  const page = (platform: string | undefined, state = createTerminalSetupState(platform), env: Record<string, string> = GHOSTTY, width = 100, height = 30) =>
    renderTerminalSetupPage({ env, state, width, height, ...(platform ? { platform } : {}) }).map((line) => line.map((span) => span.text).join("")).join("\n")

  test("opens on the Option setup with the exact Ghostty line, and tab goes to Shift+Enter", () => {
    const text = page("darwin")
    expect(text).toContain("Option as Alt")
    expect(text).toContain("macos-option-as-alt = true")
    expect(text).toContain("Ghostty · detected")
    expect(text).toContain("tab Shift+Enter")
    expect(text).toContain("Ctrl+J is a newline everywhere. Option+Enter needs the setting.")
    const newline = page("darwin", { guide: 0 })
    expect(newline).toContain("keybind = shift+enter=text:\\x1b[13;2u")
    expect(newline).toContain("tab Option as Alt")
    expect(newline).not.toContain("macos-option-as-alt")
  })

  test("the key check tells Option sending Alt from Option typing a character", () => {
    expect(describeOptionPress("\x1bq")).toMatchObject({ works: true, text: "alt+q: Option sends Alt, the alt+key bindings work" })
    expect(describeOptionPress("œ")).toMatchObject({ works: false })
    expect(describeOptionPress("œ").text).toContain("Option typed a character, not Alt (alt+q does not fire)")
    expect(describeOptionPress("a").text).toBe("a: not an Option key")
    // Drawn with the label in use: Option on a Mac.
    configureKeyLabels({ setting: "auto", platform: "darwin" })
    expect(page("darwin", { guide: 0, topic: "option", lastKey: "œ" })).toContain("(opt+q does not fire)")
    expect(page("darwin", { guide: 0, topic: "option", lastKey: "\x1bq" })).toContain("opt+q: Option sends Alt")
  })

  test("other terminals show their own setting", () => {
    expect(page("darwin", createTerminalSetupState("darwin"), APPLE)).toContain(`Tick "Use Option as Meta key"`)
    expect(page("darwin", createTerminalSetupState("darwin"), { TERM_PROGRAM: "iTerm.app" })).toContain("Esc+")
    expect(page("darwin", createTerminalSetupState("darwin"), { KITTY_WINDOW_ID: "1" })).toContain("macos_option_as_alt both")
    expect(page("darwin", createTerminalSetupState("darwin"), { TERM_PROGRAM: "WezTerm" })).toContain("send_composed_key_when_right_alt_is_pressed = false")
    expect(page("darwin", createTerminalSetupState("darwin"), { ALACRITTY_LOG: "/x" })).toContain(`option_as_alt = "Both"`)
  })

  test("Linux and Windows get the page they always had: no Option topic, no tab, the same text with or without a platform", () => {
    const base = page(undefined)
    for (const platform of ["linux", "win32"]) {
      const text = page(platform)
      expect(text).toBe(base)
      expect(text).not.toContain("Option")
      expect(text).not.toContain("tab ")
      expect(text).toContain("Alt+Enter and Ctrl+J insert a newline in every terminal, with no setup.")
      expect(text).toContain("keybind = shift+enter=text:\\x1b[13;2u")
    }
    expect(createTerminalSetupState("linux")).toEqual({ guide: 0 })
    expect(createTerminalSetupState()).toEqual({ guide: 0 })
  })

  test("the page fits 80x24 and 60x20 on a Mac", () => {
    for (const [width, height] of [[80, 24], [60, 20]] as const) for (const topic of [undefined, "option"] as const) {
      const text = page("darwin", topic ? { guide: 0, topic } : { guide: 0 }, GHOSTTY, width, height)
      for (const row of text.split("\n")) expect([...row].length).toBeLessThanOrEqual(width)
    }
  })

  test("in the app: /terminal-setup opens on the Option topic, a key is checked, tab switches", async () => {
    const h = mac({ height: 34 })
    await h.type("/terminal-setup")
    await h.type("\r")
    await settle()
    expect(h.app.page).toBe("terminal-setup")
    expect(frame(h)).toContain("macos-option-as-alt = true")
    await h.app.onKey("\x1bq")
    expect(frame(h)).toContain("opt+q: Option sends Alt")
    await h.app.onKey("œ")
    expect(frame(h)).toContain("Option typed a character, not Alt (opt+q does not fire)")
    await h.app.onKey("\t")
    expect(frame(h)).toContain("keybind = shift+enter")
    await h.app.onKey("\t")
    expect(frame(h)).toContain("macos-option-as-alt = true")
  })

  test("in the app on Linux: tab is just a key to check", async () => {
    const h = mac({ platform: "linux", height: 34 })
    await h.type("/terminal-setup")
    await h.type("\r")
    await settle()
    expect(frame(h)).toContain("keybind = shift+enter")
    await h.app.onKey("\t")
    expect(frame(h)).toContain("keybind = shift+enter")
    expect(frame(h)).toContain("tab: not a newline key")
  })
})
