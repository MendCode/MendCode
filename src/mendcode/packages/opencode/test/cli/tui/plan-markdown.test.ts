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
  expect(result).toContain("│ Looks correct? │")
  expect(result).toContain("├─ Yes")
  expect(result).toContain("│ Accept change │")
  expect(result).toContain("└─ No")
  expect(result).toContain("↺ Add hello message")
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
  expect(result).toContain("├─ Yes")
  expect(result).toContain("│ Approve  │")
  expect(result).toContain("└─ No")
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
  expect(result).toContain("├─ Yes")
  expect(result).toContain("│ Create first workspace │")
  expect(result).toContain("│ Offer guided action │")
  expect(result).toContain("│ Track activation │")
  expect(result).toContain("└─ No")
  expect(result).toContain("│ Show correction │")
  expect(result).toContain("↺ Data valid?")
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
  expect(result).toContain("├─ Yes")
  expect(result).toContain("│ Try product examples │")
  expect(result).toContain("│ Confirm onboarding complete │")
  expect(result).toContain("└─ No")
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
  expect(result).toContain("├─ Yes")
  expect(result).toContain("│ Accept change │")
  expect(result).toContain("└─ No")
  expect(result).toContain("│ Fix placement or formatting │")
  expect(result).toContain("↺ Check raw Markdown")
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
  expect(result).toContain("└─ ||--o{ places")
  expect(result).toContain("└─ ||--|{ contains")
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
  expect(result).toContain("└─ }|..|{ uses")
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

test("renderPlanMarkdown renders Mermaid state diagrams locally", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = ["```mermaid", "stateDiagram-v2", "  [*] --> Idle", "  Idle --> Running: start", "```"].join(
    "\n",
  )

  const result = await renderPlanMarkdown(markdown, 100)
  expect(result).toContain("┌ ● ┐ ──▶ ┌ Idle ┐")
  expect(result).toContain("┌ Idle ┐ ── start ─▶ ┌ Running ┐")
  expect(result).not.toContain("stateDiagram-v2")
})

test("renderPlanMarkdown renders Mermaid class diagrams locally", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = ["```mermaid", "classDiagram", "  Animal <|-- Duck", "  Duck : +swim()", "```"].join("\n")

  const result = await renderPlanMarkdown(markdown, 100)
  expect(result).toContain("┌ Animal ┐ <|-- ┌ Duck ┐")
  expect(result).toContain("┌ Duck ┐  +swim()")
  expect(result).not.toContain("classDiagram")
})

test("renderPlanMarkdown renders Mermaid pie charts locally", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = ["```mermaid", "pie", "  title Status", "  \"Done\" : 60", "  \"Todo\" : 40", "```"].join("\n")

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
  expect(result).toContain("• Root")
  expect(result).toContain("  ◦ Child")
  expect(result).not.toContain("mindmap")
})

test("renderPlanMarkdown renders additional Mermaid chart families locally", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = [
    "```mermaid",
    "quadrantChart",
    "  title Prioridades",
    "  x-axis Bajo --> Alto",
    "  Feature A: [0.8, 0.6]",
    "```",
    "```mermaid",
    "gitGraph",
    "  commit id: \"init\"",
    "  branch feature",
    "  checkout feature",
    "  commit id: \"work\"",
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
  expect(result).toContain("Prioridades")
  expect(result).toContain("Feature A (0.8, 0.6)")
  expect(result).toContain("Git graph")
  expect(result).toContain("branch feature")
  expect(result).toContain("Ventas")
  expect(result).toContain("bar: 2, 4")
  expect(result).toContain("┌ A ┐ ── 10 ─▶ ┌ B ┐")
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
  expect(result).toContain("┌ req_login ┐")
  expect(result).toContain("C4Context")
  expect(result).toContain("Person: ┌ User ┐")
  expect(result).toContain("┌ user ┐ ── Uses ─▶ ┌ app ┐")
  expect(result).toContain("Block diagram")
  expect(result).toContain("┌ Client ┐ ── ┌ Server ┐")
  expect(result).toContain("Packet")
  expect(result).toContain("0-15")
  expect(result).toContain("Architecture")
  expect(result).toContain("┌ api ┐ server API")
  expect(result).not.toContain("requirementDiagram")
  expect(result).not.toContain("block-beta")
  expect(result).not.toContain("packet-beta")
  expect(result).not.toContain("architecture-beta")
})

test("renderPlanMarkdown keeps unsupported mermaid blocks as code", async () => {
  process.env.MENDCODE_TERMAID_BIN = "/definitely/not/termaid"
  const markdown = ["Plan", "", "```mermaid", "unknownDiagram", "  A --> B", "```"].join("\n")

  expect(await renderPlanMarkdown(markdown, 80)).toBe(markdown)
})
