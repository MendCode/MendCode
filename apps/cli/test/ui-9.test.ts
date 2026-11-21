import { afterEach, describe, expect, test } from "bun:test"
import fixtures from "./fixtures/mermaid-ui9.json"
import { renderMermaid } from "../src/view/mermaid"
import { renderMarkdown } from "../src/view/markdown"
import { diagramBounds, layoutDiagram } from "../src/view/mermaid-viewer"
import { textWidth } from "../src/view/wrap"
import { Canvas, MERMAID_NOTES } from "../src/view/mermaid/core"
import { closeUi9, ui9Harness } from "./ui-9-harness"
import { budgetMs } from "../../../scripts/test-budget"
import { cleanTemps } from "./session-ui-harness"

const plain = (result: ReturnType<typeof renderMermaid>) => {
  if (!("lines" in result)) throw new Error(result.note)
  return result.lines.map((line) => line.map((span) => span.text).join(""))
}

afterEach(cleanTemps)

describe("UI-9 family matrix (v1 sources and real-world variants)", () => {
  test("every registered family has two distinct fixtures with node/label expectations", () => {
    const groups = Map.groupBy(fixtures, (fixture) => fixture.kind)
    expect(groups.size).toBe(30)
    for (const group of groups.values()) {
      expect(group.length).toBeGreaterThanOrEqual(2)
      expect(new Set(group.map((fixture) => fixture.source)).size).toBeGreaterThanOrEqual(2)
      for (const fixture of group) expect(fixture.labels.length).toBeGreaterThan(1)
    }
  })
  for (const [index, fixture] of fixtures.entries()) {
    test(`${fixture.kind} fixture ${index + 1}: nodes, labels, relationships and cells at 100/180`, () => {
      for (const width of [100, 180]) {
        const result = renderMermaid(fixture.source, width)
        const rows = plain(result)
        const text = rows.join("\n")
        expect(text).toMatch(new RegExp(fixture.structure))
        for (const label of fixture.labels) expect(text).toContain(label)
        if (fixture.edges) {
          const count = fixture.edgeGlyphs === "||" ? (text.match(/\|\|[─╌┄]/g) ?? []).length : [...text].filter((char) => fixture.edgeGlyphs.includes(char)).length
          expect(count).toBe(fixture.edges)
        }
        for (const row of rows) {
          expect(textWidth(row)).toBeLessThanOrEqual(width)
          expect(row).not.toContain("\x1b")
        }
        if ("lines" in result) expect(result.lines.flat().some((span) => span.fg === "heading")).toBe(true)
      }
    })
  }
  for (const [index, fixture] of fixtures.entries()) {
    test(`${fixture.kind} fixture ${index + 1}: app harness opens the rendered canvas at both frame sizes`, async () => {
      for (const [width, height] of [[100, 30], [180, 50]]) {
        const h = await ui9Harness(fixture.source, width, height)
        try {
          expect(h.app.page).toBe("diagram")
          const rows = h.text()
          expect(rows).toHaveLength(height!)
          expect(rows.join("\n")).toContain("zoom 100%")
          expect(rows.join("\n")).not.toContain("shown as source")
          for (const row of rows) expect(textWidth(row)).toBeLessThanOrEqual(width!)
        } finally {
          await closeUi9(h)
        }
      }
    })
  }
})

test("activations, actors, autonumber and all fragment kinds are drawn", () => {
  const source = "sequenceDiagram\nautonumber 10 2\nactor U as User\nparticipant A as API\nU->>+A: request\nloop retry\nA->>A: validate\nend\npar load\nA->>U: progress\nand wait\nNote right of A: queued\nend\nopt cached\nA-->>U: cache\nend\nalt done\nA-->>-U: receipt\nelse failed\nNote over U,A: retry\nend"
  const text = plain(renderMermaid(source, 100)).join("\n")
  for (const value of ["♙ User", "║", "10. request", "12. validate", "loop", "par", "and", "opt", "alt", "else", "queued", "retry"]) expect(text).toContain(value)
})

test("CJK, combining marks and ZWJ emoji keep box geometry and full labels", () => {
  for (const source of [
    'flowchart TD\nA["資料 👩🏽‍💻 Café"] -->|"承認"| B["結果"]',
    'sequenceDiagram\nparticipant A as 開発者\nparticipant B as 👩🏽‍💻\nA->>B: 資料を確認\nNote over A,B: Café',
    'classDiagram\nclass User {\n +String 資料\n}\nUser --> Store : 保存',
    'pie title 資料\n"開発 👩🏽‍💻": 20\n"Café": 10',
    'quadrantChart\n資料: [0.5, 0.5]\n開発者: [0.5, 0.5]\nCafé: [0.5, 0.5]',
    'architecture-beta\nservice api(server)[資料 👩🏽‍💻]\nservice db(database)[保存]\napi:R --> L:db',
  ]) {
    const rows = plain(renderMermaid(source, 100))
    for (const row of rows) expect(textWidth(row)).toBeLessThanOrEqual(100)
    expect(rows.join("\n")).toContain("資料")
  }
})

test("malformed sources preserve fenced code and a single reason that quotes what was not understood", async () => {
  await ui9Harness("flowchart TD\nA --> B").then(closeUi9)
  for (const [source, reason] of [
    ["pie\n\"bad\": NaN", '1 line not understood: "bad": NaN · shown as source'],
    ["classDiagram\nclass Broken {\n+id", "1 line not understood: a { or a note that is never closed · shown as source"],
    ["sequenceDiagram\nelse orphan", "1 line not understood: else orphan · shown as source"],
    ["flowchart TD\nA --> ???", "1 line not understood: A --> ??? · shown as source"],
    ["packet-beta\n8-3: reversed", "1 line not understood: 8-3: reversed · shown as source"],
    ["requirementDiagram\nrequirement a {\nid: 1", "1 line not understood: a { or a note that is never closed · shown as source"],
  ] as const) {
    expect(renderMermaid(source, 100)).toEqual({ note: reason })
    const rows = renderMarkdown("```mermaid\n" + source + "\n```", 100).map((line) => line.map((span) => span.text).join(""))
    expect(rows.some((row) => row.includes(source.split("\n")[0]!))).toBe(true)
    expect(rows.filter((row) => /not understood|unsupported|invalid|too complex|too wide/.test(row))).toEqual([reason])
  }
})

test("a diagram type with no drawing shows its links as a graph and says so once", () => {
  const rows = renderMarkdown("```mermaid\nunknownDiagram\nA --> B\n```", 100).map((line) => line.map((span) => span.text).join(""))
  for (const id of ["A", "B"]) expect(rows.join("\n")).toContain(`│ ${id} │`)
  expect(rows.some((row) => row.includes("unknownDiagram\n"))).toBe(false)
  expect(rows.filter((row) => /no drawing here/.test(row))).toEqual(["unknownDiagram has no drawing here · its links drawn as a plain graph"])
})

test("fuzz-ish malformed inputs and adversarial layout stay bounded for every family", () => {
  let seed = 31
  const random = () => (seed = Math.imul(seed, 1664525) + 1013904223 >>> 0)
  const heads = fixtures.filter((f, i) => fixtures.findIndex((x) => x.kind === f.kind) === i).map((f) => f.source.split("\n")[0]!)
  const started = performance.now()
  for (const head of heads) {
    for (let i = 0; i < 24; i++) {
      const body = Array.from({ length: 1 + random() % 10 }, () => ["???", "}", "A --->", "note over:", '"', "@{", "columns 99999999", "0-99999999: huge", "\t".repeat(100) + "Root"][random() % 9]).join("\n")
      const result = renderMermaid(head + "\n" + body, 20 + random() % 160)
      if ("lines" in result) expect(result.lines.length).toBeLessThanOrEqual(600)
      else expect(result.note).not.toContain("\n")
    }
  }
  for (const source of ["block-beta\ncolumns 999999999\nA B", "packet-beta\n0-999999999: huge", "mindmap\n" + " ".repeat(10000) + "Root", "flowchart TD\n" + "A ".repeat(16000)]) expect("note" in renderMermaid(source, 100)).toBe(true)
  expect(performance.now() - started).toBeLessThan(budgetMs(1000))
})

test("oversized layouts really render in the viewer and pan horizontally", () => {
  const source = "flowchart TD\nR --> " + Array.from({ length: 30 }, (_, i) => `N${i}[Step ${i}]`).join(" & ")
  // The chat stacks the row of thirty boxes into its hundred columns; the viewer lays the row out as written.
  const chat = renderMermaid(source, 100)
  for (const row of plain(chat)) expect(textWidth(row)).toBeLessThanOrEqual(100)
  expect(plain(chat).join("\n")).toContain("Step 29")
  const layout = layoutDiagram({ source, zoom: 0, render: renderMermaid })
  expect(layout.note).toBeUndefined()
  expect(diagramBounds(layout, 100, 30).maxX).toBeGreaterThan(0)
})

test("subgraphs preserve shapes, all edge styles and endpoint decorations", () => {
  for (const direction of ["TD", "TB", "BT", "LR", "RL"]) {
    const source = `graph ${direction}\nsubgraph cluster[Storage]\nA((Client)) o--o B{Ready?}\nB -.-> C[[Commit]]\nC ==> D([Done])\nend`
    const text = plain(renderMermaid(source, 180)).join("\n")
    for (const glyph of ["╔", "╱", "╭", "○"]) expect(text).toContain(glyph)
    expect(text).toMatch(/[┄┆]/)
    expect(text).toMatch(/[━┃]/)
    expect((text.match(/○/g) ?? []).length).toBe(2)
    for (const label of ["Storage", "Client", "Ready?", "Commit", "Done"]) expect(text).toContain(label)
  }
})

test("every traditional and extended flowchart shape preserves its label", () => {
  const nodes = ['R[Rect]', 'O(Round)', 'S([Stadium])', 'C((Circle))', 'D(((Double)))', 'Q{Decision}', 'H{{Hexagon}}', 'B[(Database)]', 'F[[Subroutine]]', 'P[/Input/]', 'T[\\Trap/]', 'A>Asymmetric]']
  const source = "flowchart TD\n" + nodes.map((node, i) => i ? `${nodes[i - 1]!.match(/^\w+/)![0]} --> ${node}` : node).join("\n")
  const text = plain(renderMermaid(source, 100)).join("\n")
  for (const label of ["Rect", "Round", "Stadium", "Circle", "Double", "Decision", "Hexagon", "Database", "Subroutine", "Input", "Trap", "Asymmetric"]) expect(text).toContain(label)
  const extended = plain(renderMermaid('flowchart LR\nA@{ shape: cyl, label: "Database" } --> B@{ shape: cloud, label: "Remote" }', 100)).join("\n")
  expect(extended).toContain("Database")
  expect(extended).toContain("Remote")
})

test("namespaces and members are laid out inside their class cluster", () => {
  const source = "classDiagram\nnamespace Billing {\nclass Invoice {\n+UUID id\n+total() Money\n}\nclass Payment {\n+String receipt\n}\nInvoice --> Payment : settles\n}"
  const text = plain(renderMermaid(source, 100)).join("\n")
  for (const label of ["Billing", "Invoice", "UUID id", "total() Money", "Payment", "receipt", "settles"]) expect(text).toContain(label)
  expect((text.match(/◀/g) ?? []).length).toBe(1)
})

test("packet ranges cross word boundaries, remain ordered and retain wrapped labels", () => {
  const rows = plain(renderMermaid('packet-beta\n0-47: "A long field across words"\n+16: "Checksum"', 60))
  const text = rows.join("\n")
  for (const label of ["word 0", "word 1", "0–31", "32–47", "48–63", "Checksum"]) expect(text).toContain(label)
  for (const row of rows) expect(textWidth(row)).toBeLessThanOrEqual(60)
  for (const source of ['packet-beta\n0-7: "one"\n4-9: "overlap"', 'packet-beta\n+0: "empty"']) expect("note" in renderMermaid(source, 100)).toBe(true)
})

test("valid prefixes do not hide invalid relations, dates or numeric data", () => {
  for (const source of [
    "classDiagram\nA --> B\ninvalid syntax!",
    "stateDiagram-v2\nA --> B\nnote right of B\nunclosed note",
    "erDiagram\nA ||--o{ B : uses\n???",
    "architecture-beta\nservice a(server)[A] trailing garbage",
    "architecture-beta\ngroup a(cloud)[A] in b\ngroup b(cloud)[B] in a\nservice s(server)[Service] in a",
    'radar-beta\naxis a["A"], b["B"]\ncurve c["C"]{8, broken}',
    "xychart-beta\nbar [1, 2..3]",
    "gantt\nTask :2026-02-30, 2d",
    "gantt\nTask :after missing, 2d",
    "gitGraph\ncommit\ncheckout missing\ncommit",
  ]) expect("note" in renderMermaid(source, 100)).toBe(true)
  expect(plain(renderMermaid("flowchart TD\nA[Infinity] --> B[NaN]", 100)).join("\n")).toContain("Infinity")
})

test("canvas allocation and cross-product layouts are bounded before memory is reserved", () => {
  expect(() => new Canvas(1600, 600)).toThrow(MERMAID_NOTES.tooComplex)
  const source = "mindmap\nroot\n " + "wide ".repeat(100) + "\n" + Array.from({ length: 100 }, (_, i) => " ".repeat(2 + i % 10) + `Node ${i}`).join("\n")
  const started = performance.now()
  // No canvas is reserved for it: the statements come back as an outline.
  const result = renderMermaid(source, 1600)
  expect(result.note).toBe("too large for its own drawing · shown as an outline")
  expect(plain(result).slice(0, 2)).toEqual(["mindmap", "├ root"])
  expect(performance.now() - started).toBeLessThan(budgetMs(1000))
})

test("all families adapt or return source safely at 60 cells, including the viewer", () => {
  for (const fixture of fixtures) {
    const result = renderMermaid(fixture.source, 60)
    if ("lines" in result) for (const row of plain(result)) expect(textWidth(row)).toBeLessThanOrEqual(60)
    const viewer = layoutDiagram({ source: fixture.source, zoom: 0, render: renderMermaid })
    expect(viewer.note).toBeUndefined()
    expect(viewer.height).toBeGreaterThan(2)
  }
})

test("all C4 variants preserve bare and quoted arguments, descriptions and relations", () => {
  for (const header of ["C4Context", "C4Container", "C4Component", "C4Dynamic", "C4Deployment"]) {
    const rows = plain(renderMermaid(`${header}\nPerson(user, User)\nSystem(app, "Application", "API, storage")\nRel(user, app, Uses)`, 100))
    const text = rows.join("\n")
    for (const label of ["User", "Application", "API, storage", "Uses"]) expect(text).toContain(label)
    expect((text.match(/▶/g) ?? []).length).toBe(1)
  }
})

test("inline comments do not become nodes or erase quoted percent labels", () => {
  for (const source of [
    'flowchart TD\nA["CPU 50%%"] --> B[Done] %% comment',
    'sequenceDiagram\nparticipant A as User %% comment\nA->>B: done %% comment',
    'pie\n"CPU 50%%": 10 %% comment\n"Idle": 20',
  ]) {
    const text = plain(renderMermaid(source, 100)).join("\n")
    expect(text).not.toContain("comment")
    if (source.includes("CPU")) expect(text).toContain("CPU 50%%")
  }
})

test("long sequence fragment headings never clip labels or overwrite closing borders", () => {
  const label = "Retry while the billing service completes a multi region reconciliation operation"
  const source = `sequenceDiagram\nparticipant A as API\nloop ${label}\nA->>A: retry\nend`
  const rows = plain(renderMermaid(source, 100))
  expect(rows.join("\n")).toContain(label)
  expect(rows.find((row) => row.includes(label))!.trimEnd().endsWith("┐")).toBe(true)
  for (const row of rows) expect(textWidth(row)).toBeLessThanOrEqual(100)
  // Too wide for 60 columns, it is cut at the right edge and says where to see it whole.
  const cut = renderMermaid(source, 60)
  expect(cut.note).toBe("wider than the chat, cut at the right edge · /diagram shows it whole")
  for (const row of plain(cut)) expect(textWidth(row)).toBeLessThanOrEqual(60)
  expect(plain(cut).join("\n")).toContain("Retry while the billing service")
})
