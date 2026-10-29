import { afterEach, expect, test } from "bun:test"
import type { CommandInput, CommandReply } from "@mendcode/client"
import type { SessionSummary } from "@mendcode/protocol"
import { parseAutomation, runAutomation } from "../src/automation"
import { renderSessionList, sessionListKey } from "../src/view/session-list"
import { projectSessions } from "../src/view/sidebar"
import { textWidth } from "../src/view/wrap"
import { appHarness, cleanTemps, conversation, ids, NOW, tempDir } from "./session-ui-harness"

afterEach(cleanTemps)
const parse = (...args: string[]) => {
  const result = parseAutomation(args)
  if (result.ok !== true) throw new Error(JSON.stringify(result))
  return result.command
}

test("CLI archive, restore and include-archived carry their exact daemon inputs and output", async () => {
  const id = ids("session")
  const commands: CommandInput[] = []
  let output = ""
  const deps = { client: { send: async (command: CommandInput): Promise<CommandReply> => {
    commands.push(command)
    return { ok: true, result: command.type === "session.list" ? { sessions: [{ sessionId: id, title: "Kept history", directory: "/project", createdAt: NOW, updatedAt: NOW, lastSeq: 1, queued: 0, state: "idle", archivedAt: NOW }] } : { session: { sessionId: id, ...(command.type === "session.archive" && !command.restore ? { archivedAt: NOW } : {}) } } }
  }, subscribe: async () => ({ ok: true as const }) }, listen() {}, out: { write: (text: string) => { output += text } }, err: { write: (text: string) => { throw new Error(text) } }, cwd: "/project", now: () => NOW }
  expect(parse("session", "archive", id)).toMatchObject({ kind: "session.archive", id, restore: false })
  expect(await runAutomation(parse("session", "archive", id), deps)).toBe(0)
  expect(output).toBe(`Archived ${id}\n`)
  expect(commands.at(-1)).toEqual({ type: "session.archive", sessionId: id })
  output = ""
  expect(await runAutomation(parse("session", "archive", id, "--restore", "--json"), deps)).toBe(0)
  expect(commands.at(-1)).toEqual({ type: "session.archive", sessionId: id, restore: true })
  expect(JSON.parse(output).data).toMatchObject({ sessionId: id, session: { sessionId: id } })
  output = ""
  expect(await runAutomation(parse("session", "list", "--archived", "--search", "history"), deps)).toBe(0)
  expect(commands.at(-1)).toMatchObject({ type: "session.list", archived: true, search: "history", directory: "/project", roots: true })
  expect(output).toContain("[archived]")
})

test("picker archives/restores without closing the open transcript and typing preserves archive scope", async () => {
  const id = ids("session")
  const session: SessionSummary = { sessionId: id, title: "Kept history", directory: "/project", createdAt: NOW, updatedAt: NOW, lastSeq: 1, queued: 0, state: "idle" }
  const h = appHarness({ sessionId: id, dataDir: tempDir(), directory: "/project", reply: (command) => {
    if (command.type === "session.list") return { ok: true, result: { sessions: command.archived || session.archivedAt === undefined ? [session] : [] } }
    if (command.type === "session.archive") {
      if (command.restore) delete session.archivedAt
      else session.archivedAt = NOW
      return { ok: true, result: { session } }
    }
  } })
  h.app.applySettings({ onboarded: true })
  conversation(id, h.app.onEvent).exchange("Keep this prompt", "Keep this response")
  await h.type("/sessions\r")
  await h.app.onKey("\x01")
  expect(h.sentOf("session.archive").at(-1)).toEqual({ type: "session.archive", sessionId: id })
  expect(h.text().join("\n")).not.toContain("Kept history")
  await h.app.onKey("\x0f")
  expect(h.sentOf("session.list").at(-1)).toMatchObject({ archived: true })
  await h.type("Kept")
  expect(h.text().join("\n")).toContain("Kept history")
  expect(h.text().join("\n")).toContain("archived")
  await h.app.onKey("\x01")
  expect(h.sentOf("session.archive").at(-1)).toEqual({ type: "session.archive", sessionId: id, restore: true })
  await h.app.onKey("\x1b")
  expect(h.text().join("\n")).toContain("Keep this response")
})

test("live archive/restore updates hide and reinsert a session without a reload, while old events preserve the marker", async () => {
  const id = ids("session")
  const session: SessionSummary = { sessionId: id, title: "Remote archive", directory: "/project", createdAt: NOW, updatedAt: NOW, lastSeq: 1, queued: 0, state: "idle" }
  const h = appHarness({ sessionId: id, dataDir: tempDir(), directory: "/project", reply: (command) => command.type === "session.list" ? { ok: true, result: { sessions: [session] } } : undefined })
  h.app.applySettings({ onboarded: true })
  await h.type("/sessions\r")
  const activity = { type: "session.activity" as const, gseq: 0, at: NOW, sessionId: id, title: session.title, directory: "/project", updatedAt: NOW, state: "idle" as const }
  h.app.onGlobal({ ...activity, archivedAt: NOW })
  expect(h.text().join("\n")).not.toContain("Remote archive")
  h.app.onGlobal(activity)
  expect(h.text().join("\n")).not.toContain("Remote archive")
  h.app.onGlobal({ ...activity, archivedAt: null })
  expect(h.text().join("\n")).toContain("Remote archive")
  expect(projectSessions([{ ...session, archivedAt: NOW }], "/project")).toEqual([{ ...session, archivedAt: NOW }])
})

test("archive key actions, rejected writes and all picker states respect narrow and wide cell bounds", async () => {
  const id = ids("session")
  const session: SessionSummary = { sessionId: id, title: "History preserved", directory: "/project", createdAt: NOW, updatedAt: NOW, lastSeq: 1, queued: 0, state: "idle", archivedAt: NOW }
  expect(sessionListKey({ selected: 0, filter: "", archived: true }, "\x01", [session]).action).toEqual({ type: "archive", sessionId: id, restore: true })
  expect(sessionListKey({ selected: 0, filter: "" }, "\x01", [session]).action.type).toBe("none")
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
    for (const state of [{ selected: 0, filter: "" }, { selected: 0, filter: "History", archived: true }, { selected: 0, filter: "zzz", archived: true }, { selected: 0, filter: "", archived: true, edit: { mode: "delete" as const, sessionId: id } }, { selected: 0, filter: "", archived: true, edit: { mode: "rename" as const, sessionId: id, draft: "x".repeat(200) } }]) {
      const rows = renderSessionList({ sessions: [session], state, width: width!, height: height!, now: NOW })
      expect(rows.length).toBe(height)
      for (const row of rows) expect(textWidth(row.map((span) => span.text).join(""))).toBe(width)
    }
  }
  const h = appHarness({ dataDir: tempDir(), reply: (command) => command.type === "session.list" ? { ok: true, result: { sessions: [{ ...session, archivedAt: undefined }] } } : command.type === "session.archive" ? { ok: false, error: { code: "unknown_session", message: "Session unavailable" } } : undefined })
  h.app.applySettings({ onboarded: true })
  await h.type("/sessions\r")
  await h.app.onKey("\x01")
  expect(h.text().join("\n")).toContain("Session unavailable")
  expect(h.text().join("\n")).toContain("History preserved")
})
