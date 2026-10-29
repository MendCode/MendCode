import { describe, expect, test } from "bun:test"
import type { Line } from "../src/ui/theme"
import { ATOM_ELECTRONS, atomAnimating, atomElectrons, renderAtom, type AtomItem } from "../src/view/panel-atom"
import { textWidth } from "../src/view/wrap"

/** The Atom card: what is running right now, one orbit per kind of work and one electron per running item. */
const plain = (line: Line) => line.map((span) => span.text).join("")
const items: AtomItem[] = [{ kind: "tool", label: "read src/panel.ts" }, { kind: "tool", label: "grep orbit" }, { kind: "agent", label: "Finish the rename" }, { kind: "job", label: "bun test --watch" }]
const draw = (options: Partial<Parameters<typeof renderAtom>[0]> = {}) => renderAtom({ items, width: 48, height: 15, now: 1_300, running: true, ...options })
const glyphCount = (rows: Line[], glyph: string) => rows.slice(0, -4).map(plain).join("").split(glyph).length - 1

describe("the Atom card", () => {
  test("every row is exactly the card's width and the card never exceeds its height", () => {
    for (const [width, height] of [[48, 15], [56, 20], [30, 9], [20, 8], [16, 6], [12, 3], [80, 40]] as const) {
      const rows = draw({ width, height })
      expect(rows.length).toBeLessThanOrEqual(height)
      for (const row of rows) expect(textWidth(plain(row))).toBe(width)
    }
    expect(draw({ height: 0 })).toEqual([])
  })

  test("one electron per running item on its own orbit, and the counts say the same", () => {
    const rows = draw()
    expect(glyphCount(rows, "✦")).toBe(2)
    expect(glyphCount(rows, "◆")).toBe(1)
    expect(glyphCount(rows, "▣")).toBe(1)
    expect(rows.map(plain).join("\n")).toContain("✦ 2 tools · ◆ 1 agent · ▣ 1 job")
    expect(rows.map(plain).join("\n")).toContain("✦ read src/panel.ts")
  })

  test("an idle session is a bare nucleus with muted counts and one line that says so", () => {
    const rows = draw({ items: [], running: false })
    const text = rows.map(plain).join("\n")
    expect(text).toContain("○")
    expect(text).toContain("✦ 0 tools · ◆ 0 agents · ▣ 0 jobs")
    expect(text).toContain("Idle, nothing running")
    expect(rows.at(-2)!.filter((span) => span.text.trim()).every((span) => span.fg === "muted")).toBe(true)
    // A turn that is only thinking has a lit nucleus and says nothing else runs.
    expect(draw({ items: [], running: true }).map(plain).join("\n")).toContain("Thinking, nothing else running")
  })

  test("more items than rows: the last row counts the rest; more than an orbit holds: the orbit is capped", () => {
    const many: AtomItem[] = Array.from({ length: 20 }, (_, index) => ({ kind: "job", label: `job ${index}` }))
    const rows = draw({ items: many })
    expect(plain(rows.at(-1)!).trim()).toBe("+18 more")
    expect(glyphCount(rows, "▣")).toBeLessThanOrEqual(ATOM_ELECTRONS)
    expect(atomElectrons("job", 20, 0)).toHaveLength(ATOM_ELECTRONS)
    expect(atomElectrons("job", 0, 0)).toEqual([])
  })

  test("electrons move with the clock and stand still under reduced motion", () => {
    expect(draw({ now: 0 }).map(plain)).not.toEqual(draw({ now: 2_000 }).map(plain))
    expect(draw({ now: 0, reduced: true }).map(plain)).toEqual(draw({ now: 2_000, reduced: true }).map(plain))
    expect(atomAnimating(true, 1, false)).toBe(true)
    expect(atomAnimating(true, 0, false)).toBe(false)
    expect(atomAnimating(true, 3, true)).toBe(false)
    expect(atomAnimating(false, 3, false)).toBe(false)
  })

  test("a card too short for the drawing lists the counts and the names", () => {
    const rows = draw({ height: 6, width: 34 }).map(plain)
    expect(rows[0]!.trim()).toBe("✦ 2 tools · ◆ 1 agent · ▣ 1 job")
    expect(rows).toHaveLength(5)
    expect(rows.join("")).not.toMatch(/[⠁-⣿]/)
  })

  test("ascii mode draws only ASCII and a control character in a name never reaches the screen", () => {
    const rows = draw({ ascii: true, items: [{ kind: "tool", label: "read\x1b[31m é.ts" }] }).map(plain)
    for (const row of rows) expect(row).toMatch(/^[\x20-\x7e]*$/)
    expect(rows.join("\n")).toContain("T 1 tool | A 0 agents | J 0 jobs")
    expect(draw({ items: [{ kind: "tool", label: "a\x1b[2Jb" }] }).map(plain).join("")).not.toContain("\x1b")
  })
})
