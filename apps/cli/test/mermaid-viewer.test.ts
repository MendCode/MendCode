import { describe, expect, test } from "bun:test"
import { createIdFactory } from "@mendcode/protocol"
import type { Line } from "../src/ui/theme"
import { renderMermaid } from "../src/view/mermaid"
import {
  createDiagramView,
  diagramBounds,
  diagramViewKey,
  layoutDiagram,
  mermaidSources,
  renderDiagramView,
  transcriptDiagrams,
  type DiagramLayout,
  type DiagramViewState,
  type DiagramZoom,
} from "../src/view/mermaid-viewer"
import { textWidth } from "../src/view/wrap"
import { appHarness } from "./extensions-harness"

const ids = createIdFactory()
const text = (line: Line) => line.map((span) => span.text).join("")
const plain = (lines: Line[]) => lines.map(text)

const SMALL = "flowchart LR\n A[Alpha] --> B[Beta]"
const WIDE = `flowchart LR\n ${Array.from({ length: 14 }, (_, i) => `N${i}[Node number ${i}]`).join(" --> ")}`
const TALL = `flowchart TD\n ${Array.from({ length: 16 }, (_, i) => `S${i}[Step ${i}]`).join(" --> ")}`
const SEQUENCE = "sequenceDiagram\n Alice->>Bob: hello\n Bob-->>Alice: hi back"

const layout = (source: string, zoom: DiagramZoom = 0) => layoutDiagram({ source, zoom, render: renderMermaid })
const fence = (body: string, marker = "```") => `${marker}mermaid\n${body}\n${marker}`

describe("finding diagrams in the transcript", () => {
  test("every closed mermaid fence of a message, in order; other fences and unclosed ones are skipped", () => {
    const message = `first\n\n${fence(SMALL)}\n\n\`\`\`ts\nconst a = 1\n\`\`\`\n\n~~~mermaid\n${SEQUENCE}\n~~~\n\nthen an unfinished one\n\`\`\`mermaid\nflowchart TD\n A --> B`
    expect(mermaidSources(message)).toEqual([SMALL, SEQUENCE])
    expect(mermaidSources("no diagram here")).toEqual([])
  })

  test("only the agent's messages count, oldest first", () => {
    const blocks = [
      { kind: "user_message", text: fence("graph TD\n X --> Y"), itemId: "u1" },
      { kind: "agent_message", text: fence(SMALL), itemId: "a1" },
      { kind: "tool_call", text: fence(SEQUENCE), itemId: "t1" },
      { kind: "agent_message", text: `${fence(SEQUENCE)}\n${fence(TALL)}`, itemId: "a2" },
    ]
    expect(transcriptDiagrams(blocks)).toEqual([
      { source: SMALL, itemId: "a1" },
      { source: SEQUENCE, itemId: "a2" },
      { source: TALL, itemId: "a2" },
    ])
  })
})

describe("diagram layout and zoom", () => {
  test("100% is the drawn diagram as it is; a diagram too wide for the chat fits here", () => {
    const natural = renderMermaid(SMALL, 400)
    expect("lines" in natural).toBe(true)
    const view = layout(SMALL)
    expect(plain(view.lines)).toEqual(plain((natural as { lines: Line[] }).lines))
    expect(view.height).toBe(view.lines.length)
    expect(view.width).toBe(Math.max(...view.lines.map((line) => textWidth(text(line)))))
    expect(renderMermaid(WIDE, 60)).toEqual({ note: "diagram too wide · shown as source" })
    const wide = layout(WIDE)
    expect(wide.note).toBeUndefined()
    expect(wide.width).toBeGreaterThan(60)
  })

  test("200% and 300% spread the diagram sideways, keeping every label whole and every line within the new width", () => {
    const base = layout(SMALL)
    const x2 = layout(SMALL, 1)
    const x3 = layout(SMALL, 2)
    expect(x2.height).toBe(base.height)
    expect(x3.height).toBe(base.height)
    expect(x2.width).toBeGreaterThan(base.width)
    expect(x3.width).toBeGreaterThan(x2.width)
    expect(x2.width).toBeLessThanOrEqual(base.width * 2)
    expect(x3.width).toBeLessThanOrEqual(base.width * 3)
    for (const view of [x2, x3]) {
      const all = plain(view.lines).join("\n")
      expect(all).toContain("Alpha")
      expect(all).toContain("Beta")
      for (const line of view.lines) expect(textWidth(text(line))).toBeLessThanOrEqual(view.width)
    }
  })

  test("a stretched box keeps its borders in line from its top edge to its bottom edge", () => {
    for (const zoom of [1, 2] as const) {
      const rows = plain(layout("flowchart TD\n A[Alpha] --> B[Beta]", zoom).lines)
      const label = rows.findIndex((row) => row.includes("Alpha"))
      const box = [rows[label - 1]!, rows[label]!, rows[label + 1]!].map((row) => row.trim())
      expect(box[0]![0]).toBe("┌")
      expect(box[2]![0]).toBe("└")
      expect(box[1]![0]).toBe("│")
      expect(new Set(box.map((row) => textWidth(row))).size).toBe(1)
      // The label sits in the middle of its box, not against a border.
      const inner = box[1]!.slice(1, -1)
      expect(Math.abs(inner.length - inner.trimStart().length - (inner.length - inner.trimEnd().length))).toBeLessThanOrEqual(1)
    }
  })

  test("stretching extends strokes instead of leaving gaps: a horizontal run stays unbroken", () => {
    const row = (view: DiagramLayout) => plain(view.lines).find((line) => line.includes("─►") || line.includes("──►") || line.includes("▶")) ?? plain(view.lines).find((line) => /─{2,}/.test(line))!
    const natural = row(layout(SMALL))
    const stretched = row(layout(SMALL, 2))
    const longest = (line: string) => Math.max(...(line.match(/─+/g) ?? [""]).map((run) => run.length))
    expect(longest(stretched)).toBeGreaterThan(longest(natural))
  })

  test("overview folds the drawing into braille: a quarter of the rows, half of the columns", () => {
    const base = layout(TALL)
    const overview = layout(TALL, -1)
    expect(overview.height).toBe(Math.ceil(base.height / 4))
    expect(overview.width).toBeLessThanOrEqual(Math.ceil(base.width / 2))
    for (const line of overview.lines) expect(/^[⠀-⣿]*$/u.test(text(line))).toBe(true)
    expect(plain(overview.lines).join("").replace(/⠀/gu, "").length).toBeGreaterThan(0)
  })

  test("a sequence diagram zooms too", () => {
    expect(layout(SEQUENCE, 1).width).toBeGreaterThan(layout(SEQUENCE).width)
    expect(plain(layout(SEQUENCE, 1).lines).join("\n")).toContain("hello")
  })

  test("a diagram the renderer cannot draw shows its note and its source, at any zoom", () => {
    const unsupported = "unknownDiagram title Pets\n \"Dogs\" : 3"
    for (const zoom of [-1, 0, 2] as const) {
      const view = layout(unsupported, zoom)
      expect(view.note).toBe("unsupported diagram")
      expect(plain(view.lines)).toEqual(["unsupported diagram", "", "unknownDiagram title Pets", " \"Dogs\" : 3"])
    }
  })
})

describe("diagram keys", () => {
  const bounds = { maxX: 50, maxY: 20, viewWidth: 40, viewHeight: 10 }
  const press = (state: DiagramViewState, key: string, count = 3) => diagramViewKey(state, key, { count, bounds })

  test("arrows and hjkl pan by a few cells and clamp at the edges", () => {
    let state = createDiagramView()
    expect(press(state, "h").state).toBe(state)
    expect(press(state, "k").state).toBe(state)
    state = press(state, "l").state
    expect(state).toMatchObject({ x: 6, y: 0 })
    state = press(state, "\x1b[C").state
    state = press(state, "j").state
    expect(state).toMatchObject({ x: 12, y: 2 })
    state = press(state, "\x1b[B").state
    expect(state.y).toBe(4)
    expect(press(state, "\x1b[D").state).toMatchObject({ x: 6, y: 4 })
    expect(press(state, "\x1b[A").state).toMatchObject({ x: 12, y: 2 })
    for (let i = 0; i < 30; i++) state = press(state, "l").state
    expect(state.x).toBe(50)
    expect(press(state, "l").state).toBe(state)
    for (let i = 0; i < 30; i++) state = press(state, "j").state
    expect(state.y).toBe(20)
  })

  test("shift-arrows and capitals pan a page; home and end jump to the corners", () => {
    let state = createDiagramView()
    state = press(state, "L").state
    expect(state.x).toBe(30)
    state = press(state, "J").state
    expect(state.y).toBe(7)
    expect(press(state, "\x1b[1;2D").state.x).toBe(0)
    expect(press(state, "K").state.y).toBe(0)
    expect(press(state, "\x1b[5~").state.y).toBe(0)
    expect(press(state, "\x1b[6~").state.y).toBe(14)
    expect(press(state, "\x1b[F").state).toMatchObject({ x: 50, y: 20 })
    expect(press(press(state, "G").state, "g").state).toMatchObject({ x: 0, y: 0 })
  })

  test("+ and − zoom one step and stop at overview and 300%", () => {
    let state = createDiagramView()
    expect(state.zoom).toBe(0)
    state = press(state, "+").state
    expect(state.zoom).toBe(1)
    state = press(state, "=").state
    expect(state.zoom).toBe(2)
    expect(press(state, "+").state).toBe(state)
    state = press(press(press(state, "-").state, "-").state, "_").state
    expect(state.zoom).toBe(-1)
    expect(press(state, "-").state).toBe(state)
  })

  test("zooming keeps the middle of the view where it was", () => {
    const state: DiagramViewState = { index: 0, zoom: 0, x: 10, y: 4 }
    const zoomed = press(state, "+").state
    // The middle was at column 30; at 200% it is at 60, so the view starts 20 earlier than that.
    expect(zoomed).toMatchObject({ zoom: 1, x: 40, y: 4 })
    const back = press(zoomed, "-").state
    expect(back).toMatchObject({ zoom: 0, x: 10, y: 4 })
    const overview = press(state, "-").state
    expect(overview.zoom).toBe(-1)
    expect(overview.x).toBeLessThan(state.x)
    expect(overview.y).toBe(0)
  })

  test("0 and r reset the zoom and the pan; already reset changes nothing", () => {
    const moved: DiagramViewState = { index: 1, zoom: 2, x: 30, y: 9 }
    expect(press(moved, "0").state).toEqual({ index: 1, zoom: 0, x: 0, y: 0 })
    expect(press(moved, "r").state).toEqual({ index: 1, zoom: 0, x: 0, y: 0 })
    const fresh = createDiagramView(1)
    expect(press(fresh, "0").state).toBe(fresh)
  })

  test("n and p move between the session's diagrams with a fresh view; they stop at the ends", () => {
    const state: DiagramViewState = { index: 1, zoom: 2, x: 30, y: 9 }
    expect(press(state, "n").state).toEqual({ index: 2, zoom: 0, x: 0, y: 0 })
    expect(press(state, "p").state).toEqual({ index: 0, zoom: 0, x: 0, y: 0 })
    expect(press({ index: 2, zoom: 0, x: 0, y: 0 }, "]").state.index).toBe(2)
    expect(press({ index: 0, zoom: 0, x: 0, y: 0 }, "[").state.index).toBe(0)
    expect(diagramViewKey(state, "n", { count: 0, bounds }).state).toBe(state)
  })

  test("esc and q close; other keys do nothing", () => {
    const state = createDiagramView()
    expect(press(state, "\x1b").action).toBe("close")
    expect(press(state, "q").action).toBe("close")
    expect(press(state, "z")).toEqual({ state, action: "none" })
  })

  test("bounds follow the layout and the page's size", () => {
    const view = layout(WIDE)
    const { maxX, maxY, viewWidth, viewHeight } = diagramBounds(view, 80, 24)
    expect(viewWidth).toBe(78)
    expect(maxX).toBe(view.width - 78)
    expect(maxY).toBe(Math.max(0, view.height - viewHeight))
    expect(diagramBounds(layout(SMALL), 140, 40)).toMatchObject({ maxX: 0, maxY: 0 })
  })
})

describe("full-screen diagram render", () => {
  const render = (view: DiagramLayout | undefined, state: DiagramViewState, width: number, height: number, count = 1) => renderDiagramView({ layout: view, state, count, width, height })

  test("every width and height draws exactly height rows within width, at every zoom and pan", () => {
    const states: DiagramViewState[] = [createDiagramView(), { index: 0, zoom: 1, x: 40, y: 3 }, { index: 0, zoom: 2, x: 9999, y: 9999 }, { index: 0, zoom: -1, x: 5, y: 1 }]
    for (const source of [SMALL, WIDE, TALL, SEQUENCE]) {
      for (const state of states) {
        const view = layout(source, state.zoom)
        for (const width of [30, 40, 60, 80, 100, 140]) {
          for (const height of [8, 12, 24, 40]) {
            const rows = plain(render(view, state, width, height))
            expect(rows).toHaveLength(height)
            for (const row of rows) expect(textWidth(row)).toBeLessThanOrEqual(width)
          }
        }
      }
    }
  })

  test("a small diagram is centered in the view", () => {
    const view = layout(SMALL)
    const rows = plain(render(view, createDiagramView(), 100, 24))
    const first = rows.findIndex((row) => row.includes("Alpha"))
    expect(first).toBeGreaterThan(3)
    const at = rows[first]!.indexOf("│")
    expect(at).toBeGreaterThan(20)
    expect(text(render(view, createDiagramView(), 100, 24)[1]!)).toContain("Diagram · 1 of 1")
  })

  test("a wide diagram shows its left part at first and the right part after panning", () => {
    const view = layout(WIDE)
    const width = 60
    const height = 20
    const start = plain(render(view, createDiagramView(), width, height))
    expect(start.join("\n")).toContain("Node number 0")
    expect(start.join("\n")).not.toContain("Node number 13")
    expect(start.join("\n")).toMatch(/cols 1-58\/\d+/)
    const { maxX } = diagramBounds(view, width, height)
    const end = plain(render(view, { index: 0, zoom: 0, x: maxX, y: 0 }, width, height))
    expect(end.join("\n")).toContain("Node number 13")
    expect(end.join("\n")).not.toContain("Node number 0]")
    expect(end.join("\n")).toContain(`cols ${maxX + 1}-${view.width}/${view.width}`)
  })

  test("panning one step moves the picture by that many cells", () => {
    const view = layout(WIDE)
    const a = plain(render(view, createDiagramView(), 60, 20))
    const b = plain(render(view, { index: 0, zoom: 0, x: 6, y: 0 }, 60, 20))
    const row = a.findIndex((line) => line.includes("Node number 1"))
    expect(row).toBeGreaterThan(0)
    expect(a[row]!.indexOf("Node number 1")).toBe(b[row]!.indexOf("Node number 1") + 6)
  })

  test("a tall diagram scrolls down and reports the rows it shows", () => {
    const view = layout(TALL)
    const start = plain(render(view, createDiagramView(), 80, 16))
    expect(start.join("\n")).toContain("Step 0")
    expect(start.join("\n")).not.toContain("Step 15")
    expect(start.join("\n")).toMatch(/rows 1-\d+\/\d+/)
    const { maxY } = diagramBounds(view, 80, 16)
    expect(plain(render(view, { index: 0, zoom: 0, x: 0, y: maxY }, 80, 16)).join("\n")).toContain("Step 15")
  })

  test("the header names the zoom; a note diagram says source", () => {
    expect(text(render(layout(SMALL), createDiagramView(), 100, 24)[1]!)).toContain("zoom 100%")
    expect(text(render(layout(SMALL, 1), { index: 0, zoom: 1, x: 0, y: 0 }, 100, 24)[1]!)).toContain("zoom 200%")
    expect(text(render(layout(SMALL, -1), { index: 0, zoom: -1, x: 0, y: 0 }, 100, 24)[1]!)).toContain("zoom overview")
    expect(text(render(layout("unknownDiagram\n \"a\" : 1"), createDiagramView(), 100, 24)[1]!)).toContain("source")
  })

  test("no layout yet says loading, and no diagram says so", () => {
    expect(plain(render(undefined, createDiagramView(), 80, 12)).join("\n")).toContain("loading diagram…")
    expect(plain(render(undefined, createDiagramView(), 80, 12, 0)).join("\n")).toContain("no diagram in this session yet")
  })
})

describe("/diagram in the app", () => {
  async function session(messages: string[], options: { width?: number; height?: number } = {}) {
    const h = await appHarness({ width: options.width ?? 100, height: options.height ?? 30 })
    await h.start({ onboarded: true })
    const turnId = ids("turn")
    h.event({ type: "turn.started", turnId, queueId: ids("queue") })
    for (const message of messages) {
      const itemId = ids("item")
      h.event({ type: "item.started", turnId, itemId, kind: "agent_message" })
      h.event({ type: "item.completed", itemId, status: "ok", text: message })
    }
    return h
  }
  const open = async (h: Awaited<ReturnType<typeof session>>, args = "") => {
    await h.type(`/diagram${args ? ` ${args}` : ""}`)
    await h.key("\r")
    await Bun.sleep(60)
    h.app.render()
  }

  test("without a diagram it says so and stays in the chat", async () => {
    const h = await session(["just words"])
    await open(h)
    expect(h.app.page).toBe("chat")
    expect(h.text()).toContain("no diagram in this session yet")
  })

  test("it opens the last diagram full screen; n and p move between diagrams, esc returns", async () => {
    const h = await session([`here you go\n\n${fence(SMALL)}`, `and a sequence\n\n${fence(SEQUENCE)}`])
    await open(h)
    expect(h.app.page).toBe("diagram")
    expect(h.text()).toContain("Diagram · 2 of 2")
    expect(h.text()).toContain("Alice")
    await h.key("p")
    expect(h.text()).toContain("Diagram · 1 of 2")
    expect(h.text()).toContain("Alpha")
    await h.key("n")
    expect(h.text()).toContain("Alice")
    await h.key("\x1b")
    expect(h.app.page).toBe("chat")
  })

  test("/diagram <n> opens that one; a number past the last says how many there are", async () => {
    const h = await session([`${fence(SMALL)}\n${fence(SEQUENCE)}`])
    await open(h, "1")
    expect(h.text()).toContain("Diagram · 1 of 2")
    expect(h.text()).toContain("Alpha")
    await h.key("\x1b")
    await open(h, "5")
    expect(h.app.page).toBe("chat")
    expect(h.text()).toContain("usage: /diagram [n] (1-2; the last one by default)")
  })

  test("zoom, pan and reset work on the screen", async () => {
    const h = await session([fence(WIDE)], { width: 70, height: 24 })
    await open(h)
    expect(h.text()).toContain("zoom 100%")
    expect(h.text()).toContain("Node number 0")
    await h.key("+")
    expect(h.text()).toContain("zoom 200%")
    await h.key("+")
    expect(h.text()).toContain("zoom 300%")
    await h.key("-")
    await h.key("-")
    await h.key("-")
    expect(h.text()).toContain("zoom overview")
    await h.key("0")
    expect(h.text()).toContain("zoom 100%")
    expect(h.text()).toMatch(/cols 1-68\//)
    await h.key("l")
    expect(h.text()).toMatch(/cols 7-74\//)
    await h.key("L")
    expect(h.text()).toMatch(/cols (?!7-)\d+-\d+\//)
    await h.key("r")
    expect(h.text()).toMatch(/cols 1-68\//)
    for (const row of h.rows()) expect(textWidth(row)).toBeLessThanOrEqual(70)
    expect(h.rows()).toHaveLength(24)
  })

  test("a diagram the chat showed as source is drawn here", async () => {
    const h = await session([fence(WIDE)], { width: 70, height: 24 })
    await h.key("\x1b")
    expect(h.text()).toContain("diagram too wide · shown as source")
    await open(h)
    expect(h.app.page).toBe("diagram")
    expect(h.text()).not.toContain("shown as source")
    expect(h.text()).toContain("Node number 0")
  })

  test("the leader chord ctrl+x i opens it", async () => {
    const h = await session([fence(SMALL)])
    await h.key("\x18")
    await h.key("i")
    await Bun.sleep(60)
    h.app.render()
    expect(h.app.page).toBe("diagram")
  })
})
