import { describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { createIdFactory, type GlobalEvent, type SessionEvent } from "@mendcode/protocol"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"
import { approvalOptions } from "../src/view/request-panel"

const ids = createIdFactory()
const NOW = 1_800_000_000_000
const plain = (line: Line) => line.map((span) => span.text).join("")

function harness(options: { mode?: "balanced" | "minimal"; width?: number; height?: number } = {}) {
  const frames: Line[][] = []
  const sent: Array<Record<string, unknown>> = []
  const screen = { size: { width: options.width ?? 100, height: options.height ?? 30 }, draw: (rows: Line[]) => void frames.push(rows) } as unknown as Parameters<typeof createApp>[0]["screen"]
  const sessionId = ids("session")
  const turnId = ids("turn")
  const app = createApp({
    sessionId, screen, directory: "/work/app", exit() {}, schedule: (fn) => fn(), glyphs: glyphs({}), now: () => NOW, random: () => 0, mode: options.mode ?? "balanced",
    send: (async (command: Record<string, unknown>) => (sent.push(command), { ok: true })) as never,
  })
  let seq = 0
  const ev = (patch: Record<string, unknown>) => app.onEvent({ sessionId, seq: ++seq, at: NOW, ...patch } as SessionEvent)
  const text = () => frames.at(-1)!.map(plain)
  const key = async (value: string) => { await app.onKey(value); await Bun.sleep(2) }
  const request = (patch: Record<string, unknown>) => {
    ev({ type: "turn.started", turnId, queueId: ids("queue") })
    ev({ type: "server.request", requestId: ids("request"), turnId, async: true, ...patch })
    app.render()
  }
  const chat = () => { ev({ type: "turn.started", turnId, queueId: ids("queue") }); const itemId = ids("item"); ev({ type: "item.started", turnId, itemId, kind: "agent_message" }); ev({ type: "item.completed", itemId, status: "ok", text: "Working on the release." }); app.render() }
  const global = (event: Record<string, unknown>) => { app.onGlobal({ gseq: 0, at: NOW, ...event } as unknown as GlobalEvent); app.render() }
  return { app, sent, text, key, request, global, chat, sessionId }
}

const detail = ["• Build api · shell: bun run gen.ts", "• Docs · edit: docs/a.md", "", "Allow all allows exactly these, once each."].join("\n")
const group = { kind: "approval", title: "2 child sessions waiting for approval", detail, options: [{ label: "Allow all (2)" }, { label: "Reject all" }, { label: "One by one" }] }
const oldGroup = { kind: "question", title: "2 child sessions waiting for approval", detail: "", questions: [{ header: "Child approvals", question: "2 sessions you started wait for approval.", options: [{ label: "Approve all (2)" }, { label: "Deny all" }, { label: "One by one" }], custom: false, context: detail.replace("Allow all allows", "Approve all approves") }] }
const answers = (h: { sent: Array<Record<string, unknown>> }) => h.sent.filter((command) => command.type === "request.resolve").map((command) => command.decision)

describe("the card for children waiting for approval", () => {
  test("it is drawn as a tool approval: same frame, choices, keys and one row per child", async () => {
    const h = harness()
    h.request(group)
    const rows = h.text().join("\n")
    expect(rows).toContain("2 child sessions waiting for approval")
    expect(rows).toContain("Build api · shell: bun run gen.ts")
    expect(rows).toContain("Docs · edit: docs/a.md")
    expect(rows).toContain("1  (●) Allow all (2)")
    expect(rows).toContain("(○) Reject all")
    expect(rows).toContain("(○) One by one")
    expect(rows).toContain("↑↓ select · enter confirm")
    expect(rows).not.toContain("Child approvals")
    expect(rows).not.toContain("Allow 2 child")
    if (process.env.CAPTURE_DIR) {
      writeFileSync(`${process.env.CAPTURE_DIR}/after-group.txt`, h.text().join("\n"))
      const old = harness()
      old.request(oldGroup)
      writeFileSync(`${process.env.CAPTURE_DIR}/before-group.txt`, old.text().join("\n"))
    }
  })

  test("a letter, a digit and enter answer with the label; the daemon decides what it means", async () => {
    const a = harness()
    a.request(group)
    await a.key("a")
    expect(answers(a)).toEqual([{ kind: "answer", text: "Allow all (2)" }])
    const b = harness()
    b.request(group)
    await b.key("3")
    expect(answers(b)).toEqual([{ kind: "answer", text: "One by one" }])
    const c = harness()
    c.request(group)
    await c.key("\x1b[B")
    await c.key("\r")
    expect(answers(c)).toEqual([{ kind: "answer", text: "Reject all" }])
    const d = harness()
    d.request(group)
    await d.key("d")
    expect(answers(d)).toEqual([{ kind: "answer", text: "Reject all" }])
  })

  test("minimal keeps every choice readable at 60x20", async () => {
    const h = harness({ mode: "minimal", width: 60, height: 20 })
    h.request(group)
    const rows = h.text().join("\n")
    expect(rows).toContain("2 child sessions waiting for approval")
    expect(rows).toContain("Allow all (2)")
    expect(rows).toContain("Reject all")
  })

  test("a single child's card reads like the tool's own approval", async () => {
    const h = harness()
    h.request({ kind: "approval", title: "Build api waits for approval", tool: "shell", detail: "shell: bun run gen.ts", options: [{ label: "Allow once" }, { label: "Reject" }] })
    const rows = h.text().join("\n")
    expect(rows).toContain("Build api waits for approval")
    expect(rows).toContain("(●) Allow once")
    expect(rows).toContain("(○) Reject")
    await h.key("d")
    expect(answers(h)).toEqual([{ kind: "answer", text: "Reject" }])
    if (process.env.CAPTURE_DIR) writeFileSync(`${process.env.CAPTURE_DIR}/after-single.txt`, rows)
  })

  test("letters are the first free initial; a label with none gets no key", () => {
    expect(approvalOptions("x", undefined, false, [{ label: "Allow all" }, { label: "Allow one" }, { label: "Reject" }, { label: "1 by 1" }]).map((option) => option.key)).toEqual(["a", "", "d", ""])
  })
})

describe("the notice for children waiting in another session", () => {
  const waiting = { type: "children.waiting", launcher: "ses_launcher", launcherTitle: "Release", total: 2, children: [{ sessionId: "ses_a", title: "Build api" }, { sessionId: "ses_b", title: "Docs" }] }

  test("a terminal on another session says who waits and how to answer, and drops it when answered", async () => {
    const h = harness()
    h.chat()
    h.global(waiting)
    const rows = h.text().join("\n")
    expect(rows).toContain("2 child sessions from \"Release\" wait for approval")
    expect(rows).toContain("/approvals")
    expect(rows).toContain("2 child approvals · /approvals")
    h.global({ ...waiting, total: 0, children: [] })
    expect(h.text().join("\n")).not.toContain("child approval")
    if (process.env.CAPTURE_DIR) {
      const shown = harness()
      shown.chat()
      shown.global(waiting)
      writeFileSync(`${process.env.CAPTURE_DIR}/after-notice.txt`, shown.text().join("\n"))
    }
  })

  test("the terminal that has the launcher open sees the card, not the notice", () => {
    const h = harness()
    h.chat()
    h.global({ ...waiting, launcher: h.sessionId })
    const rows = h.text().join("\n")
    expect(rows).not.toContain("child approval")
    expect(rows).not.toContain("wait for approval")
  })
})
