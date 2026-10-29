import { afterEach, describe, expect, test } from "bun:test"
import type { ChangedFile, ChangesReport } from "@mendcode/protocol"
import { changesPageHits, changesPageKey, createChangesPageState, firstChangedLine, renderChangesPage } from "../src/view/changes-page"
import { cleanTemps, plain } from "./session-ui-harness"
import { chat, frame, press, release, rowOf, settle, slot } from "./file-viewer-helpers"

afterEach(cleanTemps)

const file = (path: string, diff: string, extra: Partial<ChangedFile> = {}): ChangedFile => ({ path, status: "modified", additions: 1, deletions: 0, binary: false, truncated: false, diff, ...extra })
const MODIFIED = "@@ -10,3 +10,4 @@\n     pub fn new() -> Self {\n-        // old\n+        // new\n+        // more\n     }"
const ONLY_DELETES = "@@ -20,4 +20,2 @@\n context\n-gone one\n-gone two\n context two"
const report = (files: ChangedFile[]): ChangesReport => ({ root: "/work", omittedFiles: 0, files }) as ChangesReport
// Each file has its own counts, so a region can be told apart even where the path is cut short.
const FILES = [
  file("src/app.rs", MODIFIED, { additions: 2, deletions: 1 }),
  file("DESIGN.md", ONLY_DELETES, { additions: 0, deletions: 2 }),
  file("src/files/link.rs", "@@ -0,0 +1,2 @@\n+one\n+two", { status: "added", additions: 2, deletions: 0 }),
  file("old.txt", "@@ -1,1 +0,0 @@\n-bye", { status: "deleted", additions: 0, deletions: 1 }),
]
const counts = (entry: ChangedFile) => ` +${entry.additions} −${entry.deletions}`

describe("the first changed line", () => {
  test("is the first added line, or where the deleted text was, and nothing for a diff without a change", () => {
    expect(firstChangedLine(FILES[0])).toBe(11)
    expect(firstChangedLine(FILES[1])).toBe(21)
    expect(firstChangedLine(FILES[2])).toBe(1)
    expect(firstChangedLine(file("bin.png", "", { binary: true }))).toBeUndefined()
    expect(firstChangedLine(file("same.txt", ""))).toBeUndefined()
    expect(firstChangedLine(undefined)).toBeUndefined()
  })
})

describe("the regions of the page", () => {
  for (const [width, height] of [[120, 24], [80, 20], [69, 20], [50, 18]] as const) {
    test(`every region lies on its own file at ${width}x${height}`, () => {
      const data = report(FILES)
      for (const focus of ["files", "diff"] as const) {
        for (const selected of [0, 2]) {
          const state = { ...createChangesPageState(), selected, focus }
          const lines = renderChangesPage({ report: data, state, width, height }).map(plain)
          const hits = changesPageHits({ report: data, state, width, height })
          expect(hits.length).toBeGreaterThan(0)
          for (const hit of hits) {
            const shown = lines[hit.row]!.slice(hit.from, hit.to)
            const entry = data.files[hit.file]!
            expect(shown).toContain(counts(entry))
            if (width >= 120) expect(shown).toContain(entry.path.length > 14 ? entry.path.slice(-8) : entry.path)
            expect(hit.to).toBeLessThanOrEqual(width)
          }
        }
      }
    })
  }

  test("a long list keeps the regions on the rows the list scrolled to", () => {
    const many = report(Array.from({ length: 30 }, (_, index) => file(`f${String(index).padStart(2, "0")}.ts`, "@@ -1 +1 @@\n-a\n+b")))
    const state = { ...createChangesPageState(), selected: 25 }
    const lines = renderChangesPage({ report: many, state, width: 100, height: 20 }).map(plain)
    const hits = changesPageHits({ report: many, state, width: 100, height: 20 })
    expect(hits.some((hit) => hit.file === 25)).toBe(true)
    for (const hit of hits) expect(lines[hit.row]!.slice(hit.from, hit.to)).toContain(many.files[hit.file]!.path)
  })

  test("a comment being typed, the comment list and a replay step have no regions", () => {
    const data = report(FILES)
    for (const patch of [{ mode: "compose" as const }, { mode: "list" as const }, { replay: true }]) {
      expect(changesPageHits({ report: data, state: { ...createChangesPageState(), ...patch }, width: 120, height: 24 })).toEqual([])
    }
    expect(changesPageHits({ report: report([]), state: createChangesPageState(), width: 120, height: 24 })).toEqual([])
  })
})

describe("the f key", () => {
  test("asks to open the selected file at its first change, and says so for a deleted file", () => {
    const data = report(FILES)
    expect(changesPageKey(createChangesPageState(), "f", data).action).toEqual({ type: "view", path: "src/app.rs", line: 11 })
    expect(changesPageKey({ ...createChangesPageState(), selected: 1 }, "f", data).action).toEqual({ type: "view", path: "DESIGN.md", line: 21 })
    const deleted = changesPageKey({ ...createChangesPageState(), selected: 3 }, "f", data)
    expect(deleted.action).toEqual({ type: "none" })
    expect(deleted.state.notice).toBe("deleted: no file to open")
  })

  test("is listed in the page's hints", () => {
    const text = renderChangesPage({ report: report(FILES), state: createChangesPageState(), width: 200, height: 24 }).map(plain).join("\n")
    expect(text).toContain("f view")
  })
})

describe("in the app", () => {
  const changes = () => (dir: string) => ({ ...report(FILES), root: dir })
  const open = async (width = 160) => {
    const ctx = await chat({ width, height: 40, text: "nothing to see here", changes: changes() })
    await ctx.h.type("/changes\r")
    await settle()
    ctx.h.app.render()
    return ctx
  }
  const read = (h: Awaited<ReturnType<typeof chat>>["h"]) => (h.sentOf("file.view") as Array<{ path: string; from?: number }>)

  test("a click on a file of the list opens it in the viewer at its first changed line, and the chat takes the page's place", async () => {
    const { h } = await open()
    expect(h.app.page).toBe("changes")
    const row = rowOf(h, "DESIGN.md")
    const col = h.text()[row]!.indexOf("DESIGN.md")
    await h.app.onKey(press(col, row))
    await h.app.onKey(release(col, row))
    await settle()
    h.app.render()
    expect(read(h).at(-1)?.path).toBe("DESIGN.md")
    expect(h.app.page).toBe("chat")
    expect(frame(h)).toContain("‹ DESIGN.md")
    // DESIGN.md has 40 lines: the window is around line 21, which is selected.
    expect(slot(h).join("\n")).toContain("21 design 21")
  })

  test("a click on the heading above the diff opens that file too", async () => {
    const { h } = await open()
    const row = h.text().findIndex((text, at) => at > 3 && text.lastIndexOf("src/app.rs") > 40)
    expect(row).toBeGreaterThan(0)
    const col = h.text()[row]!.lastIndexOf("src/app.rs")
    await h.app.onKey(press(col, row))
    await h.app.onKey(release(col, row))
    await settle()
    h.app.render()
    expect(read(h).at(-1)?.path).toBe("src/app.rs")
    expect(frame(h)).toContain("‹ app.rs")
  })

  test("a click elsewhere on the page does nothing, and a deleted file says so", async () => {
    const { h } = await open()
    await h.app.onKey(press(100, 30))
    await h.app.onKey(release(100, 30))
    await settle()
    expect(read(h)).toEqual([])
    expect(h.app.page).toBe("changes")
    const row = rowOf(h, "old.txt")
    const col = h.text()[row]!.indexOf("old.txt")
    await h.app.onKey(press(col, row))
    await h.app.onKey(release(col, row))
    await settle()
    h.app.render()
    expect(read(h)).toEqual([])
    expect(frame(h)).toContain("deleted: no file to open")
  })

  test("f opens the selected file and the arrows keep working as before", async () => {
    const { h } = await open()
    await h.app.onKey("\x1b[B")
    h.app.render()
    await h.app.onKey("f")
    await settle()
    h.app.render()
    expect(read(h).at(-1)?.path).toBe("DESIGN.md")
    expect(h.app.page).toBe("chat")
  })

  test("on a narrow terminal the click opens the file as a page", async () => {
    const { h } = await open(70)
    const row = rowOf(h, "src/app.rs")
    const col = h.text()[row]!.indexOf("src/app.rs")
    await h.app.onKey(press(col, row))
    await h.app.onKey(release(col, row))
    await settle()
    h.app.render()
    expect(read(h).at(-1)?.path).toBe("src/app.rs")
    expect(frame(h)).toContain("‹ app.rs")
  })
})
