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

test("unknown and malformed sources preserve fenced code and a single reason", async () => {
  await ui9Harness("flowchart TD\nA --> B").then(closeUi9)
  for (const source of ["unknownDiagram\nA --> B", "pie\n\"bad\": NaN", "classDiagram\nclass Broken {\n+id", "sequenceDiagram\nelse orphan", "flowchart TD\nA --> ???", "packet-beta\n8-3: reversed", "requirementDiagram\nrequirement a {\nid: 1"]) {
    expect("note" in renderMermaid(source, 100)).toBe(true)
    const rows = renderMarkdown("```mermaid\n" + source + "\n```", 100).map((line) => line.map((span) => span.text).join(""))
    expect(rows.some((row) => row.includes(source.split("\n")[0]!))).toBe(true)
    expect(rows.filter((row) => /unsupported|invalid|too complex|too wide/.test(row))).toHaveLength(1)
  }
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
  const source = "flowchart LR\n" + Array.from({ length: 30 }, (_, i) => `N${i}[Step ${i}]`).join(" --> ")
  expect("note" in renderMermaid(source, 100)).toBe(true)
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
  expect(renderMermaid(source, 1600)).toEqual({ note: MERMAID_NOTES.tooComplex })
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
  expect(renderMermaid(source, 60)).toEqual({ note: MERMAID_NOTES.tooWide })
})
