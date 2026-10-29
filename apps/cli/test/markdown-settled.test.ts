import { describe, expect, test } from "bun:test"
import type { Line } from "../src/ui/theme"
import { renderMarkdown, renderMarkdownWhole } from "../src/view/markdown"
import { foldOf, gutterOf, softWrapOf } from "../src/view/line-meta"

/** Rows with what the layout keeps beside them, so a memoised row must carry the same meta as a freshly rendered one. */
const describeRows = (lines: Line[]) => lines.map((line) => ({ spans: line, gutter: gutterOf(line), soft: softWrapOf(line), fold: foldOf(line) }))

/** A deterministic generator: the same seed always writes the same answer. */
function random(seed: number) {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

const BLOCKS = [
  (n: number) => `# Heading ${n} with \`code\``,
  (n: number) => `A paragraph ${n} with **bold**, *italic*, a [link](https://example.com/${n}) and a color #ff8800 that wraps around the width of the viewport when it is long enough to wrap.`,
  (n: number) => `- item ${n}\n- item ${n + 1}\n  - nested ${n}\n    - deeper ${n}\n- [ ] task ${n}`,
  (n: number) => `1. first ${n}\n2. second ${n}\n   continued text`,
  (n: number) => `\`\`\`ts\nconst value${n} = ${n}\n\nreturn value${n}\n\`\`\``,
  (n: number) => `~~~\nplain fence ${n}\n~~~`,
  (n: number) => `| Name | Qty |\n|:-----|----:|\n| apple ${n} | 3 |\n| kiwi | 12 |`,
  (n: number) => `> quoted ${n}\n> second line`,
  () => "---",
  (n: number) => `  indented after a blank line ${n}`,
  (n: number) => `- list ${n}\n\n  - nested after a blank\n\n- back to the top`,
]

function answer(seed: number, blocks: number) {
  const next = random(seed)
  const parts: string[] = []
  for (let i = 0; i < blocks; i++) parts.push(BLOCKS[Math.floor(next() * BLOCKS.length)]!(i))
  return parts.map((part) => part + (next() < 0.2 ? "\n\n\n" : "\n\n")).join("").trimEnd()
}

describe("settled-prefix rendering", () => {
  test("a long answer renders exactly as the whole renderer does, rows and row meta", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const source = answer(seed, 40)
      expect(source.length).toBeGreaterThan(1200)
      for (const width of [24, 60, 100]) expect(describeRows(renderMarkdown(source, width))).toEqual(describeRows(renderMarkdownWhole(source, width)))
    }
  })

  test("streaming a long answer in random chunks matches the whole renderer at every step", () => {
    for (let seed = 100; seed < 112; seed++) {
      const next = random(seed)
      const source = answer(seed, 40)
      const width = [40, 80, 120][seed % 3]!
      let shown = 0
      while (shown < source.length) {
        shown = Math.min(source.length, shown + 1 + Math.floor(next() * 60))
        const text = source.slice(0, shown)
        expect(describeRows(renderMarkdown(text, width))).toEqual(describeRows(renderMarkdownWhole(text, width)))
      }
    }
  })

  test("an open code fence, details, display math and diagrams are never split", () => {
    const filler = "Filler paragraph that keeps the source above the settled threshold.\n\n".repeat(30)
    for (const tail of ["```ts\nconst a = 1\n\nconst b = 2", "<details><summary>More</summary>\n\nhidden\n\n</details>\n\nafter", "$$\nx^2\n\ny^2\n$$\n\nafter", "```mermaid\ngraph TD\nA-->B\n```\n\nafter"]) {
      const source = filler + tail
      expect(describeRows(renderMarkdown(source, 80))).toEqual(describeRows(renderMarkdownWhole(source, 80)))
    }
  })

  test("a growing answer reuses its settled rows instead of rendering them again", () => {
    const paragraph = (n: number) => `Paragraph ${n} with **bold** and \`code\` and a few more words to fill the line.\n\n`
    const settled = Array.from({ length: 30 }, (_, n) => paragraph(n)).join("")
    const first = renderMarkdown(settled + "open tail", 80)
    const second = renderMarkdown(settled + "open tail grows", 80)
    // The rows of every settled paragraph are the same objects, not copies: only the tail was laid out again.
    const shared = second.filter((row) => first.includes(row)).length
    expect(shared).toBeGreaterThanOrEqual(first.length - 2)
  })
})
