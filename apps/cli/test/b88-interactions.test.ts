import { afterEach, expect, test } from "bun:test"
import { b88Harness } from "./b88-harness"
import { cleanTemps } from "./session-ui-harness"
import { textWidth } from "../src/view/wrap"

afterEach(cleanTemps)
for (const [width, height] of [[60, 20], [100, 30], [180, 50], [220, 60]] as const) test(`REST resolutions reconcile existing TUI requests at ${width}x${height}`, async () => {
  for (const kind of ["permission", "question", "plan-review"] as const) {
    const h = await b88Harness(kind, width, height)
    expect(h.text().join("\n")).toContain(kind === "permission" ? "Read source" : kind === "question" ? "Strategy" : "Socket recovery")
    const response = await h.reply(kind === "permission" ? { reply: "once" } : kind === "question" ? { answers: [["Retry"], ["Socket", "Queue"]] } : { action: "edit", markdown: "# Reviewed recovery", comments: "Keep retries bounded" })
    expect(response?.status).toBe(200)
    if (kind === "plan-review") {
      await h.type("/plan-review\r")
      expect(h.text().join("\n")).toContain("Reviewed recovery")
      await h.app.onKey("\x1b")
    }
    const duplicate = await h.reply(kind === "permission" ? { reply: "once" } : kind === "question" ? { answers: [["Retry"], []] } : { action: "apply" })
    expect(duplicate?.status).toBe(404)
    h.app.render()
    expect(h.frames.at(-1)).toHaveLength(height)
    expect(h.frames.every((frame) => frame.every((row) => textWidth(row.map((span) => span.text).join("")) <= width))).toBe(true)
    await h.app.onKey("\x03")
  }
})
