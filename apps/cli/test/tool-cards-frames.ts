import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { toolCardsSession, toolCardsView } from "./tool-cards-session"

/** Dumps the faux tool session in every view and size: `bun apps/cli/test/tool-cards-frames.ts <out dir>`. */
const out = process.argv[2]
if (!out) throw new Error("usage: bun apps/cli/test/tool-cards-frames.ts <out dir>")
mkdirSync(out, { recursive: true })
const events = toolCardsSession()
for (const [width, height] of [[100, 30], [200, 60]] as const) {
  for (const mode of ["minimal", "balanced", "full"] as const) {
    const rows = toolCardsView(events, { mode, width, height: 1000 }).rows()
    writeFileSync(path.join(out, `${mode}-${width}x${height}.txt`), `${rows.join("\n")}\n`)
  }
}
console.log(`frames written to ${out}`)
