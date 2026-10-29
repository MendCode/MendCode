import { afterEach, describe, expect, test } from "bun:test"
import { ALT_Q, CODEX, dragOver, has, key, scene, screen } from "./reply-comments-helpers"
import { chordNames, createBindings, DEFAULT_BINDINGS, hintKey, keyName, LEADER_CHORDS, type BindingAction } from "../src/ui/keymap"
import { configureKeyLabels, keyText, preferChord, resetKeyLabels } from "../src/ui/key-labels"
import { showsAltWorks } from "../src/view/option-keys"
import { createKeyboardProtocol } from "../src/ui/keyboard-protocol"
import { renderQueuePanel } from "../src/view/queue-panel"
import { appHarness, plain, tempDir } from "./session-ui-harness"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"
import { SIDEBAR_PRESETS } from "../src/view/sidebar-spec"

afterEach(() => resetKeyLabels())

const CTRL_X = "\x18"
const GHOSTTY = { TERM_PROGRAM: "ghostty", TERM: "xterm-ghostty" }
const macScene = () => scene({ width: 120, height: 40 }, { harness: { platform: "darwin", env: GHOSTTY } })
const linuxScene = () => scene({ width: 120, height: 40 }, { harness: { platform: "linux", env: {} } })
const chord = async (s: Awaited<ReturnType<typeof macScene>>, letter: string) => {
  await key(s, CTRL_X)
  await key(s, letter)
}

/** The chords before this change: none of them moves. */
const OLD_CHORDS = {
  n: "new", l: "sessions", m: "model", t: "theme", c: "compact", q: "quit", a: "agents", U: "usage", d: "changes", e: "editor.open", y: "message.copy", p: "stash.push", o: "stash.pop",
  z: "message.undo", r: "message.redo", g: "session.timeline", G: "session.history", h: "tips.toggle", x: "session.export", b: "sidebar.toggle", B: "panel.toggle", s: "scratch.edit",
  i: "diagram.open", k: "messages.open", "\x1b[B": "session.child.first", "\x1bOB": "session.child.first", u: "message.undo", "/": "transcript.find", v: "voice.toggle", f: "details.toggle", Y: "block.copy",
} as const

/** Every default alt binding that had no way in other than the Alt key, and the chord it has now. */
const NEW_CHORDS: ReadonlyArray<readonly [alt: string, chord: string, action: BindingAction]> = [
  ["alt+q", "w", "selection.comment"],
  ["alt+l", "W", "comment.list"],
  ["alt+r", "?", "history.search"],
  ["alt+p", "[", "history.previous"],
  ["alt+n", "]", "history.next"],
  ["alt+,", ",", "effort.previous"],
  ["alt+.", ".", "effort.next"],
  ["alt+up", "^", "queue.edit"],
  ["alt+}", "}", "panel.focus"],
  ["alt+{", "{", "file.switch"],
  ["alt+o", ";", "file.open"],
  ["alt+x", "-", "file.close"],
  ["alt+j", "j", "edit.jump-forward"],
  ["alt+J", "J", "edit.jump-backward"],
  ["alt+y", "'", "edit.yank"],
  ["alt+Y", "\"", "edit.yank-pop"],
]

describe("the ctrl+x chords for the default alt keys", () => {
  test("no chord that existed moved, and every new one is a fresh key", () => {
    for (const [letter, action] of Object.entries(OLD_CHORDS)) expect(LEADER_CHORDS[letter]).toBe(action)
    const added = Object.keys(LEADER_CHORDS).filter((letter) => !(letter in OLD_CHORDS))
    expect(added.sort()).toEqual(NEW_CHORDS.map(([, letter]) => letter).sort())
    // The leader also finds a chord by the lowercase of the key: no new letter may catch a key an old chord already answered to.
    for (const letter of added) if (letter.toLowerCase() !== letter) expect(letter.toLowerCase() in OLD_CHORDS).toBe(false)
  })

  test("each alt key and its chord run the same action", () => {
    const bindings = createBindings()
    for (const [alt, letter, action] of NEW_CHORDS) {
      expect(bindings.leader.get(letter)).toEqual({ action })
      expect(chordNames(bindings, action)).toEqual([`ctrl+x ${letter}`])
      const holders = [...bindings.direct, ...bindings.inline].filter(([seq]) => keyName(seq) === alt || keyName(seq) === alt.replace(/^alt\+([A-Z])$/, (_, upper: string) => `alt+shift+${upper.toLowerCase()}`))
      expect(holders.length).toBeGreaterThan(0)
      for (const [, bound] of holders) expect(typeof bound === "string" ? bound : "action" in bound ? bound.action : undefined).toBe(action)
    }
  })

  test("a rebound or removed chord falls back to the alt key in a hint", () => {
    configureKeyLabels({ platform: "darwin" })
    const bindings = createBindings()
    expect(hintKey(bindings, "comment.list", "alt+l")).toBe("ctrl+x W")
    bindings.leader.delete("W")
    expect(hintKey(bindings, "comment.list", "alt+l")).toBe("alt+l")
  })
})

describe("what a hint names", () => {
  test("on a Mac where Option is not known to work, the chord; once it is, the Alt key", () => {
    configureKeyLabels({ platform: "darwin" })
    expect(preferChord()).toBe(true)
    expect(hintKey(DEFAULT_BINDINGS, "history.search", "alt+r")).toBe("ctrl+x ?")
    configureKeyLabels({ altWorks: true })
    expect(preferChord()).toBe(false)
    expect(hintKey(DEFAULT_BINDINGS, "history.search", "alt+r")).toBe("alt+r")
    expect(keyText(hintKey(DEFAULT_BINDINGS, "history.search", "alt+r")!)).toBe("opt+r")
  })

  test("a key that is not an alt key, or an action with no chord, stays as it is", () => {
    configureKeyLabels({ platform: "darwin" })
    expect(hintKey(DEFAULT_BINDINGS, "effort.next", "f3")).toBe("f3")
    expect(hintKey(DEFAULT_BINDINGS, "edit.visual-line-home", "alt+a")).toBe("alt+a")
    expect(hintKey(DEFAULT_BINDINGS, "history.search", undefined)).toBeUndefined()
  })

  test("Linux and Windows hints are the Alt keys, byte for byte, whatever has been seen", () => {
    for (const platform of ["linux", "win32", undefined]) {
      for (const altWorks of [false, true]) {
        configureKeyLabels({ platform, altWorks })
        expect(preferChord()).toBe(false)
        for (const [alt, , action] of NEW_CHORDS) expect(hintKey(DEFAULT_BINDINGS, action, alt)).toBe(alt)
      }
    }
    configureKeyLabels({ platform: "linux", altWorks: false })
    const queue = renderQueuePanel({ width: 100, previews: ["next"], held: false }).rows.map(plain).join("\n")
    expect(queue).toContain("ctrl+k drop last · alt+↑ edit")
    // Held with only system notices waiting: one muted line, no box and no send chip. A message of the user's keeps the box.
    const held = renderQueuePanel({ width: 100, previews: ["[background task a]", "[background task b]"], held: true, notices: new Set([0, 1]) })
    expect(held.rows.map(plain)).toEqual([expect.stringContaining("2 background results · sent with your next message · ctrl+s sends now · ctrl+k drops")])
    expect(held.sendChip).toBeUndefined()
    // Two cells in, like the text of the box and the prompt's rule; every width gets a form that fits whole, never a cut key name.
    expect(plain(held.rows[0]!)).toMatch(/^ {2}2 background/)
    for (const width of [120, 100, 84, 80, 76, 70, 60, 46]) {
      const row = plain(renderQueuePanel({ width, previews: ["[background task a]"], held: true, notices: new Set([0]) }).rows[0]!).trimEnd()
      expect(row.length).toBeLessThanOrEqual(width)
      expect(row).toMatch(width >= 86 ? /ctrl\+s sends now · ctrl\+k drops$/ : width >= 76 ? /with your next message · ctrl\+s sends · ctrl\+k drops$/ : /with your next message$/)
    }
    expect(renderQueuePanel({ width: 60, previews: ["[background task a]"], held: true, notices: new Set([0]) }).rows.map(plain)).toEqual([expect.stringContaining("1 background result · with your next message")])
    const mixed = renderQueuePanel({ width: 100, previews: ["[background task a]", "mine"], held: true, notices: new Set([0]) })
    expect(mixed.rows.map(plain).join("\n")).toContain("2 queued · Held")
    // While a turn runs the notice is the model's to read at its next step: one muted line with no send chip, not a message of the user's.
    const running = renderQueuePanel({ width: 100, previews: ["[background task a]"], held: false, notices: new Set([0]) })
    expect(running.rows.map(plain)).toEqual([expect.stringMatching(/^  1 background result · the model reads it at its next step · ctrl\+k drops\s*$/)])
    expect(running.sendChip).toBeUndefined()
    expect(renderQueuePanel({ width: 100, previews: ["[background task a]", "mine"], held: false, notices: new Set([0]) }).rows.map(plain).join("\n")).toContain("2 queued · After response")
  })

  test("a chosen label (alt, opt, symbol) is a request to see the Alt keys", () => {
    for (const setting of ["alt", "opt", "symbol"] as const) {
      configureKeyLabels({ platform: "darwin", setting, altWorks: false })
      expect(preferChord()).toBe(false)
      expect(hintKey(DEFAULT_BINDINGS, "history.search", "alt+r")).toBe("alt+r")
    }
  })

  test("the queue panel names ctrl+x ^ on a Mac that has not shown Option, and the Option key after", () => {
    configureKeyLabels({ platform: "darwin" })
    const rows = () => renderQueuePanel({ width: 100, previews: ["next"], held: false }).rows.map(plain).join("\n")
    expect(rows()).toContain("ctrl+k drop last · ctrl+x ^ edit")
    configureKeyLabels({ altWorks: true })
    expect(rows()).toContain("ctrl+k drop last · opt+↑ edit")
  })
})

describe("which keys show that Option sends Alt", () => {
  test("a character with Esc, or CSI u with the alt modifier of one, does", () => {
    for (const real of ["\x1bq", "\x1bl", "\x1b}", "\x1b,", "\x1b[113;3u", "\x1b[113:81;3:1u", "\x1b[113;4u", "\x1b[113;3;339u"]) expect(showsAltWorks(real)).toBe(true)
  })

  test("what Option+arrow, Option+Delete and Option+Enter send by default does not", () => {
    // Terminal.app and iTerm2 send Esc b / Esc f / Esc DEL for Option+Left / Right / Delete while Option+Q still types œ.
    for (const other of ["\x1bb", "\x1bf", "\x1bB", "\x1bF", "\x1b\x7f", "\x1b\r", "\x1b[1;3A", "\x1b[1;3D", "\x1b[3;3~", "\x1b[13;3u", "\x1b[127;3u", "\x1b[27u", "\x1b[113;5u", "q", "œ", "\x1b"]) expect(showsAltWorks(other)).toBe(false)
  })
})

describe("the keyboard protocol tells the hints that Option works", () => {
  test("a terminal that answers the query is announced once; one that does not is not", () => {
    const answered = createKeyboardProtocol({ write: () => {}, enabled: true })
    const told: boolean[] = []
    answered.subscribe((active) => told.push(active))
    answered.ask()
    expect(told).toEqual([])
    answered.consume("\x1b[?0u\x1b[?62;22c")
    expect(told).toEqual([true])
    const silent = createKeyboardProtocol({ write: () => {}, enabled: true })
    const none: boolean[] = []
    silent.subscribe((active) => none.push(active))
    silent.ask()
    silent.consume("\x1b[?1;2c")
    expect(none).toEqual([])
  })
})

describe("the chords in a session", () => {
  test("ctrl+x w comments on a kept selection and on the passage just copied, like the Option key", async () => {
    const chorded = await macScene()
    await dragOver(chorded, CODEX)
    await chord(chorded, "w")
    expect(has(screen(chorded.h), "enter saves · esc cancels")).toBe(true)
    const reference = await macScene()
    await dragOver(reference, CODEX)
    await key(reference, ALT_Q)
    // The first row names the temporary directory of each scene; the rest is the same screen.
    expect(screen(chorded.h).slice(1).join("\n")).toBe(screen(reference.h).slice(1).join("\n"))
  })

  test("ctrl+x w and ctrl+x W with nothing to comment on or list say so, and type nothing", async () => {
    const s = await macScene()
    await chord(s, "W")
    expect(s.h.app.editor.text).toBe("")
    await chord(s, "w")
    expect(s.h.app.editor.text).toBe("")
  })

  test("ctrl+x ] and [ walk the prompt history", async () => {
    const s = await macScene()
    await s.h.app.onKey("[")
    s.h.app.editor.clear()
    await chord(s, "[")
    expect(s.h.app.editor.text).toBe("")
    await chord(s, "]")
    expect(s.h.app.editor.text).toBe("")
  })

  test("ctrl+x j and ctrl+x ' edit the prompt like alt+j and alt+y", async () => {
    const chorded = await linuxScene()
    const alt = await linuxScene()
    for (const s of [chorded, alt]) {
      s.h.app.editor.insert("one two three")
      await key(s, "\x01")
    }
    await chord(chorded, "j")
    await key(alt, "\x1bj")
    expect(chorded.h.app.editor.cursorOffset).toBe(alt.h.app.editor.cursorOffset)
  })

  test("ctrl+x } gives the keyboard to the right panel, as alt+} does", async () => {
    const dataDir = tempDir()
    writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, rightSidebar: true, sidebarWidgets: structuredClone(SIDEBAR_PRESETS.galaxy) })
    const h = appHarness({ width: 140, height: 30, directory: tempDir(), dataDir, mode: "full", platform: "darwin", env: GHOSTTY })
    h.app.applySettings({ tier: "full", onboarded: true, reducedMotion: true })
    await Bun.sleep(30)
    expect(h.text().join("\n")).not.toContain("· focused")
    await h.type(CTRL_X)
    await h.type("}")
    expect(h.text().join("\n")).toContain("galaxy · /panel · focused")
    await h.type("l")
    expect(h.app.editor.text).toBe("")
    await h.type("\x1b")
    expect(h.text().join("\n")).not.toContain("· focused")
    await h.type("l")
    expect(h.app.editor.text).toBe("l")
  })

  test("a chord letter that is no chord cancels the leader, as before", async () => {
    const s = await macScene()
    // A letter also answers to its lowercase (V is /voice), so the test takes a key with neither.
    await chord(s, "7")
    expect(s.h.app.editor.text).toBe("")
    await key(s, "x")
    expect(s.h.app.editor.text).toBe("x")
  })
})
