import { describe, expect, test } from "bun:test"
import path from "node:path"
import { CALLOUTS } from "../src/view/markdown-style"
import { renderMarkdown } from "../src/view/markdown"
import { markdownStyleFor } from "../src/view/markdown-style"
import { DIAGRAM_FAMILIES } from "../src/view/mermaid/families"
import { registry } from "../src/view/mermaid/registry"

const promptFile = path.join(import.meta.dir, "../../../packages/daemon/prompts/rendering.md")

async function renderingSection() {
  const prompt = await Bun.file(promptFile).text()
  const start = prompt.indexOf("Terminal rendering")
  expect(start).toBeGreaterThan(-1)
  return prompt.slice(start, prompt.indexOf("<!-- short -->"))
}

/** Headers mermaid.ts dispatches itself, before the registry. */
const DIRECT_HEADERS = ["flowchart", "graph", "sequencediagram"]

describe("diagram families, registry and system prompt", () => {
  test("every registry header and every directly dispatched header belongs to exactly one family", () => {
    const claimed = DIAGRAM_FAMILIES.flatMap((family) => family.headers)
    expect(new Set(claimed).size).toBe(claimed.length)
    expect([...claimed].sort()).toEqual([...Object.keys(registry), ...DIRECT_HEADERS].sort())
  })

  test("the system prompt lists exactly the families the terminal renders, in order", async () => {
    const section = await renderingSection()
    const listed = /Families: ([^.]+)\./.exec(section)![1]!.split(",").map((name) => name.trim())
    expect(listed).toEqual(DIAGRAM_FAMILIES.map((family) => family.name))
  })

  test("the section stays compact (at most 180 words) and mentions math, details and when a diagram fits", async () => {
    const section = await renderingSection()
    expect(section.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(180)
    for (const needle of ["$$", "<details>", "mermaid", "structure beats prose", "<kbd>"]) expect(section).toContain(needle)
  })

  test("the callouts the full prompt names are exactly the ones the enhanced renderer draws, and the syntax it shows renders", async () => {
    const section = await renderingSection()
    const named = [...section.matchAll(/\[!([A-Z]+)\]/g)].map((match) => match[1]!.toLowerCase())
    expect(named).toContain("note")
    for (const kind of CALLOUTS) expect(section).toContain(kind.toUpperCase())
    const style = markdownStyleFor({ profile: { tableStyle: "auto", headingStyle: "auto", markdownCopyHints: "auto", markdownRtl: true, messageRenderer: "full" }, mode: "balanced" })
    for (const kind of CALLOUTS) {
      const rows = renderMarkdown(`> [!${kind.toUpperCase()}]\n> text`, 40, "body", { style }).map((line) => line.map((span) => span.text).join(""))
      expect(rows[0]).toContain(kind.toUpperCase())
      expect(rows.join("\n")).not.toContain("[!")
    }
  })
})
