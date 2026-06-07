import { afterEach, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { planReviewInlineTitle, renderPlanMarkdown } from "../../../src/cli/cmd/tui/util/plan-markdown"

const originalTermaid = process.env.MENDCODE_TERMAID_BIN

afterEach(() => {
  if (originalTermaid === undefined) delete process.env.MENDCODE_TERMAID_BIN
  else process.env.MENDCODE_TERMAID_BIN = originalTermaid
})

test("renderPlanMarkdown renders simple mermaid flowcharts without termaid", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = ["# Plan", "", "```mermaid", "flowchart TD", "  A[Find file] --> B[Edit markdown]", "```"].join("\n")

  const result = await renderPlanMarkdown(markdown, 80)
  expect(result).toContain("Find file")
  expect(result).toContain("Edit markdown")
  expect(result).toContain("╭")
  expect(result).not.toContain("flowchart TD")
})

test("planReviewInlineTitle removes redundant Plan prefix", () => {
  expect(planReviewInlineTitle("Plan: Theme System y Surface Cleanup")).toBe("Theme System y Surface Cleanup")
  expect(planReviewInlineTitle("Theme System y Surface Cleanup")).toBe("Theme System y Surface Cleanup")
  expect(planReviewInlineTitle("  ")).toBeUndefined()
})

test("renderPlanMarkdown centers mermaid titles without centering diagram rows", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = [
    "## Diagrama Mermaid",
    "",
    "```mermaid",
    "flowchart TD",
    "  A[Find file] --> B[Edit markdown]",
    "```",
  ].join("\n")

  const result = await renderPlanMarkdown(markdown, 80)
  expect(result).not.toContain("## Diagrama Mermaid")
  expect(result).toMatch(/\n {20,}Diagrama Mermaid/)
  expect(result).toContain("\n╭")
  expect(result).not.toMatch(/\n {20,}╭/)
})

test("renderPlanMarkdown accepts loose mermaid fences and unicode arrows", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = [
    "## Orden Recomendado",
    "``` Mermaid",
    "flowchart TD",
    "  A[T0.1 Preflight] —→ B[T1.1 Compose]",
    "  A –→ C[T1.2 OSRM scripts]",
    "```",
  ].join("\n")

  const result = await renderPlanMarkdown(markdown, 80)
  expect(result).toContain("Orden Recomendado")
  expect(result).toContain("T0.1 Preflight")
  expect(result).toContain("T1.1 Compose")
  expect(result).toContain("T1.2 OSRM scripts")
  expect(result).toContain("╭")
  expect(result).not.toContain("``` Mermaid")
  expect(result).not.toContain("flowchart TD")
})

test("renderPlanMarkdown prefers internal flowchart rendering over termaid", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-termaid-"))
  const bin = path.join(dir, "termaid")
  try {
    await Bun.write(bin, "#!/bin/sh\ncat >/dev/null\nprintf 'BAD TERMAID OUTPUT\\n'\n")
    chmodSync(bin, 0o755)
    process.env.MENDCODE_TERMAID_BIN = bin

    const markdown = ["# Plan", "", "```mermaid", "flowchart TD", "  A[Find file] --> B[Edit markdown]", "```"].join("\n")
    const result = await renderPlanMarkdown(markdown, 80)

    expect(result).toContain("╭")
    expect(result).toContain("Find file")
    expect(result).not.toContain("BAD TERMAID OUTPUT")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("renderPlanMarkdown keeps mermaid edge labels attached to the right nodes", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = [
    "## Mermaid Flow",
    "",
    "```mermaid",
    "flowchart TD",
    "  A[Choose Markdown file] --> B[Add hello message]",
    "  B --> C{Looks correct?}",
    "  C -- Yes --> D[Accept change]",
    "  C -- No --> B",
    "```",
  ].join("\n")

  const result = await renderPlanMarkdown(markdown, 100)
  expect(result).toContain("│ Looks correct? │")
  expect(result).toContain("├─ Yes →")
  expect(result).toContain("│ Accept change │")
  expect(result).toContain("└─ No →")
  expect(result).toContain("↺ Add hello message")
  expect(result).not.toContain("┌ Yes ┐")
  expect(result).not.toContain("┌ No ┐")
})

test("renderPlanMarkdown renders branched validation flows as boxes", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = [
    "## Simple Flow",
    "",
    "```mermaid",
    "flowchart TD",
    "  A[Select Markdown file] --> B[Add hello message]",
    "  B --> C[Check raw Markdown]",
    "  C --> D[Preview rendered output]",
    "  D --> E{Valid?}",
    "  E -- Yes --> F[Accept change]",
    "  E -- No --> G[Fix placement or formatting]",
    "  G --> C",
    "```",
  ].join("\n")

  const result = await renderPlanMarkdown(markdown, 100)
  expect(result).toContain("│ Select Markdown file │")
  expect(result).toContain("│ Add hello message │")
  expect(result).toContain("Valid?")
  expect(result).toContain("├─ Yes →")
  expect(result).toContain("└─ No →")
  expect(result).toContain("↺ Check raw Markdown")
  expect(result).not.toContain("flowchart TD")
})

test("renderPlanMarkdown leaves normal markdown unchanged", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  expect(await renderPlanMarkdown("# Plan\n\n- Step", 80)).toBe("# Plan\n\n- Step")
})

test("renderPlanMarkdown keeps unsupported mermaid blocks as code", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = ["# Plan", "", "```mermaid", "sequenceDiagram", "  A->>B: hello", "```"].join("\n")

  expect(await renderPlanMarkdown(markdown, 80)).toBe(markdown)
})
