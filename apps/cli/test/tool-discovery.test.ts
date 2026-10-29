import { afterEach, expect, test } from "bun:test"
import { b26Harness } from "./b26-harness"
import { cleanTemps } from "./session-ui-harness"
import { textWidth } from "../src/view/wrap"

afterEach(cleanTemps)

test("native discovery receipts and validation errors render in chat without invoking the returned tool", async () => {
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
    for (const state of ["found", "empty", "invalid"] as const) {
      const h = await b26Harness(width!, height!, state)
      expect(h.requests[0]!.tools.map((tool) => tool.name)).not.toContain("mcp__local__symbols")
      expect(h.requests[1]!.tools.map((tool) => tool.name).includes("mcp__local__symbols")).toBe(state === "found")
      expect(h.text()).toHaveLength(height!)
      expect(h.text().every((row) => textWidth(row) <= width! && !row.includes("\x1b"))).toBe(true)
      expect(h.text().join("\n")).toContain("tool_search")
      expect(h.text().join("\n")).toContain(state === "found" ? "Found the local symbol tool." : state === "empty" ? "No matching tools." : "Search limit must be 1–8.")
      await h.type("\x0f")
      expect(h.text().join("\n")).toContain(state === "found" ? "mcp__local__symbols" : state === "empty" ? '"tools":[]' : "invalid arguments")
      await h.type("\x03")
    }
  }
})
