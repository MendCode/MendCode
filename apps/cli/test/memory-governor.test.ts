import { describe, expect, test } from "bun:test"
import { createMemoryGovernor, FRAMES_PER_COLLECTION, framesPerCollection } from "../src/ui/memory-governor"
import { createScreen } from "../src/ui/screen"
import { cells, takeCells } from "../src/view/wrap"

describe("memory governor", () => {
  test("collects once every N frames and starts counting again", () => {
    let collections = 0
    const governor = createMemoryGovernor({ every: 3, collect: () => void collections++ })
    for (let i = 0; i < 9; i++) governor.frame()
    expect(collections).toBe(3)
    governor.frame()
    governor.frame()
    expect(collections).toBe(3)
    governor.frame()
    expect(collections).toBe(4)
  })

  test("a collection that takes long on a big heap pushes the next one out in proportion, and a cheap one keeps the interval", () => {
    const cost = [2, 40, 3, 4, 5]
    let clock = 0
    let collections = 0
    const governor = createMemoryGovernor({ every: 8, now: () => clock, collect: () => { clock += cost[collections++] ?? 1 } })
    const frameAt = new Map<number, number>()
    for (let frame = 1; frame <= 120; frame++) {
      const before = collections
      governor.frame()
      if (collections > before) frameAt.set(collections, frame)
    }
    // 2 ms: every 8 frames. 40 ms: ten times the interval (80 frames) before the next. Then 3 ms and 4 ms are within the budget again.
    expect([...frameAt.values()]).toEqual([8, 16, 96, 104, 112])
  })

  test("a collection that costs 250 ms leaves the next 400 frames without another", () => {
    let clock = 0
    let collections = 0
    const governor = createMemoryGovernor({ every: 8, now: () => clock, collect: () => { collections++; clock += 250 } })
    for (let frame = 0; frame < 400; frame++) governor.frame()
    expect(collections).toBe(1)
  })

  test("0 frames turns it off", () => {
    let collections = 0
    const governor = createMemoryGovernor({ every: 0, collect: () => void collections++ })
    for (let i = 0; i < 100; i++) governor.frame()
    expect(collections).toBe(0)
  })

  test("MENDCODE_GC_FRAMES reads a whole number and falls back to the default for anything else", () => {
    expect(framesPerCollection({})).toBe(FRAMES_PER_COLLECTION)
    expect(framesPerCollection({ MENDCODE_GC_FRAMES: "16" })).toBe(16)
    expect(framesPerCollection({ MENDCODE_GC_FRAMES: "0" })).toBe(0)
    for (const bad of ["", "-1", "1.5", "many", "99999"]) expect(framesPerCollection({ MENDCODE_GC_FRAMES: bad })).toBe(FRAMES_PER_COLLECTION)
  })

  test("the screen asks for a collection after every Nth drawn frame, in both modes", () => {
    for (const inline of [false, true]) {
      let collections = 0
      const screen = createScreen({ columns: 20, rows: 4, write: () => undefined }, { MENDCODE_GC_FRAMES: "4", MENDCODE_MOUSE: "0" }, { inline, collectGarbage: () => void collections++ })
      for (let i = 0; i < 10; i++) screen.draw([[{ text: `frame ${i}` }]])
      expect(collections).toBe(2)
    }
  })
})

/** The cut the screen used to make cell by cell: the reference `takeCells` has to match. */
function reference(text: string, room: number) {
  let out = ""
  let width = 0
  for (const cell of cells(text)) {
    if (cell.text === "\n") continue
    if (width + cell.width > room) break
    out += cell.text
    width += cell.width
  }
  return { text: out, width }
}

describe("takeCells", () => {
  const samples = [
    "",
    "plain ascii text",
    "box ─── drawing │ and ‹accents› é ü",
    "中文 wide cells and ascii",
    "✅ done ⚠️ warn 👍🏽 ok 👨‍👩‍👧 family 🇵🇦",
    "tab\tinside and a\nnewline",
    "\x1b[31mred\x1b[0m escape",
    "é combining mark",
    "line one\n",
  ]

  test("cuts at the same cell the cell-by-cell walk did, for every room", () => {
    for (const text of samples) for (let room = -1; room <= 40; room++) expect(takeCells(text, room)).toEqual(reference(text, room))
  })

  test("a wide cell that does not fit stops the cut, even when a narrower one would", () => {
    expect(takeCells("a中b", 2)).toEqual({ text: "a", width: 1 })
    expect(takeCells("a中b", 3)).toEqual({ text: "a中", width: 3 })
  })
})
