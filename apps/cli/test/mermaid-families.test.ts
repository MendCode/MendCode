import { describe, expect, test } from "bun:test"
import path from "node:path"
import { DIAGRAM_FAMILIES } from "../src/view/mermaid/families"
import { registry } from "../src/view/mermaid/registry"

const promptFile = path.join(import.meta.dir, "../../../packages/engine-native/prompts/system.md")

async function renderingSection() {
  const prompt = await Bun.file(promptFile).text()
  const start = prompt.indexOf("Terminal rendering")
  expect(start).toBeGreaterThan(-1)
  return prompt.slice(start)
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

  test("the section stays compact (at most 120 words) and mentions math, details and when a diagram fits", async () => {
    const section = await renderingSection()
    expect(section.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(120)
    for (const needle of ["$$", "<details>", "mermaid", "structure beats prose", "<kbd>"]) expect(section).toContain(needle)
  })
})
