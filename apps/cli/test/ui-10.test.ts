import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { renderMermaid } from "../src/view/mermaid"
import { Canvas } from "../src/view/mermaid/core"
import { cells } from "../src/view/wrap"
import { textWidth } from "../src/view/wrap"
import { appHarness, scratch } from "./extensions-harness"
import { closeUi9, ui9Harness } from "./ui-9-harness"
import { cleanTemps } from "./session-ui-harness"
import { examples } from "./fixtures/ui10-examples"
import { largeMermaidFixtures } from "./fixtures/mermaid-ui10"

const temporary: Array<ReturnType<typeof scratch>> = []
const frameDirectory = ".agents/runs/frames/ui-10"
const dump = (name: string, rows: string[], width: number, height: number) => {
  expect(rows).toHaveLength(height)
  for (const row of rows) {
    expect(textWidth(row)).toBeLessThanOrEqual(width)
    expect(row).not.toContain("\x1b")
  }
  if (process.env.UI10_FRAMES === "1") {
    mkdirSync(frameDirectory, { recursive: true })
    writeFileSync(`${frameDirectory}/${name}-${width}x${height}.txt`, rows.join("\n") + "\n")
  }
}
afterEach(() => { cleanTemps(); for (const temp of temporary.splice(0)) temp.cleanup() })

for (const fixture of largeMermaidFixtures) {
  test(`UI-10 large ${fixture.kind}: labels never overlap or escape width`, async () => {
    expect(fixture.count).toBeGreaterThanOrEqual(15)
    for (const [width, height] of [[100, 30], [180, 50]] as const) {
      const written: Array<{ canvas: Canvas; column: number; row: number; glyph: string }> = []
      const original = Canvas.prototype.text
      const observer = spyOn(Canvas.prototype, "text").mockImplementation(function (this: Canvas, column, row, value, role) {
        if (["text", "label", "keyword"].includes(role)) {
          let cursor = column
          for (const cell of cells(value)) {
            if (cell.text.trim()) written.push({ canvas: this, column: cursor, row, glyph: cell.text })
            cursor += Math.max(1, cell.width)
          }
        }
        original.call(this, column, row, value, role)
      })
      let result: ReturnType<typeof renderMermaid>
      try { result = renderMermaid(fixture.source, width) } finally { observer.mockRestore() }
      for (const cell of written) expect(cell.canvas.charAt(cell.column, cell.row)).toBe(cell.glyph)
      if (!("lines" in result)) throw new Error(`${fixture.kind}: ${result.note}`)
      const rows = result.lines.map((line) => line.map((span) => span.text).join(""))
      const text = rows.join("\n")
      for (const token of fixture.tokens) expect(text.split(token).length - 1).toBe(1)
      for (const row of rows) expect(textWidth(row)).toBeLessThanOrEqual(width)
      const harness = await ui9Harness(fixture.source, width, height)
      try {
        expect(harness.app.page).toBe("diagram")
        expect(harness.text().join("\n")).not.toContain("shown as source")
        dump(`mermaid-${fixture.kind}`, harness.text(), width, height)
      } finally { await closeUi9(harness) }
    }
  })
}

for (const [name, source] of Object.entries(examples)) {
  test(`UI-10 ${name} example draws through the app`, async () => {
    for (const [width, height] of [[100, 30], [180, 50]] as const) {
      const temp = scratch()
      temporary.push(temp)
      temp.write("data/extensions/example.ts", source)
      temp.write("data/tui/profile.json", JSON.stringify({ pet: "off", images: "off", sidebar: "hidden" }))
      const harness = await appHarness({ dataDir: temp.dataDir, directory: temp.project, width, height })
      try {
        await harness.start({ onboarded: true, reducedMotion: true })
        harness.message("Check the deployment plan", "The release has three checks: tests, migration review, and rollback readiness.")
        expect(harness.text()).not.toContain("tui() failed")
        if (name === "messages") {
          expect(harness.text()).toContain("◆ You")
          expect(harness.text()).toContain("◇ Agent")
          expect(harness.text()).toContain("MEND · Matrix workspace")
        } else if (name === "footer") {
          expect(harness.text()).toContain("UTC")
          expect(harness.text()).toContain("No Git branch")
        } else {
          expect(harness.text()).toContain("Console · enter sends")
          expect(harness.text()).toContain("Session · idle")
          expect(harness.text()).toContain("λ")
        }
        dump(`chat-${name}`, harness.rows(), width, height)
        if (name === "messages") {
          await harness.type("/customize\r")
          expect(harness.text()).toContain("Extensions")
          expect(harness.text()).toContain("matrix-messages")
          dump("customize-extensions", harness.rows(), width, height)
        }
      } finally { await harness.key("\x1b"); await harness.key("\x03"); await harness.key("\x03") }
    }
  })
}

test("UI-10 ER relationship labels never overwrite entity borders at natural viewer width", () => {
  const fixture = largeMermaidFixtures.find((entry) => entry.kind === "er")!
  const result = renderMermaid(fixture.source, 1500)
  if (!("lines" in result)) throw new Error(result.note)
  const rows = result.lines.map((line) => line.map((span) => span.text).join(""))
  const labels = rows.find((row) => row.includes("regional relationship"))!
  expect(labels.match(/├─+┤/g)).toHaveLength(16)
  for (const row of rows) expect(textWidth(row)).toBeLessThanOrEqual(1500)
})
