/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA, SyntaxStyle, type ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { StyledPlanMarkdown } from "../../../src/cli/cmd/tui/component/styled-plan-markdown"
import { renderPlanMarkdownStatic } from "../../../src/cli/cmd/tui/util/markdown-render"

test("Mermaid ASCII card renders fitted controls and a bounded local canvas", async () => {
  const source = [
    "```mermaid",
    "journey",
    "  title Checkout journey",
    "  section Purchase",
    "    Add to cart: 5: Customer",
    "    Enter payment: 2: Customer, Payment",
    "    Confirm order: 5: Customer",
    "```",
  ].join("\n")
  const content = renderPlanMarkdownStatic(source, 160)
  const syntaxStyle = SyntaxStyle.create()
  const app = await testRender(
    () => (
      <StyledPlanMarkdown
        source={source}
        content={content}
        syntaxStyle={syntaxStyle}
        width={60}
        fg={RGBA.fromInts(235, 235, 235)}
        bg={RGBA.fromInts(20, 20, 20)}
      />
    ),
    { width: 80, height: 36 },
  )

  try {
    await Bun.sleep(20)
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("[−] [Fit] [+]")
    expect(frame).toContain("Center")
    expect(frame).toContain("Mermaid ASCII · journey")
    expect(frame).toContain("Add to cart")
    expect(Math.max(...frame.split("\n").map((line) => Bun.stringWidth(line)))).toBeLessThanOrEqual(80)

    const plusColumn = frame.split("\n")[0]?.indexOf("[+]") ?? -1
    expect(plusColumn).toBeGreaterThan(0)
    await app.mockMouse.click(plusColumn + 1, 0)
    await Bun.sleep(20)
    await app.renderOnce()
    const zoomedFrame = app.captureCharFrame()
    expect(zoomedFrame).not.toContain("[Fit]")

    const fitColumn = zoomedFrame.split("\n")[0]?.indexOf("Fit") ?? -1
    expect(fitColumn).toBeGreaterThan(0)
    await app.mockMouse.click(fitColumn + 1, 0)
    await Bun.sleep(20)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("[Fit]")
  } finally {
    app.renderer.destroy()
    syntaxStyle.destroy()
  }
})

test("a tall Mermaid ASCII card opens at the beginning and stays inside the chat viewport", async () => {
  const nodes = Array.from({ length: 120 }, (_, index) => `  S${index}[Step ${index}]`).join("\n")
  const edges = Array.from({ length: 119 }, (_, index) => `  S${index} --> S${index + 1}`).join("\n")
  const source = ["```mermaid", "flowchart LR", nodes, edges, "```"].join("\n")
  const content = renderPlanMarkdownStatic(source, 160)
  const syntaxStyle = SyntaxStyle.create()
  const app = await testRender(
    () => (
      <StyledPlanMarkdown
        source={source}
        content={content}
        syntaxStyle={syntaxStyle}
        width={60}
        fg={RGBA.fromInts(235, 235, 235)}
        bg={RGBA.fromInts(20, 20, 20)}
      />
    ),
    { width: 80, height: 36 },
  )

  try {
    await Bun.sleep(20)
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("[−] [Fit] [+]")
    expect(frame).toContain("Step 0")
    expect(frame).not.toContain("Step 119")
    expect(Math.max(...frame.split("\n").map((line) => Bun.stringWidth(line)))).toBeLessThanOrEqual(80)
  } finally {
    app.renderer.destroy()
    syntaxStyle.destroy()
  }
})

test("nested Mermaid controls work and vertical wheel continues scrolling the transcript", async () => {
  const source = [
    "```mermaid",
    "sankey-beta",
    "Users,Website,100",
    "Website,API,80",
    "API,Database,60",
    "API,Cache,20",
    "```",
  ].join("\n")
  const content = renderPlanMarkdownStatic(source, 160)
  const syntaxStyle = SyntaxStyle.create()
  let transcript: ScrollBoxRenderable | undefined
  const app = await testRender(
    () => (
      <scrollbox ref={(value: ScrollBoxRenderable) => (transcript = value)} width={80} height={18}>
        <box height={6} flexShrink={0} />
        <StyledPlanMarkdown
          source={source}
          content={content}
          syntaxStyle={syntaxStyle}
          width={60}
          fg={RGBA.fromInts(235, 235, 235)}
          bg={RGBA.fromInts(20, 20, 20)}
        />
        <box height={30} flexShrink={0} />
      </scrollbox>
    ),
    { width: 80, height: 24 },
  )

  try {
    await Bun.sleep(20)
    transcript?.scrollTo(6)
    await app.renderOnce()

    const frame = app.captureCharFrame()
    const controlRow = frame.split("\n").findIndex((line) => line.includes("[−] [Fit] [+]"))
    const plusColumn = frame.split("\n")[controlRow]?.indexOf("[+]") ?? -1
    expect(controlRow).toBeGreaterThanOrEqual(0)
    expect(plusColumn).toBeGreaterThan(0)

    await app.mockMouse.click(plusColumn + 1, controlRow)
    await Bun.sleep(20)
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("[Fit]")

    const before = transcript?.scrollTop ?? 0
    await app.mockMouse.scroll(plusColumn + 1, controlRow + 2, "down")
    await Bun.sleep(20)
    await app.renderOnce()
    expect(transcript?.scrollTop ?? 0).toBeGreaterThan(before)
  } finally {
    app.renderer.destroy()
    syntaxStyle.destroy()
  }
})
