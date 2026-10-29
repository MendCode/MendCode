import { afterEach, expect, test } from "bun:test"
import { appHarness, cleanTemps, conversation, ids, tempDir } from "./session-ui-harness"

afterEach(cleanTemps)

// What the daemon sends for `api.ui.confirm` / `api.ui.input` (extension-dialogs.ts): an async question, no turn running.
const confirm = [{ header: "Deploy", question: "Deploy now?", options: [{ label: "Yes" }, { label: "No" }], custom: false, context: "From the extension ship. Unanswered in 30 s (or dismissed), it takes its default." }]
const input = [{ header: "Ticket", question: "Ticket id (ABC-1)", options: [], custom: true, context: "From the extension ship. Unanswered in 30 s (or dismissed), it takes its default." }]

test("an extension's confirm shows between turns, a number answers it, and esc dismisses one (the extension's default answers)", async () => {
  const h = appHarness({ width: 100, height: 30, dataDir: tempDir(), directory: "/work/project" })
  const chat = conversation(h.sessionId, h.app.onEvent)
  chat.exchange("hello", "hi")
  const first = ids("request")
  chat.emit({ type: "server.request", turnId: ids("turn"), requestId: first, kind: "question", async: true, title: "ship: Deploy", detail: "", questions: confirm })
  h.app.render()
  expect(h.text().join("\n")).toContain("Deploy now?")
  await h.app.onKey("1")
  expect(h.sentOf("request.resolve")).toEqual([{ type: "request.resolve", sessionId: h.sessionId, requestId: first, decision: { kind: "answer", text: "Yes", answers: [["Yes"]] } }])
  chat.emit({ type: "server.request.resolved", requestId: first, resolution: "answered" })
  const second = ids("request")
  chat.emit({ type: "server.request", turnId: ids("turn"), requestId: second, kind: "question", async: true, title: "ship: Ticket", detail: "", questions: input })
  h.app.render()
  expect(h.text().join("\n")).toContain("Ticket id (ABC-1)")
  await h.type("ABC-7")
  await h.app.onKey("\r")
  expect(h.sentOf("request.resolve")[1]).toMatchObject({ requestId: second, decision: { kind: "answer", text: "ABC-7" } })
  chat.emit({ type: "server.request.resolved", requestId: second, resolution: "answered" })
  const third = ids("request")
  chat.emit({ type: "server.request", turnId: ids("turn"), requestId: third, kind: "question", async: true, title: "ship: Deploy", detail: "", questions: confirm })
  h.app.render()
  await h.app.onKey("\x1b")
  expect(h.sentOf("request.resolve")[2]).toMatchObject({ requestId: third, decision: { kind: "deny" } })
})
