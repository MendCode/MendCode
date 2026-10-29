import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createNativeEngine, memoryHistory, type ModelEvent } from "@mendcode/engine-native"
import { createIdFactory, type GlobalEvent, type SessionEvent, type ReviewSnapshot, type SessionId } from "@mendcode/protocol"
import { review } from "@mendcode/tools"
import { createReviews, reviewFile } from "../src/review"
import { startDaemon } from "../src"

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })
const ids = createIdFactory()
const sessionId = ids("session")
const OTHER = ids("session")
const BASE = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join("\n") + "\n"
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } })
  if (result.exitCode) throw new Error(result.stderr.toString())
  return result.stdout.toString()
}
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-review-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const project = path.join(dir, "project")
  mkdirSync(project)
  git(project, "init", "-q", "-b", "main")
  writeFileSync(path.join(project, "a.ts"), BASE)
  git(project, "add", ".")
  git(project, "commit", "-qm", "base")
  writeFileSync(path.join(project, "a.ts"), BASE.replace("line 2\n", "changed 2\n").replace("line 22\n", "changed 22\n"))
  writeFileSync(path.join(project, "b.ts"), "untracked\n")
  const events: ReviewSnapshot[] = []
  const host = () => createReviews({ dir, directory: () => project, now: () => 1234, changed: (_id, review) => events.push(review) })
  return { dir, project, host, events, service: host() }
}

test("current, summary, file and comment_list are reads with optional raw patch", async () => {
  const h = fixture()
  const before = git(h.project, "status", "--porcelain")
  const summary = JSON.parse((await h.service.port(sessionId).run({ action: "summary" })).output)
  expect(summary.stats).toEqual({ files: 2, additions: 3, deletions: 2, blocks: 3 })
  expect(summary.files[0].blocks).toHaveLength(2)
  const current = await h.service.read(sessionId, { action: "current" })
  expect(current.review.selection.filePath).toBe("a.ts")
  const file = JSON.parse((await h.service.port(sessionId).run({ action: "file" })).output)
  expect(file.blocks[0].lines.some((r: { new: number }) => r.new === 2)).toBe(true)
  expect(file.rawPatch).toBeUndefined()
  expect(JSON.parse((await h.service.port(sessionId).run({ action: "file", filePath: "a.ts", includePatch: true })).output).rawPatch).toContain("+changed 2")
  expect((await h.service.read(sessionId, { action: "comment_list" })).review.comments).toEqual([])
  expect(existsSync(reviewFile(h.dir, sessionId))).toBe(false)
  expect(h.events).toEqual([])
  expect(git(h.project, "status", "--porcelain")).toBe(before)
})

test("tool drives all navigation directions, line sides and comment authors through the daemon port", async () => {
  const h = fixture()
  const ctx = { cwd: h.project, signal: new AbortController().signal, review: h.service.port(sessionId) }
  const run = (args: unknown) => review.execute(review.args.parse(args), ctx)
  for (const [direction, file, block] of [["next-block", "a.ts", 1], ["prev-block", "a.ts", 0], ["next-file", "b.ts", 0], ["prev-file", "a.ts", 0]] as const) {
    const result = await run({ action: "navigate", direction })
    expect(result.isError).toBe(false)
    expect(result.meta).toMatchObject({ selectedFile: file, selectedBlock: block })
  }
  expect((await run({ action: "navigate", filePath: "a.ts", blockIndex: 1 })).meta?.selectedBlock).toBe(1)
  for (const [direction, file, block] of [["next-block", "b.ts", 0], ["next-file", "a.ts", 0], ["prev-file", "b.ts", 0], ["prev-block", "a.ts", 1]] as const) {
    expect((await run({ action: "navigate", direction })).meta).toMatchObject({ selectedFile: file, selectedBlock: block })
  }
  expect((await run({ action: "comment_add", filePath: "a.ts", blockIndex: 0, line: 2, side: "old", body: "Explain removal", author: "agent" })).isError).toBe(false)
  expect((await run({ action: "comment_add", filePath: "a.ts", blockIndex: 1, body: "Split hunk" })).isError).toBe(false)
  const list = JSON.parse((await run({ action: "comment_list" })).output)
  expect(list[0]).toMatchObject({ author: "agent", oldRange: { from: 2, to: 2 }, excerpt: ["-line 2"] })
  expect(list[0].newRange).toBeUndefined()
  expect(list[1]).toMatchObject({ author: "assistant", kind: "hunk", hunk: 1 })
  const bytes = readFileSync(reviewFile(h.dir, sessionId), "utf8")
  for (const args of [{ action: "comment_add", filePath: "a.ts", body: "missing block" }, { action: "navigate", filePath: "missing" }, { action: "navigate", blockIndex: 99 }, { action: "comment_add", filePath: "a.ts", blockIndex: 0, line: 999, body: "bad line" }]) expect((await run(args)).isError).toBe(true)
  expect(readFileSync(reviewFile(h.dir, sessionId), "utf8")).toBe(bytes)
  expect((await run({ action: "current" })).meta?.comments).toBe(2)
})

test("restart, reload, renames and filtered stale clearing preserve comments and session isolation", async () => {
  const h = fixture()
  await h.service.update(sessionId, { action: "comment_add", filePath: "a.ts", blockIndex: 0, line: 2, side: "new", body: "Changed line" })
  await h.service.update(sessionId, { action: "comment_add", filePath: "b.ts", blockIndex: 0, body: "Whole hunk" })
  expect((await h.host().read(sessionId, { action: "current" })).review.comments).toHaveLength(2)
  expect((await h.host().read(OTHER, { action: "current" })).review.comments).toEqual([])
  git(h.project, "mv", "a.ts", "renamed.ts")
  await h.service.update(sessionId, { action: "reload" })
  expect((await h.service.read(sessionId, { action: "comment_list" })).review.comments[0]).toMatchObject({ path: "renamed.ts", stale: false })
  writeFileSync(path.join(h.project, "renamed.ts"), BASE)
  await h.service.update(sessionId, { action: "reload" })
  const stale = (await h.service.read(sessionId, { action: "comment_list" })).review.comments
  expect(stale[0]!.stale).toBe(true)
  expect(stale[1]!.stale).toBe(false)
  await h.service.update(sessionId, { action: "comment_clear", staleOnly: true, filePath: "b.ts" })
  expect((await h.service.read(sessionId, { action: "comment_list" })).review.comments).toHaveLength(2)
  await h.service.update(sessionId, { action: "comment_clear", staleOnly: true })
  expect((await h.service.read(sessionId, { action: "comment_list" })).review.comments.map((c) => c.path)).toEqual(["b.ts"])
  await h.service.update(sessionId, { action: "comment_clear", filePath: "b.ts" })
  expect((await h.host().read(sessionId, { action: "current" })).review.comments).toEqual([])
})

test("targeted client edits preserve concurrent agent additions and reject oversize reviews atomically", async () => {
  const h = fixture()
  const first = (await h.service.update(sessionId, { action: "comment_add", filePath: "a.ts", blockIndex: 0, body: "First" })).review.comments[0]!
  await Promise.all([
    h.service.update(sessionId, { action: "comment_add", filePath: "b.ts", blockIndex: 0, body: "Concurrent" }),
    h.service.update(sessionId, { action: "sync", upsert: [{ ...first, body: "Edited" }] }),
  ])
  expect((await h.service.read(sessionId, { action: "current" })).review.comments.map((c) => c.body)).toEqual(["Edited", "Concurrent"])
  await h.service.update(sessionId, { action: "sync", remove: [first.id] })
  const before = readFileSync(reviewFile(h.dir, sessionId), "utf8")
  const many = Array.from({ length: 60 }, (_, i) => ({ ...first, id: `rc_${i}`, body: "x".repeat(800), excerpt: Array.from({ length: 40 }, () => "y".repeat(240)) }))
  await expect(h.service.update(sessionId, { action: "sync", upsert: many })).rejects.toThrow("maximum 60")
  await expect(h.service.update(OTHER, { action: "sync", upsert: many })).rejects.toThrow("byte limit")
  expect(readFileSync(reviewFile(h.dir, sessionId), "utf8")).toBe(before)
})

test("large file replies stay bounded; on-demand anchors survive a truncated workspace report", async () => {
  const h = fixture()
  writeFileSync(path.join(h.project, "big.ts"), Array.from({ length: 1500 }, (_, i) => `${i} ${"x".repeat(80)}`).join("\n") + "\n")
  const result = await h.service.read(sessionId, { action: "file", filePath: "big.ts", includePatch: true })
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(200_000)
  expect("file" in result && result.file.truncated).toBe(true)
  await h.service.update(sessionId, { action: "comment_add", filePath: "big.ts", blockIndex: 0, line: 1200, side: "new", body: "Deep anchor" })
  const refreshed = await h.service.update(sessionId, { action: "reload" })
  expect(refreshed.review.comments[0]).toMatchObject({ newRange: { from: 1200, to: 1200 }, stale: false })
})

test("native tool and two clients share selection/comments, then hydrate after reconnect", async () => {
  const h = fixture()
  const steps: ModelEvent[][] = [
    [{ type: "tool_call", call: { callId: "nav", name: "review", args: { action: "navigate", filePath: "b.ts", blockIndex: 0 } } }, { type: "finish", reason: "tool_calls" }],
    [{ type: "tool_call", call: { callId: "note", name: "review", args: { action: "comment_add", filePath: "b.ts", blockIndex: 0, body: "Agent finding" } } }, { type: "finish", reason: "tool_calls" }],
    [{ type: "text", delta: "Reviewed" }, { type: "finish", reason: "stop" }],
  ]
  const daemon = await startDaemon({ dir: h.dir, socketPath: path.join(h.dir, "mendd.sock"), log: () => {}, engine: ({ review: port, store }) => createNativeEngine({ provider: { id: "fake", model: "fake", async *stream() { yield* steps.shift()! } }, tools: [review], history: memoryHistory(), review: port, cwdFor: (id) => store.sessionDirectory(id)!, system: () => "test", compactionPrompt: "test" }) })
  cleanups.push(() => daemon.stop())
  const globals: GlobalEvent[] = []
  const events: SessionEvent[] = []
  const a = createClient({ socketPath: daemon.socketPath, name: "a", onGlobal: (e) => globals.push(e), onEvent: (e) => events.push(e) })
  const b = createClient({ socketPath: daemon.socketPath, name: "b" })
  cleanups.push(() => { a.close(); b.close() })
  await a.connect()
  await b.connect()
  const created = await a.send({ type: "session.create", directory: h.project })
  const id = (created.ok ? created.result!.sessionId : undefined) as SessionId
  await a.subscribe(id)
  await a.send({ type: "user.submit", sessionId: id, text: "Review", attachments: [] })
  const end = Date.now() + 3000
  while (!events.some((e) => e.type === "turn.completed")) {
    if (events.some((e) => e.type === "turn.failed") || Date.now() > end) throw new Error(`native review did not complete: ${JSON.stringify(events.slice(-5))}`)
    await Bun.sleep(5)
  }
  expect(globals.filter((e) => e.type === "review.changed")).toHaveLength(2)
  const fromB = await b.review(id)
  expect(fromB.ok && fromB.result?.review).toMatchObject({ selection: { filePath: "b.ts" }, comments: [{ body: "Agent finding", author: "assistant" }] })
  const cleared = await b.updateReview(id, { action: "comment_clear" })
  expect(cleared.ok && cleared.result?.review).toMatchObject({ comments: [] })
  b.close()
  const c = createClient({ socketPath: daemon.socketPath, name: "reconnected" })
  cleanups.push(() => c.close())
  await c.connect()
  expect((await c.review(id)).ok).toBe(true)
  expect((await a.review(ids("session"))).ok).toBe(false)
  expect((await a.updateReview(id, { action: "navigate", filePath: "../outside" })).ok).toBe(false)
})
