import { beforeAll, describe, expect, test } from "bun:test"
import type { Line } from "../src/ui/theme"
import { MERMAID_NOTES, renderMermaid } from "../src/view/mermaid"
import { renderMarkdown } from "../src/view/markdown"
import { ensureMermaid, onMermaidLoaded } from "../src/view/mermaid-lazy"
import { textWidth } from "../src/view/wrap"
import { budgetMs } from "../../../scripts/test-budget"

/** markdown.ts loads the mermaid renderer lazily (see mermaid-lazy.test.ts); these tests exercise the
 * finished renderer, so they wait for it once, up front. */
async function preloadMermaid() {
  if (ensureMermaid()) return
  await new Promise<void>((resolve) => onMermaidLoaded(resolve))
}

const text = (line: Line) => line.map((span) => span.text).join("")

function draw(source: string, width = 120): string[] {
  const result = renderMermaid(source, width)
  if (!("lines" in result)) throw new Error(`no diagram: ${result.note}`)
  return result.lines.map(text)
}

function locate(lines: string[], needle: string) {
  const row = lines.findIndex((line) => line.includes(needle))
  return { row, col: row < 0 ? -1 : lines[row]!.indexOf(needle) }
}

describe("flowchart parsing", () => {
  test("plain nodes and every bracket shape render their label", () => {
    const lines = draw("flowchart TD\n A[Rect] --> B(Round)\n B --> C{Choice}\n C --> D((Circle))\n D --> E([Stadium])")
    const all = lines.join("\n")
    for (const label of ["Rect", "Round", "Choice", "Circle", "Stadium"]) expect(all).toContain(label)
    expect(all).toContain("╭")
    expect(all).toContain("╔")
    expect(all).toContain("╱")
    expect(all).toContain("┌")
  })
  test("ids without brackets show the id", () => {
    expect(draw("graph TD\n Alpha --> Beta").join("\n")).toContain("Alpha")
  })
  test("later definitions give an earlier bare id its label", () => {
    const all = draw("flowchart TD\n A --> B\n A[Start here]").join("\n")
    expect(all).toContain("Start here")
    expect(all).not.toMatch(/│ A │/)
  })
  test("quoted labels keep special characters and <br> makes a second line", () => {
    const all = draw('flowchart TD\n A["Hello (world)"] --> B[one<br/>two]').join("\n")
    expect(all).toContain("Hello (world)")
    expect(all).toContain("one")
    expect(all).toContain("two")
    expect(locate(draw("flowchart TD\n B[one<br/>two]"), "two").row).toBeGreaterThan(locate(draw("flowchart TD\n B[one<br/>two]"), "one").row)
  })
  test("edge operators: solid, open, dotted, thick, cross, circle", () => {
    const solid = draw("flowchart TD\n A --> B").join("\n")
    expect(solid).toContain("▼")
    expect(draw("flowchart TD\n A --- B").join("\n")).not.toMatch(/[▼▲]/)
    expect(draw("flowchart TD\n A -.-> B").join("\n")).toContain("┆")
    expect(draw("flowchart TD\n A ==> B").join("\n")).toContain("┃")
    expect(draw("flowchart TD\n A --x B").join("\n")).toContain("✕")
    expect(draw("flowchart TD\n A --o B").join("\n")).toContain("○")
    const both = draw("flowchart TD\n A <--> B").join("\n")
    expect(both).toContain("▼")
    expect(both).toContain("▲")
  })
  test("edge labels: pipe and inline forms", () => {
    expect(draw("flowchart TD\n A -->|yes| B").join("\n")).toContain("yes")
    expect(draw("flowchart TD\n A -- maybe --> B").join("\n")).toContain("maybe")
    expect(draw("flowchart TD\n A -. cached .-> B").join("\n")).toContain("cached")
    expect(draw("flowchart TD\n A == heavy ==> B").join("\n")).toContain("heavy")
  })
  test("chains create every node in order", () => {
    const lines = draw("flowchart TD\n A --> B --> C --> D")
    const rows = ["A", "B", "C", "D"].map((id) => locate(lines, `│ ${id} │`).row)
    expect(rows.every((row) => row >= 0)).toBe(true)
    expect([...rows].sort((a, b) => a - b)).toEqual(rows)
  })
  test("& fans out and in", () => {
    const lines = draw("flowchart TD\n A --> B & C\n B & C --> D")
    const all = lines.join("\n")
    for (const id of ["A", "B", "C", "D"]) expect(all).toContain(`│ ${id} │`)
    expect(locate(lines, "│ B │").row).toBe(locate(lines, "│ C │").row)
    expect(locate(lines, "│ D │").row).toBeGreaterThan(locate(lines, "│ B │").row)
    expect((all.match(/▼/g) ?? []).length).toBe(3)
  })
  test("comments and styles are ignored; subgraphs frame their members", () => {
    const lines = draw(
      "flowchart TD\n %% a comment\n subgraph Group[Frame]\n  A --> B\n end\n classDef hot fill:#f00\n class A hot\n style B stroke:#333\n click A callback\n linkStyle 0 stroke:red\n B --> C; C --> D",
    ).join("\n")
    for (const id of ["A", "B", "C", "D"]) expect(lines).toMatch(new RegExp(`│ +${id} +│`))
    expect(lines).toContain("Frame")
    expect(lines).not.toContain("comment")
  })
  test("direction defaults to TD and TB equals TD", () => {
    expect(draw("flowchart\n A --> B")).toEqual(draw("flowchart TD\n A --> B"))
    expect(draw("graph TB\n A --> B")).toEqual(draw("flowchart TD\n A --> B"))
  })
  test("cycles and self loops do not break layout", () => {
    const all = draw("flowchart TD\n A --> B\n B --> C\n C --> A\n B --> B").join("\n")
    for (const id of ["A", "B", "C"]) expect(all).toContain(`│ ${id} │`)
  })
  test("disconnected components render side by side", () => {
    const lines = draw("flowchart TD\n A --> B\n C --> D")
    expect(locate(lines, "│ A │").row).toBe(locate(lines, "│ C │").row)
  })
  test("long labels wrap instead of making huge boxes", () => {
    const lines = draw(`flowchart TD\n A[${"word ".repeat(20)}] --> B`)
    expect(Math.max(...lines.map(textWidth))).toBeLessThan(40)
  })
})

describe("flowchart layout", () => {
  const chain = "A --> B --> C"
  test("TD layers grow downward with ▼ heads", () => {
    const lines = draw(`flowchart TD\n ${chain}`)
    expect(locate(lines, "│ A │").row).toBeLessThan(locate(lines, "│ B │").row)
    expect(locate(lines, "│ B │").row).toBeLessThan(locate(lines, "│ C │").row)
    expect(lines.join("\n")).toContain("▼")
    expect(lines.join("\n")).not.toContain("▲")
  })
  test("BT reverses the vertical order with ▲ heads", () => {
    const lines = draw(`flowchart BT\n ${chain}`)
    expect(locate(lines, "│ A │").row).toBeGreaterThan(locate(lines, "│ B │").row)
    expect(locate(lines, "│ B │").row).toBeGreaterThan(locate(lines, "│ C │").row)
    expect(lines.join("\n")).toContain("▲")
    expect(lines.join("\n")).not.toContain("▼")
  })
  test("LR layers grow rightward with ▶ heads on one row", () => {
    const lines = draw(`flowchart LR\n ${chain}`)
    expect(locate(lines, "│ A ").col).toBeLessThan(locate(lines, "│ B ").col)
    expect(locate(lines, "│ B ").col).toBeLessThan(locate(lines, "│ C ").col)
    expect(locate(lines, "│ A ").row).toBe(locate(lines, "│ C ").row)
    expect(lines.join("\n")).toContain("▶")
    expect(lines.join("\n")).not.toContain("◀")
  })
  test("RL reverses the horizontal order with ◀ heads", () => {
    const lines = draw(`flowchart RL\n ${chain}`)
    expect(locate(lines, " A ").col).toBeGreaterThan(locate(lines, " B ").col)
    expect(locate(lines, " B ").col).toBeGreaterThan(locate(lines, " C ").col)
    expect(lines.join("\n")).toContain("◀")
    expect(lines.join("\n")).not.toContain("▶")
  })
  test("longest path decides the layer of a node with several parents", () => {
    const lines = draw("flowchart TD\n A --> B --> C\n A --> C")
    expect(locate(lines, "│ C │").row).toBeGreaterThan(locate(lines, "│ B │").row)
  })
  test("a diamond branches into two children on one row", () => {
    const lines = draw("flowchart TD\n A{Ready?} -->|yes| B[Go]\n A -->|no| C[Wait]")
    expect(locate(lines, "│ Go │").row).toBe(locate(lines, "│ Wait │").row)
    expect(locate(lines, "yes").row).toBeGreaterThan(locate(lines, "Ready?").row)
    expect(locate(lines, "no").row).toBeGreaterThan(locate(lines, "Ready?").row)
  })
  test("edge labels sit between the two nodes they connect", () => {
    const lines = draw("flowchart TD\n A -->|go| B")
    expect(locate(lines, "go").row).toBeGreaterThan(locate(lines, "│ A │").row)
    expect(locate(lines, "go").row).toBeLessThan(locate(lines, "│ B │").row)
    const lr = draw("flowchart LR\n A -->|go| B")
    const goCol = locate(lr, "go").col
    expect(goCol).toBeGreaterThan(locate(lr, "│ A │").col)
    expect(goCol).toBeLessThan(locate(lr, "│ B │").col)
  })
  test("connector junctions are drawn on box borders", () => {
    expect(draw("flowchart TD\n A --- B").join("\n")).toMatch(/[┬┴]/)
  })
  test("no line ever exceeds the width and every row is a valid line", () => {
    const source = "flowchart LR\n A[Prompt] --> B{Route}\n B -->|fast| C[Agent] & D[Cache]\n C --> E([Answer])\n D -.-> E\n E ==> A"
    for (const width of [50, 80, 120, 200]) {
      const result = renderMermaid(source, width)
      if ("lines" in result) for (const line of result.lines) expect(textWidth(text(line))).toBeLessThanOrEqual(width)
      else expect(result.note).toBe(MERMAID_NOTES.tooWide)
    }
  })
  test("uses roles: boxes heading, node text body, edges muted, labels code", () => {
    const result = renderMermaid("flowchart TD\n A -->|go| B", 100)
    if (!("lines" in result)) throw new Error("no diagram")
    const spans = result.lines.flat()
    expect(spans.some((s) => s.fg === "heading" && s.text.includes("┌"))).toBe(true)
    expect(spans.some((s) => s.fg === "body" && s.text.includes("A"))).toBe(true)
    expect(spans.some((s) => s.fg === "muted" && s.text.includes("▼"))).toBe(true)
    expect(spans.some((s) => s.fg === "code" && s.text === "go")).toBe(true)
  })
  test("50-node flowchart renders quickly", () => {
    const edges = Array.from({ length: 49 }, (_, i) => ` N${Math.floor(i / 2)} --> N${i + 1}[Node ${i + 1}]`)
    const source = `flowchart TD\n${edges.join("\n")}\n N25 --> N3`
    renderMermaid(source, 400)
    const started = performance.now()
    const result = renderMermaid(source, 400)
    expect(performance.now() - started).toBeLessThan(budgetMs(100))
    expect("lines" in result).toBe(true)
  })
})

describe("sequence diagrams", () => {
  const base = "sequenceDiagram\n participant U as User\n actor D as Daemon\n U->>D: submit\n D-->>U: events\n"
  test("participants (explicit aliases and implicit) appear in order", () => {
    const lines = draw("sequenceDiagram\n participant U as User\n U->>Server: hi\n Server->>Db: q")
    const cols = ["User", "Server", "Db"].map((name) => locate(lines, name).col)
    expect(cols.every((c) => c >= 0)).toBe(true)
    expect([...cols].sort((a, b) => a - b)).toEqual(cols)
  })
  test("message text sits above its arrow and arrows point to the target", () => {
    const lines = draw(base)
    const submit = locate(lines, "submit")
    expect(lines[submit.row + 1]).toContain("▶")
    const events = locate(lines, "events")
    expect(lines[events.row + 1]).toContain("◀")
    expect(lines[events.row + 1]).toContain("┄")
    expect(lines[submit.row + 1]).not.toContain("┄")
  })
  test("arrow variants: open, dashed open, cross, dashed cross", () => {
    const lines = draw("sequenceDiagram\n A->B: open\n A-->B: dashed open\n A-xB: cross\n A--xB: dashed cross").join("\n")
    expect(lines).toContain("▷")
    expect(lines).toContain("✕")
    expect(lines).toContain("┄")
    for (const t of ["open", "dashed open", "cross", "dashed cross"]) expect(lines).toContain(t)
  })
  test("self messages draw a loop", () => {
    const lines = draw("sequenceDiagram\n A->>A: think").join("\n")
    expect(lines).toContain("think")
    expect(lines).toContain("┐")
    expect(lines).toContain("┘")
  })
  test("activation markers and activate/deactivate lines are accepted", () => {
    const all = draw("sequenceDiagram\n A->>+B: go\n activate B\n B-->>-A: done\n deactivate B").join("\n")
    expect(all).toContain("go")
    expect(all).toContain("done")
  })
  test("notes over, left of and right of", () => {
    const lines = draw("sequenceDiagram\n A->>B: hi\n Note over A,B: shared\n Note left of A: lonely\n Note right of B: extra").join("\n")
    for (const t of ["shared", "lonely", "extra"]) expect(lines).toContain(t)
  })
  test("loop, alt/else and opt blocks become labeled bracket lines", () => {
    const lines = draw("sequenceDiagram\n A->>B: x\n loop every turn\n A->>B: y\n end\n alt ok\n A->>B: z\n else failed\n B->>A: w\n end\n opt maybe\n A->>B: v\n end")
    const all = lines.join("\n")
    for (const t of ["loop every turn", "alt ok", "else failed", "opt maybe"]) expect(all).toContain(t)
    expect(lines.filter((line) => line.startsWith("└")).length).toBe(3)
    expect(lines.filter((line) => line.startsWith("┌") && !line.includes("User")).length).toBeGreaterThanOrEqual(3)
  })
  test("nested blocks inset their frames", () => {
    const lines = draw("sequenceDiagram\n A->>B: x\n loop outer\n alt inner\n A->>B: y\n end\n end")
    expect(locate(lines, "inner").col).toBeGreaterThan(locate(lines, "outer").col)
  })
  test("comments and title are ignored", () => {
    expect(draw("sequenceDiagram\n %% note\n title Something\n A->>B: hi").join("\n")).toContain("hi")
  })
  test("wide messages widen the gap between participants", () => {
    const lines = draw("sequenceDiagram\n A->>B: a fairly long message text")
    expect(lines.join("\n")).toContain("a fairly long message text")
  })
  test("no line exceeds the width; too wide falls back", () => {
    for (const width of [60, 100]) {
      const result = renderMermaid(base, width)
      if ("lines" in result) for (const line of result.lines) expect(textWidth(text(line))).toBeLessThanOrEqual(width)
    }
    expect(renderMermaid(base, 20)).toEqual({ note: MERMAID_NOTES.tooWide })
  })
  test("unbalanced end and garbage lines are unsupported", () => {
    expect(renderMermaid("sequenceDiagram\n A->>B: x\n end", 100)).toEqual({ note: MERMAID_NOTES.unsupported })
    expect(renderMermaid("sequenceDiagram\n what is this", 100)).toEqual({ note: MERMAID_NOTES.unsupported })
  })
})

describe("fallbacks", () => {
  test("unknown diagram types are unsupported", () => {
    for (const source of ["unknownDiagram\n \"a\": 1", "gantt\n title x", "unknownDiagram\n A <|-- B", "", "not mermaid at all"]) {
      expect(renderMermaid(source, 100)).toEqual({ note: MERMAID_NOTES.unsupported })
    }
  })
  test("a flowchart with a broken line is unsupported", () => {
    expect(renderMermaid("flowchart TD\n A --> \n", 100)).toEqual({ note: MERMAID_NOTES.unsupported })
    expect(renderMermaid("flowchart TD\n ???", 100)).toEqual({ note: MERMAID_NOTES.unsupported })
  })
  test("a diagram wider than the terminal falls back", () => {
    const source = `flowchart LR\n ${Array.from({ length: 8 }, (_, i) => `N${i}[Step number ${i}]`).join(" --> ")}`
    expect(renderMermaid(source, 60)).toEqual({ note: MERMAID_NOTES.tooWide })
    expect("lines" in renderMermaid(source, 400)).toBe(true)
  })
  test("frontmatter is skipped", () => {
    expect(draw("---\ntitle: demo\n---\nflowchart TD\n A --> B").join("\n")).toContain("│ B │")
  })
})

describe("markdown integration", () => {
  beforeAll(preloadMermaid)
  const plainMarkdown = (source: string, width = 100) => renderMarkdown(source, width).map(text)
  test("a closed mermaid fence renders as a diagram", () => {
    const lines = plainMarkdown("Before\n\n```mermaid\nflowchart TD\n A --> B\n```\n\nAfter")
    expect(lines.some((line) => line.includes("│ A │"))).toBe(true)
    expect(lines.some((line) => line.includes("flowchart TD"))).toBe(false)
    expect(lines[0]).toBe("Before")
    expect(lines[lines.length - 1]).toBe("After")
  })
  test("an unclosed (streaming) mermaid fence stays a code block", () => {
    const lines = plainMarkdown("```mermaid\nflowchart TD\n A --> B")
    expect(lines).toContain("│ mermaid")
    expect(lines).toContain("│ flowchart TD")
    expect(lines.some((line) => line.includes("┌"))).toBe(false)
  })
  test("unsupported diagrams show as source with a note", () => {
    const lines = plainMarkdown("```mermaid\nunknownDiagram\n \"a\": 1\n```")
    expect(lines).toContain("│ unknownDiagram")
    expect(lines[lines.length - 1]).toBe(MERMAID_NOTES.unsupported)
  })
  test("too wide diagrams show as source with a note", () => {
    const source = `flowchart LR\n ${Array.from({ length: 8 }, (_, i) => `N${i}[Step number ${i}]`).join(" --> ")}`
    const lines = plainMarkdown(`\`\`\`mermaid\n${source}\n\`\`\``, 60)
    expect(lines[lines.length - 1]).toBe(MERMAID_NOTES.tooWide)
    for (const line of lines) expect(textWidth(line)).toBeLessThanOrEqual(60)
  })
  test("other languages and text after the fence are untouched", () => {
    const lines = plainMarkdown("```ts\nconst a = 1\n```\n\n```mermaid\nflowchart LR\n A --> B\n```\n\ndone")
    expect(lines).toContain("│ const a = 1")
    expect(lines[lines.length - 1]).toBe("done")
  })
  test("uppercase language and tildes fences work", () => {
    expect(plainMarkdown("~~~Mermaid\nflowchart TD\n A --> B\n~~~").some((line) => line.includes("│ A │"))).toBe(true)
  })
  test("markdown output never exceeds the width with diagrams", () => {
    for (const width of [40, 60, 100]) {
      for (const line of plainMarkdown("```mermaid\nsequenceDiagram\n A->>B: hello there\n```", width)) expect(textWidth(line)).toBeLessThanOrEqual(width)
    }
  })
})
