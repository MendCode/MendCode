import { afterEach, expect, test } from "bun:test"
import { cleanTemps } from "./session-ui-harness"
import { b45Harness } from "./b45-harness"
import { MODEL_PAGE_ROWS } from "../src/view/model-page"
import { textWidth } from "../src/view/wrap"

afterEach(cleanTemps)
for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]] as const) {
  test(`B45 workflows routing stays within ${width}x${height}`, async () => {
    const h = b45Harness(width, height)
    await h.type("/workflows\r")
    h.app.render()
    const frame = h.frames.at(-1)!
    const text = frame.map((line) => line.map((span) => span.text).join("")).join("\n")
    expect(frame).toHaveLength(height)
    expect(frame.every((line) => textWidth(line.map((span) => span.text).join("")) <= width)).toBe(true)
    expect(text).toContain("per-run-worktree")
    expect(text).toContain("local/workflow")
    expect(text).toContain("┌")
    await h.app.onKey("\x1b")
  })
}

test("B45 model page exposes the workflow role and variant configuration", async () => {
  const h = b45Harness(100, 30)
  await h.type("/model roles\r")
  for (let n = 1; n < MODEL_PAGE_ROWS.length; n++) await h.app.onKey("\x1b[B")
  h.app.render()
  const text = h.frames.at(-1)!.map((line) => line.map((span) => span.text).join("")).join("\n")
  expect(text).toContain("workflow")
  expect(text).toContain("local/workflow")
  await h.app.onKey("\x1b")
})
