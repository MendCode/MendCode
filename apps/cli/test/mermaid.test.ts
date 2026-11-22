import { beforeAll, describe, expect, test } from "bun:test"
import type { Line } from "../src/ui/theme"
import { renderMermaid } from "../src/view/mermaid"
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
      if (!("lines" in result)) throw new Error(`no diagram at ${width}: ${result.note}`)
      for (const line of result.lines) expect(textWidth(text(line))).toBeLessThanOrEqual(width)
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
  test("no line exceeds the width; wider than the room it is cut at the right edge, and says where to see it whole", () => {
    for (const width of [60, 100]) {
      const result = renderMermaid(base, width)
      if ("lines" in result) for (const line of result.lines) expect(textWidth(text(line))).toBeLessThanOrEqual(width)
    }
    const cut = renderMermaid(base, 20)
    if (!("lines" in cut)) throw new Error(`no diagram: ${cut.note}`)
    for (const line of cut.lines) expect(textWidth(text(line))).toBeLessThanOrEqual(20)
    expect(cut.lines.map(text).join("\n")).toContain("…")
    expect(cut.note).toContain("/diagram")
  })
  test("a line that is not understood is left out and quoted in the note; with nothing left, the note alone", () => {
    const partial = renderMermaid("sequenceDiagram\n A->>B: hello\n B-->>A: bye\n what is this", 100)
    if (!("lines" in partial)) throw new Error(`no diagram: ${partial.note}`)
    expect(partial.lines.map(text).join("\n")).toContain("hello")
    expect(partial.note).toBe("1 line not understood: what is this")
    expect(renderMermaid("sequenceDiagram\n what is this", 100)).toEqual({ note: "1 line not understood: what is this · shown as source" })
  })
  test("a block left open, a bar closed twice and a message without text still draw", () => {
    const all = draw("sequenceDiagram\n A->>B: one\n deactivate B\n alt maybe\n B-->>A\n A->>B: two").join("\n")
    for (const word of ["one", "two", "alt", "maybe"]) expect(all).toContain(word)
  })
})

describe("fallbacks", () => {
  test("a type with no drawing of its own shows its links as a graph, or its statements as an outline", () => {
    const graph = renderMermaid("unknownDiagram\n A <|-- B\n B --> C : uses", 100)
    if (!("lines" in graph)) throw new Error(`no diagram: ${graph.note}`)
    for (const id of ["A", "B", "C"]) expect(graph.lines.map(text).join("\n")).toContain(`│ ${id} │`)
    expect(graph.lines.map(text).join("\n")).toContain("uses")
    expect(graph.note).toContain("unknownDiagram has no drawing here")
    const outline = renderMermaid("unknownDiagram\n \"a\": 1\n \"b\": 2", 100)
    if (!("lines" in outline)) throw new Error(`no diagram: ${outline.note}`)
    expect(outline.lines.map(text)).toEqual(["unknownDiagram", '├ "a": 1', '├ "b": 2'])
    expect(outline.note).toBe("unknownDiagram has no drawing here · shown as an outline")
  })
  test("text that is not a diagram is a note that quotes it, never a bare 'unsupported'", () => {
    expect(renderMermaid("", 100)).toEqual({ note: "empty diagram" })
    expect(renderMermaid("not mermaid at all", 100)).toEqual({ note: "not a mermaid diagram type: not mermaid at all · shown as source" })
    expect(renderMermaid("gantt\n title x", 100)).toEqual({ note: "1 line not understood: title x · shown as source" })
    for (const source of ["", "not mermaid at all", "gantt\n title x", "flowchart TD\n ???", "pie\n \"bad\": NaN"]) {
      const result = renderMermaid(source, 100)
      expect("lines" in result).toBe(false)
      expect(result.note).not.toContain("unsupported")
    }
  })
  test("a flowchart keeps the lines it understood and names the one it did not; with none understood it is the note alone", () => {
    const partial = renderMermaid("flowchart TD\n A --> B\n B --> C\n C -=> D", 100)
    if (!("lines" in partial)) throw new Error(`no diagram: ${partial.note}`)
    for (const id of ["A", "B", "C"]) expect(partial.lines.map(text).join("\n")).toContain(`│ ${id} │`)
    expect(partial.lines.map(text).join("\n")).not.toContain("D")
    expect(partial.note).toBe("1 line not understood: C -=> D")
    expect(renderMermaid("flowchart TD\n A --> \n", 100)).toEqual({ note: "1 line not understood: A --> · shown as source" })
    expect(renderMermaid("flowchart TD\n ???", 100)).toEqual({ note: "1 line not understood: ??? · shown as source" })
  })
  test("a flowchart too wide for any layout is listed, node by node, inside the width", () => {
    const source = `flowchart LR\n ${Array.from({ length: 8 }, (_, i) => `N${i}[Step number ${i}]`).join(" --> ")}`
    const listed = renderMermaid(source, 12)
    if (!("lines" in listed)) throw new Error(`no diagram: ${listed.note}`)
    for (const line of listed.lines) expect(textWidth(text(line))).toBeLessThanOrEqual(12)
    expect(listed.lines.map(text).join("\n")).toContain("└─▶")
    expect(listed.note).toContain("listed instead")
    for (const width of [60, 400]) expect(renderMermaid(source, width)).not.toHaveProperty("note")
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
  test("text that is not a diagram shows as source, with the line that was not understood under it", () => {
    const lines = plainMarkdown("```mermaid\nflowchart TD\n A -=> B\n```")
    expect(lines).toContain("│ flowchart TD")
    expect(lines[lines.length - 1]).toBe("1 line not understood: A -=> B · shown as source")
  })
  test("a drawing that leaves a line out says which one under it", () => {
    const lines = plainMarkdown("```mermaid\nflowchart TD\n A --> B\n B --> C\n C -=> D\n```")
    expect(lines.some((line) => line.includes("│ A │"))).toBe(true)
    expect(lines.some((line) => line.includes("flowchart TD"))).toBe(false)
    expect(lines[lines.length - 1]).toBe("1 line not understood: C -=> D")
  })
  test("a diagram too wide for the chat is still drawn, inside the width", () => {
    const source = `flowchart TD\n R --> ${Array.from({ length: 8 }, (_, i) => `N${i}[Step number ${i}]`).join(" & ")}`
    const lines = plainMarkdown(`\`\`\`mermaid\n${source}\n\`\`\``, 60)
    expect(lines.some((line) => line.includes("flowchart TD"))).toBe(false)
    for (let i = 0; i < 8; i++) expect(lines.join("\n")).toContain(`Step number ${i}`)
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

describe("diagrams in a narrow transcript", () => {
  const text = (lines: Line[]) => lines.map((row) => row.map((span) => span.text).join("")).join("\n")

  test("a sequence gives its spare room to the long messages, so one keeps its line beside short ones", () => {
    const source = "sequenceDiagram\n  participant U as User\n  participant C as Cart\n  participant P as Pricing\n  participant D as Discounts\n  U->>C: checkout()\n  C->>P: Sum item prices\n  P-->>C: subtotal\n  C->>D: apply coupon\n  C-->>U: total = subtotal - discount"
    const result = renderMermaid(source, 75)
    expect("lines" in result).toBe(true)
    expect(text((result as { lines: Line[] }).lines)).toContain("total = subtotal - discount")
  })

  test("the last participant's messages to itself get room beside a wide note, and none of their words is cut", () => {
    const source = "sequenceDiagram\n  actor C as Checkout page\n  participant P as preview\n  participant T as totals\n  Note over C,P: Checkout page interaction is conceptual;<br/>preview is the indexed caller of totals.\n  C->>P: preview(items, coupon)\n  P->>T: totals(items, coupon)\n  T->>T: Sum line totals\n  T->>T: Apply percentage discount and optional cap\n  T->>T: Round subtotal minus discount\n  T-->>P: { subtotal, discount, total }"
    for (const width of [100, 120]) {
      const result = renderMermaid(source, width)
      expect("lines" in result).toBe(true)
      const drawn = text((result as { lines: Line[] }).lines)
      expect(drawn).toContain("Sum line totals")
      for (const word of ["percentage", "discount", "optional", "cap", "subtotal", "minus"]) expect(drawn).toMatch(new RegExp(`┆ [^┆]*\\b${word}\\b`))
    }
  })

  test("two states side by side that each return to themselves keep both notes whole, beside their own box", () => {
    const result = renderMermaid("stateDiagram-v2\nA --> A: retry\nB --> B: again", 80)
    expect("lines" in result).toBe(true)
    const row = text((result as { lines: Line[] }).lines).split("\n").find((line) => line.includes("↻ retry"))!
    expect(row).toContain("↻ again")
    expect(row.indexOf("↻ retry")).toBeLessThan(row.indexOf("│     B"))
  })

  test("a state that returns to itself is written beside its box, and two routed labels never share a row", () => {
    const source = "stateDiagram-v2\n  [*] --> Empty\n  Empty --> Active: add item\n  Active --> Active: add/remove item\n  Active --> Discounted: apply coupon\n  Discounted --> Active: remove coupon\n  Active --> CheckedOut: checkout\n  Discounted --> CheckedOut: checkout\n  CheckedOut --> [*]"
    for (const width of [60, 90]) {
      const result = renderMermaid(source, width)
      expect("lines" in result).toBe(true)
      const drawn = text((result as { lines: Line[] }).lines)
      expect(drawn).toContain("↻ add/remove item")
      for (const label of ["apply coupon", "remove coupon", "add item"]) expect(drawn).toContain(label)
      expect(drawn.split("\n").filter((row) => row.includes("checkout")).every((row) => (row.match(/checkout/g) ?? []).length === 1)).toBe(true)
    }
  })
})

/** The reported block and every form of the syntax a model writes: each is a drawing, never the source under "unsupported diagram". */
describe("every mermaid block a model writes is drawn", () => {
  /** Drawn, complete, and nothing left to say about it. */
  function whole(source: string, width = 120): string {
    const result = renderMermaid(source, width)
    if (!("lines" in result)) throw new Error(`no diagram: ${result.note}\n${source}`)
    if (result.note) throw new Error(`drawn with a note: ${result.note}\n${source}`)
    for (const line of result.lines) expect(textWidth(text(line))).toBeLessThanOrEqual(width)
    return result.lines.map(text).join("\n")
  }

  test("the reported flowchart: a dotted link with its text inside, accents and · / + in the labels", () => {
    const source = [
      "flowchart TD",
      "  Yo[Tú / mendy en MendCode] --> SW[Oficina Software · Opus · director]",
      "  SW --> P1[Oficina Proyecto A · Opus + mend-autopilot]",
      "  SW -.consulta.-> SEC[Ciberseguridad · Opus · solo lectura]",
      "  P1 --> PR1[PRs para que tú revises]",
    ].join("\n")
    for (const label of ["Tú / mendy en MendCode", "mend-autopilot", "Ciberseguridad · Opus · solo", "PRs para que tú revises", "consulta"]) expect(whole(source, 120)).toContain(label)
    // Narrower, a label wraps inside its box: every word is still there, and the dotted link with its text.
    for (const width of [40, 60, 80, 120]) {
      const drawn = whole(source, width)
      for (const word of ["Tú", "mendy", "MendCode", "Oficina", "Software", "director", "Proyecto", "mend-autopilot", "Ciberseguridad", "lectura", "PRs", "revises", "consulta"]) expect(drawn).toContain(word)
      expect(drawn).toMatch(/[┄┆]/)
      // From 60 columns the layers fit; narrower, the boxes are stacked with their links beside them.
      expect((drawn.match(/[▼◀]/g) ?? []).length).toBe(4)
      if (width >= 60) expect(drawn).not.toContain("◀")
    }
    const narrow = renderMermaid(source, 24)
    if (!("lines" in narrow)) throw new Error(`no diagram: ${narrow.note}`)
    for (const line of narrow.lines) expect(textWidth(text(line))).toBeLessThanOrEqual(24)
  })

  test("every link form, with and without spaces around its text", () => {
    const forms: Array<[string, RegExp, string?]> = [
      ["A --> B", /▼/],
      ["A --- B", /[┬┴]/],
      ["A ---> B", /▼/],
      ["A -.-> B", /┆/],
      ["A -.- B", /┆/],
      ["A -..-> B", /┆/],
      ["A ==> B", /┃/],
      ["A === B", /┃/],
      ["A --o B", /○/],
      ["A --x B", /✕/],
      ["A <--> B", /▲[\s\S]*▼/],
      ["A o--o B", /○[\s\S]*○/],
      ["A x--x B", /✕[\s\S]*✕/],
      ["A <-.-> B", /▲[\s\S]*▼/],
      ["A -->|texto| B", /▼/, "texto"],
      ["A --> |texto| B", /▼/, "texto"],
      ["A ---|texto| B", /│/, "texto"],
      ["A -- texto --> B", /▼/, "texto"],
      ["A --texto--> B", /▼/, "texto"],
      ["A -- texto --- B", /│/, "texto"],
      ["A -. texto .-> B", /┆/, "texto"],
      ["A -.texto.-> B", /┆/, "texto"],
      ["A -.texto.- B", /┆/, "texto"],
      ["A == texto ==> B", /┃/, "texto"],
      ["A ==texto==> B", /┃/, "texto"],
      ['A -- "con: signos (y) más" --> B', /▼/, "con: signos (y) más"],
      ["A e1@--> B", /▼/],
      ["A --> B:::hot", /▼/],
    ]
    for (const [statement, stroke, label] of forms) {
      const drawn = whole(`flowchart TD\n ${statement}`)
      for (const id of ["A", "B"]) expect(drawn).toContain(`│ ${id} │`)
      expect(drawn).toMatch(stroke)
      if (label) expect(drawn).toContain(label)
    }
  })

  test("an invisible link places its nodes and draws nothing; a bare -- or <-- between two nodes is a plain line", () => {
    const hidden = whole("flowchart TD\n A ~~~ B")
    for (const id of ["A", "B"]) expect(hidden).toContain(`│ ${id} │`)
    expect(hidden).not.toMatch(/[▼▲]/)
    expect(hidden.split("\n").findIndex((row) => row.includes("│ A │"))).toBeLessThan(hidden.split("\n").findIndex((row) => row.includes("│ B │")))
    expect(whole("flowchart LR\n A -- B")).toMatch(/A ├─+┤ B/)
    expect(whole("flowchart TD\n A <-- B")).toContain("▲")
  })

  test("chains, & groups and several statements on one line", () => {
    const drawn = whole("flowchart TD\n A --> B --> C\n A & B --> D & E\n F --> G; G --> H")
    for (const id of ["A", "B", "C", "D", "E", "F", "G", "H"]) expect(drawn).toContain(`│ ${id} │`)
  })

  test("every node shape, quoted labels, markdown strings, <br> and entity codes", () => {
    const shapes = ["a[rect]", "b(round)", "c([stadium])", "d[[subroutine]]", "e[(database)]", "f((circle))", "g{decision}", "h{{hexagon}}", "i[/lean right/]", "j[\\lean left\\]", "k[/trapezoid\\]", "l[\\inverted/]", "m>flag]", "n(((double)))", 'o@{ shape: diamond, label: "typed shape" }']
    const drawn = whole(`flowchart TD\n ${shapes.slice(0, 8).join(" --> ")}\n ${shapes.slice(8).join(" --> ")}`, 200)
    for (const label of ["rect", "round", "stadium", "subroutine", "database", "circle", "decision", "hexagon", "lean right", "lean left", "trapezoid", "inverted", "flag", "double", "typed shape"]) expect(drawn).toContain(label)
    const labels = whole('flowchart TD\n A["Quoted (label) with [brackets] & more"] --> B("Call foo(bar)")\n B --> C{"Is it ok?"}\n C -->|"Yes, go"| D["`**Bold** and _soft_ words`"]\n C --> E[one<br>two<br/>three]\n E --> F["#quot;said#quot; #9829; #amp; done"]\n F --> G[Start (init) of x > 3]')
    for (const label of ["Quoted (label) with", "[brackets] & more", "Call foo(bar)", "Is it ok?", "Yes, go", "Bold and soft words", '"said" ♥ & done', "Start (init) of x > 3"]) expect(labels).toContain(label)
    const rows = labels.split("\n")
    expect(rows.findIndex((row) => row.includes("one"))).toBeLessThan(rows.findIndex((row) => row.includes("three")))
  })

  test("subgraphs in every header form, nested, with a direction, and a link that names a subgraph", () => {
    const drawn = whole(
      'flowchart TB\n subgraph one [Title One]\n  direction LR\n  a1 --> a2\n end\n subgraph two["Title Two"]\n  b1 --> b2\n  subgraph inner\n   c1\n  end\n end\n subgraph Several Words Here\n  d1\n end\n subgraph "Quoted Title"\n  e1\n end\n subgraph empty\n end\n one --> two\n a2 --> c1',
      160,
    )
    for (const title of ["Title One", "Title Two", "inner", "Several Words Here", "Quoted Title"]) expect(drawn).toContain(title)
    for (const id of ["a1", "a2", "b1", "b2", "c1", "d1", "e1"]) expect(drawn).toContain(` ${id} `)
    // `one --> two` reaches into the frames; it does not add two boxes named after them.
    expect(drawn).not.toMatch(/│ one │|│ two │/)
    // A subgraph the source never closes is closed at the end.
    expect(whole("flowchart TD\n subgraph Open\n  A --> B")).toContain("Open")
  })

  test("styling, clicks, comments, directives and front matter are read past", () => {
    const drawn = whole(
      [
        "---",
        "title: My flow",
        "config:",
        "  theme: dark",
        "---",
        "%%{init: {'theme': 'dark', 'flowchart': {'curve': 'basis'}}}%%",
        "flowchart LR",
        "  %% a comment",
        "  A:::hot --> B %% trailing comment",
        "  classDef hot fill:#f9f,stroke:#333,stroke-width:4px;",
        "  classDef default fill:#fff",
        "  class A,B hot",
        "  style A fill:#bbf,stroke:#f66",
        "  linkStyle 0 stroke:#ff3,stroke-width:4px",
        "  linkStyle default stroke:#333",
        '  click A "https://example.com" "tip"',
        "  click B call callback()",
        "  e1@{ animate: true }",
        "  accTitle: A title",
      ].join("\n"),
    )
    for (const id of ["A", "B"]) expect(drawn).toMatch(new RegExp(`│ ${id} [│├]`))
    for (const hidden of ["comment", "theme", "fill", "example.com", "animate", "My flow"]) expect(drawn).not.toContain(hidden)
    expect(drawn.split("\n").length).toBeLessThan(6)
  })

  test("graph and flowchart headers in every direction, with a ; or without a direction", () => {
    for (const header of ["graph LR", "graph RL", "graph BT", "graph TB", "graph TD;", "flowchart", "FLOWCHART td", "flowchart-elk TD", "flowchart LR;"]) {
      const drawn = whole(`${header}\n A --> B;\n B --> C;`)
      for (const id of ["A", "B", "C"]) expect(drawn).toMatch(new RegExp(`[│┤] ${id} [│├]`))
      expect((drawn.match(/[▼▲▶◀]/g) ?? []).length).toBe(2)
    }
  })

  test("ids and labels in any script, with emoji, dots and dashes", () => {
    const drawn = whole("flowchart TD\n inicio[🚀 Lanzar] --> revisión{¿Listo?}\n revisión -->|sí| fin[✅ Hecho · ñandú]\n revisión -->|no| 日本語[日本語のラベル]\n api-gateway --> user.service --> db_1")
    for (const label of ["🚀 Lanzar", "¿Listo?", "✅ Hecho · ñandú", "日本語のラベル", "sí", "api-gateway", "user.service", "db_1"]) expect(drawn).toContain(label)
  })

  test("a label wider than the column is wrapped inside it", () => {
    const long = "This is an extremely long label that goes on and on well past the width of any reasonable chat column and then keeps going"
    for (const width of [30, 50, 80]) {
      const drawn = whole(`flowchart TD\n A[${long}] --> B[ok]\n B -->|${"a long link text ".repeat(3).trim()}| C[end]`, width)
      for (const word of ["extremely", "reasonable", "keeps going", "ok", "end"]) expect(drawn).toContain(word)
    }
    const wideRow = `flowchart LR\n ${Array.from({ length: 6 }, (_, i) => `S${i}[Stage ${i} of the delivery pipeline]`).join(" --> ")}`
    const drawn = whole(wideRow, 70)
    for (let i = 0; i < 6; i++) expect(drawn).toContain(`Stage ${i}`)
  })

  test("a flowchart of 120 nodes is drawn whole when it fits, in bounded time", () => {
    const chain = `flowchart TD\n${Array.from({ length: 119 }, (_, i) => ` n${i}[Step ${i}] --> n${i + 1}[Step ${i + 1}]`).join("\n")}`
    const started = performance.now()
    const drawn = whole(chain, 100)
    expect(performance.now() - started).toBeLessThan(budgetMs(500))
    for (const at of [0, 60, 119]) expect(drawn).toContain(`│ Step ${at} │`)
    expect((drawn.match(/▼/g) ?? []).length).toBe(119)
  })

  test("a flowchart too wide or too large to draw is listed with every link, inside the width, in bounded time", () => {
    const tree = `flowchart TD\n${Array.from({ length: 119 }, (_, i) => ` n${Math.floor(i / 3)}[Node ${Math.floor(i / 3)}] --> n${i + 1}[Node ${i + 1}]`).join("\n")}`
    const dense = `flowchart LR\n${Array.from({ length: 40 }, (_, a) => Array.from({ length: 6 }, (_, b) => ` a${a} -->|l${b}| a${(a * 7 + b * 3 + 1) % 40}`).join("\n")).join("\n")}`
    const huge = `flowchart TD\n${Array.from({ length: 2999 }, (_, i) => ` n${Math.floor(i / 2)} --> n${i + 1}`).join("\n")}`
    for (const [source, said] of [[tree, "120 nodes, 119 links"], [dense, "40 nodes, 240 links"], [huge, "only the first 2000 nodes were read"]] as const) {
      for (const width of [40, 100]) {
        const started = performance.now()
        const result = renderMermaid(source, width)
        expect(performance.now() - started).toBeLessThan(budgetMs(500))
        if (!("lines" in result)) throw new Error(`no diagram: ${result.note}`)
        expect(result.note).toContain(said)
        expect(result.note).toContain("listed instead")
        expect(result.lines.length).toBeLessThanOrEqual(241)
        for (const line of result.lines) expect(textWidth(text(line))).toBeLessThanOrEqual(width)
      }
    }
    const listed = draw(tree, 100)
    expect(listed[0]).toBe("Node 0")
    expect(listed.slice(1, 4)).toEqual(["├─▶ Node 1", "├─▶ Node 2", "└─▶ Node 3"])
  })

  test("a source of any length comes back in bounded time as something drawn", () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => ` n${i} --> n${i + 1}`).join("\n")
    for (const source of [`flowchart TD\n${lines}`, `sequenceDiagram\n${Array.from({ length: 3000 }, (_, i) => ` P${i % 5}->>P${(i + 1) % 5}: message ${i}`).join("\n")}`, `weird\n${lines}`]) {
      const started = performance.now()
      const result = renderMermaid(source, 80)
      expect(performance.now() - started).toBeLessThan(budgetMs(1000))
      if (!("lines" in result)) throw new Error(`no diagram: ${result.note}`)
      expect(result.lines.length).toBeLessThanOrEqual(800)
      expect(result.note).toBeTruthy()
      for (const line of result.lines) expect(textWidth(text(line))).toBeLessThanOrEqual(80)
    }
  })

  test("class diagrams: generics, annotations, one-line bodies, cardinality on one side, every pair of ends, notes and links", () => {
    const drawn = whole(
      'classDiagram\n class Animal {\n  <<abstract>>\n  +String name\n  #List~String~ tags\n  +eat(food: Food): bool\n }\n class Shape~T~\n class Point { +int x; +int y }\n class `Odd Name`\n <<interface>> Pet\n Dog : +bark()\n Animal <|-- Dog : extends\n Animal "1" --> "*" Leg : has\n Dog "1" --> Collar\n Dog ..|> Pet\n Dog<-->Owner\n Dog *--o Tail\n Shape~T~ <|-- Circle\n note for Dog "good boy"\n note "a free note"\n link Dog "https://example.com"\n click Dog href "https://example.com"\n namespace Zoo {\n  class Cage\n }\n Cage ..> Animal',
      140,
    )
    for (const label of ["Animal", "<<abstract>>", "+eat(food: Food): bool", "Shape<T>", "Point", "+int x", "Odd Name", "«interface»", "+bark()", "extends", "1 → * has", "Collar", "Owner", "Tail", "Circle", "Zoo", "Cage"]) expect(drawn).toContain(label)
    expect(drawn).not.toContain("good boy")
    // A row of classes too wide for the room is stacked, not squeezed until its names break.
    const row = whole(`classDiagram\n direction LR\n${Array.from({ length: 9 }, (_, i) => ` Controller${i} --> Repository${i}`).join("\n")}`, 100)
    for (let i = 0; i < 9; i++) expect(row).toContain(`Controller${i}`)
  })

  test("state diagrams: names in any script, styled states, bare declarations, concurrency and display lines", () => {
    const drawn = whole(
      'stateDiagram-v2\n direction LR\n hide empty description\n [*] --> Revisión\n Revisión --> Aprobado : sí\n Revisión --> Rechazado: no\n Aprobado:::done --> [*]\n state Rechazado\n state "En espera" as Espera\n Rechazado --> Espera\n state Proceso {\n  [*] --> Paso1\n  Paso1 --> Paso2\n  --\n  Otro --> Fin\n }\n Espera --> Proceso\n note right of Revisión : la revisa alguien\n classDef done fill:#0f0\n class Aprobado done',
      140,
    )
    for (const label of ["Revisión", "Aprobado", "Rechazado", "En espera", "Proceso", "Paso1", "Paso2", "Otro", "sí", "no", "la revisa alguien"]) expect(drawn).toContain(label)
    expect(drawn).not.toContain(":::")
    const long = renderMermaid(`stateDiagram-v2\n [*] --> S0\n${Array.from({ length: 200 }, (_, i) => ` S${i} --> S${i + 1}: go`).join("\n")}`, 80)
    if (!("lines" in long)) throw new Error(`no diagram: ${long.note}`)
    expect(long.note).toContain("its links drawn as a plain graph")
    expect(long.lines.map(text).slice(0, 2)).toEqual(["S0", "└─▶ S1  go"])
    expect(long.lines.map(text).at(-1)).toMatch(/^… \d+ more rows$/)
  })

  test("ER diagrams: quoted names, an alias, worded cardinality, a relation without a label and an entity on its own", () => {
    const drawn = whole(
      'erDiagram\n CUSTOMER ||--o{ ORDER : places\n ORDER ||--|{ LINE-ITEM : contains\n "Dirección de envío" }o..|| CUSTOMER : "vive en"\n USER one to zero or more POST : writes\n USER only one optionally to many COMMENT\n p[Persona] {\n  string nombre PK\n  string email UK "the email"\n }\n p ||--o{ ORDER : makes\n LONELY\n EMPTY { }\n CUSTOMER {\n  string name PK\n  int age\n }',
      140,
    )
    for (const label of ["CUSTOMER", "ORDER", "LINE-ITEM", "Dirección de envío", "vive en", "USER", "POST", "writes", "COMMENT", "Persona", "string nombre PK", "makes", "LONELY", "EMPTY", "string name PK"]) expect(drawn).toContain(label)
    expect(drawn).not.toMatch(/│ p +│/)
  })

  test("git graphs: cherry-pick, tags, a branch order and a header with an orientation", () => {
    const drawn = whole('gitGraph LR:\n commit\n commit id: "alpha" tag: "v1"\n commit tag: "v2"\n branch feature/login order: 2\n commit type: HIGHLIGHT\n checkout main\n merge feature/login id: "m1" tag: "v3"\n cherry-pick id: "alpha"\n switch feature/login\n commit')
    for (const label of ["feature/login", "alpha", "v2", "merge feature/login", "pick alpha"]) expect(drawn).toContain(label)
    expect(drawn).not.toContain("order")
  })

  test("charts and boards: a named series over a numeric axis, bare kanban columns, a packet title, pie showData", () => {
    const chart = whole('xychart-beta\n title "Ventas"\n x-axis "Mes" 1 --> 6\n y-axis "Ingresos (k)" 0 --> 100\n bar "2024" [10, 30, 50, 70, 90, 60]\n line Meta [20, 40, 60, 80, 100, 70]', 100)
    for (const label of ["Ventas", "Ingresos (k)"]) expect(chart).toContain(label)
    const board = whole("kanban\n Todo\n  [Create docs]\n  id2[Write tests]@{ assigned: 'x', priority: 'High' }\n doing[In progress]\n  id3[Fix bug]\n Hecho ya\n  [Lanzar]", 140)
    for (const label of ["Todo", "Create docs", "Write tests", "In progress", "Fix bug", "Hecho ya", "Lanzar"]) expect(board).toContain(label)
    const packet = whole('packet-beta\n title TCP header\n 0-15: "Source Port"\n 16-31: "Destination Port"\n +32: "Sequence"', 100)
    for (const label of ["TCP header", "Source Port", "Destination Port", "Sequence"]) expect(packet).toContain(label)
    expect(whole('pie showData\n title Mascotas\n "Perros" : 386\n "Gatos" : 85.5', 100)).toContain("Perros")
    expect(whole('pie\n showData\n title Mascotas\n "Perros" : 386\n "Gatos: los dos" : 85.5', 100)).toContain("Gatos: los dos")
  })

  test("a timeline longer than the room runs down the page with every event, and a ': event' line continues its period", () => {
    const source = "timeline\n title Historia\n section Inicio\n  2002 : LinkedIn\n  2004 : Facebook : Google\n       : Flickr\n section Después\n  2005 : YouTube\n  2006 : Twitter"
    for (const width of [40, 70, 300]) {
      const drawn = whole(source, width)
      for (const label of ["Historia", "2002", "LinkedIn", "Facebook", "Google", "Flickr", "YouTube", "Twitter", "Inicio", "Después"]) expect(drawn).toContain(label)
    }
  })

  test("a picture wider than the chat is cut at the right edge with a way to see it whole; one that cannot be drawn is an outline", () => {
    // A board with more columns than fit continues on further rows of columns: nothing is cut.
    const board = whole(`kanban\n${Array.from({ length: 6 }, (_, c) => ` col${c}[Column number ${c}]\n  t${c}[A task with a longer title ${c}]`).join("\n")}`, 50)
    for (let c = 0; c < 6; c++) expect(board).toContain(`Column number ${c}`)
    const people = renderMermaid(`sequenceDiagram\n${Array.from({ length: 12 }, (_, i) => ` Service${i}->>Service${i + 1}: call number ${i}`).join("\n")}`, 50)
    if (!("lines" in people)) throw new Error(`no diagram: ${people.note}`)
    expect(people.note).toBe("wider than the chat, cut at the right edge · /diagram shows it whole")
    expect(people.lines.map(text).join("\n")).toContain("Service0")
    expect(people.lines.map(text).some((row) => row.endsWith("…"))).toBe(true)
    for (const line of people.lines) expect(textWidth(text(line))).toBeLessThanOrEqual(50)
    const many = renderMermaid(`journey\n${Array.from({ length: 700 }, (_, i) => ` Task ${i}: ${1 + (i % 5)}: Me`).join("\n")}`, 80)
    if (!("lines" in many)) throw new Error(`no diagram: ${many.note}`)
    expect(many.note).toContain("shown as an outline")
    expect(many.lines.map(text).slice(0, 2)).toEqual(["journey", "├ Task 0: 1: Me"])
    expect(many.lines.map(text).at(-1)).toMatch(/^… \d+ more lines$/)
  })

  test("one sample of every family draws at 60, 100 and 200 columns", () => {
    const samples = [
      "sequenceDiagram\n autonumber\n actor U as User\n participant A as API\n U->>+A: POST /login\n A-->>-U: 200\n Note over U,A: cached\n loop every 5s\n  A-)U: ping\n end",
      "classDiagram\n Animal <|-- Dog\n Animal : +name",
      "stateDiagram-v2\n [*] --> Idle\n Idle --> Running : start\n Running --> [*]",
      "erDiagram\n A ||--o{ B : has",
      "gantt\n title Plan\n dateFormat YYYY-MM-DD\n excludes weekends\n section Uno\n Tarea A :a1, 2024-01-01, 30d\n Tarea B :after a1, 20d\n Hito :milestone, m1, 2024-02-01, 0d",
      'pie title Pets\n "Dogs" : 386\n "Cats" : 85',
      "mindmap\n root((Centro))\n  Rama uno\n   Hoja\n  Rama dos",
      "timeline\n title T\n 2002 : A\n 2004 : B",
      "journey\n title Day\n section Work\n  Make tea: 5: Me\n  Do work: 1: Me, Cat",
      "gitGraph\n commit\n branch dev\n commit\n checkout main\n merge dev",
      "quadrantChart\n title Reach\n x-axis Low --> High\n y-axis Bad --> Good\n quadrant-1 Expand\n A: [0.3, 0.6]\n B: [0.45, 0.23]",
      'requirementDiagram\n requirement req {\n  id: 1\n  text: the text\n  risk: high\n  verifymethod: test\n }\n element ent {\n  type: sim\n }\n ent - satisfies -> req',
      'C4Context\n title System\n Person(u, "User")\n System(s, "Bank", "Does stuff")\n Rel(u, s, "Uses")',
      "xychart-beta\n x-axis [jan, feb, mar]\n bar [10, 50, 90]",
      "sankey-beta\n A,B,10\n B,C,5",
      'block-beta\n columns 2\n a["A"] b["B"]\n a --> b',
      'packet-beta\n 0-15: "Source"\n 16-31: "Destination"',
      "architecture-beta\n group api(cloud)[API]\n service db(database)[Database] in api\n service server(server)[Server] in api\n db:L -- R:server",
      "kanban\n Todo\n  [Task]",
      'radar-beta\n axis a["A"], b["B"], c["C"]\n curve x["X"]{1, 2, 3}',
      'treemap-beta\n "Root"\n  "A": 10\n  "B": 5',
    ]
    for (const source of samples) {
      for (const width of [60, 100, 200]) {
        const result = renderMermaid(source, width)
        if (!("lines" in result)) throw new Error(`no diagram at ${width}: ${result.note}\n${source}`)
        if (result.note && !result.note.includes("/diagram")) throw new Error(`drawn with a note at ${width}: ${result.note}\n${source}`)
        expect(result.lines.length).toBeGreaterThan(1)
        for (const line of result.lines) expect(textWidth(text(line))).toBeLessThanOrEqual(width)
      }
      expect(renderMermaid(source, 200)).not.toHaveProperty("note")
    }
  })
})
