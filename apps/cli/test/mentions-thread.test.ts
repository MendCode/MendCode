import { afterEach, expect, test } from "bun:test"
import { threadMentions, wantsThreads } from "../src/view/mentions"
import { appHarness, cleanTemps, ids, tempDir } from "./session-ui-harness"

afterEach(cleanTemps)

const sessions = [
  { sessionId: "session_01AAAAAAAAAAAAAAAAAAAAAAAA", title: "api cleanup" },
  { sessionId: "session_01BBBBBBBBBBBBBBBBBBBBBBBB", title: "ui refactor" },
  { sessionId: "session_01CCCCCCCCCCCCCCCCCCCCCCCC", title: "" },
]

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

test("sessions are asked for only once the query reads th or thread:", () => {
  expect(["t", "th", "thr", "thread", "thread:", "thread:ui"].map(wantsThreads)).toEqual([false, true, true, true, true, true])
  expect(wantsThreads("src")).toBe(false)
  expect(threadMentions(sessions, "src", undefined)).toEqual([])
})

test("candidates are the other sessions, filtered by title or id end, with the id's last 8 characters as the token", () => {
  expect(threadMentions(sessions, "th", "session_01AAAAAAAAAAAAAAAAAAAAAAAA").map((entry) => entry.path)).toEqual(["thread:BBBBBBBB", "thread:CCCCCCCC"])
  expect(threadMentions(sessions, "thread:refac", undefined)).toEqual([{ path: "thread:BBBBBBBB", kind: "thread", description: "ui refactor" }])
  expect(threadMentions(sessions, "thread:cccc", undefined)[0]).toMatchObject({ kind: "thread", description: "untitled" })
  expect(threadMentions(undefined, "thread:", undefined)).toEqual([])
})

function start(remote = false) {
  const id = ids("session")
  let listed = 0
  const h = appHarness({ sessionId: id, dataDir: tempDir(), directory: "/project", ...(remote ? { remote: { host: "box", readOnly: false } } : {}), reply: (command) => {
    if (command.type === "session.list") { if (command.directory === "/project" && command.limit === 20) listed++; return { ok: true, result: { sessions: sessions.map((session) => ({ ...session, directory: "/project", state: "idle", updatedAt: 1 })) } } }
    if (command.type === "files.search") return { ok: true, result: { files: [{ path: "src/thread.ts", kind: "file" }] } }
  } })
  h.app.applySettings({ onboarded: true })
  return { h, listed: () => listed }
}

test("@th offers the project's sessions with a thread tag, and tab inserts a token the daemon can resolve", async () => {
  const { h } = start()
  await flush()
  await h.type("continue @th")
  await flush()
  const out = h.text().join("\n")
  expect(out).toContain("@thread:AAAAAAAA")
  expect(out).toContain("api cleanup")
  await h.app.onKey("\t")
  expect(h.app.editor.text).toBe("continue @thread:AAAAAAAA ")
})

test("a remote client is never offered local sessions and never asks for them", async () => {
  const { h, listed } = start(true)
  await flush()
  await h.type("continue @thread:")
  await flush()
  expect(h.text().join("\n")).not.toContain("@thread:AAAAAAAA")
  expect(listed()).toBe(0)
})
