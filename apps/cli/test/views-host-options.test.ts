import { describe, expect, test } from "bun:test"
import type { ApprovalModel } from "@mendcode/extension-api/views"
import { HOST_OPTIONS_ROW, VIEW_SLOTS } from "@mendcode/extension-api/views"
import { glyphs, type Line } from "../src/ui/theme"
import { approvalOptionRows, approvalOptions } from "../src/view/request-panel"
import { createViewHost, composeHostBlock, type CustomViews } from "../src/view/views"
import { rebase, secure, validArgFor } from "../src/view/view-safety"

/** The host owns the option rows of `approval` and `question`: a custom view cannot make hit regions for them or draw on them. */

const text = (rows: readonly Line[]) => rows.map((row) => row.map((span) => span.text).join(""))
const row = (value: string): Line => [{ text: value }]
const options = approvalOptions("shell")
const model: ApprovalModel = { requestId: "r1", variant: "panel", title: "shell", tool: "shell", permission: "execute", subject: "rm -rf build", detail: [], options, choice: 0, hint: "", plan: false }

describe("approval and question have no actions of their own", () => {
  test("the closed action set is empty and no arg is valid, so a view cannot name an option", () => {
    for (const slot of ["approval", "question"] as const) {
      expect(VIEW_SLOTS[slot].actions).toEqual([])
      expect(VIEW_SLOTS[slot].hostOptions).toBe(true)
      for (const action of ["choose", "tab"]) expect(validArgFor(slot, model, action, 0)).toBe(false)
    }
  })
})

describe("composeHostBlock", () => {
  const block = { rows: [row("[1 Allow once]"), row("[2 Reject]")], hits: [{ row: 0, from: 0, to: 20, action: "choose", arg: 0 }, { row: 1, from: 0, to: 20, action: "choose", arg: 1 }] }

  test("the block replaces the {options} row, its hits land on its rows, and the view's own regions are never carried", () => {
    const composed = composeHostBlock([row("title"), row(` ${HOST_OPTIONS_ROW} `), row("hint")], block, 10)
    expect(text(composed.lines)).toEqual(["title", "[1 Allow once]", "[2 Reject]", "hint"])
    expect(composed.hits).toEqual([{ row: 1, from: 0, to: 20, action: "choose", arg: 0 }, { row: 2, from: 0, to: 20, action: "choose", arg: 1 }])
  })

  test("without a placeholder the block goes under the view; with several only the first is the block", () => {
    expect(text(composeHostBlock([row("a"), row("b")], block, 10).lines)).toEqual(["a", "b", "[1 Allow once]", "[2 Reject]"])
    expect(text(composeHostBlock([row("{options}"), row("{options}")], block, 10).lines)).toEqual(["[1 Allow once]", "[2 Reject]", "{options}"])
  })

  test("a short screen cuts the view's rows, never the block", () => {
    const tall = Array.from({ length: 30 }, (_, index) => row(`view ${index}`))
    const composed = composeHostBlock([...tall.slice(0, 3), row("{options}"), ...tall.slice(3)], block, 6)
    expect(composed.lines).toHaveLength(6)
    expect(text(composed.lines)).toEqual(["view 0", "view 1", "view 2", "[1 Allow once]", "[2 Reject]", "view 3"])
    expect(composed.hits.map((hit) => hit.row)).toEqual([3, 4])
    const none = composeHostBlock(tall, block, 2)
    expect(text(none.lines)).toEqual(["[1 Allow once]", "[2 Reject]"])
    expect(none.hits.map((hit) => hit.row)).toEqual([0, 1])
  })
})

describe("hit regions follow their rows when the terminal inserts rows", () => {
  test("the subject the terminal puts first moves the view's regions down by the rows it added, and drops the ones it cut", () => {
    const view = Array.from({ length: 6 }, (_, index) => row(`row ${index}`))
    const secured = secure("approval", model, view, { height: 8, width: 60 }, glyphs())
    expect(secured.offset).toBeGreaterThan(0)
    expect(text(secured.lines.slice(secured.offset, secured.offset + 3))).toEqual(["row 0", "row 1", "row 2"])
    const hits = rebase([{ row: 0, tag: "first" }, { row: 2, tag: "third" }, { row: 5, tag: "last" }], secured)
    for (const hit of hits) expect(text([secured.lines[hit.row]!])[0]).toBe(`row ${{ first: 0, third: 2, last: 5 }[hit.tag as "first"]}`)
    const full = secure("approval", model, Array.from({ length: 12 }, (_, index) => row(`row ${index}`)), { height: 8, width: 60 }, glyphs())
    expect(full.kept).toBeLessThan(12)
    expect(rebase([{ row: 11 }], full)).toEqual([])
  })

  test("a view that already shows the subject needs no rows and keeps its regions where they are", () => {
    const secured = secure("approval", model, [row("run: rm -rf build"), row("more")], { height: 8, width: 60 }, glyphs())
    expect(secured).toMatchObject({ offset: 0, kept: 2 })
    expect(rebase([{ row: 1 }], secured)).toEqual([{ row: 1 }])
  })

  test("a page that is full gets its escape hint in place of the last row, and a region on that row is dropped", () => {
    const secured = secure("page", {}, [row("a"), row("b"), row("c")], { height: 3, width: 30 }, glyphs())
    expect(text(secured.lines)).toEqual(["a", "b", "esc back"])
    expect(rebase([{ row: 1 }, { row: 2 }], secured)).toEqual([{ row: 1 }])
  })
})

describe("the host draws the option block under a custom view", () => {
  const fakeRuntime = (lines: Line[]): CustomViews => ({ has: (slot) => slot === "approval", call: () => ({ lines, hits: [{ row: 0, from: 0, to: 9, action: "choose", arg: 0 }] }) })

  test("the drawn approval has the terminal's option rows and only their click regions, whatever the view returned", () => {
    const host = createViewHost({ glyphs: glyphs(), custom: () => fakeRuntime([row("Reject"), row("Allow once"), row("rm -rf build")]) })
    const drawn = host.draw("approval", model, { width: 80, height: 20 })
    expect(drawn.custom).toBe(true)
    const rows = text(drawn.lines)
    const block = approvalOptionRows({ width: 80, choices: options, choice: 0 })
    // Every hit is on a row of the terminal's block and names the option whose label that row shows.
    expect(drawn.hits).toHaveLength(options.length)
    for (const hit of drawn.hits) {
      expect(hit.action).toBe("choose")
      expect(rows[hit.row]).toContain(options[hit.arg as number]!.label)
    }
    expect(drawn.lines.slice(-block.rows.length).map((line) => line.map((span) => span.text).join(""))).toEqual(text(block.rows))
  })
})
