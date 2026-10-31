import { describe, expect, test } from "bun:test"
import type { Line } from "../src/ui/theme"
import { MERMAID_NOTES, renderMermaid } from "../src/view/mermaid"
import { textWidth } from "../src/view/wrap"

const text = (line: Line) => line.map((span) => span.text).join("")

function draw(source: string, width = 100): string[] {
  const result = renderMermaid(source, width)
  if (!("lines" in result)) throw new Error(`fell back (${result.note}) for:\n${source}`)
  return result.lines.map(text)
}

/** The frame whose top border carries `title`: its row, and the columns of its two corners. */
function frameOf(rows: string[], title: string) {
  const top = rows.findIndex((row) => row.includes(`─ ${title} `))
  expect(top).toBeGreaterThanOrEqual(0)
  const row = [...rows[top]!]
  const at = rows[top]!.indexOf(`─ ${title} `)
  const left = [...rows[top]!.slice(0, at)].length - 1
  let right = left + 1
  while (right < row.length && row[right] !== "┐") right++
  const cells = (y: number) => [...rows[y]!]
  let bottom = top + 1
  while (bottom < rows.length && cells(bottom)[left] !== "└") bottom++
  return { top, bottom, left, right }
}

const STAGES = `flowchart LR
  subgraph Stage1[Collect inputs from every source]
    a1[Source alpha with long name] --> a2[Normalize alpha records]
  end
  subgraph Stage2[Transform and enrich the data]
    b1[Join with reference tables] --> b2[Compute derived metrics]
  end
  subgraph Stage3[Publish results downstream]
    c1[Write to warehouse] --> c2[Notify subscribers]
  end
  a2 --> b1
  b2 --> c1`

describe("flowchart subgraphs are laid out as clusters", () => {
  test("TD: two subgraphs are separate frames, each holding its own boxes, one above the other", () => {
    const rows = draw(`flowchart TD
  subgraph Client
    UI[Terminal UI] --> Cmd[Slash commands]
  end
  subgraph Daemon
    Sock[Socket server] --> Eng[Engine]
  end
  Cmd --> Sock`)
    const client = frameOf(rows, "Client")
    const daemon = frameOf(rows, "Daemon")
    expect(client.bottom).toBeLessThan(daemon.top)
    const inside = (frame: ReturnType<typeof frameOf>, label: string) => {
      const y = rows.findIndex((row) => row.includes(label))
      const x = [...rows[y]!.slice(0, rows[y]!.indexOf(label))].length
      return y > frame.top && y < frame.bottom && x > frame.left && x < frame.right
    }
    expect(inside(client, "Terminal UI") && inside(client, "Slash commands")).toBe(true)
    expect(inside(daemon, "Socket server") && inside(daemon, "Engine")).toBe(true)
    expect(inside(client, "Engine")).toBe(false)
    // The old scene stacked every box in one column with a side channel per edge; the layered one draws the edge straight down.
    expect(rows.join("\n")).toContain("▼")
  })

  test("nested subgraphs nest their frames: the inner frame lies inside the outer one", () => {
    const rows = draw(`flowchart TD
  subgraph Platform
    subgraph Ingest
      A[Webhook] --> B[Queue]
    end
    subgraph Review
      C[Planner] --> D[Reviewer]
    end
    B --> C
  end
  D --> E[Post comments]`)
    const outer = frameOf(rows, "Platform")
    for (const title of ["Ingest", "Review"]) {
      const inner = frameOf(rows, title)
      expect(inner.top).toBeGreaterThan(outer.top)
      expect(inner.bottom).toBeLessThan(outer.bottom)
      expect(inner.left).toBeGreaterThan(outer.left)
      expect(inner.right).toBeLessThan(outer.right)
    }
    const after = rows.findIndex((row) => row.includes("Post comments"))
    expect(after).toBeGreaterThan(outer.bottom)
  })

  test("LR: clusters sit side by side with the edge between them crossing both borders", () => {
    const rows = draw(`flowchart LR
  subgraph Build
    src[Sources] --> bin[Binary]
  end
  subgraph Ship
    rel[Release] --> inst[Installer]
  end
  bin --> rel`)
    const all = rows.join("\n")
    for (const label of ["Build", "Ship", "Sources", "Binary", "Release", "Installer"]) expect(all).toContain(label)
    const row = rows.find((line) => line.includes("Binary") && line.includes("Release"))!
    expect(row).toBeDefined()
    expect(row.indexOf("Binary")).toBeLessThan(row.indexOf("Release"))
    expect(row).toContain("┼")
  })

  test("a wide LR flow with subgraphs is laid out top-down instead of falling back, inside the width", () => {
    expect(draw(STAGES, 200).find((row) => row.includes("Source alpha with long name") && row.includes("Notify subscribers"))).toBeDefined()
    const rows = draw(STAGES, 100)
    for (const row of rows) expect(textWidth(row)).toBeLessThanOrEqual(100)
    const order = ["Collect inputs from every source", "Transform and enrich the data", "Publish results downstream"].map((title) => frameOf(rows, title).top)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    // Labels stay whole: the stacked scene used to split words to fit its boxes ("Normaliz e alpha").
    for (const label of ["Normalize alpha records", "Join with reference tables", "Write to warehouse"]) expect(rows.join("\n")).toContain(label)
  })

  test("without subgraphs a flow too wide for the chat keeps the note, so /diagram draws it at full size", () => {
    const plain = "flowchart LR\n  A[Collect every input source] --> B[Normalize all the records] --> C[Join with reference tables] --> D[Compute derived metrics] --> E[Write to the warehouse]"
    expect(renderMermaid(plain, 100)).toEqual({ note: MERMAID_NOTES.tooWide })
    expect("lines" in renderMermaid(plain, 200)).toBe(true)
  })

  test("a chain taller than the canvas allows stays a note through every retry, with or without subgraphs", () => {
    const many = Array.from({ length: 100 }, (_, i) => `n${i} --> n${i + 1}`).join("\n")
    expect(renderMermaid(`flowchart TD\n${many}`, 200)).toEqual({ note: MERMAID_NOTES.tooComplex })
    expect(renderMermaid(`flowchart TD\nsubgraph Big\n${many}\nend`, 200)).toEqual({ note: MERMAID_NOTES.tooComplex })
  })
})
