import { afterEach, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ChangesReport, MAX_FRAME_BYTES, createIdFactory, isReadOnlyCommand } from "@mendcode/protocol"
import { SNAPSHOT_TURNS_KEPT, openStore, type FileSnapshot } from "@mendcode/store"
import { createSessionHistory } from "../src/session-history"
import { boundSnapshotReport, summarizeSnapshots } from "../src/snapshot-diff"
import { createTurnSnapshots, readFileState } from "../src/turn-snapshots"

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
function temporary() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-b55-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test("B55 persisted message diffs survive pruning and restart; expired session/undo files remain explicit", () => {
  const dir = temporary()
  const project = temporary()
  execFileSync("git", ["-C", project, "init", "-q"], { stdio: "ignore" })
  let store = openStore({ dir })
  const ids = createIdFactory()
  const sessionId = ids("session")
  store.createSession({ id: sessionId, directory: project, title: "B55" })
  store.settings.set({ snapshotScope: "worktree" })
  const snapshots = createTurnSnapshots({ store })
  const turns = Array.from({ length: SNAPSHOT_TURNS_KEPT + 1 }, (_, i) => {
    const turnId = ids("turn")
    const itemId = ids("item")
    store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
    snapshots.begin(sessionId, turnId, project)
    store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId, kind: "user_message" })
    store.sessionSink.append({ type: "item.completed", sessionId, itemId, text: `prompt ${i}`, status: "ok" })
    writeFileSync(path.join(project, `file-${i}.txt`), `created ${i}\n`)
    store.sessionSink.append({ type: "turn.completed", sessionId, turnId })
    snapshots.seal(sessionId, turnId)
    return { turnId, itemId }
  })
  expect(store.turns.files.list(sessionId, turns[0]!.turnId)).toEqual([])
  store.close()
  store = openStore({ dir })
  cleanups.push(() => store.close())
  const history = createSessionHistory({ store, snapshots: createTurnSnapshots({ store }), publish: () => {}, isBusy: () => false, now: Date.now })
  expect(history.changes({ sessionId, atItemId: turns[0]!.itemId })).toMatchObject({ ok: true, result: { complete: true, files: [{ path: "file-0.txt", diff: "@@ -0,0 +1 @@\n+created 0\n" }] } })
  const total = history.changes({ sessionId })
  expect(total).toMatchObject({ ok: true, result: { complete: false } })
  if (total.ok) expect(total.result.files).toHaveLength(turns.length)
  const undone = history.undo({ sessionId, atItemId: turns[0]!.itemId })
  expect(undone).toMatchObject({ ok: true })
  if (undone.ok) expect(undone.result.notes.join(" ")).toContain("file snapshots have expired")
  expect(readFileSync(path.join(project, "file-0.txt"), "utf8")).toBe("created 0\n")
})

test("B55 missing paths below a replaced parent symlink cannot escape into another directory", () => {
  const project = temporary()
  const outside = temporary()
  mkdirSync(path.join(project, "folder"))
  const file = path.join(project, "folder", "missing.txt")
  expect(readFileState(file, 1024, true)).toEqual({ state: "absent" })
  rmSync(path.join(project, "folder"), { recursive: true })
  symlinkSync(outside, path.join(project, "folder"))
  expect(readFileState(file, 1024, true)).toEqual({ state: "skipped", reason: "unreadable" })
})

test("B55 worktree scope falls back to bounded tool snapshots outside Git", () => {
  const store = openStore({ dir: temporary() })
  cleanups.push(() => store.close())
  const project = temporary()
  const ids = createIdFactory()
  const sessionId = ids("session")
  const turnId = ids("turn")
  store.createSession({ id: sessionId, directory: project, title: "Non-Git" })
  store.settings.set({ snapshotScope: "worktree" })
  const snapshots = createTurnSnapshots({ store })
  const file = path.join(project, "file.txt")
  writeFileSync(file, "before\n")
  store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
  snapshots.begin(sessionId, turnId, project)
  snapshots.capture({ sessionId, turnId, cwd: project, tool: "write", args: { path: "file.txt" } })
  writeFileSync(file, "after\n")
  snapshots.seal(sessionId, turnId)
  expect(store.turns.snapshots.get(sessionId, turnId)).toMatchObject({ scope: "tools", complete: false, summary: { files: [{ path: "file.txt", additions: 1, deletions: 1 }] } })
  const before = store.turns.files.list(sessionId, turnId)[0]?.before
  expect(before?.state).toBe("content")
  if (before?.state === "content") expect(Buffer.from(before.content).toString()).toBe("before\n")
})

test("B55 diffs redact secret bytes and bound escaped paths/content below one protocol frame", () => {
  const secret = "sk-proj-" + "A".repeat(40)
  const file: FileSnapshot = { path: "/repo/key.txt", before: { state: "absent" }, after: { state: "content", mode: 0o644, content: Buffer.from(`${secret}\n`) } }
  const summary = summarizeSnapshots("/repo", [file], true)
  expect(summary.files[0]?.diff).not.toContain(secret)
  expect(summary.files[0]?.diff).toContain("[redacted:openai-key]")
  const huge = boundSnapshotReport({ ...summary, files: Array.from({ length: 300 }, (_, i) => ({ ...summary.files[0]!, path: `${i}/${"a".repeat(4090)}`, diff: "\\\"".repeat(1000) })) })
  expect(Buffer.byteLength(JSON.stringify(huge))).toBeLessThan(MAX_FRAME_BYTES - 2048 + 1)
  expect(ChangesReport.parse(huge).complete).toBe(false)
  expect(huge.omittedFiles).toBeGreaterThan(0)
  expect(isReadOnlyCommand("session.changes")).toBe(false)
})
