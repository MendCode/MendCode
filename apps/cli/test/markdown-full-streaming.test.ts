import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { Line } from "../src/ui/theme"
import { renderMarkdown, renderMarkdownWhole, type MarkdownStyle } from "../src/view/markdown"
import { copyOf, foldOf, gutterOf, softWrapOf } from "../src/view/line-meta"
import { textWidth } from "../src/view/wrap"
import { budgetMs } from "../../../scripts/test-budget"

const FULL: MarkdownStyle = { enhanced: true, table: "box", heading: "underline", copy: "all", rtl: true }
const STYLES: MarkdownStyle[] = [FULL, { ...FULL, table: "grid", heading: "banner" }, { ...FULL, table: "rules", heading: "uppercase", copy: "code" }, { enhanced: true, table: "minimal", heading: "bold", copy: "off", rtl: false }]

/** Rows with what the layout keeps beside them, so a memoised row must carry the same meta as a freshly rendered one. */
const describeRows = (lines: Line[]) => lines.map((line) => ({ spans: line, gutter: gutterOf(line), soft: softWrapOf(line), fold: foldOf(line), copy: copyOf(line) }))
const text = (lines: Line[]) => lines.map((line) => line.map((span) => span.text).join(""))

function random(seed: number) {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

const BLOCKS = [
  (n: number) => `# Heading ${n} with \`code\``,
  (n: number) => `## Second ${n}`,
  (n: number) => `A paragraph ${n} with **bold**, ~~gone~~, a [link](https://example.com/${n}), a footnote[^${n}] and a color #ff8800 that wraps around the width of the viewport when it is long enough.`,
  (n: number) => `[^${n}]: the footnote ${n}`,
  (n: number) => `- item ${n}\n- item ${n + 1}\n  - nested ${n}\n    - deeper ${n}\n- [x] task ${n}\n- [ ] open ${n}`,
  (n: number) => `1. first ${n}\n2. second ${n}\n   continued text`,
  (n: number) => `\`\`\`ts\nconst value${n} = ${n} // c\n\nreturn value${n}\n\`\`\``,
  (n: number) => `\`\`\`bash\n$ git commit -m "x${n}" --no-verify\n\`\`\``,
  (n: number) => `~~~\nplain fence ${n}\n~~~`,
  (n: number) => `| Name | Qty | 名前 |\n|:-----|----:|:---:|\n| apple ${n} | 3 | 猫 |\n| kiwi | 12 | 🚀 |`,
  (n: number) => `> quoted ${n}\n> second line\n> third\n> fourth`,
  (n: number) => `> [!NOTE]\n> callout ${n}`,
  () => "---",
  (n: number) => `שלום עולם ${n} זו פסקה בעברית with English and 2024 numbers שמתארכת מעבר לרוחב`,
  (n: number) => `- פריט ${n} ברשימה\n- item ${n}`,
  (n: number) => `  indented after a blank line ${n}`,
]

function parts(seed: number, count: number) {
  const next = random(seed)
  return Array.from({ length: count }, (_, i) => BLOCKS[Math.floor(next() * BLOCKS.length)]!(i))
}
const answer = (seed: number, count: number) => parts(seed, count).join("\n\n")

describe("enhanced rendering while streaming", () => {
  test("the settled-prefix memo renders exactly as the whole renderer does, in every style", () => {
    for (const style of STYLES) {
      for (let seed = 1; seed <= 12; seed++) {
        const source = answer(seed, 40)
        expect(source.length).toBeGreaterThan(1200)
        for (const width of [24, 60, 100]) expect(describeRows(renderMarkdown(source, width, "body", { style }))).toEqual(describeRows(renderMarkdownWhole(source, width, "body", { style })))
      }
    }
  })

  test("streaming in random chunks matches the whole renderer at every step", () => {
    for (let seed = 100; seed < 106; seed++) {
      const next = random(seed)
      const source = answer(seed, 40)
      const style = STYLES[seed % STYLES.length]!
      let shown = 0
      while (shown < source.length) {
        shown = Math.min(source.length, shown + 1 + Math.floor(next() * 80))
        const part = source.slice(0, shown)
        expect(describeRows(renderMarkdown(part, [40, 80, 120][seed % 3]!, "body", { style }))).toEqual(describeRows(renderMarkdownWhole(part, [40, 80, 120][seed % 3]!, "body", { style })))
      }
    }
  })

  test("a finished block never changes while the next one streams in, character by character", () => {
    for (const style of [FULL, STYLES[1]!]) {
      for (let seed = 7; seed < 13; seed++) {
        const blocks = parts(seed, 8)
        for (let k = 1; k < blocks.length; k++) {
          const done = blocks.slice(0, k).join("\n\n")
          const finished = renderMarkdownWhole(done, 50, "body", { style })
          const frozen = describeRows(finished)
          const next = blocks[k]!
          for (let at = 1; at <= next.length; at++) {
            const rows = renderMarkdownWhole(`${done}\n\n${next.slice(0, at)}`, 50, "body", { style })
            expect(describeRows(rows.slice(0, finished.length)), `${seed}/${k}@${at}`).toEqual(frozen)
            expect(rows[finished.length]?.length ?? 0, `${seed}/${k}@${at}: blank row after the finished block`).toBe(0)
          }
        }
      }
    }
  })

  test("an open fence keeps its header and grows by one row per line", () => {
    const lines = ["```ts", "const a = 1", "const b = 2", "const c = 3"]
    let previous = 0
    for (let n = 1; n <= lines.length; n++) {
      const rows = renderMarkdown(lines.slice(0, n).join("\n"), 40, "body", { style: FULL })
      expect(text(rows)[0]!.startsWith("╭─ ts ")).toBe(true)
      expect(rows.length).toBe(previous + 1)
      previous = rows.length
    }
  })

  test("a table that is still being typed never breaks the width", () => {
    const table = "| a | b |\n|---|---|\n| 1 | 2 |"
    for (const style of STYLES) for (let at = 1; at <= table.length; at++) for (const row of text(renderMarkdownWhole(table.slice(0, at), 20, "body", { style }))) expect(textWidth(row)).toBeLessThanOrEqual(20)
  })
})

describe("performance", () => {
  const TORTURE = fs.readFileSync(path.join(import.meta.dir, "fixtures", "markdown-torture.md"), "utf8").replace(/```mermaid[\s\S]*?```/g, "")
  const document = () => {
    const out: string[] = []
    while (out.join("\n").split("\n").length < 2000) out.push(TORTURE)
    return out.join("\n\n").split("\n").slice(0, 2000).join("\n")
  }

  test("the enhanced engine renders a 2000 line document at width 100 in under 50 ms", () => {
    const source = document()
    renderMarkdown(source, 100, "body", { style: FULL })
    const started = performance.now()
    const rows = renderMarkdownWhole(source, 100, "body", { style: FULL })
    const elapsed = performance.now() - started
    expect(elapsed).toBeLessThan(budgetMs(50))
    expect(rows.length).toBeGreaterThan(1500)
  })

  test("a streamed frame of a long answer costs the open paragraph, not the answer", () => {
    const source = answer(3, 120)
    renderMarkdown(source, 100, "body", { style: FULL })
    const started = performance.now()
    for (let at = 0; at < 20; at++) renderMarkdown(`${source}\n\nA tail that grows ${"x".repeat(at)}`, 100, "body", { style: FULL })
    expect((performance.now() - started) / 20).toBeLessThan(budgetMs(10))
  })

  test("highlighting a shell line stays well under the per-line budget", () => {
    const { highlight } = require("../src/view/syntax") as typeof import("../src/view/syntax")
    const line = '$ git commit -m "fix: handle empty input" --no-verify # skip hooks'
    const started = performance.now()
    for (let i = 0; i < 20_000; i++) highlight(line, "bash")
    expect((performance.now() - started) / 20_000).toBeLessThan(budgetMs(0.05))
  })
})
