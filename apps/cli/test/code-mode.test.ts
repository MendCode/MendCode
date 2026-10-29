import { afterEach, expect, test } from "bun:test"
import { b71Harness } from "./b71-harness"
import { cleanTemps } from "./session-ui-harness"
import { textWidth } from "../src/view/wrap"

afterEach(cleanTemps)

for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
  for (const state of ["selected", "denied", "invalid", "syntax"] as const) {
    test(`Code Mode ${state} renders on existing rows at ${width}×${height}`, async () => {
      const h = await b71Harness(width!, height!, state)
      expect(h.requests[0]!.tools.map((tool) => tool.name)).toContain("code")
      expect(h.requests[0]!.tools.map((tool) => tool.name)).not.toContain("mcp__local__symbols")
      expect(h.calls()).toBe(state === "selected" ? 1 : 0)
      expect(h.text()).toHaveLength(height!)
      expect(h.text().every((row) => textWidth(row) <= width! && !row.includes("\x1b"))).toBe(true)
      expect(h.text().join("\n")).toContain("code")
      expect(h.text().join("\n")).toContain(h.answer)
      await h.type("\x0f")
      const frame = h.text().join("\n")
      expect(frame).toContain(state === "selected" ? '"value":["start","stop"]' : state === "denied" ? '"ok":false' : state === "invalid" ? "InvalidToolInput" : "ParseError")
      if (state === "selected" || state === "invalid") expect(frame).toContain("mcp__local__symbols")
      expect(h.text().every((row) => textWidth(row) <= width!)).toBe(true)
      await h.type("\x03")
    })
  }
}
