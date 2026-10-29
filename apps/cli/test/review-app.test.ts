import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createIdFactory, type ChangedFile, type ChangesReport, type SessionEvent } from "@mendcode/protocol"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"
import { approvalOptions, editedPlanReason, MAX_PLAN_REPLY, PLAN_EDITED_NOTE } from "../src/view/request-panel"
import { reviewsPath } from "../src/view/review-comments"

const ids = createIdFactory()
const NOW = 1_800_000_000_000
const plain = (line: Line) => line.map((span) => span.text).join("")

const DIFF = `@@ -10,4 +10,5 @@ function a() {
 context one
-removed line
+added line one
+added line two
 context two`
const file = (input: Partial<ChangedFile> & { path: string }): ChangedFile => ({ status: "modified", additions: 0, deletions: 0, binary: false, diff: "", truncated: false, ...input })
const REPORT: ChangesReport = { root: "/work/app", branch: "main", omittedFiles: 0, files: [file({ path: "src/a.ts", additions: 2, deletions: 1, diff: DIFF })] }

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function harness(options: { dataDir?: string; mode?: "balanced" | "minimal"; send?: (command: Record<string, unknown>) => unknown } = {}) {
  const frames: Line[][] = []
  const sent: Array<Record<string, unknown>> = []
  const screen = { size: { width: 100, height: 30 }, draw: (rows: Line[]) => void frames.push(rows) } as unknown as Parameters<typeof createApp>[0]["screen"]
  const sessionId = ids("session")
  const turnId = ids("turn")
  const app = createApp({
    sessionId,
    screen,
    directory: "/work/app",
    exit() {},
    schedule: (fn) => fn(),
    glyphs: glyphs({}),
    now: () => NOW,
    random: () => 0,
    mode: options.mode ?? "balanced",
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    send: (async (command: Record<string, unknown>) => {
      sent.push(command)
      const custom = await options.send?.(command)
      if (custom) return custom
      if (command.type === "changes.query") return { ok: true, result: REPORT }
      return { ok: true }
    }) as never,
  })
  let seq = 0
  const ev = (patch: Record<string, unknown>) => app.onEvent({ sessionId, seq: ++seq, at: NOW, ...patch } as SessionEvent)
  const text = () => frames.at(-1)!.map(plain)
  const key = async (value: string) => {
    await app.onKey(value)
    await Bun.sleep(2)
  }
  const type = async (value: string) => {
    for (const char of value) await key(char)
  }
  return { app, sent, ev, text, key, type, sessionId, turnId, frames }
}

const tmpDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-review-app-"))
  dirs.push(dir)
  return dir
}

describe("/changes review in the app", () => {
  async function open(options: Parameters<typeof harness>[0] = {}) {
    const h = harness(options)
    await h.app.onInput("/changes")
    await h.key("\r")
    await Bun.sleep(5)
    return h
  }

  test("a comment is saved per session in <dataDir>/tui/reviews/<sessionId>.json and comes back when the page reopens", async () => {
    const dataDir = tmpDir()
    const h = await open({ dataDir })
    for (const k of ["\r", "j", "j", "j", "c"]) await h.key(k)
    await h.type("Why add this?")
    await h.key("\r")
    const saved = reviewsPath(dataDir, h.sessionId)
    expect(saved).toBe(path.join(dataDir, "tui", "reviews", `${h.sessionId}.json`))
    const stored = JSON.parse(fs.readFileSync(saved, "utf8"))
    expect(stored.comments).toHaveLength(1)
    expect(stored.comments[0]).toMatchObject({ path: "src/a.ts", kind: "line", body: "Why add this?", excerpt: ["+added line one"], newRange: { from: 11, to: 11 } })
    expect(h.text().some((row) => row.includes("◆ Why add this?"))).toBe(true)

    await h.key("\x1b")
    await h.key("\x1b")
    expect(h.app.page).toBe("chat")
    await h.app.onInput("/changes")
    await h.key("\r")
    await Bun.sleep(5)
    await h.key("\r")
    expect(h.text().some((row) => row.includes("◆ Why add this?"))).toBe(true)
  })

  test("deleting the last comment removes the file", async () => {
    const dataDir = tmpDir()
    const h = await open({ dataDir })
    for (const k of ["\r", "j", "j", "j", "c", ..."note", "\r"]) await h.key(k)
    expect(fs.existsSync(reviewsPath(dataDir, h.sessionId))).toBe(true)
    await h.key("d")
    expect(fs.existsSync(reviewsPath(dataDir, h.sessionId))).toBe(false)
  })

  test("s sends every comment as one user message, then the comments and the file are gone", async () => {
    const dataDir = tmpDir()
    const h = await open({ dataDir })
    for (const k of ["\r", "j", "j", "j", "c", ..."Why add this?", "\r", "G", "c", ..."Needs a test", "\r"]) await h.key(k)
    await h.key("s")
    const submit = h.sent.filter((command) => command.type === "user.submit")
    expect(submit).toHaveLength(1)
    expect(submit[0]).toMatchObject({ type: "user.submit", sessionId: h.sessionId, attachments: [] })
    expect(submit[0]!.text).toBe(
      [
        "<mendcode_review_context>",
        "MendCode review workspace:",
        "- Comments: 2 on 1 file (branch main)",
        "",
        "1. user comment src/a.ts:11",
        "   ```diff",
        "   +added line one",
        "   ```",
        "   comment: Why add this?",
        "2. user comment src/a.ts:13",
        "   ```diff",
        "    context two",
        "   ```",
        "   comment: Needs a test",
        "</mendcode_review_context>",
      ].join("\n"),
    )
    expect(fs.existsSync(reviewsPath(dataDir, h.sessionId))).toBe(false)
    expect(h.app.page).toBe("chat")
    await h.app.onInput("/changes")
    await h.key("\r")
    await Bun.sleep(5)
    await h.key("\r")
    expect(h.text().join("\n")).not.toContain("◆")
    expect(h.text().join("\n")).not.toContain("Why add this?")
    expect(h.text().some((row) => row.includes("1 file +") && !row.includes("comment"))).toBe(true)
  })

  test("a failed send keeps the comments and the file", async () => {
    const dataDir = tmpDir()
    const h = await open({ dataDir, send: (command) => (command.type === "user.submit" ? { ok: false, error: { code: "busy", message: "[SESSION]: busy" } } : undefined) })
    for (const k of ["\r", "j", "j", "j", "c", ..."keep me", "\r", "s"]) await h.key(k)
    expect(h.sent.some((command) => command.type === "user.submit")).toBe(true)
    expect(fs.existsSync(reviewsPath(dataDir, h.sessionId))).toBe(true)
    expect(h.app.page).toBe("changes")
    expect(h.text().some((row) => row.includes("◆ keep me"))).toBe(true)
  })

  test("without a data dir the review still works in memory", async () => {
    const h = await open()
    for (const k of ["\r", "j", "c", ..."x", "\r", "s"]) await h.key(k)
    expect(h.sent.find((command) => command.type === "user.submit")?.text).toContain("comment: x")
  })
})

describe("plan review", () => {
  const PLAN = "## Plan\n1. Add the flag\n2. Test it"
  const RID = () => ids("request")

  async function review(options: { mode?: "balanced" | "minimal" } = {}) {
    const h = harness(options)
    const itemId = ids("item")
    const requestId = RID()
    h.ev({ type: "turn.started", turnId: h.turnId, queueId: ids("queue") })
    h.ev({ type: "item.started", turnId: h.turnId, itemId, kind: "tool_call", meta: { tool: "plan_submit" } })
    h.ev({ type: "item.delta", itemId, text: PLAN })
    h.ev({ type: "foreground.state", state: "waiting_approval", turnId: h.turnId })
    h.ev({ type: "server.request", requestId, turnId: h.turnId, kind: "approval", title: "Review plan", detail: "approve to build it, or type what to change and press enter", itemId })
    await Bun.sleep(2)
    return { ...h, requestId }
  }
  const resolved = (h: { sent: Array<Record<string, unknown>> }) => h.sent.filter((command) => command.type === "request.resolve").map((command) => command.decision)

  test("the panel offers approve, edit, comment and reject, each with its key", async () => {
    const h = await review()
    expect(approvalOptions("Review plan").map((option) => [option.label, option.key, option.choice])).toEqual([
      ["Approve & build", "a", "once"],
      ["Edit plan", "e", "edit"],
      ["Comment", "c", "comment"],
      ["Reject", "d", "deny"],
    ])
    h.app.render()
    const rows = h.text()
    for (const label of ["1  (●) Approve & build", "2  (○) Edit plan", "3  (○) Comment", "4  (○) Reject"]) expect(rows.some((row) => row.includes(label))).toBe(true)
  })

  test("approve: a approves once", async () => {
    const h = await review()
    await h.key("a")
    expect(resolved(h)).toEqual([{ kind: "approve", scope: "once" }])
  })

  test("reject: d denies without feedback, so the agent asks what the user wants", async () => {
    const h = await review()
    await h.key("d")
    expect(resolved(h)).toEqual([{ kind: "deny" }])
  })

  test("comment: c then feedback denies with the feedback as the reason (letters type, they do not approve)", async () => {
    const h = await review()
    await h.key("c")
    expect(resolved(h)).toEqual([])
    expect(h.app.editor.text).toBe("")
    await h.type("add a rollback step")
    expect(h.app.editor.text).toBe("add a rollback step")
    expect(resolved(h)).toEqual([])
    await h.key("\r")
    expect(resolved(h)).toEqual([{ kind: "deny", reason: "add a rollback step" }])
    expect(h.app.editor.text).toBe("")
  })

  test("edit: e puts the plan in the prompt; the edited plan goes back as the reason with a note that it was edited", async () => {
    const h = await review()
    await h.key("e")
    expect(h.app.editor.text).toBe(PLAN)
    expect(resolved(h)).toEqual([])
    await h.type("\n3. Ship")
    await h.key("\x1b\r")
    await h.type("4. Celebrate")
    await h.key("\r")
    expect(resolved(h)).toEqual([{ kind: "deny", reason: `${PLAN_EDITED_NOTE}${PLAN}\n3. Ship\n4. Celebrate` }])
    expect((resolved(h)[0] as { reason: string }).reason.length).toBeLessThanOrEqual(MAX_PLAN_REPLY)
  })

  test("edit: esc drops the edit and sends nothing; the options work again", async () => {
    const h = await review()
    await h.key("e")
    await h.key("\x1b")
    expect(h.app.editor.text).toBe("")
    expect(resolved(h)).toEqual([])
    await h.key("a")
    expect(resolved(h)).toEqual([{ kind: "approve", scope: "once" }])
  })

  test("edit: a plan too long for a reply is kept in the prompt and not sent", async () => {
    const h = await review()
    await h.key("e")
    await h.app.onInput("x".repeat(MAX_PLAN_REPLY))
    await h.key("\r")
    expect(resolved(h)).toEqual([])
    expect(h.app.editor.text.length).toBeGreaterThan(MAX_PLAN_REPLY)
    expect(editedPlanReason("x".repeat(MAX_PLAN_REPLY))).toBeUndefined()
    expect(editedPlanReason("short")).toBe(`${PLAN_EDITED_NOTE}short`)
  })

  test("digits and enter pick the same options", async () => {
    const one = await review()
    await one.key("4")
    expect(resolved(one)).toEqual([{ kind: "deny" }])
    const two = await review()
    await two.key("3")
    await two.type("tighten step 2")
    await two.key("\r")
    expect(resolved(two)).toEqual([{ kind: "deny", reason: "tighten step 2" }])
    const three = await review()
    await three.key("\x1b[B")
    await three.key("\x1b[B")
    await three.key("\x1b[B")
    await three.key("\r")
    expect(resolved(three)).toEqual([{ kind: "deny" }])
  })

  test("typing feedback without choosing still denies with it, as before", async () => {
    const h = await review()
    await h.type("Split step 1")
    await h.key("\r")
    expect(resolved(h)).toEqual([{ kind: "deny", reason: "Split step 1" }])
  })

  test("minimal mode keeps the one-line prompt and the same keys", async () => {
    const h = await review({ mode: "minimal" })
    h.app.render()
    const line = h.text().find((row) => row.includes("[a] approve & build"))
    expect(line).toContain("[e] edit")
    expect(line).toContain("[c] comment")
    expect(line).toContain("[d] reject")
    await h.key("e")
    expect(h.app.editor.text).toBe(PLAN)
  })

  test("an ordinary approval is unchanged: a, s and d", async () => {
    const h = harness()
    h.ev({ type: "turn.started", turnId: h.turnId, queueId: ids("queue") })
    h.ev({ type: "server.request", requestId: RID(), turnId: h.turnId, kind: "approval", title: "Run command", detail: "ls" })
    await h.key("s")
    expect(resolved(h)).toEqual([{ kind: "approve", scope: "session" }])
    expect(approvalOptions("Run command").map((option) => option.key)).toEqual(["a", "s", "d"])
    await h.key("e")
    expect(h.app.editor.text).toBe("e")
  })
})
