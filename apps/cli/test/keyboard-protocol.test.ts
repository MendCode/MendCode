import { describe, expect, test } from "bun:test"
import { createKeyboardProtocol, KEYBOARD_FLAGS, KEYBOARD_POP, KEYBOARD_PUSH, KEYBOARD_QUERY, keyboardWanted, translateKey } from "../src/ui/keyboard-protocol"
import { createScreen } from "../src/ui/screen"
import { createBindings } from "../src/ui/keymap"
import { isAltSequence } from "../src/view/option-keys"
import { createCrashGuard } from "../src/ui/crash"
import { DEFAULT_TUI_PROFILE, normalizeTuiProfile, writeTuiProfile, type TuiProfile } from "../src/view/tui-profile"
import { CUSTOMIZE_ROWS } from "../src/view/customize-page"
import { TUI_DEFAULTS, TUI_ENUMS, tuiProblems } from "@mendcode/protocol/wire"
import { appHarness, tempDir } from "./session-ui-harness"

const ESC = "\x1b"

describe("CSI u keys become the sequences the keymap binds", () => {
  const cases: Array<[string, string, string]> = [
    ["a plain letter", `${ESC}[97u`, "a"],
    ["a letter with its associated text", `${ESC}[97;;97u`, "a"],
    ["shift+letter with the text", `${ESC}[97;2;65u`, "A"],
    ["shift+letter with the shifted key (flag 4)", `${ESC}[97:65;2u`, "A"],
    ["shift+1 is !", `${ESC}[49:33;2;33u`, "!"],
    ["space", `${ESC}[32;;32u`, " "],
    ["a composed character without a modifier (IME, a dead key's result)", `${ESC}[101;;233u`, "é"],
    ["committed text with no key", `${ESC}[0;;12354u`, "あ"],
    ["enter, tab, backspace, escape", `${ESC}[13u`, "\r"],
    ["tab", `${ESC}[9u`, "\t"],
    ["shift+tab", `${ESC}[9;2u`, `${ESC}[Z`],
    ["backspace", `${ESC}[127u`, "\x7f"],
    ["escape", `${ESC}[27u`, ESC],
    ["ctrl+c", `${ESC}[99;5u`, "\x03"],
    ["ctrl+x, the leader", `${ESC}[120;5u`, "\x18"],
    ["ctrl+c on a Cyrillic layout, by the base layout key", `${ESC}[1089::99;5u`, "\x03"],
    ["ctrl+alt+y", `${ESC}[121;7u`, "\x1b\x19"],
    ["ctrl+space", `${ESC}[32;5u`, "\x00"],
    ["ctrl+shift+a stays CSI u, which the keymap lists", `${ESC}[97;6u`, `${ESC}[97;6u`],
    ["alt+q", `${ESC}[113;3u`, `${ESC}q`],
    ["Option+Q that composed œ (Ghostty and kitty with Option as text)", `${ESC}[113;3;339u`, `${ESC}q`],
    ["alt+shift+y", `${ESC}[121:89;4;89u`, `${ESC}Y`],
    ["alt+comma", `${ESC}[44;3;8804u`, `${ESC},`],
    ["alt+backspace", `${ESC}[127;3u`, "\x1b\x7f"],
    ["alt+enter stays CSI u, which the editor binds", `${ESC}[13;3u`, `${ESC}[13;3u`],
    ["shift+enter stays CSI u, which the editor binds", `${ESC}[13;2u`, `${ESC}[13;2u`],
    ["ctrl+enter stays CSI u, which the editor binds", `${ESC}[13;5u`, `${ESC}[13;5u`],
    ["caps lock and num lock are not modifiers", `${ESC}[97;193u`, "a"],
    ["a release is nothing", `${ESC}[97;1:3u`, ""],
    ["a modifier pressed alone is nothing", `${ESC}[57441;2u`, ""],
    ["keypad 5", `${ESC}[57404u`, "5"],
    ["super combinations stay as they are", `${ESC}[99;9u`, `${ESC}[99;9u`],
    ["arrows are not CSI u and pass through", `${ESC}[1;3A`, `${ESC}[1;3A`],
    ["plain text passes through", "hello", "hello"],
    ["a paste marker passes through", `${ESC}[200~`, `${ESC}[200~`],
  ]
  for (const [name, from, to] of cases) test(name, () => expect(translateKey(from)).toBe(to))

  test("Option+key that composed text is the binding when the app binds it, and the text when it does not", () => {
    const bindings = createBindings()
    const bound = (seq: string) => bindings.direct.has(seq) || bindings.inline.has(seq)
    // Spanish layout: Option+2 types @. alt+2 is nothing here, so the @ is typed.
    expect(translateKey(`${ESC}[50;3;64u`, bound)).toBe("@")
    // Option+Q is œ, and alt+q is the comment key.
    expect(translateKey(`${ESC}[113;3;339u`, bound)).toBe(`${ESC}q`)
    // Option+F is ƒ, alt+f moves a word.
    expect(translateKey(`${ESC}[102;3;402u`, bound)).toBe(`${ESC}f`)
    // Without text it is a real Alt, bound or not.
    expect(translateKey(`${ESC}[50;3u`, bound)).toBe(`${ESC}2`)
  })

  test("the translated Alt keys are the ones the app already treats as Alt", () => {
    expect(isAltSequence(translateKey(`${ESC}[113;3;339u`))).toBe(true)
    expect(isAltSequence(translateKey(`${ESC}[97;;97u`))).toBe(false)
  })
})

describe("asking the terminal", () => {
  const make = (enabled = true) => {
    const writes: string[] = []
    return { writes, protocol: createKeyboardProtocol({ write: (data) => void writes.push(data), enabled }) }
  }

  test("the query goes out once, the flags are pushed only after the keyboard answer, and release pops them", () => {
    const { writes, protocol } = make()
    protocol.ask()
    protocol.ask()
    expect(writes).toEqual([KEYBOARD_QUERY])
    expect(protocol.state).toBe("asked")
    expect(protocol.consume(`${ESC}[?0u${ESC}[?62;22c`)).toBe("")
    expect(protocol.state).toBe("on")
    expect(writes).toEqual([KEYBOARD_QUERY, KEYBOARD_PUSH])
    expect(KEYBOARD_PUSH).toBe(`${ESC}[>${KEYBOARD_FLAGS}u`)
    expect(protocol.release()).toBe(KEYBOARD_POP)
    expect(protocol.state).toBe("idle")
    expect(protocol.release()).toBe("")
  })

  test("the terminal is in raw mode before the screen asks: its answer is never echoed as text", async () => {
    const main = await Bun.file(new URL("../src/main.ts", import.meta.url)).text()
    const raw = main.indexOf("process.stdin.setRawMode?.(true)\nscreen.enter()")
    expect(raw).toBeGreaterThan(0)
    // The start has one `screen.enter()` at column 0, and it is the one right after raw mode.
    expect(main.indexOf("\nscreen.enter()")).toBe(main.indexOf("\n", raw))
  })

  test("a terminal that only answers the device query is left alone and no stray bytes reach the keys", () => {
    const { writes, protocol } = make()
    protocol.ask()
    expect(protocol.consume(`${ESC}[?1;2c`)).toBe("")
    expect(protocol.state).toBe("refused")
    expect(writes).toEqual([KEYBOARD_QUERY])
    expect(protocol.release()).toBe("")
    expect(protocol.translate(`${ESC}[97u`)).toBe(`${ESC}[97u`)
  })

  test("a terminal that answers nothing stays asked, writes nothing more and keeps its keys", () => {
    const { writes, protocol } = make()
    protocol.ask()
    expect(protocol.consume("abc")).toBe("abc")
    expect(protocol.consume(`${ESC}[A`)).toBe(`${ESC}[A`)
    expect(protocol.state).toBe("asked")
    expect(writes).toEqual([KEYBOARD_QUERY])
  })

  test("answers split by the read boundary are held until they are whole, and a lone Esc is a key", () => {
    const { writes, protocol } = make()
    protocol.ask()
    expect(protocol.consume(`x${ESC}[?`)).toBe("x")
    expect(protocol.consume("0u")).toBe("")
    expect(protocol.state).toBe("on")
    expect(protocol.consume(`${ESC}[?6`)).toBe("")
    expect(protocol.consume("2c")).toBe("")
    expect(protocol.consume(ESC)).toBe(ESC)
    expect(writes).toEqual([KEYBOARD_QUERY, KEYBOARD_PUSH])
  })

  test("an answer that comes after the screen was left is removed from the keys and does nothing", () => {
    const { writes, protocol } = make()
    protocol.ask()
    expect(protocol.release()).toBe("")
    expect(protocol.consume(`${ESC}[?0u${ESC}[?1c`)).toBe("")
    expect(protocol.state).toBe("idle")
    expect(writes).toEqual([KEYBOARD_QUERY])
  })

  test("disabled, nothing is asked and nothing is removed from the input", () => {
    const { writes, protocol } = make(false)
    protocol.ask()
    expect(protocol.consume(`${ESC}[?0u`)).toBe(`${ESC}[?0u`)
    expect(writes).toEqual([])
  })

  test("only the auto setting on a Mac wants it", () => {
    expect(keyboardWanted("auto", "darwin")).toBe(true)
    for (const platform of ["linux", "win32", undefined]) expect(keyboardWanted("auto", platform)).toBe(false)
    expect(keyboardWanted("off", "darwin")).toBe(false)
  })

  test("the setting is declared like its neighbours", () => {
    expect(DEFAULT_TUI_PROFILE.keyProtocol).toBe("auto")
    expect(TUI_DEFAULTS.keyProtocol).toBe("auto")
    expect(TUI_ENUMS.keyProtocol).toEqual(["auto", "off"])
    expect(CUSTOMIZE_ROWS).toContain("keyProtocol")
    expect(normalizeTuiProfile({ keyProtocol: "on" }).keyProtocol).toBe("auto")
    expect(normalizeTuiProfile({ keyProtocol: "off" }).keyProtocol).toBe("off")
    expect(tuiProblems({ keyProtocol: "on" })).toEqual(["keyProtocol: expected auto|off"])
  })
})

describe("the protocol on the screen", () => {
  const output = (isTTY = true) => {
    const writes: string[] = []
    return { writes, out: { write: (data: string) => void writes.push(data), columns: 80, rows: 24, isTTY } }
  }

  test("entering asks, the answer pushes, leaving pops before the alternate screen is left", () => {
    const { writes, out } = output()
    const screen = createScreen(out, {}, { keyboard: true })
    screen.enter()
    expect(writes.at(-1)).toBe(KEYBOARD_QUERY)
    expect(screen.consumeTerminalInput(`${ESC}[?0u${ESC}[?62c`)).toBe("")
    expect(writes.at(-1)).toBe(KEYBOARD_PUSH)
    expect(screen.keyboard.active).toBe(true)
    screen.leave()
    const closing = writes.at(-1)!
    expect(closing).toContain(KEYBOARD_POP)
    expect(closing.indexOf(KEYBOARD_POP)).toBeLessThan(closing.indexOf(`${ESC}[?1049l`))
    expect(screen.keyboard.active).toBe(false)
    // Coming back (the external editor, ctrl+z) asks again.
    screen.enter()
    expect(writes.at(-1)).toBe(KEYBOARD_QUERY)
  })

  test("nothing is asked off a Mac, with the setting off, on a pipe, or with MENDCODE_KEY_PROTOCOL=0", () => {
    for (const [tty, env, keyboard] of [[true, {}, false], [false, {}, true], [true, { MENDCODE_KEY_PROTOCOL: "0" }, true]] as const) {
      const { writes, out } = output(tty)
      const screen = createScreen(out, env, { keyboard })
      screen.enter()
      screen.leave()
      expect(writes.join("")).not.toContain(KEYBOARD_QUERY)
      expect(writes.join("")).not.toContain(KEYBOARD_POP)
    }
  })

  test("the process exit pops what is still pushed, once", () => {
    const { writes, out } = output()
    const screen = createScreen(out, {}, { keyboard: true })
    screen.enter()
    screen.consumeTerminalInput(`${ESC}[?0u`)
    screen.releaseKeyboard()
    screen.releaseKeyboard()
    expect(writes.filter((data) => data === KEYBOARD_POP)).toHaveLength(1)
  })

  test("the setting turned off pops at once, and on asks again", () => {
    const { writes, out } = output()
    const screen = createScreen(out, {}, { keyboard: true })
    screen.enter()
    screen.consumeTerminalInput(`${ESC}[?0u`)
    screen.setKeyboard(false)
    expect(writes.at(-1)).toBe(KEYBOARD_POP)
    screen.setKeyboard(true)
    expect(writes.at(-1)).toBe(KEYBOARD_QUERY)
  })

  test("inline mode gives the alternate screen its own flags and takes them off before leaving it", () => {
    const { writes, out } = output()
    const screen = createScreen(out, {}, { keyboard: true, inline: true })
    screen.enter()
    screen.consumeTerminalInput(`${ESC}[?0u`)
    screen.fullscreen(true)
    expect(writes.at(-1)).toContain(`${ESC}[?1049h${KEYBOARD_PUSH}`)
    screen.fullscreen(false)
    expect(writes.at(-1)).toContain(`${KEYBOARD_POP}${ESC}[?1049l`)
    // Leaving while a page is open pops the alternate screen's flags first, then the main screen's.
    screen.fullscreen(true)
    screen.leave()
    const tail = writes.slice(-2).join("")
    expect(tail.match(new RegExp(KEYBOARD_POP.replace(/[[\]]/g, "\\$&"), "g"))).toHaveLength(2)
  })

  test("the crash screen reads its keys through the translation", () => {
    const { out } = output()
    const screen = createScreen(out, {}, { keyboard: true })
    screen.enter()
    screen.consumeTerminalInput(`${ESC}[?0u`)
    expect(screen.translateKeys(`${ESC}[113;;113u`)).toBe("q")
    let exited = -1
    const guard = createCrashGuard({ screen, now: () => 0, env: {}, saveDrafts: async () => undefined, exit: (code) => { exited = code }, resume: () => undefined })
    void guard.handle(new Error("boom"))
    return Promise.resolve().then(() => Bun.sleep(5)).then(() => {
      expect(guard.onInput(`${ESC}[113;;113u`)).toBe(true)
      expect(exited).toBe(1)
    })
  })
})

describe("keys through the app", () => {
  const mac = () => {
    const dataDir = tempDir()
    writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE } as TuiProfile)
    const { out } = output()
    const screen = createScreen(out, {}, { keyboard: true })
    const h = appHarness({ dataDir, directory: tempDir(), width: 100, height: 30, mode: "full", platform: "darwin", env: { TERM_PROGRAM: "ghostty" }, screen })
    h.app.applySettings({ onboarded: true })
    screen.enter()
    return { h, screen }
  }
  function output() {
    const writes: string[] = []
    return { writes, out: { write: (data: string) => void writes.push(data), columns: 100, rows: 30, isTTY: true } }
  }

  test("before the terminal answers, keys are what the terminal sent", async () => {
    const { h } = mac()
    await h.app.onInput(`${ESC}[97u`)
    expect(h.app.editor.text).toBe("")
  })

  test("after it answers, typed text, a dead key's result and an unbound Option character are typed; Option+Q is the binding", async () => {
    const { h } = mac()
    await h.app.onInput(`${ESC}[?0u${ESC}[?62c`)
    await h.app.onInput(`${ESC}[104;;104u${ESC}[111;;111u`)
    expect(h.app.editor.text).toBe("ho")
    await h.app.onInput(`${ESC}[101;;233u`)
    await h.app.onInput(`${ESC}[50;3;64u`)
    expect(h.app.editor.text).toBe("hoé@")
    h.app.editor.clear()
    await h.app.onInput(`${ESC}[113;3;339u`)
    expect(h.app.editor.text).toBe("")
    await h.app.onInput(`${ESC}[57441;2u`)
    expect(h.app.editor.text).toBe("")
  })

  test("a paste is text whatever it contains", async () => {
    const { h } = mac()
    await h.app.onInput(`${ESC}[?0u`)
    await h.app.onInput(`${ESC}[200~${ESC}[113;3u œ${ESC}[201~`)
    expect(h.app.editor.text).toBe("[113;3u œ")
  })
})
