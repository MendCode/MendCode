import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory } from "@mendcode/protocol"
import { lazyPrWatch } from "../src/lazy-pr-watch"
import { lazyPrReviewPort } from "../src/lazy-pr-review-port"
import { lazyReviewSessions } from "../src/lazy-review-sessions"
import { lazyWorkflows } from "../src/lazy-workflows"
import type { PrWatchOptions } from "../src/pr-watch"
import { hasSavedPrWork } from "../src/saved-pr-work"

const ids = createIdFactory()
const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

test("importing the daemon leaves GitHub, PR review, PR watch and the workflow host unevaluated", () => {
  // Import only: no daemon is started, no socket, login or user's data directory is opened.
  const module = path.resolve(import.meta.dir, "../src/daemon.ts")
  const script = `await import(${JSON.stringify(module)}); console.log(JSON.stringify(Object.keys(require.cache).filter(file => /packages\\/daemon\\/src\\/(github\\.ts|pr-watch\\.ts|pr-review-tool\\.ts|workflows\\.ts|pr-review\\/)/.test(file))))`
  const child = Bun.spawnSync([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" })
  expect(child.exitCode).toBe(0)
  expect(child.stderr.toString()).toBe("")
  expect(JSON.parse(child.stdout.toString())).toEqual([])
})

function watchOptions(): PrWatchOptions {
  const dir = mkdtempSync(path.join(tmpdir(), "lazy-github-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, enabled: () => false, sessionExists: () => true, sessionDirectory: () => dir, notify: async () => undefined, mask: (_, text) => text, run: async () => { throw new Error("unexpected gh") } }
}

test("fresh watch ports keep synchronous empty replies and validation without loading a service", async () => {
  const watch = await lazyPrWatch(watchOptions())
  cleanups.push(watch.stop)
  const port = watch.port("session")
  expect(port.list()).toBe("no pull request is watched by this session")
  expect(port.unwatch({})).toEqual({ ok: false, message: "this session watches no pull request" })
  expect(port.unwatch({ pr: "7" })).toEqual({ ok: false, message: "no watch of this session matches that pull request" })
  expect(port.unwatch({ pr: "--bad" })).toEqual({ ok: false, message: "pr must be a number, #number, a github.com pull request URL or a branch name" })
  expect(watch.list("session")).toEqual([])
  await watch.tick()
  const replies = await Promise.all([port.watch({ pr: "7" }), watch.control({ sessionId: "session", action: "watch", pr: "7" })])
  expect(replies[0]).toEqual(replies[1])
  expect(replies[0].ok).toBe(false)
})

test("persisted watches are available synchronously on return, including after an immediate stop", async () => {
  const options = watchOptions()
  writeFileSync(path.join(options.dir, "pr-watch.json"), JSON.stringify({ version: 1, watches: [{ sessionId: "session", directory: options.dir, url: "https://github.com/acme/app/pull/7", number: 7, title: "Saved PR", head: "feature", base: "main", createdAt: 1, mark: { failed: "", passed: false, conflict: false, seen: [] }, pending: [] }] }))
  const watch = await lazyPrWatch(options)
  watch.stop()
  expect(watch.list("session")).toMatchObject([{ number: 7, state: "watching" }])
  expect(watch.port("session").list()).toContain("Saved PR")
  const restored = await lazyPrWatch(options)
  cleanups.push(restored.stop)
  expect(restored.list("session")).toEqual(watch.list("session"))
})

test("empty saved ledgers do not load features; nonempty and malformed files still reach their real reader", () => {
  const { dir } = watchOptions()
  const file = path.join(dir, "records.json")
  expect(hasSavedPrWork(file, "watches")).toBe(false)
  writeFileSync(file, JSON.stringify({ version: 1, watches: [], jobs: [], sessions: {} }))
  expect(hasSavedPrWork(file, "watches")).toBe(false)
  expect(hasSavedPrWork(file, "jobs")).toBe(false)
  expect(hasSavedPrWork(file, "sessions")).toBe(false)
  writeFileSync(file, JSON.stringify({ version: 1, watches: [{}], jobs: [{}], sessions: { owner: ["notice"] } }))
  expect(hasSavedPrWork(file, "watches")).toBe(true)
  expect(hasSavedPrWork(file, "jobs")).toBe(true)
  expect(hasSavedPrWork(file, "sessions")).toBe(true)
  writeFileSync(file, "broken")
  expect(hasSavedPrWork(file, "watches")).toBe(true)
})

test("review factories load once on first child, not for routing or observers", async () => {
  let created = 0
  const id = ids("session")
  const sessions = lazyReviewSessions(({ createReviewSessions }) => {
    created++
    return createReviewSessions({ create: () => id, submit: async () => {}, deny: () => {}, cancel: async () => {}, remove: () => {} })
  })
  const factory = sessions.factory({ directory: "/project" })
  expect(sessions.isReview(id)).toBe(false)
  expect(sessions.isEditor(id)).toBe(false)
  expect(created).toBe(0)
  const children = await Promise.all([factory({ purpose: "review" }), factory({ purpose: "verify" })])
  expect(created).toBe(1)
  expect(sessions.isReview(id)).toBe(true)
  await children[0]!.close()
  await children[1]!.close()
})

test("review tool ports defer control calls until used and retain preview/status text", async () => {
  let calls = 0
  const port = lazyPrReviewPort({ sessionId: "session", directory: () => "/project", control: async () => { calls++; return { ok: true, text: "status", watches: [] } } })
  expect(calls).toBe(0)
  const [preview, status] = await Promise.all([port.preview({ pr: "7" }), port.status()])
  expect(preview).toContain("Review pull request 7 of /project")
  expect(status).toMatchObject({ ok: true, text: expect.stringContaining("No review jobs.") })
  expect(calls).toBe(2)
})

test("workflow boot, routing and empty ports do not build the service", async () => {
  let liveChecks = 0
  const host = lazyWorkflows({
    store: { hasLive: () => { liveChecks++; return false }, all: () => [], save: () => {}, remove: () => {} },
    definitions: { list: () => [], definition: () => undefined, revision: () => undefined, save: () => {} },
    clock: { now: Date.now, setTimer: () => { throw new Error("unexpected timer") } },
    ids, layersFor: () => [], defaultPermission: () => "ask", createSession: () => { throw new Error("unexpected session") },
    submit: async () => ({ error: "unexpected submit" }), cancelTurn: () => {}, deleteSession: () => true,
    runCheck: async () => { throw new Error("unexpected check") }, fingerprint: async () => undefined, emit: () => {},
  })
  cleanups.push(host.dispose)
  const port = host.port(ids("session"), "/project")
  host.boot()
  expect(liveChecks).toBe(1)
  expect(host.loaded()).toBe(false)
  expect(host.execution(ids("session"))).toBeUndefined()
  expect(await port.status()).toBe("no workflows in this project")
  expect(await host.handle({ type: "workflow.list" })).toEqual({ ok: true, result: { workflows: [] } })
  expect(host.loaded()).toBe(false)
})
