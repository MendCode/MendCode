import { afterEach, describe, expect, test } from "bun:test"
import { cleanTemps } from "./session-ui-harness"
import { createBindings } from "../src/ui/keymap"
import { keymapRows } from "../src/view/keymap-page"
import { chat, drag, frame, press, release, rowOf, settle, type Setup } from "./file-viewer-helpers"

afterEach(cleanTemps)

const ALT_O = "\x1bo"
const viewed = (h: Awaited<ReturnType<typeof chat>>["h"]) => (h.sentOf("file.view") as Array<{ path: string; from?: number }>).map((read) => read.path)

async function started(text: string, setup: Setup = {}) {
  const ctx = await chat({ text, ...setup })
  return ctx
}

describe("the open-path key", () => {
  test("opens the only path of the item in view, at its line", async () => {
    const { h } = await started("The entry is src/app.rs:120 and nothing else.")
    await h.app.onKey(ALT_O)
    await settle()
    h.app.render()
    expect(viewed(h)).toEqual(["src/app.rs"])
    expect(frame(h)).toContain("‹ app.rs")
    expect(frame(h)).toContain("fn target()")
  })

  test("several paths are listed in the palette's picker, in reading order, and the chosen one opens", async () => {
    const { h } = await started("See src/app.rs:120, then DESIGN.md#L10-L20 and ./AGENTS.md please.")
    await h.app.onKey(ALT_O)
    await settle()
    h.app.render()
    expect(viewed(h)).toEqual([])
    const text = frame(h)
    expect(text).toContain("Open file")
    const first = rowOf(h, "src/app.rs:120")
    expect(rowOf(h, "DESIGN.md:10-20")).toBeGreaterThan(first)
    // The second entry.
    await h.app.onKey("\x1b[B")
    await h.app.onKey("\r")
    await settle()
    h.app.render()
    expect(viewed(h)).toEqual(["DESIGN.md"])
    expect(frame(h)).toContain("‹ DESIGN.md")
  })

  test("esc closes the picker and opens nothing", async () => {
    const { h } = await started("See src/app.rs:120 and DESIGN.md#L10-L20.")
    await h.app.onKey(ALT_O)
    await settle()
    h.app.render()
    await h.app.onKey("\x1b")
    h.app.render()
    expect(viewed(h)).toEqual([])
    expect(frame(h)).not.toContain("Open file")
  })

  test("no path says so, and a path outside the workspace is not offered", async () => {
    const none = await started("Nothing to open here at all.")
    await none.h.app.onKey(ALT_O)
    await settle()
    none.h.app.render()
    expect(frame(none.h)).toContain("no file path in the item in view")
    const outside = await started("Do not read /etc/hosts, read src/app.rs:3 instead.")
    await outside.h.app.onKey(ALT_O)
    await settle()
    outside.h.app.render()
    expect(viewed(outside.h)).toEqual(["src/app.rs"])
  })

  test("a selection decides what is looked at: the paths inside it, not the whole item", async () => {
    const { h } = await started("First src/app.rs:120 and then DESIGN.md#L10-L20 in one line.")
    const row = rowOf(h, "DESIGN.md#L10-L20")
    const line = h.text()[row]!
    const from = line.indexOf("DESIGN.md")
    await h.app.onKey(press(from, row))
    await h.app.onKey(drag(from + 16, row))
    await h.app.onKey(release(from + 16, row))
    await h.app.onKey(ALT_O)
    await settle()
    h.app.render()
    expect(viewed(h)).toEqual(["DESIGN.md"])
  })

  test("the ctrl+x chord does the same, and so does a rebound key", async () => {
    const chord = await started("The entry is src/app.rs:120.")
    await chord.h.app.onKey("\x18")
    await chord.h.app.onKey(";")
    await settle()
    expect(viewed(chord.h)).toEqual(["src/app.rs"])
    const rebound = await started("The entry is src/app.rs:120.", { keybindings: { "alt+o": null, "ctrl+g": "file.open" } })
    await rebound.h.app.onKey(ALT_O)
    await settle()
    expect(viewed(rebound.h)).toEqual([])
    await rebound.h.app.onKey("\x07")
    await settle()
    expect(viewed(rebound.h)).toEqual(["src/app.rs"])
  })

  test("it is a rebindable action with a label, a default key and a chord, listed by /keymap", () => {
    const bindings = createBindings()
    expect(bindings.direct.get(ALT_O)).toEqual({ action: "file.open" })
    expect(bindings.leader.get(";")).toEqual({ action: "file.open" })
    const rows = keymapRows(bindings)
    const open = rows.find((row) => row.action === "file.open")
    expect(open?.label).toContain("open the file path")
    expect(open?.keys.map((key) => key.name)).toEqual(expect.arrayContaining(["alt+o", "ctrl+x ;"]))
    expect(rows.find((row) => row.action === "file.close")?.keys.map((key) => key.name)).toEqual(expect.arrayContaining(["alt+x", "ctrl+x -"]))
  })
})

describe("closing the file by key", () => {
  test("alt+x and ctrl+x - close the open file", async () => {
    for (const keys of [["\x1bx"], ["\x18", "-"]]) {
      const { h } = await started("The entry is src/app.rs:120.")
      await h.app.onKey(ALT_O)
      await settle()
      h.app.render()
      expect(frame(h)).toContain("‹ app.rs")
      for (const key of keys) await h.app.onKey(key)
      h.app.render()
      expect(frame(h)).not.toContain("‹ app.rs")
    }
  })
})
