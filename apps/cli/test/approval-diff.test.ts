import { describe, expect, test } from "bun:test"
import { createIdFactory, type SessionEvent } from "@mendcode/protocol"
import { approvalWindow, renderApprovalDiff, splitApprovalDetail } from "../src/view/approval-diff"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"
import { textWidth } from "../src/view/wrap"

const ids = createIdFactory()
const sessionId = ids("session")
const turnId = ids("turn")
const plain = (lines: Line[]) => lines.map((line) => line.map((span) => span.text).join(""))

const DIFF = ["@@ -2,2 +2,2 @@", "-old one", "-old two", "+new one", "+new two"].join("\n")
const detail = (body = DIFF) => `src/a.ts\n\n${body}`
const longBody = ["@@ -1,60 +1,60 @@", ...Array.from({ length: 60 }, (_, i) => `${i % 2 ? "+" : "-"}line ${i}`)].join("\n")

describe("approval diff view", () => {
  test("one-line details have no diff box", () => {
    expect(splitApprovalDetail("src/a.ts")).toBeUndefined()
    expect(renderApprovalDiff({ detail: "npm test", width: 60, screenHeight: 30, scroll: 0 })).toBeUndefined()
    expect(splitApprovalDetail("src/a.ts\n\n")).toBeUndefined()
  })
  test("splits the head from the preview and colors + - @@ lines", () => {
    expect(splitApprovalDetail(detail())).toEqual({ head: "src/a.ts", preview: DIFF.split("\n") })
    const box = renderApprovalDiff({ detail: detail(), width: 60, screenHeight: 30, scroll: 0 })!
    expect(box.head).toBe("src/a.ts")
    expect(plain(box.rows)).toEqual(DIFF.split("\n").map((l) => `  ${l}`))
    expect(box.rows.map((row) => row[1]!.fg)).toEqual(["heading", "error", "error", "success", "success"])
  })
  test("patch file headers and tool notes get their own styles", () => {
    const box = renderApprovalDiff({ detail: detail("*** Update File: a.ts\n@@ -1,1 +1,1 @@\n context\n… 12 more lines"), width: 60, screenHeight: 30, scroll: 0 })!
    expect(box.rows.map((row) => row[1]!.fg)).toEqual(["primary", "heading", "body", "muted"])
  })
  test("a blast-radius preview of a risky command: heading in the primary color, removals in red, notes dimmed", () => {
    const preview = ["*** rm would delete 2 paths · 3 files · 2 KB", "- a.txt · 2 KB", "- build/ · 2 files · 3 B", "  missing: nope.txt (ignored by -f)", "… 4 more lines"].join("\n")
    const box = renderApprovalDiff({ detail: `rm -rf a.txt build nope.txt\n\n${preview}`, width: 70, screenHeight: 30, scroll: 0 })!
    expect(box.head).toBe("rm -rf a.txt build nope.txt")
    expect(box.rows.map((row) => row[1]!.fg)).toEqual(["primary", "error", "error", "body", "muted"])
  })
  test("shows about 40% of the screen (min 6 rows) and a hint with the remaining lines", () => {
    expect(approvalWindow({ total: 100, screenHeight: 50 })).toEqual({ rows: 19, maxScroll: 81, overflow: true })
    expect(approvalWindow({ total: 100, screenHeight: 10 })).toEqual({ rows: 5, maxScroll: 95, overflow: true })
    expect(approvalWindow({ total: 4, screenHeight: 10 })).toEqual({ rows: 4, maxScroll: 0, overflow: false })
    const box = renderApprovalDiff({ detail: detail(longBody), width: 60, screenHeight: 25, scroll: 0 })!
    expect(box.rows).toHaveLength(10)
    expect(plain(box.rows).at(-1)).toBe("  … 52 more lines · pgup/pgdn")
  })
  test("scroll is clamped and the hint reports lines above", () => {
    const end = renderApprovalDiff({ detail: detail(longBody), width: 60, screenHeight: 25, scroll: 9999 })!
    expect(end.scroll).toBe(52)
    expect(plain(end.rows).at(-1)).toBe("  ↑ 52 above · pgup/pgdn")
    expect(plain(end.rows)[0]).toContain("line 51")
    const middle = renderApprovalDiff({ detail: detail(longBody), width: 60, screenHeight: 25, scroll: 9 })!
    expect(plain(middle.rows).at(-1)).toBe("  ↑ 9 above · … 43 more lines · pgup/pgdn")
    expect(renderApprovalDiff({ detail: detail(longBody), width: 60, screenHeight: 25, scroll: -5 })!.scroll).toBe(0)
  })
  test("long lines are cut to the width", () => {
    const box = renderApprovalDiff({ detail: detail(`+${"x".repeat(200)}`), width: 40, screenHeight: 30, scroll: 0 })!
    expect(textWidth(plain(box.rows)[0]!)).toBeLessThanOrEqual(40)
    expect(plain(box.rows)[0]).toEndWith("…")
  })
})

describe("approval panel in the app", () => {
  function harness(height = 30, mode?: "minimal" | "balanced" | "full") {
    const frames: Line[][] = []
    const sent: Array<Record<string, unknown>> = []
    const screen = { size: { width: 70, height }, draw: (rows: Line[]) => void frames.push(rows) } as unknown as Parameters<typeof createApp>[0]["screen"]
    const app = createApp({ sessionId, screen, send: async (c) => (sent.push(c as Record<string, unknown>), { ok: true }), exit() {}, schedule: (fn) => fn(), glyphs: glyphs({}), ...(mode ? { mode } : {}) })
    let seq = 0
    const ev = (e: Record<string, unknown>) => ({ sessionId, seq: ++seq, at: 0, ...e }) as SessionEvent
    app.onEvent(ev({ type: "turn.started", turnId, queueId: ids("queue") }))
    for (let i = 0; i < 40; i++) {
      const itemId = ids("item")
      app.onEvent(ev({ type: "item.started", turnId, itemId, kind: "agent_message" }))
      app.onEvent(ev({ type: "item.completed", itemId, status: "ok", text: `message ${i}` }))
    }
    const ask = (title: string, body: string) => app.onEvent(ev({ type: "server.request", requestId: ids("request"), turnId, kind: "approval", title, detail: body }))
    const text = () => frames.at(-1)!.map((row) => row.map((s) => s.text).join(""))
    return { app, ask, text, frames, sent }
  }

  test("an edit approval shows v1's panel: rail, Allow <Title>?, the path, the colored diff and numbered choices", async () => {
    const { ask, text, frames } = harness()
    ask("Edit files", detail())
    await Bun.sleep(10) // the diff view loads lazily on the first turn
    const rows = text()
    expect(rows.some((l) => /^ {2}┃ [△→←✱#%◈] Allow Edit files\?/.test(l))).toBe(true)
    expect(rows.some((l) => l.replace(/^ {2}┃/, "").trim() === "src/a.ts")).toBe(true)
    expect(rows.some((l) => l.includes("┃  -old one"))).toBe(true)
    expect(rows.some((l) => l.includes("┃  +new two"))).toBe(true)
    expect(rows.some((l) => l.includes("1  (●) Allow once"))).toBe(true)
    expect(rows.some((l) => l.includes("2  (○) Allow for this session"))).toBe(true)
    expect(rows.some((l) => l.includes("3  (○) Reject"))).toBe(true)
    const plus = frames.at(-1)!.find((row) => row.map((s) => s.text).join("").includes("┃  +new two"))!
    expect(plus.find((s) => s.text.includes("+"))!.fg).toBe("success")
    // The box sits on the panel fill.
    const title = frames.at(-1)!.find((row) => row.map((s) => s.text).join("").includes("Allow Edit files?"))!
    expect(title.some((s) => s.bg === "panel")).toBe(true)
    for (const row of rows.filter((l) => l.includes("┃"))) expect(textWidth(row)).toBeLessThanOrEqual(70)
  })
  test("↑↓ and enter pick a choice; a digit picks it directly; letters still work", async () => {
    const { app, ask, sent } = harness()
    ask("Run command", "bun test")
    await app.onInput("\x1b[B")
    await app.onInput("\r")
    expect(sent.at(-1)).toMatchObject({ type: "request.resolve", decision: { kind: "approve", scope: "session" } })
    ask("Run command", "bun test")
    await app.onInput("3")
    expect(sent.at(-1)).toMatchObject({ type: "request.resolve", decision: { kind: "deny" } })
    ask("Run command", "bun test")
    await app.onInput("a")
    expect(sent.at(-1)).toMatchObject({ type: "request.resolve", decision: { kind: "approve", scope: "once" } })
  })
  test("minimal keeps the one-line layout", () => {
    const { ask, text } = harness(30, "minimal")
    ask("Run command", "bun test")
    const rows = text()
    const at = rows.findIndex((l) => l.includes("Run command"))
    expect(rows[at + 1]).toBe("  bun test")
    expect(rows[at + 2]).toContain("[a] approve")
  })
  test("the plan review keeps its own wording, two choices and no session grant", () => {
    const { ask, text } = harness()
    ask("Review plan", "approve to build it, or type what to change and press enter")
    const rows = text()
    expect(rows.some((l) => l.includes("(●) Approve & build"))).toBe(true)
    expect(rows.some((l) => l.includes("for this session"))).toBe(false)
  })
  test("pgup/pgdn scroll a long preview instead of the transcript, and reset for the next request", async () => {
    const { app, ask, text } = harness(30)
    ask("Edit files", detail(longBody))
    expect(text().some((l) => l.includes("message 39"))).toBe(true)
    expect(text().some((l) => l.includes("more lines · pgup/pgdn"))).toBe(true)
    await app.onInput("\x1b[6~")
    expect(text().some((l) => l.includes("↑ 11 above"))).toBe(true)
    expect(text().some((l) => l.includes("message 39"))).toBe(true)
    await app.onInput("\x1b[5~")
    expect(text().some((l) => l.includes("above"))).toBe(false)
    await app.onInput("\x1b[5~")
    expect(text().some((l) => l.includes("above"))).toBe(false)
    await app.onInput("\x1b[6~")
    ask("Edit files", detail(longBody))
    await app.onInput("d")
  })
  test("without an overflowing preview pgup still scrolls the transcript", async () => {
    const { app, ask, text } = harness(12)
    ask("Edit files", detail())
    await app.onInput("\x1b[5~")
    expect(text().some((l) => l.includes("message 39"))).toBe(false)
  })
})
