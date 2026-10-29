import { afterEach, expect, test } from "bun:test"
import { b21Harness } from "./b21-harness"
import { cleanTemps } from "./session-ui-harness"
import { textWidth } from "../src/view/wrap"

afterEach(cleanTemps)
test("B21 revision identity, borders and header hints render through the real app at all breakpoints", async () => {
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
    const h = b21Harness(width!, height!)
    await h.type("/workflows\r")
    const lines = h.text()
    expect(lines).toHaveLength(height!)
    for (const line of lines) expect(textWidth(line)).toBeLessThanOrEqual(width!)
    expect(lines.join("\n")).toContain("wfr_api-rewrite-v2")
    expect(lines.join("\n")).toContain("┌")
    expect(lines.slice(0, 2).join("\n")).toContain("esc back")
    expect(lines.slice(-2).join("\n")).not.toContain("esc back")
    expect(lines.join("\n")).toContain("port")
    await h.app.onKey("\x1b")
  }
})

test("B21 failed task retry uses the existing CLI factory and preserves workflow identity", async () => {
  const h = b21Harness(100, 30, "failed")
  await h.type("/workflows\r")
  await h.app.onKey("t")
  expect(h.sentOf("workflow.control")).toEqual([{ type: "workflow.control", workflowId: h.run.workflowId, action: "retry", taskId: "port" }])
  await h.app.onKey("\x1b")
})
