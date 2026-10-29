import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { createIdFactory, parseRenderSpec, type RenderNode, type SessionEvent } from "@mendcode/protocol"
import { glyphs, type Line } from "../src/ui/theme"
import { CODE_MAP, renderCodeMap, savedLabel, uniquePaths, type CodeMapInput } from "../src/view/code-map"
import { graftTraceMap, graftTraceRender } from "../src/view/graft-map"
import { renderSpecLines } from "../src/view/render-spec"
import { renderToolCard } from "../src/view/tool-card"
import { createTranscript, type PresentationMode } from "../src/view/transcript"
import { textWidth } from "../src/view/wrap"

const plain = (line: Line) => line.map((span) => span.text).join("")
const draw = (input: Partial<CodeMapInput> & { width: number }) => renderCodeMap({ ...fixture, ...input }).map(plain)
const spansOf = (input: Partial<CodeMapInput> & { width: number }) => renderCodeMap({ ...fixture, ...input }).flat()

const entry = (label: string, file: string, line: number, depth?: number, via?: string) => ({ label, file, line, kind: "function", ...(depth ? { depth } : {}), ...(via ? { via } : {}) })

/** Direct hops first and deeper ones after them, as graph_callers lists them; `via` names the entry each was reached through. */
const fixture: CodeMapInput = {
  width: 100,
  center: { label: "renderToolCard", file: "apps/cli/src/view/tool-card.ts", line: 237, kind: "function" },
  left: {
    title: "callers",
    flow: "in",
    entries: [
      entry("defaultBody", "apps/cli/src/view/transcript.ts", 399, 1),
      entry("chatView", "apps/cli/src/view/transcript.ts", 700, 1),
      entry("toolCardTest", "apps/cli/test/chat-transcript.test.ts", 7, 1),
      entry("recallTest", "apps/cli/test/tool-card-sessions.test.ts", 2, 1),
      entry("rowsOf", "apps/cli/src/view/transcript.ts", 520, 2, "defaultBody"),
      entry("layout", "apps/cli/src/ui/app/render.ts", 40, 2, "chatView"),
      entry("frame", "apps/cli/src/ui/app/render.ts", 90, 3, "layout"),
    ],
  },
  right: {
    title: "callees",
    flow: "out",
    entries: [
      entry("cardRows", "apps/cli/src/view/tool-card.ts", 254, 1),
      entry("parseToolTitle", "apps/cli/src/view/tool-card.ts", 101, 1),
      entry("parseDiff", "apps/cli/src/view/tool-card.ts", 131, 1),
      entry("computerCard", "apps/cli/src/view/computer-card.ts", 7, 2, "cardRows"),
      entry("wrapSpans", "apps/cli/src/view/markdown.ts", 600, 2, "cardRows"),
      entry("renderSpecLines", "apps/cli/src/view/render-spec.ts", 19, 2, "parseToolTitle"),
      entry("sessionRecallCard", "apps/cli/src/view/session-recall-card.ts", 6, 2, "parseToolTitle"),
      entry("diffBlocks", "apps/cli/src/view/tool-card.ts", 347, 2, "cardRows"),
      entry("outputLines", "apps/cli/src/view/tool-card.ts", 229, 2, "parseDiff"),
      entry("parsePatch", "apps/cli/src/view/tool-card.ts", 161, 3, "outputLines"),
    ],
    more: 6,
  },
}

/** The box's inner rows, without the frame: what sits between `│ ` and ` │`. */
const inner = (rows: string[]) => rows.slice(1, -1).map((row) => row.slice(2, -2))
/** The status set into the bottom edge: what sits between `└` (or `+`) and the run of `─` that closes it. */
const footerOf = (rows: string[]) => rows.at(-1)!.slice(1).replace(/[─-]+[┘+]$/, "")

describe("call map layout", () => {
  for (const width of [24, 40, 60, 69, 70, 100, 132, 180]) {
    test(`at ${width} columns every row has the same width and none exceeds it, collapsed and expanded`, () => {
      for (const expanded of [false, true]) {
        const rows = draw({ width, expanded })
        const first = textWidth(rows[0]!)
        expect(first).toBeLessThanOrEqual(width)
        for (const row of rows) expect(textWidth(row)).toBe(first)
        expect(rows.join("\n")).toContain("renderTo")
      }
    })
  }

  test("the box fits its content: narrower than the room, wide enough for the title", () => {
    const rows = draw({ width: 180 })
    expect(textWidth(rows[0]!)).toBeLessThan(180)
    const small = draw({
      width: 180,
      center: { label: "f", file: "a.ts", line: 1 },
      left: { title: "callers", entries: [{ label: "g", file: "a.ts", line: 9 }], flow: "in" },
      right: { title: "callees", entries: [{ label: "h", file: "a.ts", line: 20 }], flow: "out" },
    })
    expect(small[0]).toBe(`┌f · 1 caller · 1 callee${"─".repeat(textWidth(small[0]!) - 25)}┐`)
    expect(textWidth(small[0]!)).toBeLessThan(60)
    for (const row of small) expect(textWidth(row)).toBe(textWidth(small[0]!))
    expect(draw({ width: 100 }).every((row) => textWidth(row) <= 100)).toBe(true)
  })

  test("100 columns: v1's frame, callers left, the centre diamond in the middle, callees right, joined by dotted links", () => {
    const rows = draw({ width: 100 })
    // The title is set into the top edge and the status into the bottom one, as v1's graph frame did.
    expect(rows[0]).toMatch(/^┌renderToolCard · 7 callers · 16 callees─+┐$/)
    expect(rows.at(-1)).toMatch(/^└\+1 caller · \+10 callees · ctrl\+o─+┘$/)
    const centre = rows.find((row) => row.includes("◆ renderToolCard"))!
    expect(centre).toMatch(/◇[⠀-⣿]+◆ renderToolCard [⠀-⣿]+/)
    expect(rows.join("\n")).toMatch(/◇ cardRows\s+:254/)
    expect(rows.join("\n")).toMatch(/defaultBody\s+transcript:399\s+◇/)
    expect(rows.join("\n")).toContain("tool-card:237")
    // No box-drawing rail inside the box: the links are braille dots, no tree joints and no arrows.
    for (const row of inner(rows)) expect(row).not.toMatch(/[─┬┼├┤┐┘▶]/)
    for (const row of rows) expect(row).not.toContain("\x1b")
  })

  test("every direct neighbour has its own dotted link to the centre; links stay inside the space between the nodes", () => {
    const rows = draw({ width: 132, expanded: true })
    const centre = rows.findIndex((row) => row.includes("◆ renderToolCard"))
    const diamond = Array.from(rows[centre]!).indexOf("◆")
    const leftNodes = rows.flatMap((row, y) => (/ ◇[⠀-⣿]/.test(row) ? [y] : []))
    expect(leftNodes).toHaveLength(4)
    // A link leaves each caller's diamond and arrives at the centre's: the cell before the centre diamond carries dots.
    expect(Array.from(rows[centre]!)[diamond - 1]).toMatch(/[⠁-⣿]/)
    for (const y of leftNodes) {
      const cells = Array.from(rows[y]!)
      expect(cells[cells.indexOf("◇") + 1]).toMatch(/[⠁-⣿]/)
    }
    const rightNodes = rows.filter((row) => /[⠀-⣿]◇ /.test(row))
    expect(rightNodes).toHaveLength(3)
  })

  test("the centre node is the accent, bold one; callers and callees are plain text with a muted file:line", () => {
    const spans = spansOf({ width: 132 })
    expect(spans.find((span) => span.text === "◆ ")).toMatchObject({ fg: "accent", bold: true })
    expect(spans.find((span) => span.fg === "accent" && span.text.includes("renderToolCard"))).toMatchObject({ bold: true })
    expect(spans.find((span) => span.text === "defaultBody")).toMatchObject({ fg: "text" })
    expect(spans.find((span) => span.text === "defaultBody")?.bold).toBeUndefined()
    expect(spans.find((span) => span.text.startsWith("transcript:399"))).toMatchObject({ fg: "muted", dim: true })
    expect(spans.find((span) => span.text.includes("tool-card:237"))).toMatchObject({ fg: "muted", dim: true })
    // Only the centre is accent text; the connectors' arrowheads are the other accent marks.
    expect(spans.filter((span) => span.fg === "accent" && /[a-z]/i.test(span.text)).every((span) => span.text.includes("renderToolCard"))).toBe(true)
  })

  test("100 columns give callers their complete suffixes before callees' shorter suffixes", () => {
    const rows = draw({ width: 100 })
    for (const [name, suffix] of [["defaultBody", "transcript:399"], ["toolCardTest", "chat-transcript.test:7"], ["recallTest", "tool-card-sessions.test:2"]]) {
      expect(rows.find((row) => row.includes(name!))).toContain(suffix!)
    }
    const locations = rows.filter((row) => /defaultBody|toolCardTest|recallTest/.test(row)).map((row) => row.search(/transcript:399|chat-transcript.test:7|tool-card-sessions.test:2/))
    expect(new Set(locations).size).toBe(1)
  })

  test("a short callee column stays content-sized and leaves room for caller locations", () => {
    const rows = draw({
      width: 100,
      center: { label: "run", file: "run.ts", line: 1 },
      left: { title: "callers", entries: [entry("start", "caller.ts", 2), entry("stop", "caller.ts", 3)] },
      right: { title: "callees", entries: [entry("f", "run.ts", 4)] },
    })
    expect(rows.join("\n")).toMatch(/start\s+caller:2/)
    expect(rows.join("\n")).toMatch(/stop\s+caller:3/)
    expect(textWidth(rows[0]!)).toBeLessThan(60)
    expect(rows.join("\n")).toMatch(/[⠀-⣿]◇ f\s+:4 │/)
  })

  test("single direct neighbours sit level with the centre on a short dotted link, including hanging descendants and ASCII", () => {
    for (const ascii of [false, true]) {
      const rows = draw({
        width: 100, ascii,
        center: { label: "run", file: "run.ts", line: 1 },
        left: { title: "callers", entries: [entry("start", "caller.ts", 2), entry("parent", "caller.ts", 3, 2, "start")] },
        right: { title: "callees", entries: [entry("child", "run.ts", 4), entry("leaf", "run.ts", 5, 2, "child")] },
      })
      const center = rows.find((row) => row.includes(ascii ? "@ run" : "◆ run"))!
      expect(center).toMatch(ascii ? /start\s+caller:2 o\.+@ run \.*o child/ : /start\s+caller:2 ◇⠒+◆ run [⠀-⣿]*◇ child/)
      expect(rows.join("\n")).toContain(ascii ? "` parent" : "⠣ parent")
      expect(new Set(rows.map(textWidth)).size).toBe(1)
    }
  })

  test("names are column-aligned and each file is a muted suffix: the file without its extension, a bare line in the centre's own file", () => {
    const rows = draw({ width: 132, expanded: true })
    const starts = rows.flatMap((row) => {
      const found = /^│ (defaultBody|chatView|toolCardTest|recallTest)\s+(\S+)/.exec(row)
      return found ? [row.indexOf(found[2]!)] : []
    })
    expect(starts).toHaveLength(4)
    expect(new Set(starts).size).toBe(1)
    const text = rows.join("\n")
    expect(text).toContain("transcript:399")
    expect(text).toContain("chat-transcript.test:7")
    expect(text).not.toContain(".ts")
    expect(text).not.toContain("apps/cli")
    expect(text).not.toContain("▾")
    expect(text).toMatch(/cardRows\s+:254/)
    expect(text).not.toContain("tool-card:254")
    expect(text).toMatch(/computerCard\s+computer-card:7/)
  })

  test("files that share a name get the fewest parent directories that tell them apart, and only then", () => {
    const paths = uniquePaths(["a/index.ts", "b/index.ts", "c/x.ts", "a/deep/y.ts", "b/deep/y.ts", "p/z.ts", "p/z.js", ""])
    expect(paths.get("a/index.ts")).toBe("a/index")
    expect(paths.get("b/index.ts")).toBe("b/index")
    expect(paths.get("c/x.ts")).toBe("x")
    expect(paths.get("a/deep/y.ts")).toBe("a/deep/y")
    expect(paths.get("b/deep/y.ts")).toBe("b/deep/y")
    expect(paths.get("p/z.ts")).toBe("z.ts")
    expect(paths.get("p/z.js")).toBe("z.js")
    expect(paths.has("")).toBe(false)
    expect(uniquePaths(["src/view/render.ts", "src/ui/render.ts", "src/view/deck.ts"])).toEqual(new Map([["src/view/render.ts", "view/render"], ["src/ui/render.ts", "ui/render"], ["src/view/deck.ts", "deck"]]))
    const text = draw({
      width: 100,
      center: { label: "run", file: "x/run.ts", line: 1 },
      left: { title: "callers", flow: "in", entries: [{ label: "one", file: "a/index.ts", line: 2 }, { label: "two", file: "b/index.ts", line: 3 }, { label: "three", file: "c/other.ts", line: 4 }] },
      right: { title: "callees", entries: [], flow: "out" },
    }).join("\n")
    expect(text).toMatch(/one\s+a\/index:2/)
    expect(text).toMatch(/two\s+b\/index:3/)
    expect(text).toMatch(/three\s+other:4/)
  })

  test("a file name is never cut: a row that does not fit loses its suffix, and names are cut only as a last resort", () => {
    const labels = new Set([...uniquePaths([fixture.center, ...fixture.left.entries, ...fixture.right.entries].map((item) => item.file!)).values()])
    for (const width of [70, 74, 80, 88, 95, 100, 110, 132]) {
      for (const expanded of [false, true]) {
        const rows = draw({ width, expanded })
        expect(rows.join("\n")).not.toContain("…")
        for (const row of rows) {
          for (const found of row.matchAll(/(\S*):(\d+)/g)) if (found[1] !== "") expect(labels.has(found[1]!)).toBe(true)
        }
        expect(rows.join("\n")).toContain("renderToolCard")
        for (const name of ["defaultBody", "chatView", "toolCardTest", "recallTest", "cardRows", "parseToolTitle", "parseDiff"]) expect(rows.join("\n")).toContain(name)
      }
    }
    // Tight enough that the callers' long suffixes go, yet every shown name is whole.
    const tight = draw({ width: 70 }).join("\n")
    expect(tight).toContain("renderSpecLines")
    expect(tight).not.toContain("transcript:399")
    expect(tight).not.toContain("tool-card-sessions.test:2")
    // When even the names do not fit the last resort cuts a name, not a file.
    const cramped = draw({ width: 70, left: { title: "callers", flow: "in", entries: [entry("n".repeat(60), "a/b.ts", 4)] } }).join("\n")
    expect(cramped).toContain("…")
    expect(cramped).not.toContain("b:4")
  })

  test("callees mirror callers: centred on the centre's row, diamonds in one column, names in one column", () => {
    const rows = draw({ width: 132, expanded: true })
    const centre = rows.findIndex((row) => row.includes("◆ renderToolCard"))
    const at = (name: string) => rows.findIndex((row) => row.includes(` ${name}`))
    const callees = ["cardRows", "parseToolTitle", "parseDiff"].map(at)
    expect(callees[0]!).toBeLessThan(centre)
    expect(callees[2]!).toBeGreaterThan(centre)
    const column = (name: string) => Array.from(rows[at(name)]!).indexOf(name[0]!, Array.from(rows[at(name)]!).lastIndexOf("◇"))
    expect(new Set(["cardRows", "parseToolTitle", "parseDiff"].map((name) => Array.from(rows[at(name)]!).lastIndexOf("◇"))).size).toBe(1)
    expect(new Set(["cardRows", "parseToolTitle", "parseDiff"].map(column)).size).toBe(1)
    expect(new Set(["defaultBody", "chatView", "toolCardTest", "recallTest"].map((name) => Array.from(rows[at(name)]!).indexOf("◇"))).size).toBe(1)
  })

  test("a deeper hop is indented right under the entry it was reached through, with a dotted hook, never a dN label", () => {
    const rows = draw({ width: 132, expanded: true })
    const text = rows.join("\n")
    expect(text).not.toMatch(/\bd[1-9]\b/)
    expect(text).not.toContain("dN")
    const at = (name: string) => rows.findIndex((row) => row.includes(name))
    const mark = (name: string) => rows[at(name)]!.indexOf(`⠣ ${name}`)
    const start = (name: string) => rows[at(name)]!.indexOf(name)
    // Callers: rowsOf calls defaultBody, layout calls chatView, frame calls layout.
    expect(at("rowsOf")).toBe(at("defaultBody") + 1)
    expect(at("layout")).toBe(at("chatView") + 1)
    expect(at("frame")).toBe(at("layout") + 1)
    expect(mark("rowsOf")).toBe(start("defaultBody"))
    expect(mark("frame")).toBe(mark("layout") + 2)
    expect(at("toolCardTest")).toBeGreaterThan(at("frame"))
    // Callees: each child follows its own parent, not the end of the list.
    expect(at("computerCard")).toBeGreaterThan(at("cardRows"))
    expect(at("computerCard")).toBeLessThan(at("parseToolTitle"))
    expect(at("renderSpecLines")).toBeGreaterThan(at("parseToolTitle"))
    expect(at("renderSpecLines")).toBeLessThan(at("parseDiff"))
    expect(at("outputLines")).toBe(at("parseDiff") + 1)
    expect(at("parsePatch")).toBe(at("outputLines") + 1)
    expect(mark("parsePatch")).toBe(mark("outputLines") + 2)
    expect(mark("computerCard")).toBe(start("cardRows"))
    // Hanging rows are not joined to the centre: they carry no diamond of their own.
    expect(rows[at("rowsOf")]).toMatch(/rowsOf\s+transcript:520 {3}/)
    expect(rows[at("computerCard")]).toMatch(/ {3}⠣ computerCard/)
  })

  test("an entry whose parent is not shown is counted in the footer, never drawn under the wrong one", () => {
    const side = (entries: CodeMapInput["right"]["entries"], more = 0) => ({ title: "callees", flow: "out" as const, entries, more })
    const orphan = draw({ width: 132, expanded: true, left: { title: "", entries: [] }, right: side([entry("kid", "a/k.ts", 1), entry("lost", "a/l.ts", 2, 2, "nobody")]) })
    expect(orphan.join("\n")).toContain("kid")
    expect(orphan.join("\n")).not.toContain("lost")
    expect(footerOf(orphan)).toBe("+1 callee")
    // A child is drawn only when its parent is: seven direct hops fill the preview, so the 7th's child waits for ctrl+o.
    const roots = Array.from({ length: 7 }, (_, i) => entry(`root${i}`, "a/r.ts", i + 1))
    const many = side([...roots, entry("child", "a/c.ts", 9, 2, "root6")])
    const collapsed = draw({ width: 132, left: { title: "", entries: [] }, right: many })
    expect(collapsed.join("\n")).not.toContain("child")
    expect(collapsed.join("\n")).not.toContain("root6")
    expect(footerOf(collapsed)).toBe("+2 callees · ctrl+o")
    const expanded = draw({ width: 132, expanded: true, left: { title: "", entries: [] }, right: many })
    const rows = expanded
    expect(rows.findIndex((row) => row.includes("child"))).toBe(rows.findIndex((row) => row.includes("root6")) + 1)
    // Without a via, a deeper entry hangs under the nearest shallower entry before it (graft lists a hop right after the one it came from).
    const graft = draw({ width: 132, expanded: true, left: { title: "", entries: [] }, right: side([entry("a", "x/a.ts", 1), entry("b", "x/b.ts", 2), entry("deep", "x/d.ts", 3, 2)]) })
    expect(graft.findIndex((row) => row.includes("deep"))).toBe(graft.findIndex((row) => row.includes("◇ b")) + 1)
    // Several entries under one name: the via names the hop-1 parent; a deeper entry never lands under a sibling at its own depth.
    const same = draw({ width: 132, expanded: true, left: { title: "", entries: [] }, right: side([entry("p", "x/p.ts", 1), entry("q", "x/q.ts", 2), entry("kid", "x/k.ts", 3, 2, "q")]) })
    expect(same.findIndex((row) => row.includes("kid"))).toBe(same.findIndex((row) => row.includes("◇ q")) + 1)
  })

  test("the bottom edge carries the hidden counts, then ctrl+o, right under the last row", () => {
    const rows = draw({ width: 100 })
    expect(footerOf(rows)).toBe("+1 caller · +10 callees · ctrl+o")
    expect(inner(rows).at(-1)!.trim()).not.toBe("")
    expect(rows.filter((row) => row.includes("ctrl+o"))).toHaveLength(1)
    expect(rows.join("\n")).not.toContain("ctrl+o expands")
    expect(rows.join("\n")).not.toContain("callers 7")
  })

  test("expanded shows every row, leaves only what the tool left out, and offers to collapse", () => {
    const collapsed = draw({ width: 132 })
    const expanded = draw({ width: 132, expanded: true })
    expect(expanded.join("\n")).toContain("frame")
    expect(expanded.join("\n")).toContain("parsePatch")
    expect(collapsed.join("\n")).not.toContain("frame")
    expect(footerOf(expanded)).toBe("+6 callees · ctrl+o collapses")
    expect(expanded.length).toBeGreaterThan(collapsed.length)
    const complete = draw({ width: 132, expanded: true, right: { ...fixture.right, more: 0 } })
    expect(footerOf(complete)).toBe("ctrl+o collapses")
  })

  test("the saved-tokens estimate sits in the footer, muted, with a ~; absent when unknown, zero or negative", () => {
    const withSaved = draw({ width: 132, saved: 12_400 })
    expect(footerOf(withSaved)).toBe("+1 caller · +10 callees · ~12.4K tokens saved · ctrl+o")
    const spans = spansOf({ width: 132, saved: 12_400 })
    expect(spans.find((span) => span.text.includes("tokens saved"))).toMatchObject({ fg: "muted", dim: true })
    expect(footerOf(draw({ width: 132, expanded: true, saved: 850, right: { ...fixture.right, more: 0 } }))).toBe("~850 tokens saved · ctrl+o collapses")
    for (const saved of [undefined, 0, -40, Number.NaN]) expect(draw({ width: 132, saved }).join("\n")).not.toContain("tokens saved")
    expect(savedLabel(850)).toBe("~850 tokens saved")
    expect(savedLabel(12_400)).toBe("~12.4K tokens saved")
    const noFooter = draw({ width: 100, center: fixture.center, left: { title: "callers", flow: "in", entries: [entry("a", "x.ts", 1)] }, right: { title: "callees", flow: "out", entries: [] }, saved: 3000 })
    expect(noFooter.join("\n")).toContain("~3,000 tokens saved")
  })

  test("full detail adds kinds and a longer preview", () => {
    const balanced = draw({ width: 132 }).join("\n")
    const full = draw({ width: 132, detail: "full" }).join("\n")
    expect(balanced).not.toContain("fn cardRows")
    expect(full).toContain("fn cardRows")
    expect(full).toContain("fn · tool-card:237")
    expect(full.split("\n").length).toBeGreaterThan(balanced.split("\n").length)
  })

  test("the preview shows the direct hops first, then their children, up to the balanced limit per side", () => {
    const rows = draw({ width: 132 })
    const text = rows.join("\n")
    const shown = ["cardRows", "parseToolTitle", "parseDiff", "computerCard", "wrapSpans", "renderSpecLines"]
    expect(shown).toHaveLength(CODE_MAP.rows.balanced)
    for (const label of shown) expect(text).toContain(label)
    for (const label of ["sessionRecallCard", "diffBlocks", "outputLines", "parsePatch"]) expect(text).not.toContain(label)
    expect(rows.filter((row) => /[◇⠣] \w/.test(row)).length).toBeGreaterThanOrEqual(CODE_MAP.rows.balanced)
  })

  test("below 70 columns the map stacks as the same tree: callers, centre, callees", () => {
    const rows = draw({ width: 60 })
    const at = (text: string) => rows.findIndex((row) => row.includes(text))
    expect(rows[0]).toMatch(/^┌renderToolCard · 7 callers · 16 callees─+┐$/)
    expect(at("│ ◇ defaultBody")).toBe(1)
    expect(at("│ ⡇ ⠣ rowsOf")).toBe(2)
    expect(at("◇ toolCardTest")).toBeGreaterThan(at("◇ defaultBody"))
    expect(at("│ ◆ renderToolCard")).toBeGreaterThan(at("recallTest"))
    expect(at("◇ cardRows")).toBeGreaterThan(at("◆ renderToolCard"))
    expect(at("⡇ ⠣ computerCard")).toBe(at("◇ cardRows") + 1)
    expect(at("◇ parseToolTitle")).toBeGreaterThan(at("⠣ wrapSpans"))
    expect(at("◇ parseDiff")).toBeGreaterThan(at("◇ parseToolTitle"))
    expect(rows.join("\n")).toMatch(/cardRows\s+:254/)
    expect(rows.some((row) => /[┤┼├▶]/.test(row))).toBe(false)
    expect(footerOf(rows)).toMatch(/^\+\d+ callers? · \+\d+ callees · ~12\.4K tokens saved · ctrl\+o$|^\+\d+ callers? · \+\d+ callees · ctrl\+o$/)
  })

  test("below 40 columns it drops the frame and still fits, rows all the same width", () => {
    const rows = draw({ width: 30 })
    expect(rows.some((row) => row.startsWith("┌"))).toBe(false)
    for (const row of rows) expect(textWidth(row)).toBe(30)
    expect(rows.some((row) => row.includes("◆ renderToolCard"))).toBe(true)
  })

  test("long names are truncated with an ellipsis, never wrapped", () => {
    const rows = draw({ width: 80, center: { label: "c".repeat(90), file: "a/b.ts", line: 1 }, left: { title: "callers", flow: "in", entries: [entry("n".repeat(120), `${"d/".repeat(60)}x.ts`, 4)] } })
    for (const row of rows) expect(textWidth(row)).toBe(80)
    expect(rows.join("\n")).toContain("…")
  })

  test("wide characters never break the alignment", () => {
    const wide = { ...fixture.center, label: "渲染卡片", file: "应用/视图.ts" }
    const left = { title: "callers", flow: "in" as const, entries: [entry("日本語の関数", "a/ファイル.ts", 3), entry("café", "a/b.ts", 5, 1), entry("🙂smile", "a/c.ts", 6, 2)] }
    const right = { title: "callees", flow: "out" as const, entries: [entry("한국어", "a/d.ts", 9), entry("plain", "a/e.ts", 10), entry("深い", "a/e.ts", 11, 2)], more: 2 }
    for (const width of [40, 60, 70, 100, 132]) {
      const rows = draw({ width, center: wide, left, right })
      const first = textWidth(rows[0]!)
      expect(first).toBeLessThanOrEqual(width)
      for (const row of rows) expect(textWidth(row)).toBe(first)
    }
    const rows = draw({ width: 100, center: wide, left, right })
    expect(rows.join("\n")).toContain("日本語の関数")
    const bar = rows.filter((row) => row.startsWith("│")).map((row) => textWidth(row))
    expect(new Set(bar).size).toBe(1)
  })

  test("a side with nothing is left out of the map and counted as 0 in the title", () => {
    const empty = draw({ width: 100, left: { title: "callers", entries: [], flow: "in" }, right: { title: "callees", entries: [], flow: "out" } })
    expect(empty[0]).toMatch(/^┌renderToolCard · 0 callers · 0 callees─*┐$/)
    expect(empty.join("\n")).toContain("◆ renderToolCard")
    expect(empty.join("\n")).not.toContain("none")
    const onlyRight = draw({ width: 100, left: { title: "callers", entries: [], flow: "in" } })
    expect(onlyRight.find((row) => row.includes("◆ renderToolCard"))).toMatch(/^│ ◆ renderToolCard/)
    expect(onlyRight.join("\n")).toContain("0 callers")
  })

  test("a search map has matches on the right only, joined without arrows", () => {
    const search = draw({
      width: 100,
      center: { label: "search: run", kind: "search" },
      left: { title: "", entries: [] },
      right: { title: "matches", flow: "none", entries: [entry("run", "a.ts", 3), entry("runAll", "b.ts", 9)], more: 0 },
    })
    const text = search.join("\n")
    expect(search[0]).toMatch(/^┌search: run · 2 matches─+┐$/)
    expect(text).toMatch(/run\s+a:3/)
    expect(text).not.toContain("callers")
    expect(text).not.toContain("▶")
    expect(text).toMatch(/◆ search: run [⠀-⣿]+◇ run/)
    expect(search.find((row) => row.includes("search: run") && row.includes("◆"))!.indexOf("◆")).toBeLessThan(5)
    const one = draw({ width: 100, center: { label: "search: x", kind: "search" }, left: { title: "", entries: [] }, right: { title: "matches", flow: "none", entries: [entry("x", "a.ts", 1)], more: 0 } })
    expect(one[0]).toContain("1 match─")
  })

  test("ASCII glyph mode uses plain ASCII only", () => {
    for (const width of [60, 100]) {
      const rows = draw({ width, ascii: true, expanded: true, saved: 5000 })
      for (const row of rows) expect(row).toMatch(/^[\x20-\x7e]*$/)
      expect(rows.join("\n")).toContain("@ renderToolCard")
      expect(rows.join("\n")).toMatch(width < CODE_MAP.minWide ? /^\| o defaultBody/m : /o\.+/)
      expect(rows.join("\n")).toContain("` rowsOf")
      const first = textWidth(rows[0]!)
      for (const row of rows) expect(textWidth(row)).toBe(first)
    }
  })
})

describe("call map as a renderSpec node", () => {
  const spec: RenderNode = { type: "codemap", center: fixture.center, left: { title: "callers", flow: "in", entries: fixture.left.entries.slice(0, 2) }, right: { title: "callees", flow: "out", entries: fixture.right.entries.slice(0, 2) } }

  test("the protocol accepts it and refuses extra fields and oversized sides", () => {
    expect(parseRenderSpec(spec).ok).toBe(true)
    expect(parseRenderSpec({ ...spec, script: "x" }).ok).toBe(false)
    const huge = { ...spec, left: { title: "callers", entries: Array.from({ length: 51 }, (_, i) => ({ label: `s${i}` })) } }
    expect(parseRenderSpec(huge).ok).toBe(false)
    expect(parseRenderSpec({ ...spec, center: { label: "x", depth: 12 } }).ok).toBe(true)
    expect(parseRenderSpec({ ...spec, center: { label: "x", depth: 1_000_001 } }).ok).toBe(false)
  })

  test("deep traversal labels preserve hop counts without unbounded indentation", () => {
    for (const width of [24, 60, 180]) {
      const rows = draw({ width, expanded: true, right: { title: "callees", flow: "out", entries: [entry("base", "a.ts", 1, 1), entry("deep", "a.ts", 2, 1_000_000, "base")] } })
      for (const row of rows) expect(textWidth(row)).toBeLessThanOrEqual(width)
      if (width === 180) expect(rows.join("\n")).toContain("d1000000 deep")
    }
  })

  test("an entry may name the entry it was reached through (via), within the label limit", () => {
    const deep = (entry: Record<string, unknown>) => ({ ...spec, left: { title: "callers", entries: [{ label: "a" }, entry] } })
    expect(parseRenderSpec(deep({ label: "b", depth: 2, via: "a" })).ok).toBe(true)
    expect(parseRenderSpec(deep({ label: "b", depth: 2, via: "" })).ok).toBe(false)
    expect(parseRenderSpec(deep({ label: "b", depth: 2, via: "v".repeat(121) })).ok).toBe(false)
    expect(parseRenderSpec(deep({ label: "b", via: 3 })).ok).toBe(false)
  })

  test("the saved-tokens estimate is a non-negative integer of the spec", () => {
    expect(parseRenderSpec({ ...spec, saved: 12_400 }).ok).toBe(true)
    expect(parseRenderSpec({ ...spec, saved: -1 }).ok).toBe(false)
    expect(parseRenderSpec({ ...spec, saved: 1.5 }).ok).toBe(false)
    expect(parseRenderSpec({ ...spec, saved: "9" }).ok).toBe(false)
  })

  test("renderSpecLines draws it, passes saved, expanded and detail through a stack", () => {
    const stack: RenderNode = { type: "stack", children: [{ type: "text", text: "head" }, { type: "codemap", center: fixture.center, left: fixture.left, right: fixture.right, saved: 2_000 }] }
    const collapsed = renderSpecLines(stack, 100).map(plain)
    const expanded = renderSpecLines(stack, 100, { expanded: true }).map(plain)
    expect(collapsed[0]).toBe("head")
    expect(collapsed.join("\n")).toContain("~2,000 tokens saved")
    expect(expanded.length).toBeGreaterThan(collapsed.length)
    expect(renderSpecLines(stack, 100, { detail: "full" }).map(plain).join("\n")).toContain("fn cardRows")
  })

  test("a tool card draws the map under its head and ctrl+o (expanded) shows every row", () => {
    const base = { title: "Callers of renderToolCard", text: "d1 ...", status: "ok" as const, width: 100, frame: 0, tailLines: 4, render: { type: "codemap", center: fixture.center, left: fixture.left, right: fixture.right } as RenderNode }
    const collapsed = renderToolCard({ ...base, expanded: false }).map(plain)
    const expanded = renderToolCard({ ...base, expanded: true }).map(plain)
    expect(collapsed[0]).toContain("Callers of renderToolCard")
    expect(collapsed[1]!.startsWith("     ┌")).toBe(true)
    expect(expanded.length).toBeGreaterThan(collapsed.length)
    for (const row of [...collapsed, ...expanded]) expect(textWidth(row)).toBeLessThanOrEqual(100)
  })
})

const GRAFT_TEXT = [
  "⬆ graft 0.18.0 → 0.21.1 available: run `npm i -g @nanonets/graft@latest` (restart your agent after).",
  "[graft] no graft/ here — answering from /repo/graft",
  "[graft] tokens saved ≈ 16,491 (98%) — this output ≈ 316 tok vs reading the 6 file(s) it covers whole ≈ 16,807 tok (estimate).",
  "",
  "renderToolCard · function · apps/cli/src/view/tool-card.ts:L237-L252",
  "  calls ← defaultBody (apps/cli/src/view/transcript.ts:L399-L514)",
  "      489: return renderToolCard({",
  "  calls ← chat-transcript.test.ts (apps/cli/test/chat-transcript.test.ts:L1-L469)",
  "      7: import { parsePatch, renderToolCard } from \"../src/view/tool-card\"",
  "  calls → cardRows (apps/cli/src/view/tool-card.ts:L254-L317) [depth 1]",
  "  calls → computerCard (apps/cli/src/view/computer-card.ts:L7-L39) [depth 2]",
].join("\n")

describe("graft trace text as a call map", () => {
  test("reads the header, callers, callees, depths and graft's own saved-tokens figure", () => {
    const map = graftTraceMap(GRAFT_TEXT)!
    expect(map.center).toEqual({ label: "renderToolCard", kind: "function", file: "apps/cli/src/view/tool-card.ts", line: 237 })
    expect(map.left.entries).toEqual([
      { label: "defaultBody", file: "apps/cli/src/view/transcript.ts", line: 399 },
      { label: "chat-transcript.test.ts", file: "apps/cli/test/chat-transcript.test.ts", line: 1 },
    ])
    expect(map.right.entries).toEqual([
      { label: "cardRows", file: "apps/cli/src/view/tool-card.ts", line: 254, depth: 1 },
      { label: "computerCard", file: "apps/cli/src/view/computer-card.ts", line: 7, depth: 2 },
    ])
    expect(map).toMatchObject({ saved: 16_491 })
    expect(parseRenderSpec(map).ok).toBe(true)
  })

  test("no saved figure is invented when graft printed none", () => {
    const map = graftTraceMap(GRAFT_TEXT.split("\n").filter((line) => !line.startsWith("[graft] tokens saved")).join("\n"))!
    expect(map.saved).toBeUndefined()
    expect("saved" in map).toBe(false)
    expect(parseRenderSpec(map).ok).toBe(true)
  })

  test("only the graft trace tools, MCP-prefixed or bare, are read; other text stays raw", () => {
    expect(graftTraceRender("mcp__graft__graft_trace_calls", GRAFT_TEXT)).toBeDefined()
    expect(graftTraceRender("graft_trace_calls", GRAFT_TEXT)).toBeDefined()
    expect(graftTraceRender("graft_find_code", GRAFT_TEXT)).toBeUndefined()
    expect(graftTraceRender("graft_trace_calls", "no symbol found")).toBeUndefined()
    expect(graftTraceRender("graft_trace_calls", "")).toBeUndefined()
  })

  test("more than 50 edges on a side are counted, not listed", () => {
    const lines = Array.from({ length: 55 }, (_, i) => `  calls ← f${i} (a/b.ts:L${i + 1}-L${i + 2})`)
    const map = graftTraceMap(["x · function · a.ts:L1-L2", ...lines].join("\n"))!
    expect(map.left.entries).toHaveLength(50)
    expect(map.left.more).toBe(5)
    expect(parseRenderSpec(map).ok).toBe(true)
  })
})

const ids = createIdFactory()
const sessionId = ids("session")
const NOW = new Date(2026, 9, 3, 15, 50).getTime()

function transcript({ title, text, render, mode }: { title: string; text: string; render?: RenderNode; mode?: PresentationMode }) {
  let seq = 0
  const events: SessionEvent[] = []
  const emit = (event: Record<string, unknown>) => events.push({ sessionId, seq: ++seq, at: NOW - 60_000 + seq * 100, ...event } as SessionEvent)
  const turnId = ids("turn")
  emit({ type: "turn.started", turnId, queueId: ids("queue") })
  const user = ids("item")
  emit({ type: "item.started", turnId, itemId: user, kind: "user_message" })
  emit({ type: "item.completed", itemId: user, status: "ok", text: "Who calls renderToolCard?" })
  const tool = ids("item")
  emit({ type: "item.started", turnId, itemId: tool, kind: "tool_call", meta: { tool: title } })
  emit({ type: "item.completed", itemId: tool, status: "ok", text, ...(render ? { render } : {}) })
  const agent = ids("item")
  emit({ type: "item.started", turnId, itemId: agent, kind: "agent_message" })
  emit({ type: "item.completed", itemId: agent, status: "ok", text: "defaultBody is the only product caller." })
  emit({ type: "turn.completed", turnId })
  const t = createTranscript({ appearance: { messageLayout: "classic", messageMeta: "off", userIcon: "●", userLead: "", userLabel: true, assistantLead: "", userTint: false }, glyphs: glyphs({}), mode: mode ?? "balanced", now: () => NOW })
  t.setAppearance({ reasoning: "auto", toolOutput: "auto", timestamps: false })
  for (const event of events) t.apply(event)
  return t
}

const mapSpec: RenderNode = { type: "codemap", center: fixture.center, left: fixture.left, right: fixture.right, saved: 12_400 }
const rowsOf = (t: ReturnType<typeof transcript>, width: number, height: number) => t.viewport(width, height).map((row) => row.text)

describe("call map in the transcript", () => {
  test("balanced and full draw the map, minimal keeps one line, ctrl+o expands and collapses", () => {
    const t = transcript({ title: "graph_callers: renderToolCard", text: "d1 line", render: mapSpec })
    const collapsed = rowsOf(t, 100, 80).filter((row) => row.trim())
    expect(collapsed.some((row) => row.includes("┌renderToolCard · 7 callers · 16 callees"))).toBe(true)
    expect(collapsed.some((row) => row.includes("+1 caller · +10 callees · ~12.4K tokens saved · ctrl+o"))).toBe(true)
    t.toggleTools()
    const expanded = rowsOf(t, 100, 80).filter((row) => row.trim())
    expect(expanded.length).toBeGreaterThan(collapsed.length)
    expect(expanded.some((row) => row.includes("⠣ frame"))).toBe(true)
    t.toggleTools()
    expect(rowsOf(t, 100, 80).filter((row) => row.trim()).length).toBe(collapsed.length)
    const minimal = transcript({ title: "graph_callers: renderToolCard", text: "d1 line", render: mapSpec, mode: "minimal" })
    expect(rowsOf(minimal, 100, 40).some((row) => row.includes("┌"))).toBe(false)
  })

  test("graft's MCP trace result, which has no spec, is drawn as the same map with graft's own saving", () => {
    const t = transcript({ title: "mcp__graft__graft_trace_calls: renderToolCard", text: GRAFT_TEXT })
    const rows = rowsOf(t, 100, 60).filter((row) => row.trim())
    expect(rows.some((row) => row.includes("┌renderToolCard · 2 callers · 2 callees"))).toBe(true)
    expect(rows.some((row) => row.includes("⠣ computerCard"))).toBe(true)
    expect(rows.some((row) => row.includes("~16.5K tokens saved"))).toBe(true)
    const other = transcript({ title: "mcp__graft__graft_find_code: x", text: GRAFT_TEXT })
    expect(rowsOf(other, 100, 60).some((row) => row.includes("┌renderToolCard"))).toBe(false)
    const without = transcript({ title: "mcp__graft__graft_trace_calls: renderToolCard", text: GRAFT_TEXT.split("\n").filter((line) => !line.startsWith("[graft] tokens")).join("\n") })
    expect(rowsOf(without, 100, 60).some((row) => row.includes("tokens saved"))).toBe(false)
  })
})

describe("frames", () => {
  const directory = process.env.GRAFT_MAP_FRAMES_DIR ?? ".agents/runs/frames/graft-map-v2"
  const dumped: string[] = []
  const sizes: Array<[number, number]> = [[60, 20], [100, 30], [180, 50]]
  const dump = (name: string, rows: string[], width: number, height: number) => {
    const frame = [...rows.slice(-height)]
    while (frame.length < height) frame.push("")
    expect(frame).toHaveLength(height)
    for (const row of frame) {
      expect(textWidth(row)).toBeLessThanOrEqual(width)
      expect(row).not.toContain("\x1b")
    }
    if (process.env.GRAFT_MAP_FRAMES === "1") {
      mkdirSync(directory, { recursive: true })
      writeFileSync(`${directory}/${name}-${width}x${height}.txt`, frame.join("\n") + "\n")
      dumped.push(name)
    }
  }
  afterAll(() => {
    if (process.env.GRAFT_MAP_FRAMES === "1") expect(dumped.length).toBe(sizes.length * 5)
  })
  for (const [width, height] of sizes) {
    test(`frames at ${width}x${height}`, () => {
      const cases: Array<[string, ReturnType<typeof transcript>]> = [
        ["callers", transcript({ title: "graph_callers: renderToolCard", text: "d1 line", render: mapSpec })],
        ["callers-full", transcript({ title: "graph_callers: renderToolCard", text: "d1 line", render: mapSpec, mode: "full" })],
        ["graft-trace", transcript({ title: "mcp__graft__graft_trace_calls: renderToolCard", text: GRAFT_TEXT })],
        ["search", transcript({ title: "graph_find: run", text: "x", render: { type: "codemap", center: { label: "search: run", kind: "search" }, left: { title: "", entries: [] }, right: { title: "matches", flow: "none", entries: [entry("run", "src/a.ts", 3), entry("runAll", "src/b.ts", 9), entry("runner", "src/b.ts", 20)], more: 0 } } })],
      ]
      for (const [name, t] of cases) dump(name, rowsOf(t, width, 200).filter((row, at, all) => row.trim() || all.slice(at).some((later) => later.trim())).map((row) => row.trimEnd()), width, height)
      const expandedView = transcript({ title: "graph_callers: renderToolCard", text: "d1 line", render: mapSpec })
      expandedView.toggleTools()
      dump("callers-expanded", rowsOf(expandedView, width, 200).filter((row, at, all) => row.trim() || all.slice(at).some((later) => later.trim())).map((row) => row.trimEnd()), width, height)
    })
  }
})
