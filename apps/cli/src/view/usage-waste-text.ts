import type { UsageWasteReport } from "@mendcode/protocol"
import { glyphs } from "../ui/theme"
import { reportGrid } from "./usage-tabs"
import { wasteTab } from "./usage-waste-tab"

/** `mendcode stats --waste`: the Waste tab's panels as plain text, without the selection marks or keys. */
export function wasteText(report: UsageWasteReport, width = 92): string {
  const head = `Waste · ${report.from} to ${report.to} · ${report.scope.kind}${report.scope.directory ? ` · ${report.scope.directory}` : ""}`
  const rows = reportGrid((view) => wasteTab({ report, index: -1, width: view.width, glyphs: view.glyphs, plain: true }), { width, glyphs: glyphs() } as Parameters<typeof reportGrid>[1])
  return `${head}\n${rows.map((line) => line.map((span) => span.text).join("").trimEnd()).join("\n")}\n`
}
