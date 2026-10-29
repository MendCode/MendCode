import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import fixtures from "../apps/cli/test/fixtures/mermaid-ui9.json"
import { closeUi9, ui9Harness } from "../apps/cli/test/ui-9-harness"
import { cleanTemps } from "../apps/cli/test/session-ui-harness"
import { renderMermaid } from "../apps/cli/src/view/mermaid"
import { textWidth } from "../apps/cli/src/view/wrap"

const directory = process.argv[2]
if (!directory) throw new Error("usage: render-ui9-frames.ts <directory>")
mkdirSync(directory, { recursive: true })
const counts = new Map<string, number>()
try {
  for (const fixture of fixtures) {
    const n = (counts.get(fixture.kind) ?? 0) + 1
    counts.set(fixture.kind, n)
    for (const [width, height] of [[100, 30], [180, 50]] as const) {
      const canvas = renderMermaid(fixture.source, width)
      if (!("lines" in canvas)) throw new Error(`${fixture.kind}-${n}: ${canvas.note}`)
      const rows = canvas.lines.map((row) => row.map((span) => span.text).join(""))
      if (rows.some((row) => textWidth(row) > width || row.includes("\x1b"))) throw new Error(`invalid canvas ${fixture.kind}-${n}`)
      const name = `${fixture.kind}-${n}-${width}`
      writeFileSync(path.join(directory, `${name}.canvas.txt`), rows.join("\n") + "\n")
      const h = await ui9Harness(fixture.source, width, height)
      try {
        h.app.render()
        const frame = h.text()
        if (h.app.page !== "diagram" || frame.length !== height || frame.some((row) => textWidth(row) > width || row.includes("\x1b"))) throw new Error(`invalid frame ${name}`)
        writeFileSync(path.join(directory, `${name}.txt`), frame.join("\n") + "\n")
      } finally {
        await closeUi9(h)
      }
    }
  }
  process.stdout.write(`${fixtures.length} fixtures · ${counts.size} families · ${fixtures.length * 2} app frames and full canvases\n`)
} finally {
  cleanTemps()
}
