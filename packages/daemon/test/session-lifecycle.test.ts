import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createIdFactory, isReadOnlyCommand, SessionMeta, type SessionId } from "@mendcode/protocol"
import { startDaemon, type DaemonOptions } from "../src"
import { remoteTokens } from "../src/remote"
import { createSessionLifecycle, lifecycleOf } from "../src/session-lifecycle"
import { cleanTitle, createSessionMetadata } from "../src/session-metadata"
import { sessionMetaTool } from "../src/session-meta-tool"

const ids = createIdFactory()
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
async function boot(extra: Partial<DaemonOptions> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-meta-"))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  let port!: Parameters<DaemonOptions["engine"]>[0]["sessionMeta"]
  let browserPort!: Parameters<DaemonOptions["engine"]>[0]["browser"]
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "d.sock"), listen: "127.0.0.1:0", engine: ({ clock, sessionMeta, browser }) => { port = sessionMeta; browserPort = browser; return createFauxEngine({ clock, deltaMs: 1 }) }, ...extra })
  cleanup.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "lifecycle-test" })
  await client.connect()
  cleanup.push(() => client.close())
  const reply = await client.send({ type: "session.create", directory: dir, title: "original" })
  const id = (reply.ok ? reply.result?.sessionId : undefined) as SessionId
  await client.subscribe(id, 0)
  const meta = (input: import("@mendcode/protocol").SessionMetaInput) => client.send({ type: "session.meta", sessionId: id, input })
  return { dir, daemon, client, id, meta, port: () => port(id), browserPort: () => browserPort(id) }
}
async function until(check: () => boolean) {
  const end = Date.now() + 3000
  while (!check()) { if (Date.now() > end) throw new Error("timeout"); await Bun.sleep(5) }
}

test("metadata is additive, validated, tier gated and never read-only", async () => {
  expect(SessionMeta.safeParse({ type: "session.meta", id: ids("command"), clientId: ids("client"), sessionId: ids("session"), input: { action: "rules", inactiveDays: 0 } }).success).toBe(false)
  expect(isReadOnlyCommand("session.meta")).toBe(false)
  expect(isReadOnlyCommand("session.fanout")).toBe(false)
  const h = await boot()
  expect(await h.meta({ action: "pin" })).toMatchObject({ ok: false, error: { code: "forbidden" } })
  await h.client.send({ type: "settings.set", patch: { tier: "balanced" } })
  expect(await h.meta({ action: "pin" })).toMatchObject({ ok: true })
  expect(h.daemon.store.sessionPinnedAt(h.id)).toBeNumber()
  await h.meta({ action: "rename", title: "renamed" })
  expect(h.daemon.store.sessionInfo(h.id)?.title).toBe("renamed")
  await h.meta({ action: "settle", reason: "finished" })
  expect(h.daemon.store.sessionInfo(h.id)?.archivedAt).toBeNumber()
  expect(lifecycleOf(h.daemon.store, h.id).settledReason).toBe("finished")
  await h.meta({ action: "restore" })
  expect(h.daemon.store.sessionInfo(h.id)?.archivedAt).toBeNull()
  expect(lifecycleOf(h.daemon.store, h.id).settledReason).toBeUndefined()
})

test("PR reads are on demand through argument arrays; failure preserves the saved link", async () => {
  const calls: string[][] = []
  let state = "OPEN", fail = false
  const h = await boot({ prWatch: { run: async ({ argv }) => { calls.push(argv); return { code: fail ? 1 : 0, out: JSON.stringify({ number: 7, url: "https://github.com/acme/app/pull/7", title: "Feature", state, headRefName: "feature" }), err: "secret diagnostic" } } } })
  await h.client.send({ type: "settings.set", patch: { tier: "balanced" } })
  await h.meta({ action: "link_pr" })
  expect(calls).toEqual([["pr", "view", "--json", "number,url,title,state,headRefName"]])
  await h.meta({ action: "rules", prClosed: true })
  state = "MERGED"
  await h.meta({ action: "check" })
  expect(h.daemon.store.sessionInfo(h.id)?.archivedAt).toBeNumber()
  await h.meta({ action: "restore" })
  await h.client.send({ type: "session.list" })
  expect(h.daemon.store.sessionInfo(h.id)?.archivedAt).toBeNull()
  fail = true
  expect(JSON.stringify(await h.meta({ action: "check" }))).not.toContain("secret diagnostic")
  expect(lifecycleOf(h.daemon.store, h.id).pr?.state).toBe("MERGED")
  await h.meta({ action: "unlink_pr" })
  expect(lifecycleOf(h.daemon.store, h.id).pr).toBeUndefined()
  expect(await h.meta({ action: "link_pr", pr: "--evil" })).toMatchObject({ ok: false })
})

test("inactive rules use a fake clock; pin, busy and disable protect sessions; deferred settle survives service recreation", async () => {
  const h = await boot()
  let now = Date.now(), busy = false
  const setup = () => createSessionLifecycle({ store: h.daemon.store, now: () => now, busy: () => busy, changed() {}, settled() {}, regenerate: async () => false, gh: async () => ({ code: 1, out: "", err: "" }) })
  const service = setup()
  await service.run(h.id, { action: "rules", inactiveDays: 2 })
  now += 3 * 86400000
  await service.run(h.id, { action: "pin" })
  service.evaluate(h.id)
  expect(h.daemon.store.sessionInfo(h.id)?.archivedAt).toBeNull()
  await service.run(h.id, { action: "pin", pinned: false })
  busy = true
  service.evaluate(h.id)
  expect(h.daemon.store.sessionInfo(h.id)?.archivedAt).toBeNull()
  await service.run(h.id, { action: "rules", disabled: true })
  busy = false
  service.evaluate(h.id)
  expect(h.daemon.store.sessionInfo(h.id)?.archivedAt).toBeNull()
  service.requestSettle(h.id, "agent done")
  setup().evaluate(h.id)
  expect(lifecycleOf(h.daemon.store, h.id).settledReason).toBe("agent done")
})

test("agent settle defers until its current turn ends, without discarding queued work", async () => {
  const h = await boot()
  await h.client.send({ type: "settings.set", patch: { tier: "balanced" } })
  await h.client.send({ type: "user.submit", sessionId: h.id, text: "/tool 150", attachments: [] })
  await until(() => !!h.daemon.store.sessionsWithActiveTurn().length)
  expect(await h.meta({ action: "settle" })).toMatchObject({ ok: false })
  expect(await h.port()({ action: "settle", reason: "done" })).toMatchObject({ pending: true })
  await until(() => h.daemon.store.sessionInfo(h.id)?.archivedAt !== null)
  expect(h.daemon.store.turns.list(h.id)).toHaveLength(1)
})

test("remote clients and remote-origin tools cannot reach metadata or gh", async () => {
  const h = await boot()
  await h.client.send({ type: "settings.set", patch: { tier: "balanced" } })
  const token = remoteTokens(h.dir).create({ name: "remote", readOnly: false }).token
  const remote = createClient({ name: "remote-test", remote: { hostname: "127.0.0.1", port: h.daemon.remotePort!, token } })
  await remote.connect()
  cleanup.push(() => remote.close())
  expect(await remote.send({ type: "session.meta", sessionId: h.id, input: { action: "link_pr" } })).toMatchObject({ ok: false, error: { code: "forbidden" } })
  h.daemon.store.meta.set(`session.local-tools.restricted:${h.id}`, "true")
  await expect(h.port()({ action: "rename", title: "evil" })).rejects.toThrow("local only")
  for (const action of ["tabs", "open_tab", "select_tab", "close_tab"] as const) {
    expect(await h.browserPort().run({ action, url: "http://localhost:3000", tabId: "default" } as import("@mendcode/tools").BrowserInput, new AbortController().signal)).toMatchObject({ ok: false, error: "Browser tab control is local only" })
  }
  expect(sessionMetaTool.permissionFor?.({ action: "link_pr" })).toBe("execute")
})

test("regeneration uses a bounded transcript and cannot replace an intervening rename", async () => {
  const h = await boot()
  await h.client.send({ type: "user.submit", sessionId: h.id, text: "build the feature", attachments: [] })
  await until(() => h.daemon.store.lastTurnStatus(h.id) === "completed")
  let finish!: (value: string) => void
  let prompt = ""
  const service = createSessionMetadata({ store: h.daemon.store, settings: () => ({}), model: () => ({ model: "fake-title" }), complete: async (request) => { prompt = request.prompt; return new Promise((resolve) => { finish = resolve }) } })
  const pending = service.regenerate(h.id)
  expect(prompt).toContain("build the feature")
  await h.client.send({ type: "session.rename", sessionId: h.id, title: "manual wins" })
  finish("Generated title")
  expect(await pending).toBe(false)
  expect(h.daemon.store.sessionInfo(h.id)?.title).toBe("manual wins")
  const next = service.regenerate(h.id)
  finish("Generated title")
  expect(await next).toBe(true)
  service.stop()
})

test("a generated title drops the Markdown a model copied from a message that opens with a heading", () => {
  expect(cleanTitle("# MISIÓN CIENTÍFICA: CERRO AZUL")).toBe("MISIÓN CIENTÍFICA: CERRO AZUL")
  expect(cleanTitle("<think>x</think>\n## **Fix login bug**\nmore")).toBe("Fix login bug")
  expect(cleanTitle("\"Refactor auth\"")).toBe("Refactor auth")
  expect(cleanTitle("C# migration plan")).toBe("C# migration plan")
})
