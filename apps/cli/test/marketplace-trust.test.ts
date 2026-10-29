import { expect, test } from "bun:test"
import type { PackagePreviewReport } from "@mendcode/protocol"
import { createMarketplaceState, renderMarketplacePage } from "../src/view/marketplace-page"
import { textWidth } from "../src/view/wrap"

test("trust warnings render in the existing preview at narrow and wide widths", () => {
  const preview: PackagePreviewReport = { scope: "project", action: "install", problems: [], entry: { name: "stable-id", title: "Renamed title", version: "1", description: "one command", sourceId: "local", location: "/temp", tags: [], state: "available", contents: { skills: 0, commands: 1, tools: 0, themes: 0, mcp: false } }, trust: { identity: "stable-id", signed: false, authorization: "required", duplicates: ["user:duplicate"], comparisonComplete: false } }
  for (const width of [42, 80, 120]) {
    const rows = renderMarketplacePage({ state: createMarketplaceState(), preview, report: { entries: [preview.entry], query: "", issues: [] }, sources: [], error: "", width, height: 70 })
    const text = rows.map((line) => line.map((span) => span.text).join(""))
    expect(text.join("\n")).toContain("Trust · unsigned")
    expect(text.join("\n")).toContain("stable-id")
    expect(text.join("\n")).toContain("Duplicate content")
    for (const line of text) expect(textWidth(line)).toBeLessThanOrEqual(width)
  }
})
