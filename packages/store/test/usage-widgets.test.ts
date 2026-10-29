import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type SessionId } from "@mendcode/protocol"
import { openStore, type Store } from "../src"
import { createUsageQuery } from "../../daemon/src/usage"

const cleanup: Array<() => void> = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })
const ids = createIdFactory()
const at = new Date("2026-09-30T12:00:00").getTime()
const range = { from: "2026-09-30", to: "2026-09-30" }
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-b77-store-"))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const store = openStore({ dir, now: () => at })
  cleanup.push(() => store.close())
  const session = (directory: string, agent?: string) => { const id = ids("session"); store.createSession({ id, directory, title: "Local fixture" }); if (agent) store.setSessionAgent(id, agent); return id }
  return { store, dir, session }
}
function turn(store: Store, sessionId: SessionId, end: "completed" | "failed" | "running" = "completed", unchanged = false) {
  const turnId = ids("turn")
  store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
  store.turns.files.captureBefore(sessionId, turnId, "code.ts", { state: "content", content: new TextEncoder().encode("before") })
  store.turns.files.seal(sessionId, turnId, "code.ts", { state: "content", content: new TextEncoder().encode(unchanged ? "before" : "after") })
  if (end === "failed") store.sessionSink.append({ type: "turn.failed", sessionId, turnId, error: { code: "local", message: "fixture" } })
  else if (end !== "running") store.sessionSink.append({ type: "turn.completed", sessionId, turnId })
  return turnId
}

test("agent turns and retained changes obey ranges and directory scopes, including empty scopes", () => {
  const h = fixture()
  const a = h.session("/work/a", "review"), b = h.session("/work/b")
  turn(h.store, a); turn(h.store, a); turn(h.store, b)
  expect(h.store.usageWidgets(range)).toEqual({ agents: [{ name: "review", turns: 2 }, { name: "build", turns: 1 }], outcomes: { changedFiles: 2, sessionsWithCodeChanges: 2, coverage: "retained-snapshots" } })
  expect(h.store.usageWidgets({ ...range, directories: ["/work/a"] })).toMatchObject({ agents: [{ name: "review", turns: 2 }], outcomes: { changedFiles: 1, sessionsWithCodeChanges: 1 } })
  for (const query of [{ from: "2026-10-01", to: "2026-10-01" }, { ...range, directories: [] }]) expect(h.store.usageWidgets(query)).toMatchObject({ agents: [], outcomes: { changedFiles: 0, sessionsWithCodeChanges: 0 } })
  const report = createUsageQuery(h.store, "/work/a")({ ...range, scope: "directory" }, range.to)
  expect(report.agents).toEqual([{ name: "review", turns: 2 }])
  expect(report.outcomes?.changedFiles).toBe(1)
})

test("unchanged, skipped, failed, open and undone changes are excluded; no contents leave the query", () => {
  const h = fixture(), s = h.session("/work/a")
  const completed = turn(h.store, s)
  turn(h.store, s, "completed", true)
  turn(h.store, s, "failed")
  const skip = ids("turn")
  h.store.sessionSink.append({ type: "turn.started", sessionId: s, turnId: skip, queueId: ids("queue") })
  h.store.turns.files.captureBefore(s, skip, "binary", { state: "skipped", reason: "binary" })
  h.store.turns.files.seal(s, skip, "binary", { state: "content", content: new Uint8Array([1]) })
  h.store.sessionSink.append({ type: "turn.completed", sessionId: s, turnId: skip })
  const report = h.store.usageWidgets(range)
  expect(report.outcomes?.changedFiles).toBe(1)
  expect(JSON.stringify(report)).not.toContain("before")
  expect(JSON.stringify(report)).not.toContain("code.ts")
  h.store.sessionSink.append({ type: "turn.reverted", sessionId: s, turnId: completed })
  turn(h.store, s, "running")
  expect(h.store.usageWidgets(range).outcomes?.changedFiles).toBe(0)
})

test("agent labels use saved plan mode and existing projections survive reopen", () => {
  const h = fixture(), s = h.session("/work/a")
  h.store.sessionSink.append({ type: "session.permission", sessionId: s, mode: "plan" })
  turn(h.store, s)
  const expected = h.store.usageWidgets(range)
  expect(expected.agents).toEqual([{ name: "plan", turns: 1 }])
  h.store.close()
  cleanup.pop()
  const reopened = openStore({ dir: h.dir, now: () => at })
  cleanup.push(() => reopened.close())
  expect(reopened.usageWidgets(range)).toEqual(expected)
})
