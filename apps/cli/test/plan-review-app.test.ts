import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import type { PlanReviewRecord } from "@mendcode/protocol"
import { cleanTemps, plain } from "./session-ui-harness"
import { planHarness, planHarnessSkewed } from "./plan-review-harness"
import { renderPlanReviewPage, type PlanDraft } from "../src/view/plan-review-page"
import { createEditor } from "../src/view/editor"
import { markdownStyleFor } from "../src/view/markdown-style"
import { DEFAULT_TUI_PROFILE } from "../src/view/tui-profile"
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

test("applying takes full access by default, the page says so before the key, and m picks another access without removing the rest", async () => {
  const h = await planHarness()
  expect(h.text().join("\n")).toContain("full access")
  expect(h.text().join("\n")).toContain("m access")
  await h.app.onKey("\r")
  expect(h.sentOf("request.resolve").at(-1)).toMatchObject({ decision: { kind: "plan_review", action: "apply", permission: "full" } })
  for (const [presses, expected, label] of [[1, "edits", "auto edits"], [2, "ask", "ask before edits"], [3, "full", "full access"]] as const) {
    const again = await planHarness()
    for (let i = 0; i < presses; i++) await again.app.onKey("m")
    expect(again.text().join("\n")).toContain(label)
    await again.app.onKey("\r")
    expect(again.sentOf("request.resolve").at(-1)).toMatchObject({ decision: { action: "apply", permission: expected } })
  }
})

test("on a remote daemon the page defaults to ask before edits, and m can still choose full access", async () => {
  const h = await planHarness(100, 30, "implementation", false, { host: "box:7777", readOnly: false })
  expect(h.text().join("\n")).toContain("ask before edits")
  await h.app.onKey("\r")
  expect(h.sentOf("request.resolve").at(-1)).toMatchObject({ decision: { action: "apply", permission: "ask" } })
  const chosen = await planHarness(100, 30, "implementation", false, { host: "box:7777", readOnly: false })
  await chosen.app.onKey("m")
  await chosen.app.onKey("\r")
  expect(chosen.sentOf("request.resolve").at(-1)).toMatchObject({ decision: { action: "apply", permission: "full" } })
})

test("accepting without implementation and a planning-only packet carry no access", async () => {
  const accepted = await planHarness()
  await accepted.app.onKey("a")
  expect(accepted.sentOf("request.resolve").at(-1)!.decision).not.toHaveProperty("permission")
  const planning = await planHarness(100, 30, "plan")
  expect(planning.text().join("\n")).not.toContain("full access")
  await planning.app.onKey("\r")
  expect(planning.sentOf("request.resolve").at(-1)!.decision).not.toHaveProperty("permission")
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

const LONG_PLAN = readFileSync(new URL("./fixtures/plan-review-long.md", import.meta.url), "utf8")
const wheel = (button: 64 | 65, col = 10, row = 10) => `\x1b[<${button};${col};${row}M`

test("a daemon from before the permission field still accepts the plan: one retry without it, and the page says the access waits for a restart", async () => {
  // The harness' daemon rejects a reply that carries `permission`, the way an older build's strict schema does.
  const rejecting = await planHarnessSkewed()
  await rejecting.app.onKey("\r")
  const resolves = rejecting.sentOf("request.resolve") as Array<{ decision: Record<string, unknown> }>
  expect(resolves).toHaveLength(2)
  expect(resolves[0]!.decision).toMatchObject({ action: "apply", permission: "full" })
  expect("permission" in resolves[1]!.decision).toBe(false)
  expect(resolves[1]!.decision).toMatchObject({ action: "apply", destination: "build" })
  expect(rejecting.text().join("\n")).toContain("waits for /daemon restart")
})

test("a rejection that is not the daemon's age is not retried", async () => {
  const h = await planHarnessSkewed("daemon rejected request.resolve · invalid destination")
  await h.app.onKey("\r")
  expect(h.sentOf("request.resolve")).toHaveLength(1)
  expect(h.text().join("\n")).toContain("invalid destination")
})

test("the plan is drawn like an answer in the chat: diagrams, callouts and tables at full, the classic style below it", async () => {
  const full = await planHarness(100, 30, "implementation", false, undefined, { markdown: LONG_PLAN, mode: "full" })
  await Bun.sleep(300)
  full.app.render()
  expect(full.text().join("\n")).toContain("┃ NOTE")
  for (let i = 0; i < 14; i++) await full.app.onKey("\x1b[B")
  expect(full.text().join("\n")).toContain("Tag pushed on main")
  const minimal = await planHarness(100, 30, "implementation", false, undefined, { markdown: LONG_PLAN, mode: "minimal" })
  await Bun.sleep(300)
  minimal.app.render()
  expect(minimal.text().join("\n")).toContain("[!NOTE]")
  // A diagram is drawn at every tier the page drew it at before; only the plain renderer shows its source.
  for (let i = 0; i < 14; i++) await minimal.app.onKey("\x1b[B")
  expect(minimal.text().join("\n")).toContain("Tag pushed on main")
  expect(minimal.text().join("\n")).not.toContain("flowchart LR")
})

test("a wide diagram keeps to the panel width at 100 and 200 columns", async () => {
  for (const [width, height] of [[100, 30], [200, 60]] as const) {
    const h = await planHarness(width, height, "implementation", false, undefined, { markdown: LONG_PLAN, mode: "full" })
    await Bun.sleep(300)
    for (let i = 0; i < 40; i++) {
      await h.app.onKey("\x1b[6~")
      for (const line of h.text()) expect(textWidth(line)).toBeLessThanOrEqual(width)
    }
  }
})

test("the wheel scrolls the plan like the arrow keys; the keys still work", async () => {
  const h = await planHarness(100, 30, "implementation", false, undefined, { markdown: LONG_PLAN, mode: "full" })
  const top = h.text().join("\n")
  await h.app.onInput(wheel(65))
  const down = h.text().join("\n")
  expect(down).not.toBe(top)
  expect(down).toContain("4–25 /")
  await h.app.onInput(wheel(64))
  expect(h.text().join("\n")).toContain("1–22 /")
  await h.app.onKey("\x1b[B")
  expect(h.text().join("\n")).toContain("2–23 /")
})

test("while editing, a wheel report neither types nor scrolls", async () => {
  const h = await planHarness(100, 30, "implementation", false, undefined, { markdown: LONG_PLAN, mode: "full" })
  await h.app.onKey("e")
  const before = h.text().join("\n")
  await h.app.onInput(wheel(65))
  expect(h.text().join("\n")).toBe(before)
})

test("scrolling does not draw the plan again: one drawing is kept for the text and width, and it goes with the draft", async () => {
  const draft: PlanDraft = { id: "r", stage: "preview", markdown: LONG_PLAN, comments: "", destination: "build", permission: "full", scroll: 0, reviewScroll: 0, editor: createEditor({ wordWrap: true }), note: "" }
  const record = { requestId: "r", turnId: "t", sessionId: "s", markdown: LONG_PLAN, phase: "implementation", destination: "build", title: "Plan", createdAt: 0 } as unknown as PlanReviewRecord
  const style = markdownStyleFor({ profile: DEFAULT_TUI_PROFILE, mode: "full" })
  const frame = (width: number) => renderPlanReviewPage({ record, draft, pending: true, width, height: 30, index: 0, count: 1, renderer: "full", markdown: style })
  frame(100)
  const rows = draft.drawn!.rows
  draft.scroll = 5
  frame(100)
  expect(draft.drawn!.rows).toBe(rows)
  frame(120)
  expect(draft.drawn!.rows).not.toBe(rows)
})

test("the Review panel scrolls with the wheel when it is taller than its room, and only while the pointer is over it", async () => {
  const draft: PlanDraft = { id: "r", stage: "preview", markdown: "# Plan\n\nBody", comments: "", destination: "agent-with-a-very-long-name ".repeat(12).trim(), permission: "full", scroll: 0, reviewScroll: 0, editor: createEditor({ wordWrap: true }), note: "" }
  const record = { requestId: "r", turnId: "t", sessionId: "s", markdown: "# Plan\n\nBody", phase: "implementation", destination: draft.destination, title: "Plan", createdAt: 0 } as unknown as PlanReviewRecord
  const style = markdownStyleFor({ profile: DEFAULT_TUI_PROFILE, mode: "full" })
  const frame = () => renderPlanReviewPage({ record, draft, pending: true, width: 100, height: 14, index: 0, count: 1, renderer: "full", markdown: style }).rows.map(plain)
  const first = frame().join("\n")
  expect(draft.reviewBox!.overflow).toBe(true)
  draft.reviewScroll = 3
  const scrolled = frame().join("\n")
  expect(scrolled).not.toBe(first)
  draft.reviewScroll = 999
  frame()
  expect(draft.reviewScroll).toBeGreaterThan(0)
  expect(draft.reviewScroll).toBeLessThan(999)
})

test("at the markdown renderer a diagram is still drawn; only plain shows its source", async () => {
  const record = { requestId: "r", turnId: "t", sessionId: "s", markdown: LONG_PLAN, phase: "implementation", destination: "build", title: "Plan", createdAt: 0 } as unknown as PlanReviewRecord
  const style = markdownStyleFor({ profile: DEFAULT_TUI_PROFILE, mode: "balanced" })
  const draftOf = (): PlanDraft => ({ id: "r", stage: "preview", markdown: LONG_PLAN, comments: "", destination: "build", permission: "full", scroll: 14, reviewScroll: 0, editor: createEditor({ wordWrap: true }), note: "" })
  const shown = (renderer: "plain" | "markdown") => { const draft = draftOf(); renderPlanReviewPage({ record, draft, pending: true, width: 100, height: 30, index: 0, count: 1, renderer, markdown: style }); return renderPlanReviewPage({ record, draft, pending: true, width: 100, height: 30, index: 0, count: 1, renderer, markdown: style }).rows.map(plain).join("\n") }
  await Bun.sleep(300)
  expect(shown("markdown")).toContain("Tag pushed on main")
  expect(shown("markdown")).not.toContain("flowchart LR")
  expect(shown("plain")).toContain("flowchart LR")
})
