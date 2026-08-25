import { afterEach, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import {
  hasStyledHexColors,
  isMermaidAsciiCardContent,
  mermaidAsciiCardViewport,
  shouldColorizeHexMarkdownLine,
  shouldRenderStableTextPlain,
  wrapMarkdownDisplayCodeBlocks,
  wrapPlainDisplayText,
} from "../../../src/cli/cmd/tui/component/styled-plan-markdown"
import {
  extractMermaidSources,
  hasMermaidFence,
  planReviewInlineTitle,
  renderPlanMarkdown,
  renderMermaidAsciiCard,
  renderPlanMarkdownStatic,
  renderPlanMarkdownStreaming,
  renderStreamingMarkdownTail,
  streamingMarkdownCommitIndex,
  visibleStreamingMarkdownPreview,
} from "../../../src/cli/cmd/tui/util/markdown-render"
import { styledPlanMarkdownSegments, visibleStyledPlanMarkdownLines } from "../../../src/cli/cmd/tui/util/styled-plan-lines"

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

test("renderPlanMarkdown strips decoded markup from Mermaid labels", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = [
    "```mermaid",
    "flowchart LR",
    '  A["Safe &lt;script&gt;hidden&lt;/script&gt; label"] --> B[Next]',
    "```",
  ].join("\n")

  const result = await renderPlanMarkdown(markdown, 100)
  expect(result).toContain("Safe hidden label")
  expect(result).not.toContain("script")
  expect(result).not.toContain("<")
  expect(result).not.toContain(">")
})

test("renderPlanMarkdown attaches single Mermaid edge labels to the vertical connector", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = [
    "```mermaid",
    "flowchart TD",
    "  A[Approve?] -->|yes| B[Implement]",
    "```",
  ].join("\n")

  const result = await renderPlanMarkdown(markdown, 100)
  expect(result).toContain("yes ──┤")
  expect(result).not.toMatch(/\n\s+yes\s*\n/)
})

test("renderPlanMarkdown centers Mermaid TD branches around their parent", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = [
    "```mermaid",
    "flowchart TD",
    "  A[Root] --> B[Left branch]",
    "  A --> C[Right branch]",
    "```",
  ].join("\n")

  const result = await renderPlanMarkdown(markdown, 100)
  const lines = result.split("\n")
  const boxColumn = (label: string) => {
    const contentColumn = lines.find((line) => line.includes(`│ ${label}`))?.indexOf(`│ ${label}`) ?? -1
    return contentColumn < 0 ? -1 : contentColumn - 1
  }
  const rootColumn = boxColumn("Root")
  const leftColumn = boxColumn("Left branch")
  const rightColumn = boxColumn("Right branch")

  expect(rootColumn).toBeGreaterThan(0)
  expect(leftColumn).toBeLessThan(rootColumn)
  expect(rightColumn).toBeGreaterThan(rootColumn)
  expect(result).toContain("┌")
  expect(result).toContain("▼")
})

test("planReviewInlineTitle removes redundant Plan prefix", () => {
  expect(planReviewInlineTitle("Plan: Theme System y Surface Cleanup")).toBe("Theme System y Surface Cleanup")
  expect(planReviewInlineTitle("Theme System y Surface Cleanup")).toBe("Theme System y Surface Cleanup")
  expect(planReviewInlineTitle("  ")).toBeUndefined()
})

test("Mermaid ASCII cards keep wide and tall canvases inside a bounded viewport", () => {
  const journey = [
    "journey",
    "  title Checkout journey",
    "  section Purchase",
    "    Add to cart: 5: Customer",
    "    Enter payment: 2: Customer, Payment",
    "    Confirm order: 5: Customer",
  ].join("\n")
  const wide = renderMermaidAsciiCard(journey, 160)
  const wideViewport = mermaidAsciiCardViewport(wide, 60)
  expect(isMermaidAsciiCardContent(wide)).toBe(true)
  expect(wideViewport.viewportWidth).toBe(60)
  expect(wideViewport.overflowX).toBe(true)

  const fitted = renderMermaidAsciiCard(journey, 64)
  expect(Math.max(...fitted.split("\n").map((line) => Bun.stringWidth(line)))).toBeLessThanOrEqual(64)
  expect(fitted.split("\n").length).toBeGreaterThan(wide.split("\n").length)

  const longFlow = renderMermaidAsciiCard([
    "flowchart LR",
    ...Array.from({ length: 120 }, (_, index) => `n${index}[Step ${index}] --> n${index + 1}[Step ${index + 1}]`),
  ].join("\n"), 60)
  const tallViewport = mermaidAsciiCardViewport(longFlow, 60)
  expect(tallViewport.naturalWidth).toBeLessThanOrEqual(60)
  expect(tallViewport.overflowY).toBe(true)
  expect(tallViewport.viewportRows).toBe(28)
})

test("Mermaid card controls can recover each original source block in message order", () => {
  const markdown = [
    "before",
    "```mermaid",
    "flowchart TD",
    "  A --> B",
    "```",
    "between",
    "```mermaid",
    "journey",
    "  section Buy",
    "    Pay: 5: Customer",
    "```",
  ].join("\n")
  expect(extractMermaidSources(markdown)).toEqual([
    "flowchart TD\n  A --> B",
    "journey\n  section Buy\n    Pay: 5: Customer",
  ])
})

test("public Mermaid ASCII documentation includes the complete visual fixture catalog", () => {
  const fixtureNames = [
    "flowchart", "swimlane-beta", "sequenceDiagram", "classDiagram", "stateDiagram-v2", "erDiagram", "journey",
    "gantt", "pie", "quadrantChart", "requirementDiagram", "gitGraph", "C4Context", "mindmap", "timeline", "zenuml",
    "sankey", "xychart-beta", "block-beta", "packet-beta", "kanban", "architecture-beta", "radar-beta", "eventmodeling",
    "treemap-beta", "venn-beta", "ishikawa-beta", "wardley-beta", "cynefin-beta", "treeView-beta",
    "STRESS · swimlane 4 lanes", "STRESS · class relation matrix", "STRESS · state branches and terminal",
    "STRESS · ER fields and cross-links", "STRESS · journey multi-section", "STRESS · gantt dependencies",
    "STRESS · quadrant labels and points", "STRESS · requirement relations", "STRESS · git branches and merge",
    "STRESS · mixed XY", "STRESS · radar 6 axes", "STRESS · deep TreeView", "LONG FLOWCHART (120 NODES)",
    "CYCLES AND BRANCHES", "ADVERSARIAL METADATA",
  ]
  const documentationPath = path.resolve(import.meta.dir, "../../../../../../../docs/mermaid-ascii-rendering.md")
  const documentation = readFileSync(documentationPath, "utf8")
  for (const name of fixtureNames) expect(documentation).toContain(`### \`${name}\``)
  expect(documentation.match(/^### `/gm)).toHaveLength(fixtureNames.length)
  expect(documentation).toContain("[Fit]")
  expect(documentation).toContain("LONG FLOWCHART (120 NODES)")
  expect(documentation.match(/^<details open>$/gm)).toHaveLength(fixtureNames.length)
  expect(documentation).not.toMatch(/^<details>$/m)
})

test("stable text mode keeps markdown renderer for inline formatting", () => {
  expect(shouldRenderStableTextPlain("plain streaming text", true)).toBe(true)
  expect(shouldRenderStableTextPlain("**bold** and `inline-code`", true)).toBe(false)
  expect(shouldRenderStableTextPlain("[docs](https://example.com)", true)).toBe(false)
  expect(shouldRenderStableTextPlain("plain streaming text", false)).toBe(false)
})

test("renderPlanMarkdown aligns mermaid titles with diagram rows", async () => {
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
  expect(result).toMatch(/\n +Diagrama Mermaid\n\n +╭/)
  expect(result).not.toContain("\nDiagrama Mermaid\n\n╭")
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

    const markdown = ["# Plan", "", "```mermaid", "flowchart TD", "  A[Find file] --> B[Edit markdown]", "```"].join(
      "\n",
    )
    const result = await renderPlanMarkdown(markdown, 80)

    expect(result).toContain("╭")
    expect(result).toContain("Find file")
    expect(result).not.toContain("BAD TERMAID OUTPUT")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("renderPlanMarkdown renders chained LR flowcharts horizontally", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = [
    "## Mermaid Flow",
    "",
    "```mermaid",
    "flowchart LR",
    "  A[Draft plan] --> B[Review modal] --> C[Approve]",
    "```",
  ].join("\n")

  const result = await renderPlanMarkdown(markdown, 100)
  expect(result).toContain("Draft plan")
  expect(result).toContain("Review modal")
  expect(result).toContain("Approve")
  expect(result).toContain("╭────────────╮     ╭──────────────╮     ╭──────────╮")
  expect(result).toContain("│ Draft plan │────▶│ Review modal │────▶│ Approve  │")
  expect(result).not.toContain("flowchart LR")
})

test("renderPlanMarkdown renders branched LR flowcharts as boxed rows", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = [
    "```mermaid",
    "flowchart LR",
    "  A[Root] --> B[Top Node]",
    "  A --> C[Bottom Node]",
    "  B --> D[Final]",
    "  C --> D",
    "```",
  ].join("\n")

  const result = await renderPlanMarkdown(markdown, 120)
  expect(result).toContain("│ Root     │────▶│ Top Node │────▶│ Final    │")
  expect(result).toContain("│ Root     │────▶│ Bottom Node │────▶│ Final    │")
  expect(result).not.toContain("┌ Root ┐")
  expect(result).not.toContain("flowchart LR")
})

test("renderPlanMarkdown reflows long LR flowcharts within the fitted card width", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = [
    "```mermaid",
    "flowchart LR",
    "  MW[MultiWorkspace] --> RM{RootMode}",
    "  RM -->|AgentView| AV[AgentViewRoot]",
    "  RM -->|Editor| WS[Workspace existente]",
    "  AV --> AP[AgentPanel compartido]",
    "  AP --> CV[ConversationView / ThreadView]",
    "  CV --> NR[Wright Native Agent]",
    "  CV --> AR[Agentes ACP]",
    "  NR --> LMR[LanguageModelRegistry]",
    "  AR --> ACR[ACP Agent Registry]",
    "  LMR --> CS[Codex Subscription]",
    "  LMR --> OG[OpenCode Go]",
    "  LMR --> OR[OpenRouter y BYOK]",
    "  ACR --> CA[Claude Code]",
    "  ACR --> CX[Codex CLI]",
    "  ACR --> CU[Cursor Agent]",
    "  ACR --> OA[OpenCode Agent]",
    "```",
  ].join("\n")

  const result = await renderPlanMarkdown(markdown, 100)
  const lines = result.split("\n")
  const rootLine = lines.find((line) => line.includes("│ MultiWorkspace │"))

  expect(rootLine?.indexOf("│ MultiWorkspace │")).toBeGreaterThan(0)
  expect(Math.max(...lines.map((line) => Bun.stringWidth(line)))).toBeLessThanOrEqual(100)
  expect(lines.length).toBeGreaterThan(20)
  expect(result).toContain("│ AgentPanel compartido │")
  expect(result).toContain("│ OpenCode Agent │")
  expect(result).toContain("────▶")
  expect(result).not.toContain("path 1")
  expect(result).not.toContain("flowchart LR")

  const tdResult = await renderPlanMarkdown(markdown.replace("flowchart LR", "flowchart TD"), 100)
  const tdLines = tdResult.split("\n")
  const tdRootLine = tdLines.find((line) => line.includes("│ MultiWorkspace │"))
  expect(tdRootLine?.indexOf("│ MultiWorkspace │")).toBeGreaterThan(0)
  expect(Math.max(...tdLines.map((line) => Bun.stringWidth(line)))).toBeLessThanOrEqual(100)
  expect(tdResult).not.toContain("path 1")
})

test("renderPlanMarkdown renders RL flowcharts right-to-left", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = ["```mermaid", "flowchart RL", "  A[Start] --> B[Middle] --> C[Done]", "```"].join("\n")

  const result = await renderPlanMarkdown(markdown, 100)
  expect(result).toContain("│ Done     │◀────│ Middle   │◀────│ Start    │")
  expect(result).not.toContain("flowchart RL")
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
  expect(result).toContain("│ ◇ Looks correct? │")
  expect(result).toContain("Yes")
  expect(result).not.toContain("├─ Yes")
  expect(result).toContain("│ Accept change │")
  expect(result).toContain("No")
  expect(result).not.toContain("└─ No")
  expect(result).not.toContain("↺ Add hello message")
  expect(result).not.toContain("┌ Yes ┐")
  expect(result).not.toContain("┌ No ┐")
})

test("renderPlanMarkdown supports pipe-style mermaid edge labels", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = [
    "## Mermaid Flow",
    "",
    "```mermaid",
    "flowchart TD",
    "  A[Review plan] --> B{Looks good?}",
    "  B -->|Yes| C[Approve]",
    "  B -->|No| D[Edit]",
    "```",
  ].join("\n")

  const result = await renderPlanMarkdown(markdown, 100)
  expect(result).toContain("Yes")
  expect(result).toContain("│ Approve  │")
  expect(result).toContain("No")
  expect(result).toContain("│ Edit     │")
  expect(result).not.toContain("|Yes|")
})

test("renderPlanMarkdown tolerates bang-style Mermaid arrow terminators", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = ["```mermaid", "flowchart TD", "  A[Review] --!> B[Ship]", "```"].join("\n")

  const result = await renderPlanMarkdown(markdown, 80)
  expect(result).toContain("│ Review   │")
  expect(result).toContain("│ Ship     │")
  expect(result).not.toContain("flowchart TD")
})

test("renderPlanMarkdown renders branch continuations as vertical boxes", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = [
    "```mermaid",
    "flowchart TD",
    "  A[Data valid?] -->|Yes| B[Create first workspace]",
    "  B --> C[Offer guided action]",
    "  C --> D[Track activation]",
    "  A -->|No| E[Show correction]",
    "  E --> A",
    "```",
  ].join("\n")

  const result = await renderPlanMarkdown(markdown, 120)
  expect(result).toContain("Yes")
  expect(result).toContain("│ Create first workspace │")
  expect(result).toContain("│ Offer guided action │")
  expect(result).toContain("│ Track activation │")
  expect(result).toContain("No")
  expect(result).toContain("│ Show correction │")
  expect(result).not.toContain("↺ Data valid?")
})

test("renderPlanMarkdown keeps cyclic branches ranked without detached loop annotations", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = [
    "```mermaid",
    "flowchart TD",
    "  A[Data valid?] -->|Yes| B[Create first workspace]",
    "  B --> C[Offer guided action]",
    "  C --> D[Track activation]",
    "  A -->|No| E[Show correction]",
    "  E --> A",
    "```",
  ].join("\n")

  const result = await renderPlanMarkdown(markdown, 120)
  const branchRow = result
    .split("\n")
    .find((line) => line.includes("│ Create first workspace │") && line.includes("│ Show correction │"))

  expect(branchRow).toBeDefined()
  expect(branchRow?.indexOf("Create first workspace")).toBeLessThan(branchRow?.indexOf("Show correction") ?? -1)
  expect(result).toContain("Yes")
  expect(result).toContain("No")
  expect(result).not.toContain("├─ Yes")
  expect(result).not.toContain("└─ No")
  expect(result).not.toContain("↺ Data valid?")
})

test("renderPlanMarkdown renders multiple Mermaid back-edges as literal return lines", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = [
    "```mermaid",
    "flowchart TD",
    "  A[Draft plan] --> B[Render Markdown]",
    "  B --> C[Review Mermaid]",
    "  C --> D{Approve?}",
    "  D -->|yes| E[Implement]",
    "  D -->|no| F[Edit plan]",
    "  D -->|comments| G[Add comments]",
    "  D -->|reject| H[Reject plan]",
    "  F --> B",
    "  G --> C",
    "  E --> I[Done]",
    "  H --> I",
    "```",
  ].join("\n")

  const result = await renderPlanMarkdown(markdown, 100)
  expect(result).toContain("yes")
  expect(result).toContain("no")
  expect(result).toContain("comments")
  expect(result).toContain("reject")
  expect(result).toContain("│ Edit plan │")
  expect(result).toContain("│ Add comments │")
  expect(result).toContain("│ Done     │")
  const doneRow = result.split("\n").findIndex((line) => line.includes("│ Done     │"))
  expect(doneRow).toBeGreaterThan(0)
  expect(result.split("\n")[doneRow - 2]).toContain("▼")
  expect(result.match(/▲/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  expect(result).not.toContain("↩ Render Markdown")
  expect(result).not.toContain("↩ Review Mermaid")
  expect(result).not.toContain("↺ Render Markdown")
  expect(result).not.toContain("↺ Review Mermaid")
})

test("renderPlanMarkdown keeps constrained Mermaid return edges connected", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = [
    "```mermaid",
    "flowchart TD",
    "  A[Draft plan] --> B[Render Markdown]",
    "  B --> C[Review Mermaid]",
    "  C --> D{Approve?}",
    "  D -->|yes| E[Implement]",
    "  D -->|no| F[Edit plan]",
    "  D -->|comments| G[Add comments]",
    "  D -->|reject| H[Reject plan]",
    "  F --> B",
    "  G --> C",
    "  E --> I[Done]",
    "  H --> I",
    "```",
  ].join("\n")

  const result = await renderPlanMarkdown(markdown, 48)
  expect(result).toContain("└─ Render Markdown")
  expect(result).toContain("└─ Review Mermaid")
  expect(result).not.toContain("↩")
  expect(result).not.toContain("↺")
})

test("renderPlanMarkdown keeps Mermaid edges that span multiple ranks", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = [
    "```mermaid",
    "flowchart TD",
    "  A[Start] --> B[Middle]",
    "  B --> C[Finish]",
    "  A --> C",
    "```",
  ].join("\n")

  const result = await renderPlanMarkdown(markdown, 100)
  expect(result).toContain("│ Start    │")
  expect(result).toContain("│ Middle   │")
  expect(result).toContain("│ Finish   │")
  expect(result).not.toContain("flowchart TD")
})

test("renderPlanMarkdown keeps clean branch labels in a narrow flowchart layout", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = [
    "```mermaid",
    "flowchart TD",
    "  A[Data valid?] -->|Yes| B[Create first workspace]",
    "  B --> C[Offer guided action]",
    "  C --> D[Track activation]",
    "  A -->|No| E[Show correction]",
    "  E --> A",
    "```",
  ].join("\n")

  const result = await renderPlanMarkdown(markdown, 48)
  expect(result).toContain("Yes")
  expect(result).toContain("No")
  expect(result).toContain("Data valid? ──┘")
  expect(result).not.toContain("├─ Yes")
  expect(result).not.toContain("└─ No")
  expect(result).not.toContain("↺ Data valid?")
})

test("renderPlanMarkdown wraps long branch continuations into vertical boxes", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = [
    "```mermaid",
    "flowchart TD",
    "  A[Health check passes?] -->|Yes| B[Try product examples]",
    "  B --> C[Confirm onboarding complete]",
    "  A -->|No| D[Review troubleshooting]",
    "  D --> E[Fix missing runtime or port issue]",
    "  E --> F[Run local API]",
    "```",
  ].join("\n")

  const result = await renderPlanMarkdown(markdown, 120)
  expect(result).toContain("Yes")
  expect(result).toContain("│ Try product examples │")
  expect(result).toContain("│ Confirm onboarding complete │")
  expect(result).toContain("No")
  expect(result).toContain("│ Review troubleshooting │")
  expect(result).toContain("│ Fix missing runtime or port issue │")
  expect(result).not.toContain(
    "└─ No → ┌ Review troubleshooting ┐ ──▶ ┌ Fix missing runtime or port issue ┐ ──▶ ┌ Run local API ┐",
  )
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
  expect(result).toContain("Yes")
  expect(result).not.toContain("├─ Yes")
  expect(result).toContain("│ Accept change │")
  expect(result).toContain("No")
  expect(result).not.toContain("└─ No")
  expect(result).toContain("│ Fix placement or formatting │")
  expect(result).not.toContain("↺ Check raw Markdown")
  expect(result).not.toContain("flowchart TD")
})

test("renderPlanMarkdown renders BT flowcharts from original sink to source", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = ["```mermaid", "flowchart BT", "  A[Bottom] --> B[Middle] --> C[Top]", "```"].join("\n")

  const result = await renderPlanMarkdown(markdown, 80)
  expect(result).toMatch(/│ Top\s+│[\s\S]+│ Middle\s+│[\s\S]+│ Bottom\s+│/)
  expect(result).not.toContain("flowchart BT")
})

test("renderPlanMarkdown renders Mermaid sequence diagrams locally", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = [
    "## Mermaid Sequence",
    "",
    "```mermaid",
    "sequenceDiagram",
    "  participant U as Usuario",
    "  participant A as App",
    "  participant API as API",
    "  U->>A: Click enviar",
    "  A->>API: POST /submit",
    "  API-->>A: 200 OK",
    "```",
  ].join("\n")

  const result = await renderPlanMarkdown(markdown, 100)
  expect(result).toContain("Mermaid Sequence")
  expect(result).toContain("│ Usuario  │")
  expect(result).toContain("│ App      │")
  expect(result).toContain("│ API      │")
  expect(result).toContain("Click enviar")
  expect(result).toContain("POST /submit")
  expect(result).toContain("200 OK")
  expect(result).toContain("├")
  expect(result).toContain("▶")
  expect(result).toContain("╌")
  expect(result).toContain("│")
  expect(result).not.toContain("┌ Usuario ┐ ──▶ ┌ App ┐  Click enviar")
  expect(result).not.toContain("Usuario → App")
  expect(result).not.toContain("sequenceDiagram")
})

test("renderPlanMarkdown renders Mermaid sequence diagrams with inferred participants and reverse arrows", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = [
    "```mermaid",
    "sequenceDiagram",
    "  Alice->>John: Hello John, how are you?",
    "  John-->>Alice: Great!",
    "  Alice-)John: See you later!",
    "```",
  ].join("\n")

  const result = await renderPlanMarkdown(markdown, 100)
  expect(result).toContain("Alice")
  expect(result).toContain("John")
  expect(result).toContain("Hello John, how are you?")
  expect(result).toContain("Great!")
  expect(result).toContain("See you later!")
  expect(result).toContain("◀")
  expect(result).not.toContain("sequenceDiagram")
})

test("renderPlanMarkdown renders Mermaid ER diagrams locally", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = [
    "```mermaid",
    "erDiagram",
    "  USER ||--o{ ORDER : places",
    "  ORDER ||--|{ ORDER_ITEM : contains",
    "  ORDER_ITEM {",
    "    string productCode",
    "    int quantity",
    "  }",
    "```",
  ].join("\n")

  const result = await renderPlanMarkdown(markdown, 100)
  expect(result).toContain("╭────────────────────╮")
  expect(result).toContain("│ USER     │")
  expect(result).toContain("│ ORDER    │")
  expect(result).toMatch(/\|\|─+o\{/)
  expect(result).toMatch(/\|\|─+\|\{/)
  expect(result).toContain("places")
  expect(result).toContain("│     ORDER_ITEM     │")
  expect(result).toContain("├────────────────────┤")
  expect(result).toContain("│ string productCode │")
  expect(result).toContain("│ int quantity       │")
  expect(result).not.toContain("┌ USER ┐ ||--o{ ┌ ORDER ┐  places")
  expect(result).not.toContain("places o{--||")
  expect(result).not.toContain("Entity fields")
  expect(result).not.toContain("  • string productCode")
  expect(result).not.toContain("erDiagram")
})

test("renderPlanMarkdown supports dotted Mermaid ER relationships", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = [
    "```mermaid",
    "erDiagram",
    "  CUSTOMER }|..|{ DELIVERY-ADDRESS : uses",
    "```",
  ].join("\n")

  const result = await renderPlanMarkdown(markdown, 100)
  expect(result).toContain("CUSTOMER")
  expect(result).toContain("DELIVERY-ADDRESS")
  expect(result).toMatch(/}\|╌+\|\{/)
  expect(result).toContain("uses")
  expect(result).not.toContain("erDiagram")
})

test("renderPlanMarkdown renders markdown lists as terminal-friendly bullets", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = ["# Plan", "", "- Step", "  - Child", "- [x] Done", "- [ ] Todo"].join("\n")

  const result = await renderPlanMarkdown(markdown, 80)
  expect(result).toContain("• Step")
  expect(result).toContain("  ◦ Child")
  expect(result).toContain("☑ Done")
  expect(result).toContain("☐ Todo")
  expect(result).not.toContain("- Step")
})

test("renderPlanMarkdown renders markdown headings with visible hierarchy", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = ["# Título H1", "## Título H2", "### Título H3", "#### Título H4", "##### Título H5", "###### Título H6"].join(
    "\n",
  )

  const result = await renderPlanMarkdown(markdown, 80)
  expect(result).toContain("Título H1\n═════════")
  expect(result).toContain("Título H2\n─────────")
  expect(result).toContain("◆ Título H3")
  expect(result).toContain("◇ Título H4")
  expect(result).toContain("▪ Título H5")
  expect(result).toContain("· Título H6")
  expect(result).not.toContain("### Título H3")
})

test("renderPlanMarkdown leaves normal paragraphs unchanged", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  expect(await renderPlanMarkdown("Paragraph\n\nSecond paragraph", 80)).toBe("Paragraph\n\nSecond paragraph")
})

test("renderPlanMarkdown leaves narrow markdown tables unchanged", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = ["| A | B |", "| --- | --- |", "| One | Two |"].join("\n")

  expect(await renderPlanMarkdown(markdown, 80)).toBe(markdown)
})

test("renderPlanMarkdown can preserve markdown tables for rich chat", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = [
    "| Archivo | Cambio |",
    "| --- | --- |",
    "| `services/zerobase/intent.go` | Nuevo envelope de intent estructurado + detección de acciones/rutas sensibles. |",
  ].join("\n")

  const result = await renderPlanMarkdown(markdown, 80, { tableMode: "preserve" })
  expect(result).toBe(markdown)
})

test("renderPlanMarkdown renders rich chat markdown tables as grids", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = [
    "| Archivo | Acción | Cambio |",
    "| --- | --- | --- |",
    "| `client/src/components/ui/OrgSelector.tsx` | Modificado | Emite evento cuando cambia la organización activa. |",
    "| `client/src/components/ai/AIChatProvider.tsx` | Modificado | Reconsulta `/api/ai/status` cuando cambia la organización activa. |",
  ].join("\n")

  const result = await renderPlanMarkdown(markdown, 96, { tableMode: "grid" })
  expect(result).toContain("```text")
  expect(result).toContain("┌")
  expect(result).toContain("Archivo")
  expect(result).toContain("OrgSelector.tsx")
  expect(result).toContain("AIChatProvider.tsx")
  expect(result).not.toContain("| Archivo | Acción | Cambio |")
  expect(result).not.toContain("`/api/ai/status`")
})

test("renderPlanMarkdownStatic renders non-mermaid chat tables synchronously", () => {
  const markdown = [
    "| Archivo | Acción | Cambio |",
    "| --- | --- | --- |",
    "| `client/src/components/ui/OrgSelector.tsx` | Modificado | Emite evento cuando cambia la organización activa. |",
  ].join("\n")

  const result = renderPlanMarkdownStatic(markdown, 96, { tableMode: "grid" })
  expect(hasMermaidFence(markdown)).toBe(false)
  expect(result).toContain("┌")
  expect(result).toContain("OrgSelector.tsx")
  expect(result).not.toContain("| Archivo | Acción | Cambio |")
})

test("streaming markdown keeps unfinished blocks as a plain tail", () => {
  const markdown = ["## Listo", "", "| Archivo | Acción |", "| --- | --- |", "| `src/main.cpp` | Modificado |"].join("\n")

  const result = renderPlanMarkdownStreaming(markdown, 96, { tableMode: "grid", markdownMode: "tables-only" })
  expect(result.content).toBe("## Listo\n\n")
  expect(result.tail).toContain("| Archivo | Acción |")
  expect(result.tail).toContain("| `src/main.cpp` | Modificado |")
  expect(result.content).not.toContain("┌")
})

test("streaming markdown freezes completed tables and keeps later tokens in the tail", () => {
  const markdown = [
    "## Listo",
    "",
    "| Archivo | Acción |",
    "| --- | --- |",
    "| `src/main.cpp` | Modificado |",
    "",
    "Siguiente pa",
  ].join("\n")

  const result = renderPlanMarkdownStreaming(markdown, 96, { tableMode: "grid", markdownMode: "tables-only" })
  expect(result.content).toContain("```text")
  expect(result.content).toContain("┌")
  expect(result.content).toContain("src/main.cpp")
  expect(result.tail).toBe("Siguiente pa")
})

test("streaming markdown keeps unfinished fences out of the rendered prefix", () => {
  const openFence = renderPlanMarkdownStreaming("Antes\n\n```ts\nconst value = 1", 96, {
    tableMode: "grid",
    markdownMode: "tables-only",
  })
  expect(openFence.content).toBe("Antes\n\n")
  expect(openFence.tail).toBe("```ts\nconst value = 1")

  const closedFence = renderPlanMarkdownStreaming("Antes\n\n```ts\nconst value = 1\n```\nTail", 96, {
    tableMode: "grid",
    markdownMode: "tables-only",
  })
  expect(closedFence.content).toContain("```ts")
  expect(closedFence.content).toContain("const value = 1")
  expect(closedFence.tail).toBe("Tail")
})

test("streaming markdown tail renders active tables without waiting for block completion", () => {
  const tail = [
    "| Archivo | Acción | Cambio |",
    "| --- | --- | --- |",
    "| `src/main.cpp` | Modificado | Cambiando token",
  ].join("\n")

  const rendered = renderStreamingMarkdownTail(tail, 96, { tableMode: "grid", markdownMode: "tables-only" })
  expect(rendered).toContain("┌")
  expect(rendered).toContain("src/main.cpp")
  expect(rendered).toContain("Cambiando token")
  expect(rendered).not.toContain("```text")
})

test("streaming markdown tail keeps hex colors available for live table styling", () => {
  const tail = ["| Nombre | Color |", "| --- | --- |", "| Selene | #8B5CF6 |"].join("\n")

  const rendered = renderStreamingMarkdownTail(tail, 96, { tableMode: "grid", markdownMode: "tables-only" })
  expect(rendered).toContain("#8B5CF6")
  expect(hasStyledHexColors(rendered)).toBe(true)
})

test("streaming markdown tail renders stable headings after completion without remounting", () => {
  const rendered = renderStreamingMarkdownTail("## Historia breve\n\nTexto final", 96, {
    tableMode: "grid",
    markdownMode: "tables-only",
  }, { finalized: true })

  expect(rendered).toContain("Historia breve")
  expect(rendered).toContain("──────────────")
  expect(rendered).not.toContain("## Historia breve")
})

test("streaming markdown tail preserves headings for markdown rendering", () => {
  const rendered = renderStreamingMarkdownTail(
    "## Historia breve\n\nTexto final",
    96,
    { tableMode: "grid", markdownMode: "tables-only" },
    { output: "markdown" },
  )

  expect(rendered).toContain("## Historia breve")
  expect(rendered).not.toContain("──────────────")
})

test("streaming markdown tail preserves live table grids for markdown rendering", () => {
  const rendered = renderStreamingMarkdownTail(
    ["## Cambios", "", "| Archivo | Acción | Cambio |", "| --- | --- | --- |", "| `src/main.cpp` | Modificado | Cambiando token"].join("\n"),
    96,
    { tableMode: "grid", markdownMode: "tables-only" },
    { output: "markdown" },
  )

  expect(rendered).toContain("## Cambios")
  expect(rendered).toContain("```text")
  expect(rendered).toContain("┌")
  expect(rendered).toContain("src/main.cpp")
  expect(rendered).not.toContain("| Archivo | Acción | Cambio |")
})

test("streaming markdown tail renders finalized inline markdown and fences without remounting", () => {
  const rendered = renderStreamingMarkdownTail(
    [
      "No parece mal.",
      "",
      "- `Pulse acum.` / pulsos: **igual en todas las filas**",
      "- Entonces `Consumo delta`: **0**, correctamente.",
      "",
      "```txt",
      "consumo_delta = lectura_actual_acumulada - lectura_anterior_acumulada",
      "```",
      "",
      "1. **Consumo real oficial**",
      "   Se arregla en el origen.",
    ].join("\n"),
    96,
    { tableMode: "grid", markdownMode: "tables-only" },
    { finalized: true },
  )

  expect(rendered).toContain("• Pulse acum. / pulsos: igual en todas las filas")
  expect(rendered).toContain("• Entonces Consumo delta: 0, correctamente.")
  expect(rendered).toContain("consumo_delta = lectura_actual_acumulada - lectura_anterior_acumulada")
  expect(rendered).toContain("1. Consumo real oficial")
  expect(rendered).not.toContain("```")
  expect(rendered).not.toContain("**")
  expect(rendered).not.toContain("`Pulse acum.`")
})

test("streaming markdown tail wraps long text lines to the render width", () => {
  const rendered = renderStreamingMarkdownTail(
    "Dile: No es problema del dashboard; el medidor Pulse está enviando lecturas con el totalizador y pulsos sin avanzar, por eso Teca calcula consumo 0 aunque sí reciba datos.",
    72,
    { tableMode: "grid", markdownMode: "tables-only" },
    { finalized: true },
  )

  expect(rendered.split("\n").length).toBeGreaterThan(1)
  for (const line of rendered.split("\n")) {
    expect(Bun.stringWidth(line)).toBeLessThanOrEqual(72)
  }
})

test("streaming markdown tail renders closed inline markdown on the live final line", () => {
  const rendered = renderStreamingMarkdownTail(
    'Dile:\n\n**"Sí, ya quedó ajustado: la gráfica sale por horas."**',
    96,
    { tableMode: "grid", markdownMode: "tables-only" },
  )

  expect(rendered).toContain('"Sí, ya quedó ajustado: la gráfica sale por horas."')
  expect(rendered).not.toContain("**")
})

test("streaming markdown keeps partial tokens visible without waiting for a newline", () => {
  const options = { tableMode: "grid" as const, markdownMode: "tables-only" as const }
  const first = renderStreamingMarkdownTail("Generando", 96, options, { output: "text" })
  const second = renderStreamingMarkdownTail("Generando una respuesta", 96, options, { output: "text" })

  expect(first).toContain("Generando")
  expect(second).toContain("Generando una respuesta")
})

test("streaming markdown tail leaves the active final line unstyled while typing", () => {
  const rendered = renderStreamingMarkdownTail("## Historia breve\n\n## Still typing", 96, {
    tableMode: "grid",
    markdownMode: "tables-only",
  })

  expect(rendered).toContain("Historia breve")
  expect(rendered).toContain("──────────────")
  expect(rendered).toContain("## Still typing")
})

test("streaming markdown tail keeps live table width stable as cell text grows", () => {
  const first = renderStreamingMarkdownTail(
    ["| Archivo | Acción | Cambio |", "| --- | --- | --- |", "| `src/main.cpp` | Modificado | Ca"].join("\n"),
    96,
    { tableMode: "grid", markdownMode: "tables-only" },
  )
  const second = renderStreamingMarkdownTail(
    ["| Archivo | Acción | Cambio |", "| --- | --- | --- |", "| `src/main.cpp` | Modificado | Cambiando tokens largos"].join("\n"),
    96,
    { tableMode: "grid", markdownMode: "tables-only" },
  )

  expect(first.split("\n")[0]).toBe(second.split("\n")[0])
})

test("streaming markdown reuses frozen rendered content while only the tail changes", () => {
  const first = renderPlanMarkdownStreaming("## Bloque\n\nTail uno", 96, {
    tableMode: "grid",
    markdownMode: "tables-only",
  })
  const second = renderPlanMarkdownStreaming("## Bloque\n\nTail dos", 96, {
    tableMode: "grid",
    markdownMode: "tables-only",
  }, first.state)

  expect(streamingMarkdownCommitIndex("## Bloque\n\nTail dos")).toBe("## Bloque\n\n".length)
  expect(second.content).toBe(first.content)
  expect(second.state).toBe(first.state)
  expect(second.tail).toBe("Tail dos")
})

test("streaming markdown commits only closed paragraphs or blocks", () => {
  expect(streamingMarkdownCommitIndex("Linea uno\nLinea dos\n")).toBe("Linea uno\nLinea dos\n".length)
  expect(streamingMarkdownCommitIndex("Linea uno\n\nLinea dos")).toBe("Linea uno\n\n".length)
  expect(streamingMarkdownCommitIndex("```ts\nconst value = 1\n```\nTail")).toBe("```ts\nconst value = 1\n```\n".length)
})

test("streaming markdown preview hides the active partial line", () => {
  expect(visibleStreamingMarkdownPreview("token token")).toBe("")
  expect(visibleStreamingMarkdownPreview("Linea lista\npartial")).toBe("Linea lista\n")
  expect(visibleStreamingMarkdownPreview("Linea lista\nOtra lista\n")).toBe("Linea lista\nOtra lista\n")
})

test("styled session markdown separates generated tables from adjacent headings", () => {
  const markdown = [
    "## Resumen de cambios",
    "| Archivo | Acción | Cambio |",
    "| --- | --- | --- |",
    "| `include/tank_config.h` | Modificado | WiFi default cada 10 min. |",
    "## Defaults producción",
    "Sensor ultrasónico real: cada 3 min",
  ].join("\n")

  const result = renderPlanMarkdownStatic(markdown, 96, { tableMode: "grid", markdownMode: "tables-only" })
  const lines = visibleStyledPlanMarkdownLines(result)
  const topBorder = lines.findIndex((line) => line.startsWith("┌"))
  const bottomBorder = lines.findIndex((line) => line.startsWith("└"))

  expect(topBorder).toBeGreaterThan(1)
  expect(lines[topBorder - 2]).toBe("## Resumen de cambios")
  expect(lines[topBorder - 1]).toBe("")
  expect(bottomBorder).toBeGreaterThan(topBorder)
  expect(lines[bottomBorder + 1]).toBe("")
  expect(lines[bottomBorder + 2]).toBe("## Defaults producción")
})

test("renderPlanMarkdownStatic renders local Mermaid before async fallback", () => {
  const markdown = ["```mermaid", "gantt", "  title Delivery", "  dateFormat YYYY-MM-DD", "  Task :a1, 2026-06-19, 1d", "```"].join("\n")

  const result = renderPlanMarkdownStatic(markdown, 96, { tableMode: "grid", markdownMode: "tables-only" })
  expect(result).toContain("```text")
  expect(result).toContain("Delivery")
  expect(result).toContain("Task")
  expect(result).toContain("█")
  expect(result).not.toContain("```mermaid")
})

test("renderPlanMarkdownStatic renders hex color previews inside tables", () => {
  const markdown = [
    "| Name | Hex | Preview |",
    "| --- | --- | --- |",
    "| Mend Blue | #1E88E5 | 🔵 |",
    "| Success Green | #43A047 | 🟢 |",
  ].join("\n")

  const result = renderPlanMarkdownStatic(markdown, 96, { tableMode: "grid", markdownMode: "tables-only" })
  expect(result).toContain("│ Mend Blue")
  expect(result).toContain("#1E88E5")
  expect(result).toContain("#43A047")
  expect(result).not.toContain("\u001b[")
  expect(result).not.toContain("🔵")
  expect(result).not.toContain("🟢")
  expect(result).not.toContain("| Mend Blue | #1E88E5 | 🔵 |")
})

test("styled plan markdown hides generated text fences around hex tables", () => {
  const content = ["# Title", "", "```text", "│ Hex │ Preview │", "│ #1E88E5 │ #1E88E5 │", "```", "After"].join("\n")

  const lines = visibleStyledPlanMarkdownLines(content)
  expect(lines).toEqual(["# Title", "", "│ Hex │ Preview │", "│ #1E88E5 │ #1E88E5 │", "After"])
  expect(lines.join("\n")).not.toContain("```")
  expect(styledPlanMarkdownSegments(content)).toEqual([
    { kind: "markdown", content: "# Title\n" },
    { kind: "text", content: "│ Hex │ Preview │\n│ #1E88E5 │ #1E88E5 │" },
    { kind: "markdown", content: "After" },
  ])
})

test("styled plan markdown wraps long fenced code lines to the message width", () => {
  const markdown = [
    "2. Abre MendCode ahí y pide:",
    "",
    "```text",
    "/loop Cada minuto edita el archivo ./loop-smoke.txt agregando una línea nueva con timestamp y el número de iteración. Ejecuta exactamente 2 iteraciones y detente.",
    "```",
    "",
    "Qué deberías ver",
  ].join("\n")

  const result = wrapMarkdownDisplayCodeBlocks(markdown, 64)
  const lines = result.split("\n")
  expect(lines).toContain("```text")
  expect(lines).toContain("```")
  expect(lines.at(-1)).toBe("Qué deberías ver")
  expect(lines.some((line) => line.startsWith("/loop Cada minuto"))).toBe(true)
  expect(lines.some((line) => line.includes("detente."))).toBe(true)
  expect(lines.filter((line) => !line.startsWith("```") && line.trim()).every((line) => Bun.stringWidth(line) <= 63)).toBe(true)
})

test("styled plan markdown does not wrap long lines outside fenced code blocks", () => {
  const longProse = "Este párrafo fuera del bloque debe mantenerse intacto aunque exceda el ancho porque el problema del screenshot era específico a fences visibles en chat."
  const fenced = "/loop Cada minuto edita el archivo ./loop-smoke.txt agregando una línea nueva con timestamp y el número de iteración. Ejecuta exactamente 2 iteraciones y detente."
  const markdown = [longProse, "", "```text", fenced, "```"].join("\n")

  const result = wrapMarkdownDisplayCodeBlocks(markdown, 64)
  const lines = result.split("\n")
  expect(lines[0]).toBe(longProse)
  expect(lines.filter((line) => line.includes("screenshot era específico"))).toHaveLength(1)
  expect(lines.some((line) => line.startsWith("/loop Cada minuto"))).toBe(true)
  expect(lines.filter((line) => !line.startsWith("```") && line !== longProse && line.trim()).every((line) => Bun.stringWidth(line) <= 63)).toBe(true)
})

test("styled plan markdown wraps text-fence segments used by minimal and full chat presentation", () => {
  const content = [
    "/loop Cada minuto edita el archivo ./loop-smoke.txt agregando una línea nueva con timestamp y el número de iteración. Ejecuta exactamente 2 iteraciones y detente.",
    "│ Box drawing rows stay intact even if they are wider than the viewport │",
  ].join("\n")

  const result = wrapPlainDisplayText(content, 44)
  const lines = result.split("\n")
  expect(lines.some((line) => line.startsWith("/loop Cada minuto"))).toBe(true)
  expect(lines.some((line) => line.includes("detente."))).toBe(true)
  expect(lines.find((line) => line.startsWith("│"))).toBe("│ Box drawing rows stay intact even if they are wider than the viewport │")
  expect(lines.filter((line) => !line.startsWith("│") && line.trim()).every((line) => Bun.stringWidth(line) <= 43)).toBe(true)
})

test("styled plan markdown wraps fenced unicode lines by display width", () => {
  const markdown = [
    "```text",
    "const status = '界界界界界界界界界界界界界界界界界界界界 ✅ listo para probar';",
    "```",
  ].join("\n")

  const result = wrapMarkdownDisplayCodeBlocks(markdown, 20)
  const lines = result.split("\n")
  expect(lines).toContain("```text")
  expect(lines).toContain("```")
  expect(lines.filter((line) => !line.startsWith("```") && line.trim()).every((line) => Bun.stringWidth(line) <= 19)).toBe(true)
  expect(lines.some((line) => line.includes("✅"))).toBe(true)
})

test("styled plan markdown does not colorize macro-style hashtags", () => {
  expect(hasStyledHexColors("#define TANK_USE_MOCK_SENSOR 1")).toBe(false)
  expect(hasStyledHexColors("Use #abc here")).toBe(true)
})

test("styled plan markdown leaves hex-like tokens inside inline code in markdown flow", () => {
  expect(shouldColorizeHexMarkdownLine("React muestra `#130`.", false)).toBe(false)
  expect(shouldColorizeHexMarkdownLine("Usa `background: #1E88E5`.", false)).toBe(false)
  expect(shouldColorizeHexMarkdownLine("Color de marca: #1E88E5", false)).toBe(true)
})

test("styled plan markdown keeps markdown tables with hex values in markdown flow", () => {
  expect(shouldColorizeHexMarkdownLine("| Color | #1E88E5 |", false)).toBe(false)
  expect(shouldColorizeHexMarkdownLine(`${"|".repeat(10_000)} #1E88E5 |`, false)).toBe(false)
})

test("styled plan markdown keeps fenced code lines with hex values in markdown flow", () => {
  expect(shouldColorizeHexMarkdownLine("background: #1E88E5;", true)).toBe(false)
  expect(shouldColorizeHexMarkdownLine("Use #1E88E5 here", false)).toBe(true)
})

test("renderPlanMarkdownStatic preserves non-table markdown in rich chat mode", () => {
  const markdown = [
    "### Escapes",
    "",
    "\\# No heading",
    "\\*No italic\\*",
    "",
    "```txt",
    "DEMO",
    "```",
    "",
    "| Elemento | Resultado |",
    "|---|---|",
    "| Tables | Columnas alineadas |",
  ].join("\n")

  const result = renderPlanMarkdownStatic(markdown, 96, { tableMode: "grid", markdownMode: "tables-only" })
  expect(result).toContain("### Escapes")
  expect(result).toContain("\\# No heading")
  expect(result).toContain("```txt\nDEMO\n```")
  expect(result).toContain("┌")
  expect(result).toContain("│ Elemento")
})

test("renderPlanMarkdown renders wide markdown tables as text blocks", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = [
    "| Sprint | Objetivo | Tareas | Archivos probables | Riesgos |",
    "| --- | --- | --- | --- | --- |",
    "| Sprint 1 | Implementar onboarding dashboard | Mapear pantallas, construir componente, persistir progreso | frontend/src/pages/DashboardPage.tsx, frontend/src/widgets/onboarding.tsx | Regresiones visuales |",
  ].join("\n")

  const result = await renderPlanMarkdown(markdown, 80)
  expect(result).toContain("```text")
  expect(result).toContain("Sprint 1")
  expect(result).toContain("  Objetivo: Implementar onboarding dashboard")
  expect(result).toContain("  Archivos probables: frontend/src/pages/DashboardPage.tsx,")
  expect(result).toContain("frontend/src/widgets/onboarding.tsx")
  expect(result).not.toContain("| Sprint | Objetivo | Tareas | Archivos probables | Riesgos |")
  expect(result).toContain("```")
})

test("renderPlanMarkdown strips inline markdown inside wide table text blocks", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = [
    "| Archivo | Acción | Cambio |",
    "| --- | --- | --- |",
    "| `components/landing/home-tui-gallery.tsx` | Modified | Ejecuté `npm run lint` y dejé **Full** sin backticks literales en el bloque largo de salida. |",
  ].join("\n")

  const result = await renderPlanMarkdown(markdown, 72)
  expect(result).toContain("components/landing/home-tui-gallery.tsx")
  expect(result).toContain("Ejecuté npm run lint")
  expect(result).toContain("Full sin backticks")
  expect(result).not.toContain("`components/landing/home-tui-gallery.tsx`")
  expect(result).not.toContain("`npm run lint`")
  expect(result).not.toContain("**Full**")
})

test("renderPlanMarkdown renders Mermaid state diagrams locally", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = [
    "```mermaid",
    "stateDiagram-v2",
    "  [*] --> Idle",
    "  Idle --> Running: start",
    "  Running --> [*]: done",
    "```",
  ].join("\n")

  const result = await renderPlanMarkdown(markdown, 100)
  expect(result).toMatch(/│\s+●\s+│/)
  expect(result).not.toContain("│  ●  │")
  expect(result).toContain("│    Idle    │")
  expect(result).toContain("start")
  expect(result).toContain("│  Running   │")
  expect(result).toContain("done")
  expect(result).toMatch(/│\s+◉\s+│/)
  expect(result).not.toContain("│  ◉  │")
  expect(result).not.toContain("↺ [*]")
  expect(result).toContain("▼")
  expect(result).not.toContain("stateDiagram-v2")
})

test("renderPlanMarkdown renders Mermaid class diagrams locally", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = ["```mermaid", "classDiagram", "  Animal <|-- Duck", "  Duck : +swim()", "```"].join("\n")

  const result = await renderPlanMarkdown(markdown, 100)
  expect(result).toContain("│ Animal")
  expect(result).toContain("◁────")
  expect(result).toContain("│   Duck")
  expect(result).toContain("│ +swim()")
  expect(result).not.toContain("└─ Duck")
  expect(result).not.toContain("classDiagram")
})

test("renderPlanMarkdown renders Mermaid pie charts locally", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = ["```mermaid", "pie title Status", "  \"Done\" : 60", "  \"Todo\" : 40", "```"].join("\n")

  const result = await renderPlanMarkdown(markdown, 100)
  expect(result).toContain("Status")
  expect(result).toContain("Done")
  expect(result).toContain("60 (60.0%)")
  expect(result).not.toContain("pie")
})

test("renderPlanMarkdown renders indented Mermaid diagrams locally", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = ["```mermaid", "mindmap", "  Root", "    Child", "```"].join("\n")

  const result = await renderPlanMarkdown(markdown, 100)
  expect(result).toContain("Mindmap")
  expect(result).toContain("Root")
  expect(result).toContain("▶")
  expect(result).toContain("Child")
  expect(result).not.toContain("mindmap")
})

test("renderPlanMarkdown renders additional Mermaid chart families locally", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = [
    "```mermaid",
    "gantt",
    "  dateFormat YYYY-MM-DD",
    "  section Discovery",
    "  Repo inspection :a1, 2026-06-19, 1d",
    "  Pattern analysis :a2, after a1, 1d",
    "```",
    "```mermaid",
    "quadrantChart",
    "  title Prioridades",
    "  x-axis Bajo --> Alto",
    "  Feature A: [0.8, 0.6]",
    "```",
    "```mermaid",
    "gitGraph",
    "  commit id: \"init\"",
    "  branch feature/mendcode-demo",
    "  checkout feature/mendcode-demo",
    "  commit id: \"work\"",
    "  checkout main",
    "  merge feature/mendcode-demo",
    "```",
    "```mermaid",
    "xychart-beta",
    "  title \"Ventas\"",
    "  x-axis [ene, feb]",
    "  bar [2, 4]",
    "```",
    "```mermaid",
    "sankey-beta",
    "  A,B,10",
    "```",
  ].join("\n")

  const result = await renderPlanMarkdown(markdown, 100)
  expect(result).toContain("Gantt")
  expect(result).toContain("Time scale")
  expect(result).toContain("── Discovery")
  expect(result).toContain("Repo inspection")
  expect(result).toContain("█")
  expect(result).toContain("Prioridades")
  expect(result).toContain("● Feature A")
  expect(result).toContain("┼")
  expect(result).toContain("Git graph")
  expect(result).toContain("feature/mendcode-demo")
  expect(result).toContain("merge feature/mendcode-demo")
  expect(result).toContain("●")
  expect(result).toContain("Ventas")
  expect(result).toContain("value ↑")
  expect(result).toContain("ene")
  expect(result).toContain("Sankey · flow width = value")
  expect(result).toContain("████")
  expect(result).not.toContain("dateFormat YYYY-MM-DD\n  section")
  expect(result).not.toContain("gantt")
  expect(result).not.toContain("quadrantChart")
  expect(result).not.toContain("gitGraph")
  expect(result).not.toContain("xychart-beta")
  expect(result).not.toContain("sankey-beta")
})

test("renderPlanMarkdown renders structural Mermaid chart families locally", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = [
    "```mermaid",
    "requirementDiagram",
    "  requirement req_login {",
    "    id: 1",
    "    text: User can login",
    "  }",
    "```",
    "```mermaid",
    "C4Context",
    "  Person(user, \"User\")",
    "  System(app, \"App\")",
    "  Rel(user, app, \"Uses\")",
    "```",
    "```mermaid",
    "block-beta",
    "  columns 2",
    "  A[Client] B[Server]",
    "```",
    "```mermaid",
    "packet-beta",
    "  0-15: \"Source Port\"",
    "```",
    "```mermaid",
    "architecture-beta",
    "  service api(server)[API]",
    "  service db(database)[DB]",
    "  api:R -- L:db",
    "```",
  ].join("\n")

  const result = await renderPlanMarkdown(markdown, 120)
  expect(result).toContain("Requirement diagram")
  expect(result).toContain("«requirement» req_login")
  expect(result).toContain("C4 Context")
  expect(result).toContain("Person · User")
  expect(result).toContain("System · App")
  expect(result).toContain("Uses")
  expect(result).toContain("Block diagram")
  expect(result).toContain("Client")
  expect(result).toContain("Server")
  expect(result).toContain("Packet layout")
  expect(result).toContain("0–15")
  expect(result).toContain("Architecture")
  expect(result).toContain("API")
  expect(result).toContain("server")
  expect(result).not.toContain("requirementDiagram")
  expect(result).not.toContain("block-beta")
  expect(result).not.toContain("packet-beta")
  expect(result).not.toContain("architecture-beta")
})

test("reported Mermaid regressions render as connected geometry instead of tables or detached annotations", () => {
  const render = (source: string, width = 96) => renderPlanMarkdownStatic(["```mermaid", source, "```"].join("\n"), width)

  const swimlane = render([
    "swimlane-beta LR",
    '  subgraph customer["Customer"]',
    "    request[Request] --> response[Response]",
    "  end",
    '  subgraph service["Service"]',
    "    receive[Receive]",
    "  end",
    "  request --> receive",
  ].join("\n"))
  expect(swimlane).toContain("├─ Service")
  expect(swimlane).toContain("┼")
  expect(swimlane).not.toContain("Handoffs")

  const state = render(["stateDiagram-v2", "  [*] --> Idle", "  Idle --> Done: finish", "  Done --> [*]"].join("\n"))
  expect(state).toContain("●")
  expect(state).toContain("◉")
  expect(state).toContain("▼")
  expect(state).not.toContain("│  ●  │")
  expect(state).not.toContain("│  ◉  │")
  expect(state).not.toContain("↺ [*]")

  const horizontalState = render(["stateDiagram-v2", "  direction LR", "  [*] --> Idle", "  Idle --> Done", "  Done --> [*]"].join("\n"))
  expect(horizontalState).toMatch(/●\s+────▶.*Idle/)
  expect(horizontalState).toMatch(/Done.*────▶\s+◉/)

  const classes = render([
    "classDiagram",
    "  Animal <|-- Duck",
    "  Car *-- Engine : contains",
    "  Team o-- Player : aggregates",
    "  Service ..> Repository : depends",
  ].join("\n"))
  expect(classes).toContain("◁────")
  expect(classes).toContain("◆────")
  expect(classes).toContain("◇────")
  expect(classes).toContain("╌╌╌▶")

  const journey = render([
    "journey",
    "  title Checkout",
    "  section Discover",
    "    Browse: 3: Customer",
    "    Compare: 4: Customer",
    "  section Purchase",
    "    Pay: 2: Customer, Payment",
    "    Confirm: 5: Customer",
  ].join("\n"), 72)
  expect(journey).toContain("★★☆☆☆  2/5")
  expect(journey).toContain("● Customer, Payment")
  expect(journey).toContain("Discover")
  expect(journey).toContain("Purchase")
  expect(journey).not.toContain("│ Section")
  expect(journey).not.toContain("│ Task")

  const gantt = render([
    "gantt",
    "  title Release",
    "  dateFormat YYYY-MM-DD",
    "  section Build",
    "  API :a1, 2026-01-01, 3d",
    "  UI :a2, after a1, 2d",
  ].join("\n"))
  expect(gantt).toContain("Time scale")
  expect(gantt).toContain("── Build")
  expect(gantt).toContain("█")
  expect(gantt).not.toContain("│ Task")

  const quadrant = render([
    "quadrantChart",
    "  title Portfolio",
    "  x-axis Low --> High",
    "  y-axis Risk --> Safe",
    "  quadrant-1 Invest",
    "  Winner: [0.8, 0.7]",
  ].join("\n"))
  expect(quadrant).toContain("┼")
  expect(quadrant).toContain("● Winner")
  expect(quadrant).toContain("Invest")

  const requirement = render([
    "requirementDiagram",
    "  requirement req_login {",
    "    id: 1",
    "    text: User can login",
    "  }",
    "  element login_form {",
    "    type: UI",
    "  }",
    "  login_form - satisfies -> req_login",
  ].join("\n"))
  expect(requirement).toContain("«element» login_form")
  expect(requirement).toContain("satisfies")
  expect(requirement).toContain("────▶")

  const git = render([
    "gitGraph",
    '  commit id: "start"',
    "  branch feature",
    "  checkout feature",
    '  commit id: "work"',
    "  checkout main",
    "  merge feature",
  ].join("\n"))
  expect(git).toContain("main")
  expect(git).toContain("feature")
  expect(git).toContain("merge feature")
  expect(git.match(/●/g)?.length).toBe(2)
  expect(git).toContain("◎")
})

test("experimental Mermaid families use plotted or spatial ASCII primitives", () => {
  const render = (source: string) => renderPlanMarkdownStatic(["```mermaid", source, "```"].join("\n"), 88)

  const xy = render(["xychart-beta", '  title "Growth"', "  x-axis [Jan, Feb]", "  bar [1, 2]", "  line [2, 1]"].join("\n"))
  expect(xy).toContain("value ↑")
  expect(xy).toContain("█")
  expect(xy).toContain("●")
  expect(xy).not.toContain("bar: 1, 2")

  const horizontalXy = render(["xychart horizontal", '  title "Latency"', "  x-axis [API, UI]", "  bar [4, 7]"].join("\n"))
  expect(horizontalXy).toContain("API")
  expect(horizontalXy).toContain("UI")
  expect(horizontalXy).toContain("████")

  const verticalTimeline = render(["timeline TD", "  title Releases", "  2025 : Alpha", "  2026 : Beta"].join("\n"))
  expect(verticalTimeline).toContain("●")
  expect(verticalTimeline).toContain("▼")
  expect(verticalTimeline).toContain("Alpha")

  const sankey = render(["sankey", "  A,B,10", "  B,C,5"].join("\n"))
  expect(sankey).toContain("flow width = value")
  expect(sankey).toContain("████")

  const packet = render(["packet-beta", '  0-7: "Flags"', '  8-15: "Code"'].join("\n"))
  expect(packet).toContain("┬")
  expect(packet).toContain("┴")

  const kanban = render(["kanban", "  todo[Todo]", "    task[Task]", "  done[Done]", "    ship[Ship]"].join("\n"))
  expect(kanban).toMatch(/Todo\s+.*Done/)
  expect(kanban).toMatch(/Task\s+.*Ship/)

  const radar = render(["radar-beta", '  title "Skills"', '  axis a["Speed"], b["Quality"], c["Safety"]', '  curve team["Team"]{8, 9, 7}'].join("\n"))
  expect(radar).toContain("Scale")
  expect(radar).toContain("●")
  expect(radar).not.toContain("│ Curve")

  const eventModel = render(["eventmodeling", "  tf 01 ui Cart", "  tf 02 cmd AddItem", "  tf 03 evt ItemAdded"].join("\n"))
  expect(eventModel).toContain("UI / Automation")
  expect(eventModel).toContain("Command / Read Model")
  expect(eventModel).toContain("Events")
  expect(eventModel).not.toContain("│ Frame")

  const venn = render(["venn-beta", '  set A["Alpha"]:20', '  set B["Beta"]:12', '  union A,B["Shared"]:3'].join("\n"))
  expect(venn).toContain("Shared")
  expect(venn).toContain("·")

  const treemap = render(["treemap-beta", '  "Products"', '    "Apps": 12', '    "Tools": 8'].join("\n"))
  expect(treemap).toContain("Products")
  expect(treemap).toContain("┬")
  expect(treemap).toContain("Apps")

  const ishikawa = render(["ishikawa-beta", "  Blurry photo", "    Process", "      Out of focus", "    User", "      Shaky hands"].join("\n"))
  expect(ishikawa).toContain("═")
  expect(ishikawa).toContain("▶")
  expect(ishikawa).not.toContain("Cause branches")

  const wardley = render(["wardley-beta", "  anchor User [0.9, 0.1]", "  component App [0.7, 0.4]", "  User -> App"].join("\n"))
  expect(wardley).toContain("Visibility ↑")
  expect(wardley).toContain("Genesis")
  expect(wardley).toContain("Commodity")
  expect(wardley).toContain("─")
  expect(wardley).not.toContain("Links")

  const cynefin = render(["cynefin-beta", "  complex", '    "Experiment"', "  clear", '    "Runbook"', '  complex --> clear : "simplify"'].join("\n"))
  expect(cynefin).toContain("simplify")
  expect(cynefin).toContain("◀")
  expect(cynefin).not.toContain("Transitions")
})

test("renderPlanMarkdown covers C4 container, component, deployment, and relationship variants", () => {
  const variants = [
    ["C4Container", '  System_Ext(ext, "External")', '  SystemQueue(queue, "Queue")', '  ContainerDb(db, "Database")', '  ContainerQueue(worker, "Worker queue")', '  ComponentDb(store, "Store")', '  RelIndex(1, ext, queue, "publishes")'],
    ["C4Deployment", '  Deployment_Node(host, "Host")', '  Node_L(service, "Service")', '  Rel_U(host, service, "runs")'],
  ]

  for (const source of variants) {
    const result = renderPlanMarkdownStatic(["```mermaid", ...source, "```"].join("\n"), 88)
    expect(result).toContain("╭ Mermaid ASCII")
    expect(result).not.toContain("ASCII source fallback")
    expect(result).not.toContain(source[0] ?? "")
  }

  const container = renderPlanMarkdownStatic(["```mermaid", ...variants[0]!, "```"].join("\n"), 88)
  expect(container).toContain("External")
  expect(container).toContain("Queue")
  expect(container).toContain("publishes")
  const deployment = renderPlanMarkdownStatic(["```mermaid", ...variants[1]!, "```"].join("\n"), 88)
  expect(deployment).toContain("Host")
  expect(deployment).toContain("Service")
  expect(deployment).toContain("runs")
})

test("renderPlanMarkdown keeps Event Modeling data blocks and explicit relations", () => {
  const source = [
    "eventmodeling",
    '  tf 01 ui CartUI',
    '  tf 02 cmd AddItem {"sku":"A-1"}',
    '  tf 03 evt ItemAdded [[ItemData]]',
    "  01 ->> 03",
    "  data ItemData `json`{",
    '    "sku": "A-1"',
    "  }",
  ].join("\n")
  const result = renderPlanMarkdownStatic(["```mermaid", source, "```"].join("\n"), 88)
  expect(result).toContain("CartUI")
  expect(result).toContain("sku")
  expect(result).toContain("UI / Automation")
  expect(result).toContain("Events")
  expect(result).toContain("▶")
  expect(result).not.toContain("ASCII source fallback")
  expect(result).not.toContain("eventmodeling")
})

test("renderPlanMarkdown turns unsupported mermaid blocks into safe ASCII cards", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = ["Plan", "", "```mermaid", "unknownDiagram", "  A --> B", "```"].join("\n")

  const result = await renderPlanMarkdown(markdown, 80)
  expect(result).toContain("ASCII source fallback")
  expect(result).toContain("A ──▶ B")
  expect(result).not.toContain("```mermaid")
  expect(result).not.toContain("unknownDiagram")
})

test("renderPlanMarkdown converts every Mermaid block beyond the fast-path limit", () => {
  const markdown = Array.from({ length: 9 }, (_, index) =>
    ["```mermaid", "flowchart LR", `A${index}[Source ${index}] --> B${index}[Target ${index}]`, "```"].join("\n"),
  ).join("\n\n")

  const result = renderPlanMarkdownStatic(markdown, 80)
  expect(result.match(/Mermaid ASCII/g)?.length).toBe(9)
  expect(result.match(/Source [0-8]/g)?.length).toBe(9)
  expect(result).not.toContain("```mermaid")
  expect(result).not.toContain("flowchart LR")
})

test("renderPlanMarkdown keeps oversized valid Mermaid diagrams semantic and scrollable", () => {
  const repeatedLabel = "long label ".repeat(18)
  const lines = Array.from({ length: 48 }, (_, index) => {
    const next = index + 1
    return `n${index}["Node ${index} ${repeatedLabel}"]${next < 48 ? ` --> n${next}["Node ${next} ${repeatedLabel}"]` : ""}`
  })
  const source = ["flowchart LR", ...lines].join("\n")
  expect(Buffer.byteLength(source, "utf8")).toBeGreaterThan(8_000)

  const result = renderPlanMarkdownStatic(["```mermaid", source, "```"].join("\n"), 80)
  expect(result).toContain("Node 0")
  expect(result).toContain("Node 47")
  expect(result).not.toContain("ASCII source fallback")
  expect(Math.max(...result.split("\n").map((line) => Bun.stringWidth(line)))).toBeGreaterThan(80)
})

test("renderPlanMarkdown does not leak an unterminated Mermaid fence", () => {
  const result = renderPlanMarkdownStatic(["```mermaid", "flowchart TD", "A[Start] --> B[Finish]"].join("\n"), 80)

  expect(result).toContain("Start")
  expect(result).toContain("Finish")
  expect(result).toContain("▼")
  expect(result).not.toContain("```mermaid")
})

test("renderPlanMarkdown keeps the reference flowchart grammar connected", () => {
  const markdown = [
    "~~~mermaid",
    "flowchart LR",
    '  subgraph core["Core Services"]',
    '    gateway("API Gateway")',
    '    decision{"Token valid?"}',
    '    orders["Orders Service"]',
    '    store[("Postgres")]',
    "  end",
    '  gateway --> decision -->|yes| orders',
    '  decision -->|no| gateway',
    "  orders ==> store",
    '  orders --> left["Left"] & right["Right"]',
    '  note["Legacy note — unconnected"]',
    "~~~",
  ].join("\n")

  const result = renderPlanMarkdownStatic(markdown, 96)
  expect(result).toContain("API Gateway")
  expect(result).toContain("Token valid?")
  expect(result).toContain("Orders Service")
  expect(result).toContain("Postgres")
  expect(result).toContain("Legacy note — unconnected")
  expect(result).toContain("yes")
  expect(result).toContain("no")
  expect(result).toContain("────▶")
  expect(result).not.toContain("~~~mermaid")
  expect(result).not.toContain("flowchart LR")
})

test("renderPlanMarkdown preserves sequence fragments and notes as diagram rows", () => {
  const markdown = [
    "```mermaid",
    "sequenceDiagram",
    "  participant Client as Web Client",
    "  participant API as API",
    "  alt valid token",
    "    Client->>API: GET /items",
    "  else rejected",
    "    API-->>Client: 401 Unauthorized",
    "  end",
    "  Note over Client,API: retry once",
    "```",
  ].join("\n")

  const result = renderPlanMarkdownStatic(markdown, 100)
  expect(result).toContain("Web Client")
  expect(result).toContain("GET /items")
  expect(result).toContain("401 Unauthorized")
  expect(result).toContain("alt · valid token")
  expect(result).toContain("else · rejected")
  expect(result).toContain("retry once")
  expect(result).toContain("▶")
  expect(result).not.toContain("sequenceDiagram")
})

test("renderPlanMarkdown renders composite states and real cycle connectors", () => {
  const markdown = [
    "```mermaid",
    "stateDiagram-v2",
    '  state "Waiting for token" as Waiting',
    "  state Active {",
    "    state Running <<fork>>",
    "    Running --> Waiting: timeout",
    "  }",
    "  [*] --> Waiting",
    "  Waiting --> Active",
    "  Active --> [*]: done",
    "```",
  ].join("\n")

  const result = renderPlanMarkdownStatic(markdown, 96)
  expect(result).toContain("Waiting for token")
  expect(result).toContain("Active {}")
  expect(result).toContain("fork · Running")
  expect(result).toContain("timeout")
  expect(result).toContain("done")
  expect(result).toContain("▼")
  expect(result).toContain("●")
  expect(result).toContain("◉")
  expect(result).not.toContain("path 1")
  expect(result).not.toContain("stateDiagram-v2")
})

test("renderPlanMarkdown renders every ER field and cardinality without dropping cross-links", () => {
  const markdown = [
    "```mermaid",
    "erDiagram",
    "  USER ||--o{ ORDER : places",
    "  USER }|..|{ AUDIT_LOG : records",
    "  ORDER {",
    "    uuid id PK",
    "    datetime createdAt",
    "  }",
    "  AUDIT_LOG {",
    "    uuid id FK",
    "    string eventName",
    "  }",
    "```",
  ].join("\n")

  const result = renderPlanMarkdownStatic(markdown, 96)
  expect(result).toContain("USER")
  expect(result).toContain("ORDER")
  expect(result).toContain("AUDIT_LOG")
  expect(result).toContain("uuid id PK")
  expect(result).toContain("datetime createdAt")
  expect(result).toContain("uuid id FK")
  expect(result).toContain("records")
  expect(result).toMatch(/}\|╌/)
  expect(result).toMatch(/╌\|\{/)
  expect(result).not.toContain("erDiagram")
})

test("follow-up Mermaid screenshot regressions keep bounded and faithful geometry", () => {
  const render = (source: string, width = 88) => renderPlanMarkdownStatic(["```mermaid", source, "```"].join("\n"), width)

  const longFlow = render([
    "flowchart LR",
    ...Array.from({ length: 120 }, (_, index) => `n${index}[Step ${index}] --> n${index + 1}[Step ${index + 1}]`),
  ].join("\n"), 56)
  expect(longFlow).toContain("Step 0")
  expect(longFlow).toContain("Step 120")
  expect(Math.max(...longFlow.split("\n").map((line) => Bun.stringWidth(line)))).toBeLessThanOrEqual(190)
  expect(longFlow.split("\n").length).toBeGreaterThan(70)

  const er = render([
    "erDiagram",
    "  USER ||--o{ ORDER : places",
    "  ORDER ||--|{ LINE_ITEM : contains",
    "  PRODUCT ||--o{ LINE_ITEM : appears in",
    "  USER {",
    "    uuid id PK",
    "  }",
    "  ORDER {",
    "    uuid id PK",
    "  }",
  ].join("\n"))
  expect(er.match(/│\s+ORDER\s+│/g)?.length).toBe(1)
  expect(er.match(/│\s+LINE_ITEM\s+│/g)?.length).toBe(1)
  expect(er).toContain("appears in")

  const journey = render(["journey", "  title Checkout", "  section Purchase", "    Pay: 5: Customer"].join("\n"))
  expect(journey).toContain("★★★★★  5/5")
  expect(journey).toContain("● Customer")
  expect(journey).not.toContain("Satisfaction")

  const git = render(["gitGraph", '  commit id: "start"', "  branch feature", '  commit id: "work"'].join("\n"))
  expect(git).toMatch(/feature\s+.*●/)
  expect(git).toContain("work")

  const architecture = render([
    "architecture-beta",
    "  group core(cloud)[Core]",
    "  service api(server)[API] in core",
    "  service db(database)[DB] in core",
    "  api:R --> L:db",
    "  junction split",
  ].join("\n"))
  expect(architecture).toContain("Core · cloud")
  expect(architecture).toContain("◆ split")
  expect(architecture).not.toContain("group: core")

  const radar = render([
    "radar-beta",
    '  axis speed["Speed"], quality["Quality"], safety["Safety"]',
    '  curve team["Team"]{quality: 9, speed: 8, safety: 7}',
  ].join("\n"))
  expect(radar).toContain("Speed")
  expect(radar).toContain("Quality")
  expect(radar).toContain("Safety")
  expect(radar).not.toMatch(/[█▓▒░]/)

  const wardley = render([
    "wardley-beta",
    "  anchor User [0.9, 0.1]",
    "  component App [0.7, 0.4]",
    "  User -> App",
    "  evolve App 0.8",
    '  note "Move right" [0.3, 0.5]',
  ].join("\n"))
  expect(wardley).toContain("Custom built")
  expect(wardley).toContain("Move right")
  expect(wardley).toContain("▶")

  const cynefin = render([
    "cynefin-beta",
    "  complex",
    '    "Experiment"',
    "  clear",
    '    "Runbook"',
    '  complex --> clear : "simplify"',
  ].join("\n"))
  expect(cynefin).toContain("Probe → Sense → Respond")
  expect(cynefin).toContain("CONFUSION / DISORDER")
  expect(cynefin).toContain("simplify")
  expect(cynefin).not.toContain("(empty)")
})

test("Mermaid family matrix renders every current diagram family inside an ASCII card", () => {
  const fixtures = [
    { head: "flowchart", source: ["flowchart TD", "  A[Start] --> B{Ready?}", "  B -->|yes| C[Done]"].join("\n"), expected: ["Start", "Done"] },
    {
      head: "swimlane-beta",
      source: [
        "swimlane-beta LR",
        '  subgraph customer["Customer"]',
        "    request[Request] --> response[Response]",
        "  end",
        '  subgraph service["Service"]',
        "    receive[Receive]",
        "  end",
        "  request --> receive",
      ].join("\n"),
      expected: ["Customer", "Receive", "▶"],
    },
    { head: "sequenceDiagram", source: ["sequenceDiagram", "  participant A as Alice", "  participant B as Bob", "  A->>B: Hello"].join("\n"), expected: ["Alice", "Hello"] },
    { head: "classDiagram", source: ["classDiagram", "  class User {", "    +id: string", "  }", "  User --> Account : owns"].join("\n"), expected: ["User", "owns"] },
    { head: "stateDiagram-v2", source: ["stateDiagram-v2", "  [*] --> Idle", "  Idle --> Done: finish", "  Done --> [*]"].join("\n"), expected: ["Idle", "finish"] },
    { head: "erDiagram", source: ["erDiagram", "  USER ||--o{ ORDER : places", "  USER {", "    string id PK", "  }"] .join("\n"), expected: ["USER", "places"] },
    { head: "journey", source: ["journey", "  title Checkout", "  section Purchase", "    Pay: 5: Customer"].join("\n"), expected: ["Checkout", "Pay"] },
    { head: "gantt", source: ["gantt", "  title Release", "  dateFormat YYYY-MM-DD", "  section Build", "  API :a1, 2024-01-01, 2d"].join("\n"), expected: ["Release", "API"] },
    { head: "pie", source: ["pie title Status", '  "Done" : 70', '  "Todo" : 30'].join("\n"), expected: ["Status", "Done"] },
    { head: "quadrantChart", source: ["quadrantChart", "  title Effort", "  x-axis Low --> High", "  y-axis Risk --> Safe", "  Quick win: [0.8, 0.7]"].join("\n"), expected: ["Effort", "Quick win"] },
    { head: "requirementDiagram", source: ["requirementDiagram", "  requirement req_login {", "    id: 1", "    text: User can login", "  }"].join("\n"), expected: ["req_login", "User can login"] },
    { head: "gitGraph", source: ["gitGraph", '  commit id: "start"', "  branch feature", "  checkout feature", '  commit id: "work"'].join("\n"), expected: ["Git graph", "work"] },
    { head: "C4Context", source: ["C4Context", '  Person(user, "User")', '  System(app, "App")', '  Rel(user, app, "Uses")'].join("\n"), expected: ["C4 Context", "Uses"] },
    { head: "mindmap", source: ["mindmap", "  root((Root))", "    Child"].join("\n"), expected: ["Mindmap", "Child"] },
    { head: "timeline", source: ["timeline", "  title History", "  2020 : Start", "  2021 : Next"].join("\n"), expected: ["History", "Start"] },
    { head: "zenuml", source: ["zenuml", "  Client->API: GET /items"].join("\n"), expected: ["ZenUML", "GET /items"] },
    { head: "sankey", source: ["sankey", "  A,B,10", "  B,C,5"].join("\n"), expected: ["Sankey", "A", "10"] },
    { head: "xychart-beta", source: ["xychart-beta", '  title "Growth"', "  x-axis [Jan, Feb]", "  bar [1, 2]"].join("\n"), expected: ["Growth", "Jan", "█"] },
    { head: "block-beta", source: ["block-beta", "  columns 2", '  A["Client"] B["Server"]', "  A --> B"].join("\n"), expected: ["Block diagram", "Client", "Server", "──▶"] },
    { head: "packet-beta", source: ["packet-beta", '  0-7: "Flags"', '  8-15: "Code"'].join("\n"), expected: ["Packet", "Flags", "Code"] },
    { head: "kanban", source: ["kanban", "  backlog[Backlog]", '    task[Task]@{ticket: "42"}', "  done[Done]", "    ship[Ship]"].join("\n"), expected: ["Kanban", "Task", "ticket", "Ship"] },
    { head: "architecture-beta", source: ["architecture-beta", "  group core(cloud)[Core]", "  service api(server)[API] in core", "  service db(database)[DB] in core", "  api:R --> L:db", "  junction split"].join("\n"), expected: ["Architecture", "Core", "API", "DB", "──▶"] },
    { head: "radar-beta", source: ["radar-beta", '  title "Skills"', '  axis a["Speed"], b["Quality"]', '  curve team["Team"]{8, 9}'].join("\n"), expected: ["Skills", "Team"] },
    { head: "eventmodeling", source: ["eventmodeling", "  tf 01 ui Cart", "  tf 02 cmd AddItem", "  tf 03 evt ItemAdded"].join("\n"), expected: ["Event modeling", "ItemAdded"] },
    { head: "treemap-beta", source: ["treemap-beta", '  "Products"', '    "Apps": 12', '    "Tools": 8'].join("\n"), expected: ["Treemap", "Products", "Apps"] },
    { head: "venn-beta", source: ["venn-beta", '  set A["Alpha"]:20', '  set B["Beta"]:12', '  union A,B["Shared"]:3', '  text A1["React"]'].join("\n"), expected: ["Venn", "Alpha", "Shared"] },
    { head: "ishikawa-beta", source: ["ishikawa-beta", "  Blurry photo", "    Process", "      Out of focus", "    User", "      Shaky hands"].join("\n"), expected: ["Ishikawa", "Blurry photo", "Shaky hands"] },
    { head: "wardley-beta", source: ["wardley-beta", "  anchor User [0.9, 0.1]", "  component App [0.7, 0.4]", "  User -> App"].join("\n"), expected: ["Wardley", "User", "App"] },
    { head: "cynefin-beta", source: ["cynefin-beta", "  title Decision", "  complex", '    "Experiment"', "  clear", '    "Runbook"', '  complex --> clear : "simplify"'].join("\n"), expected: ["Cynefin", "Experiment", "simplify"] },
    { head: "treeView-beta", source: ["treeView-beta", "  root", "    src", "      index.ts", "    README.md"].join("\n"), expected: ["TreeView", "index.ts", "README.md"] },
  ]

  for (const fixture of fixtures) {
    const result = renderPlanMarkdownStatic(["```mermaid", fixture.source, "```"].join("\n"), 72)
    expect(result).toContain("╭ Mermaid ASCII")
    for (const expected of fixture.expected) expect(result).toContain(expected)
    expect(result).not.toContain("ASCII source fallback")
    expect(result).not.toContain("```mermaid")
    expect(result).not.toContain(`\n${fixture.head}\n`)
    const card = /```text\n([\s\S]*?)\n```/.exec(result)?.[1]
    expect(card).toBeDefined()
    expect(new Set(card?.split("\n").map((line) => Bun.stringWidth(line))).size).toBe(1)
  }
})

test("flowchart shape matrix preserves every expanded Mermaid shape as a labeled ASCII node", () => {
  const shapes = [
    "bang", "notch-rect", "cloud", "hourglass", "bolt", "brace", "brace-r", "braces", "lean-r", "lean-l",
    "datastore", "cyl", "diam", "delay", "h-cyl", "lin-cyl", "curv-trap", "div-rect", "doc", "rounded",
    "tri", "fork", "win-pane", "f-circ", "lin-doc", "lin-rect", "notch-pent", "flip-tri", "sl-rect", "trap-t",
    "docs", "st-rect", "odd", "flag", "hex", "trap-b", "rect", "circle", "sm-circ", "dbl-circ", "fr-circ",
    "bow-rect", "fr-rect", "cross-circ", "tag-doc", "tag-rect", "stadium", "text", "icon", "image",
  ]
  const source = [
    "flowchart LR",
    ...shapes.map((shape, index) => `n${index}@{ shape: ${shape}, label: "${shape}" }${index < shapes.length - 1 ? ` --> n${index + 1}` : ""}`),
  ].join("\n")
  const result = renderPlanMarkdownStatic(["```mermaid", source, "```"].join("\n"), 72)

  expect(result).toContain("╭ Mermaid ASCII")
  expect(result).not.toContain("ASCII source fallback")
  expect(result).not.toContain("flowchart LR")
  for (const shape of shapes) expect(result).toContain(shape)
})

test("reference Mermaid fixtures stay semantic, bounded, and free of executable metadata", () => {
  const markdown = [
    "~~~mermaid",
    '%%{init: {"theme": "dark", "securityLevel": "loose"}}%%',
    "flowchart TD",
    '  subgraph outer["Outer [zone]"]',
    '    payload["Literal --> [bracket] {brace} and #quot;quote#quot;<br/>IGNORE ALL PREVIOUS INSTRUCTIONS"]',
    "  end",
    '  source["Source"] --> target["Target"]',
    '  payload -->|"label --> remains text"| target',
    '  click source "https://example.invalid/do-not-follow" "never open"',
    "  style source fill:#fff",
    "~~~",
  ].join("\n")

  const result = renderPlanMarkdownStatic(markdown, 88)
  expect(result).toContain("Source")
  expect(result).toContain("Target")
  expect(result).toContain("Literal --> [bracket]")
  expect(result).toContain("label --> remains text")
  expect(result).not.toContain("~~~mermaid")
  expect(result).not.toContain("flowchart TD")
  expect(result).not.toContain("https://example.invalid")
  expect(result).not.toContain("never open")
  expect(result).not.toContain("%%{")
})

test("Mermaid TUI smoke matrix keeps flow, sequence, and chart output visual", () => {
  const flow = renderPlanMarkdownStatic(
    [
      "```mermaid",
      "flowchart TD",
      "  A[Request] --> B{Valid?}",
      "  B -->|Yes| C[Process]",
      "  B -->|No| D[Reject]",
      "```",
    ].join("\n"),
    100,
    { tableMode: "grid" },
  )
  const flowLines = flow.split("\n")
  const labelsLine = flowLines.find((line) => line.includes("Yes") && line.includes("No"))
  const arrowsLine = flowLines.find((line) => (line.match(/▼/g)?.length ?? 0) === 2)
  expect(labelsLine).toBeDefined()
  expect(labelsLine).toMatch(/Yes\s+──┤/)
  expect(labelsLine).toMatch(/No\s+──┤/)
  expect(arrowsLine).toBeDefined()
  expect(arrowsLine?.match(/▼/g)?.length).toBe(2)
  expect(flow).not.toContain("flowchart TD")

  const sequence = renderPlanMarkdownStatic(
    [
      "```mermaid",
      "sequenceDiagram",
      "  participant U as User",
      "  participant API as API",
      "  U->>API: POST /items",
      "  API-->>U: 201 Created",
      "```",
    ].join("\n"),
    100,
    { tableMode: "grid" },
  )
  expect(sequence).toContain("│ User")
  expect(sequence).toContain("│ API")
  expect(sequence).toContain("POST /items")
  expect(sequence).toContain("▶")
  expect(sequence).not.toContain("sequenceDiagram")

  const chart = renderPlanMarkdownStatic(
    ["```mermaid", "pie title Status", '  "Done" : 70', '  "Todo" : 30', "```"].join("\n"),
    100,
    { tableMode: "grid" },
  )
  expect(chart).toContain("Status")
  expect(chart).toContain("████")
  expect(chart).toContain("70 (70.0%)")
  expect(chart).not.toContain("pie title")
})
