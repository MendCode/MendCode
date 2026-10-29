import { afterEach, expect, test } from "bun:test"
import { b86Harness } from "./b86-harness"
import { cleanTemps } from "./session-ui-harness"
import { textWidth } from "../src/view/wrap"

afterEach(cleanTemps)
test("B86 REST controls and durable ledger reconcile into the existing app factories without overflow", async () => {
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
    const h = await b86Harness(width!, height!)
    try {
      await h.type("/workflows\r")
      expect(h.text().join("\n")).toContain("REST workflow")
      expect(h.text().join("\n")).toContain("┌")
      const paused = await h.request(`/workflow/${h.workflowId}/pause`, { reason: "Review first" })
      expect(paused.run.state).toBe("paused")
      h.app.render()
      expect(h.text().join("\n")).toContain("paused")
      await h.request(`/workflow/${h.workflowId}/permission-mode`, { mode: "report-only", sessionMode: "approval" })
      await h.type("b")
      expect(h.text().join("\n")).toContain("Events")
      await h.type("2")
      expect(h.text().join("\n")).toContain("Artifacts")
      for (const frame of h.frames) {
        expect(frame.length).toBe(height!)
        expect(frame.every((row) => textWidth(row.map((span) => span.text).join("")) <= width!)).toBe(true)
      }
      const stopped = await h.request(`/workflow/${h.workflowId}/stop`, {})
      expect(stopped.run.state).toBe("stopped")
    } finally { await h.close() }
  }
})
