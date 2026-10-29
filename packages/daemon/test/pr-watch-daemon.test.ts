import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createIdFactory, isReadOnlyCommand, PrWatchControl, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { remoteTokens } from "../src/remote"
import type { GhRun } from "../src/pr-watch"

const ids = createIdFactory()
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const pull = (extra: Record<string, unknown> = {}) => ({ number: 7, title: "Add the thing", url: "https://github.com/acme/app/pull/7", state: "OPEN", isDraft: false, mergeable: "MERGEABLE", reviewDecision: "", headRefName: "feature", baseRefName: "main", author: { login: "me" }, statusCheckRollup: [{ __typename: "CheckRun", name: "build", status: "IN_PROGRESS", conclusion: null }], comments: [], reviews: [], ...extra })

async function boot() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mendd-prwatch-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const state = { pr: pull() as Record<string, unknown>, calls: 0 }
  const run: GhRun = async ({ argv }) => {
    if (argv[0] === "api") return { code: 0, out: "me", err: "" }
    state.calls += 1
    return { code: 0, out: JSON.stringify(state.pr), err: "" }
  }
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), listen: "127.0.0.1:0", prWatch: { run, intervalMs: 3_600_000 }, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "prwatch" })
  await client.connect()
  cleanups.push(() => client.close())
  const created = await client.send({ type: "session.create", directory: dir, title: "t" })
  const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
  await client.subscribe(sessionId, 0)
  async function remote(readOnly: boolean) {
    const token = remoteTokens(dir).create({ name: readOnly ? "ro" : "full", readOnly }).token
    const peer = createClient({ name: "remote", remote: { hostname: "127.0.0.1", port: daemon.remotePort!, token } })
    await peer.connect()
    cleanups.push(() => peer.close())
    return peer
  }
  const notices = () => daemon.store.readAfter(sessionId, 0).filter((event) => event.type === "queue.added" && event.notice)
  return { daemon, client, sessionId, state, notices, remote }
}

test("pr.watch is a protocol command that is never in the read-only set", () => {
  const base = { id: ids("command"), clientId: ids("client"), type: "pr.watch", sessionId: ids("session") }
  expect(PrWatchControl.safeParse({ ...base, action: "watch", pr: "7" }).success).toBe(true)
  expect(PrWatchControl.safeParse({ ...base, action: "run" }).success).toBe(false)
  expect(isReadOnlyCommand("pr.watch")).toBe(false)
})

test("it is off until experimental.pr_watch is on, and then nothing runs without the user's own gh", async () => {
  const h = await boot()
  const refused = await h.client.send({ type: "pr.watch", sessionId: h.sessionId, action: "watch", pr: "7" })
  expect(refused).toMatchObject({ ok: false, error: { code: "invalid_command" } })
  expect(!refused.ok && refused.error.message).toContain("/experimental pr_watch on")
  expect(h.state.calls).toBe(0)
  await h.client.send({ type: "settings.set", patch: { experimental: { pr_watch: true } } })
  const started = await h.client.send({ type: "pr.watch", sessionId: h.sessionId, action: "watch", pr: "7" })
  expect(started).toMatchObject({ ok: true, result: { watches: [{ number: 7, state: "watching" }] } })
  expect(String(started.ok && started.result?.text)).toContain("PR #7")
  expect(await h.client.send({ type: "pr.watch", sessionId: h.sessionId, action: "list" })).toMatchObject({ ok: true, result: { watches: [{ number: 7 }] } })
  await h.client.send({ type: "settings.set", patch: { experimental: { pr_watch: false } } })
  const before = h.state.calls
  await h.daemon.prWatch.tick()
  expect(h.state.calls).toBe(before)
})

test("a change wakes the owning session through its notice queue, once", async () => {
  const h = await boot()
  await h.client.send({ type: "settings.set", patch: { experimental: { pr_watch: true } } })
  await h.client.send({ type: "pr.watch", sessionId: h.sessionId, action: "watch", pr: "7" })
  await h.daemon.prWatch.tick()
  expect(h.notices()).toHaveLength(0)
  h.state.pr = pull({ statusCheckRollup: [{ __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "FAILURE" }] })
  await h.daemon.prWatch.tick()
  const added = h.notices()
  expect(added).toHaveLength(1)
  expect(added[0]).toMatchObject({ notice: true })
  expect(JSON.stringify(added[0])).toContain("Checks failed: build")
  await h.daemon.prWatch.tick()
  expect(h.notices()).toHaveLength(1)
})

test("remote and peer clients cannot start, read or stop a watch: gh runs on this machine", async () => {
  const h = await boot()
  await h.client.send({ type: "settings.set", patch: { experimental: { pr_watch: true } } })
  for (const peer of [await h.remote(false), await h.remote(true)]) {
    for (const action of ["watch", "list", "check", "unwatch"] as const) {
      expect(await peer.send({ type: "pr.watch", sessionId: h.sessionId, action })).toMatchObject({ ok: false, error: { code: "forbidden" } })
    }
  }
  expect(h.state.calls).toBe(0)
})
