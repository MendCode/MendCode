import { afterEach, expect, test } from "bun:test"
import { cleanTemps } from "./session-ui-harness"
import { planHarness } from "./plan-review-harness"
import { textWidth } from "../src/view/wrap"

afterEach(cleanTemps)

test("review renders full Markdown and destination; editing, comments and explicit apply send structured data", async () => {
  const h = await planHarness()
  expect(h.text().join("\n")).toContain("Socket recovery")
  expect(h.text().join("\n")).toContain("Offline")
  await h.app.onKey("t")
  await h.app.onKey("c")
  await h.type("Keep the queue")
  await h.app.onKey("\x1b")
  await h.app.onKey("e")
  await h.app.onKey("\x15")
  await h.app.onInput("\x1b[200~# Edited plan\n\nRead first\x1b[201~")
  await h.app.onKey("\x0f")
  expect(h.sentOf("request.resolve").at(-1)).toMatchObject({ decision: { kind: "plan_review", action: "apply", destination: "executor", comments: "Keep the queue" } })
  expect(h.sentOf("user.submit")).toHaveLength(0)
  await h.type("/plan-review\r")
  expect(h.app.page).toBe("plan-review")
  expect(h.text().join("\n")).toContain("apply")
})

test("accept does not apply; planning-only Enter accepts; reject sends a reason and Escape closes", async () => {
  for (const action of ["accept", "plan", "reject", "close"] as const) {
    const h = await planHarness(100, 30, action === "plan" ? "plan" : "implementation")
    if (action === "reject") { await h.app.onKey("r"); await h.type("Missing tests"); await h.app.onKey("\r") }
    else await h.app.onKey(action === "accept" ? "a" : action === "plan" ? "\r" : "\x1b")
    expect(h.sentOf("request.resolve").at(-1)).toMatchObject({ decision: { action: action === "plan" ? "accept" : action, ...(action === "reject" ? { reason: "Missing tests" } : {}) } })
  }
})

test("a rejected reply keeps edited content and the review open", async () => {
  const h = await planHarness(100, 30, "implementation", true)
  await h.app.onKey("e")
  await h.type("\nKeep this edit")
  await h.app.onKey("\x0f")
  expect(h.text().join("\n")).toContain("Destination no longer trusted")
  expect(h.text().join("\n")).toContain("Keep this edit")
  await h.app.onKey("\x13")
  expect(h.sentOf("request.resolve").at(-1)).toMatchObject({ decision: { action: "edit", markdown: expect.stringContaining("Keep this edit") } })
})

test("all review stages fit compact, medium and wide grids, with cursor inside the editor", async () => {
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
    const h = await planHarness(width, height)
    for (const key of ["e", "\x1b", "c", "\x1b", "r"]) {
      await h.app.onKey(key)
      h.app.render()
      expect(h.frames.at(-1)).toHaveLength(height)
      expect(h.frames.at(-1)!.every((row) => textWidth(row.map((span) => span.text).join("")) === width)).toBe(true)
      const cursor = h.cursors.at(-1)
      if (cursor) { expect(cursor.row).toBeLessThan(height); expect(cursor.col).toBeLessThan(width) }
    }
    await h.app.onKey("\x1b"); await h.app.onKey("\x1b")
  }
})
