import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createIdFactory } from "@mendcode/protocol"
import type { EnginePort } from "@mendcode/kernel"
import type { SessionEvent, SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { remoteTokens } from "../src/remote"
import { canonical } from "../src/sync/ingest"

/**
 * Session sync between two daemons in this process, each on its own temp data dir: a hub with a loopback listener and a device
 * whose sync.json names it. No real host, model or user daemon is touched; the engine is a scripted echo.
 */
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })
const tempDir = (label: string) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `mend-sync-${label}-`)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 5_000) {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error(`timed out: ${what}`)
    await Bun.sleep(10)
  }
}

const echo = () => ({
  async runTurn(input: { text: string; newItemId(): string; emit(event: unknown): void }) {
    const itemId = input.newItemId()
    input.emit({ type: "item.started", itemId, kind: "agent_message" })
    input.emit({ type: "item.delta", itemId, text: "re: " })
    input.emit({ type: "item.completed", itemId, status: "ok", text: `re: ${input.text}` })
    return { status: "ok" }
  },
  needsCompaction: () => false,
  compact: async () => ({ status: "ok" }),
}) as unknown as EnginePort

type Daemon = Awaited<ReturnType<typeof startDaemon>>
type Client = ReturnType<typeof createClient>

async function boot(dir: string, extra: Partial<Parameters<typeof startDaemon>[0]> = {}) {
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "d.sock"), log: () => {}, engine: echo, ...extra })
  const client = createClient({ socketPath: daemon.socketPath, name: "test", reconnect: false, timeoutMs: 10_000 })
  await client.connect()
  let stopped = false
  const stop = async () => { if (stopped) return; stopped = true; client.close(); await daemon.stop() }
  cleanups.push(stop)
  return { dir, daemon, client, stop }
}

const LEASE_MS = 1_500
async function startHub() {
  const dir = tempDir("hub")
  return boot(dir, { listen: "127.0.0.1:0", sync: { leaseMs: LEASE_MS } })
}
/** A device paired with `hub` through a sync-scoped token; rounds run only when the test asks (`sync now`). */
function pairDevice(hubDir: string, port: number, name = "laptop", connect?: string, options: { run?: boolean; pathMap?: Array<{ from: string; to: string }> } = {}) {
  const dir = tempDir("device")
  const token = remoteTokens(hubDir).create({ name, sync: true, ...(options.run ? { run: true } : {}) }).token
  mkdirSync(path.join(dir, "remote"), { recursive: true })
  writeFileSync(path.join(dir, "remote", "hub.sync-token"), `${token}\n`, { mode: 0o600 })
  writeFileSync(path.join(dir, "remotes.json"), JSON.stringify({ remotes: { hub: { connect: connect ?? `127.0.0.1:${port}` } } }), { mode: 0o600 })
  writeFileSync(path.join(dir, "sync.json"), JSON.stringify({ remote: "hub", tokenFile: path.join(dir, "remote", "hub.sync-token"), ...(options.pathMap ? { pathMap: options.pathMap } : {}) }), { mode: 0o600 })
  return { dir, token }
}
const startDevice = (dir: string) => boot(dir, { sync: { tickMs: 600_000, leaseMs: LEASE_MS, idleReleaseMs: 600_000 } })

async function newSession(client: Client, directory: string) {
  const created = await client.send({ type: "session.create", directory })
  if (!created.ok) throw new Error(`session.create failed: ${JSON.stringify(created)}`)
  return created.result!.sessionId as SessionId
}
const events = (daemon: Daemon, sessionId: SessionId): SessionEvent[] => {
  const out: SessionEvent[] = []
  for (;;) {
    const page = daemon.store.readExactAfter(sessionId, out.at(-1)?.seq ?? 0, 1000)
    if (!page.length) return out
    out.push(...page)
  }
}
const turnsDone = (daemon: Daemon, sessionId: SessionId) => events(daemon, sessionId).filter((event) => event.type === "turn.completed").length
async function turn(node: { daemon: Daemon; client: Client }, sessionId: SessionId, text: string) {
  const before = turnsDone(node.daemon, sessionId)
  const sent = await node.client.send({ type: "user.submit", sessionId, text, attachments: [] })
  if (!sent.ok) return sent
  await until(() => turnsDone(node.daemon, sessionId) > before && node.daemon.store.lastTurnStatus(sessionId) !== "running" && !node.daemon.store.queueOf(sessionId).length, `turn "${text}"`)
  return sent
}
const syncNow = async (client: Client) => {
  const reply = await client.send({ type: "sync.control", input: { action: "now" } } as never)
  if (!reply.ok) throw new Error(`sync now failed: ${JSON.stringify(reply)}`)
  return reply.result as { sessions: Array<{ sessionId: string; owner: string; state: string; note?: string }> }
}
const control = (client: Client, action: string, sessionId: SessionId) => client.send({ type: "sync.control", input: { action, sessionId } } as never)
/** What both machines must agree on: every event, field for field (directories mapped to this machine's). */
const same = (a: SessionEvent[], b: SessionEvent[]) => expect(a.map(canonical)).toEqual(b.map(canonical))
const userTexts = (list: SessionEvent[]) => list.flatMap((event) => event.type === "queue.added" ? [event.text] : [])

test("a sync token sends only hello and sync.peer; a read-only token cannot sync; sync.control is local only", async () => {
  const hub = await startHub()
  const tokens = remoteTokens(hub.dir)
  const sync = createClient({ name: "dev", remote: { hostname: "127.0.0.1", port: hub.daemon.remotePort!, token: tokens.create({ name: "dev", sync: true }).token }, reconnect: false })
  const watch = createClient({ name: "watch", remote: { hostname: "127.0.0.1", port: hub.daemon.remotePort!, token: tokens.create({ name: "watch", readOnly: true }).token }, reconnect: false })
  const full = createClient({ name: "full", remote: { hostname: "127.0.0.1", port: hub.daemon.remotePort!, token: tokens.create({ name: "full" }).token }, reconnect: false })
  for (const client of [sync, watch, full]) { await client.connect(); cleanups.push(() => client.close()) }
  expect(tokens.list().find((entry) => entry.name === "dev")).toMatchObject({ scope: "sync", readOnly: false })
  expect(() => tokens.create({ name: "both", sync: true, readOnly: true })).toThrow()

  expect(await sync.send({ type: "sync.peer", input: { op: "hello" } } as never)).toMatchObject({ ok: true, result: { hub: true } })
  expect(await sync.send({ type: "session.list", limit: 5 })).toMatchObject({ ok: false, error: { code: "forbidden", message: expect.stringContaining("sync token") } })
  expect(await sync.send({ type: "settings.get" } as never)).toMatchObject({ ok: false, error: { code: "forbidden" } })
  expect(await sync.send({ type: "sync.control", input: { action: "status" } } as never)).toMatchObject({ ok: false, error: { code: "forbidden" } })
  expect(await watch.send({ type: "sync.peer", input: { op: "hello" } } as never)).toMatchObject({ ok: false, error: { code: "forbidden" } })
  expect(await full.send({ type: "sync.control", input: { action: "status" } } as never)).toMatchObject({ ok: false, error: { code: "forbidden" } })
  // Only preference settings sync: an authority or machine setting is refused on the hub, whoever sends it.
  expect(await sync.send({ type: "sync.peer", input: { op: "settings-put", patch: { permission: { bash: "allow" } } } } as never)).toMatchObject({ ok: false, error: { code: "forbidden" } })
  expect(await sync.send({ type: "sync.peer", input: { op: "settings-put", patch: { remoteEngines: ["acp"] } } } as never)).toMatchObject({ ok: false, error: { code: "forbidden" } })
  expect(await hub.client.send({ type: "sync.control", input: { action: "status" } } as never)).toMatchObject({ ok: true, result: { mode: "hub" } })
})

test("a device mirrors the hub's settled turns at the hub's seqs, refuses to write them and names the hub", async () => {
  const hub = await startHub()
  const project = tempDir("project")
  const id = await newSession(hub.client, project)
  await turn(hub, id, "first")
  await turn(hub, id, "second")
  const device = await startDevice(pairDevice(hub.dir, hub.daemon.remotePort!).dir)
  const status = await syncNow(device.client)
  expect(status.sessions).toEqual([expect.objectContaining({ sessionId: id, owner: "hub", state: "ok" })])
  same(events(device.daemon, id), events(hub.daemon, id))
  expect(device.daemon.store.sessionDirectory(id)).toBe(project)

  // Read-only here: a turn is refused with the hub's name and the way to take it over.
  const refused = await device.client.send({ type: "user.submit", sessionId: id, text: "here", attachments: [] })
  const why = refused.ok ? "" : refused.error.message
  expect(refused.ok).toBe(false)
  expect(why).toContain("owned by hub")
  expect(why).toContain(`mendcode sync take ${id}`)
  expect(events(device.daemon, id).length).toBe(events(hub.daemon, id).length)

  // A new turn on the hub arrives with the next round; a second round adds nothing (no duplicate).
  await turn(hub, id, "third")
  await syncNow(device.client)
  await syncNow(device.client)
  same(events(device.daemon, id), events(hub.daemon, id))
  expect(userTexts(events(device.daemon, id))).toEqual(["first", "second", "third"])
  // Usage statistics stay with the machine that ran the turns.
  const db = new Database(path.join(device.dir, "mendd.db"), { readonly: true })
  try { expect(db.query("SELECT coalesce(sum(prompts), 0) AS n FROM usage_activity").get()).toMatchObject({ n: 0 }) } finally { db.close() }

  // Metadata three ways: a pin made here goes to the hub; a rename on the hub comes here.
  device.daemon.store.setSessionPinned(id, true)
  expect(await hub.client.send({ type: "session.rename", sessionId: id, title: "Renamed on the hub" })).toMatchObject({ ok: true })
  await syncNow(device.client)
  expect(hub.daemon.store.sessionPinnedAt(id)).toBeNumber()
  expect(device.daemon.store.sessionInfo(id)?.title).toBe("Renamed on the hub")
})

test("a session's permission mode never travels: a mirrored or pushed session.permission event is stored but changes nothing on the receiving machine", async () => {
  const hub = await startHub()
  const project = tempDir("project")
  const id = await newSession(hub.client, project)
  expect(await hub.client.send({ type: "session.permission.set", sessionId: id, mode: "full" } as never)).toMatchObject({ ok: true })
  await turn(hub, id, "first")
  expect(hub.daemon.store.permissionModeOf(id)).toBe("full")
  const device = await startDevice(pairDevice(hub.dir, hub.daemon.remotePort!).dir)
  await syncNow(device.client)
  expect(events(device.daemon, id).some((event) => event.type === "session.permission" && event.mode === "full")).toBe(true)
  expect(device.daemon.store.permissionModeOf(id)).toBe("ask")
})

test("take: the device writes the session and the hub refuses its own writes naming the device; release hands it back with nothing lost or doubled", async () => {
  const hub = await startHub()
  const project = tempDir("project")
  const id = await newSession(hub.client, project)
  await turn(hub, id, "on the hub")
  const device = await startDevice(pairDevice(hub.dir, hub.daemon.remotePort!).dir)
  await syncNow(device.client)

  expect(await control(device.client, "take", id)).toMatchObject({ ok: true, result: { owner: "this machine" } })
  await turn(device, id, "on the laptop")
  const blocked = await hub.client.send({ type: "user.submit", sessionId: id, text: "hub again", attachments: [] })
  expect(blocked).toMatchObject({ ok: false, error: { code: "forbidden", message: expect.stringContaining("being written on laptop") } })
  // A second device cannot take what the first holds.
  const other = createClient({ name: "other", remote: { hostname: "127.0.0.1", port: hub.daemon.remotePort!, token: remoteTokens(hub.dir).create({ name: "desktop", sync: true }).token }, reconnect: false })
  await other.connect()
  cleanups.push(() => other.close())
  expect(await other.send({ type: "sync.peer", input: { op: "lease", action: "acquire", sessionId: id } } as never)).toMatchObject({ ok: false, error: { code: "busy", message: expect.stringContaining("held by laptop") } })

  await syncNow(device.client)
  same(events(hub.daemon, id), events(device.daemon, id))
  expect(await control(device.client, "release", id)).toMatchObject({ ok: true, result: { owner: "hub" } })
  await turn(hub, id, "hub again")
  await syncNow(device.client)
  same(events(device.daemon, id), events(hub.daemon, id))
  expect(userTexts(events(hub.daemon, id))).toEqual(["on the hub", "on the laptop", "hub again"])
  const seqs = events(hub.daemon, id).map((event) => event.seq)
  expect(new Set(seqs).size).toBe(seqs.length)
  expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)
})

test("a resent push is an exact retry (stored once); a stale base is a conflict; a push without the lease is refused", async () => {
  const hub = await startHub()
  const project = tempDir("project")
  const id = await newSession(hub.client, project)
  await turn(hub, id, "one")
  const paired = pairDevice(hub.dir, hub.daemon.remotePort!)
  const device = await startDevice(paired.dir)
  await syncNow(device.client)
  await control(device.client, "take", id)
  const base = hub.daemon.store.lastSeq(id) ?? 0
  await turn(device, id, "two")
  const tail = events(device.daemon, id).filter((event) => event.seq > base)
  const raw = createClient({ name: "raw", remote: { hostname: "127.0.0.1", port: hub.daemon.remotePort!, token: paired.token }, reconnect: false })
  await raw.connect()
  cleanups.push(() => raw.close())
  const syncDb = new Database(path.join(paired.dir, "mendd.db"), { readonly: true })
  const epoch = syncDb.query<{ epoch: number }, [string]>("SELECT epoch FROM sync_sessions WHERE session_id = ?").get(id)!.epoch
  syncDb.close()
  const push = (input: Record<string, unknown>) => raw.send({ type: "sync.peer", input: { op: "push", sessionId: id, epoch, lastSeq: tail.at(-1)!.seq, events: tail, ...input } } as never)
  expect(await push({ base })).toMatchObject({ ok: true, result: { stored: tail.length } })
  const stored = events(hub.daemon, id).length
  expect(await push({ base })).toMatchObject({ ok: true, result: { stored: 0 } })
  expect(events(hub.daemon, id).length).toBe(stored)
  // Seqs that do not rise, or a base the hub never had, are refused before anything is written.
  expect(await push({ base: tail.at(-1)!.seq, events: [...tail].reverse() })).toMatchObject({ ok: false })
  expect(await push({ base: tail.at(-1)!.seq + 5 })).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
  expect(await push({ base, epoch: 99 })).toMatchObject({ ok: false, error: { code: "forbidden" } })
  expect(events(hub.daemon, id).length).toBe(stored)
  same(events(hub.daemon, id), events(device.daemon, id))
})

test("a dead device's lease ends: the hub writes again, the device's late turn is fenced off and kept apart, nothing interleaves", async () => {
  const hub = await startHub()
  const project = tempDir("project")
  const id = await newSession(hub.client, project)
  await turn(hub, id, "before")
  const { dir } = pairDevice(hub.dir, hub.daemon.remotePort!)
  let device = await startDevice(dir)
  await syncNow(device.client)
  await control(device.client, "take", id)
  await turn(device, id, "unsent")
  await device.stop()

  // The lease runs out with nobody renewing it; the hub owns the session again.
  await until(async () => (await turn(hub, id, "after")).ok, "the hub writes after the lease ends", LEASE_MS * 4)
  expect(userTexts(events(hub.daemon, id))).toEqual(["before", "after"])

  // The device comes back: its lease ran out, so it starts no new turn and its late events never reach the hub.
  device = await startDevice(dir)
  expect(await device.client.send({ type: "user.submit", sessionId: id, text: "more", attachments: [] })).toMatchObject({ ok: false, error: { code: "forbidden", message: expect.stringContaining("lease") } })
  const status = await syncNow(device.client)
  expect(status.sessions.find((session) => session.sessionId === id)).toMatchObject({ state: "diverged", owner: "this machine only" })
  expect(userTexts(events(hub.daemon, id))).toEqual(["before", "after"])
  expect(userTexts(events(device.daemon, id))).toEqual(["before", "unsent"])
  // Kept apart, the copy is this machine's own again: it can continue here.
  expect((await turn(device, id, "more")).ok).toBe(true)
})

test("a lease lost with nothing unsent turns the copy back into a mirror", async () => {
  const hub = await startHub()
  const project = tempDir("project")
  const id = await newSession(hub.client, project)
  await turn(hub, id, "a")
  const { dir } = pairDevice(hub.dir, hub.daemon.remotePort!)
  let device = await startDevice(dir)
  await syncNow(device.client)
  await control(device.client, "take", id)
  await device.stop()
  await until(async () => (await turn(hub, id, "b")).ok, "lease end", LEASE_MS * 4)
  device = await startDevice(dir)
  const status = await syncNow(device.client)
  expect(status.sessions.find((session) => session.sessionId === id)).toMatchObject({ state: "ok", owner: "hub" })
  await syncNow(device.client)
  same(events(device.daemon, id), events(hub.daemon, id))
})

test("handoff: a session made on the device moves to the hub's clone of the same git remote, at the same path inside it", async () => {
  const hub = await startHub()
  const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, env: { PATH: process.env.PATH ?? "", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" } })
  const repo = (label: string, remote: string) => {
    const top = tempDir(label)
    git(top, "init", "-q")
    git(top, "remote", "add", "origin", remote)
    mkdirSync(path.join(top, "pkg", "app"), { recursive: true })
    return top
  }
  const hubRepo = repo("hub-clone", "https://example.invalid/org/repo.git")
  const deviceRepo = repo("device-clone", "git@example.invalid:Org/Repo.git")
  // The hub knows its clone through one of its own sessions there.
  const known = await newSession(hub.client, hubRepo)
  await turn(hub, known, "hub work")
  const device = await startDevice(pairDevice(hub.dir, hub.daemon.remotePort!).dir)
  await syncNow(device.client)
  const id = await newSession(device.client, path.join(deviceRepo, "pkg", "app"))
  await turn(device, id, "made here")
  expect(await control(device.client, "handoff", id)).toMatchObject({ ok: true, result: { owner: "hub" } })
  expect(hub.daemon.store.sessionDirectory(id)).toBe(path.join(hubRepo, "pkg", "app"))
  expect(userTexts(events(hub.daemon, id))).toEqual(["made here"])
  // The device keeps a mirror and the hub owns it now.
  expect(await device.client.send({ type: "user.submit", sessionId: id, text: "x", attachments: [] })).toMatchObject({ ok: false, error: { code: "forbidden" } })
  expect((await turn(hub, id, "continued on the hub")).ok).toBe(true)
  await syncNow(device.client)
  expect(userTexts(events(device.daemon, id))).toEqual(["made here", "continued on the hub"])
  expect(device.daemon.store.sessionDirectory(id)).toBe(path.join(deviceRepo, "pkg", "app"))
})

test("attachments copy in chunks; one over 8 MiB stays on the hub with a note; a long history arrives page by page", async () => {
  const hub = await startHub()
  const project = tempDir("project")
  const id = await newSession(hub.client, project)
  const small = hub.daemon.store.putBlob(new Uint8Array(300 * 1024).map((_, i) => i % 251), "application/octet-stream")
  const large = hub.daemon.store.putBlob(new Uint8Array(9 * 1024 * 1024).fill(7), "application/octet-stream")
  expect((await hub.client.send({ type: "user.submit", sessionId: id, text: "files", attachments: [small, large] })).ok).toBe(true)
  await until(() => turnsDone(hub.daemon, id) === 1 && hub.daemon.store.lastTurnStatus(id) !== "running", "turn with files")
  for (let i = 0; i < 40; i++) await turn(hub, id, `turn ${i}`)
  const device = await startDevice(pairDevice(hub.dir, hub.daemon.remotePort!).dir)
  let status = await syncNow(device.client)
  for (let round = 0; round < 20 && (device.daemon.store.lastSeq(id) ?? 0) < (hub.daemon.store.lastSeq(id) ?? 0); round++) status = await syncNow(device.client)
  same(events(device.daemon, id), events(hub.daemon, id))
  expect(Buffer.from(device.daemon.store.readBlob(small.sha256))).toEqual(Buffer.from(hub.daemon.store.readBlob(small.sha256)))
  expect(() => device.daemon.store.readBlob(large.sha256)).toThrow()
  expect(status.sessions.find((session) => session.sessionId === id)?.note).toContain("over 8 MiB")
})

test("an attachment of exactly the size limit finishes over several rounds instead of restarting each one", async () => {
  const hub = await startHub()
  const project = tempDir("project")
  const id = await newSession(hub.client, project)
  const limit = hub.daemon.store.putBlob(new Uint8Array(8 * 1024 * 1024).map((_, i) => i % 249), "application/octet-stream")
  expect((await hub.client.send({ type: "user.submit", sessionId: id, text: "files", attachments: [limit] })).ok).toBe(true)
  await until(() => turnsDone(hub.daemon, id) === 1 && hub.daemon.store.lastTurnStatus(id) !== "running", "turn with the file")
  const device = await startDevice(pairDevice(hub.dir, hub.daemon.remotePort!).dir)
  for (let round = 0; round < 8 && (device.daemon.store.lastSeq(id) ?? 0) < (hub.daemon.store.lastSeq(id) ?? 0); round++) await syncNow(device.client)
  same(events(device.daemon, id), events(hub.daemon, id))
  expect(Buffer.from(device.daemon.store.readBlob(limit.sha256))).toEqual(Buffer.from(hub.daemon.store.readBlob(limit.sha256)))
})

test("a turn longer than one history page cannot be pushed whole: the copy is marked as staying on this machine instead of retrying forever", async () => {
  const hub = await startHub()
  const project = tempDir("project")
  const id = await newSession(hub.client, project)
  await turn(hub, id, "on the hub")
  const big = (() => ({
    async runTurn(input: { text: string; newItemId(): string; emit(event: unknown): void }) {
      for (let part = 0; part < 4; part++) {
        const itemId = input.newItemId()
        input.emit({ type: "item.started", itemId, kind: "agent_message" })
        input.emit({ type: "item.completed", itemId, status: "ok", text: "x".repeat(60_000) })
      }
      return { status: "ok" }
    },
    needsCompaction: () => false,
    compact: async () => ({ status: "ok" }),
  }) as unknown as EnginePort)
  const device = await boot(pairDevice(hub.dir, hub.daemon.remotePort!).dir, { engine: big, sync: { tickMs: 600_000, leaseMs: LEASE_MS, idleReleaseMs: 600_000 } })
  await syncNow(device.client)
  expect(await control(device.client, "take", id)).toMatchObject({ ok: true })
  await turn(device, id, "a long one")
  const status = await syncNow(device.client)
  expect(status.sessions.find((session) => session.sessionId === id)).toMatchObject({ state: "unsyncable", note: expect.stringContaining("too large to copy") })
  expect(await control(device.client, "release", id)).toMatchObject({ ok: false, error: { message: expect.stringContaining("too large to copy") } })
})

test("a title or pin changed here on a mirrored session reaches the hub even when the hub changes nothing", async () => {
  const hub = await startHub()
  const project = tempDir("project")
  const id = await newSession(hub.client, project)
  await turn(hub, id, "on the hub")
  const device = await startDevice(pairDevice(hub.dir, hub.daemon.remotePort!).dir)
  await syncNow(device.client)
  await syncNow(device.client)
  device.daemon.store.renameSession(id, "renamed on the laptop")
  device.daemon.store.setSessionPinned(id, true)
  await syncNow(device.client)
  expect(hub.daemon.store.sessionInfo(id)?.title).toBe("renamed on the laptop")
  expect(hub.daemon.store.sessionPinnedAt(id)).toBeDefined()
})

test("memories and preference settings sync both ways; deletes travel; credentials, tokens and authority or machine settings never reach the wire", async () => {
  const hub = await startHub()
  const SECRETS = ["sk-device-provider-SECRET-1", "hub-channel-SECRET-2", "device-permission-SECRET-3", "device-shell-SECRET-4", "device-env-SECRET-5"]
  writeFileSync(path.join(hub.dir, "channels.json"), JSON.stringify({ telegram: { token: SECRETS[1] } }), { mode: 0o600 })
  // Everything between the two daemons goes through this relay, which keeps every byte.
  const seen: Buffer[] = []
  const relay = Bun.listen<{ upstream?: import("bun").Socket<undefined>; queue: Buffer[] }>({
    hostname: "127.0.0.1", port: 0,
    socket: {
      open(socket) {
        socket.data = { queue: [] }
        void Bun.connect({ hostname: "127.0.0.1", port: hub.daemon.remotePort!, socket: { data(_, data) { seen.push(Buffer.from(data)); socket.write(data) }, close() { socket.end() } } }).then((upstream) => {
          socket.data.upstream = upstream
          for (const chunk of socket.data.queue.splice(0)) upstream.write(chunk)
        })
      },
      data(socket, data) { seen.push(Buffer.from(data)); if (socket.data.upstream) socket.data.upstream.write(data); else socket.data.queue.push(Buffer.from(data)) },
      close(socket) { socket.data.upstream?.end() },
    },
  })
  cleanups.push(() => relay.stop(true))
  const paired = pairDevice(hub.dir, hub.daemon.remotePort!, "laptop", `127.0.0.1:${relay.port}`)
  writeFileSync(path.join(paired.dir, "providers.json"), JSON.stringify({ providers: [{ id: "x", type: "openai", apiKey: SECRETS[0] }] }), { mode: 0o600 })
  const device = await startDevice(paired.dir)
  expect(await device.client.send({ type: "settings.set", patch: { language: "es", shellCommandPrefix: SECRETS[3], defaultAgent: SECRETS[2] } } as never)).toMatchObject({ ok: true })
  writeFileSync(path.join(paired.dir, "environment.enc"), SECRETS[4]!, { mode: 0o600 })
  const remembered = await device.client.send({ type: "memory.add", scope: "user", text: "prefers short answers", category: "preferences" } as never)
  expect(remembered.ok).toBe(true)
  expect(await hub.client.send({ type: "memory.add", scope: "user", text: "deploys from the hub", category: "workflow" } as never)).toMatchObject({ ok: true })
  await syncNow(device.client)
  await syncNow(device.client)
  const texts = (node: { daemon: Daemon }) => node.daemon.store.memories.list({}).map((memory) => memory.text).sort()
  expect(texts(hub)).toEqual(["deploys from the hub", "prefers short answers"])
  expect(texts(device)).toEqual(["deploys from the hub", "prefers short answers"])
  expect((hub.daemon.store.settings.get() as Record<string, unknown>).language).toBe("es")
  expect((hub.daemon.store.settings.get() as Record<string, unknown>).shellCommandPrefix).toBeUndefined()
  expect((hub.daemon.store.settings.get() as Record<string, unknown>).defaultAgent).toBeUndefined()

  // A delete on the hub reaches the device as a tombstone.
  const hubMemory = hub.daemon.store.memories.list({}).find((memory) => memory.text === "deploys from the hub")!
  expect(await hub.client.send({ type: "memory.delete", memoryId: hubMemory.memoryId } as never)).toMatchObject({ ok: true })
  await syncNow(device.client)
  expect(texts(device)).toEqual(["prefers short answers"])

  const wire = Buffer.concat(seen).toString("latin1")
  expect(wire).toContain("prefers short answers")
  for (const secret of SECRETS) expect(wire.includes(secret), secret).toBe(false)
  for (const file of ["remote-tokens.json"]) expect(wire.includes(file)).toBe(false)
  for (const entry of remoteTokens(hub.dir).list()) expect(wire.includes(`"hash"`) && wire.includes(entry.name + "\",\"hash")).toBe(false)
})

test("random interleavings of turns, takes, releases and device restarts never lose, double or reorder an event", async () => {
  const done = { hubTurns: 0, deviceTurns: 0, refused: 0, moves: 0, restarts: 0 }
  for (const seed of [7, 19, 42]) {
    let state = seed
    const random = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648
    const hub = await startHub()
    const project = tempDir("project")
    const id = await newSession(hub.client, project)
    const { dir } = pairDevice(hub.dir, hub.daemon.remotePort!)
    let device = await startDevice(dir)
    await syncNow(device.client)
    let held = false
    const sent: string[] = []
    for (let step = 0; step < 30; step++) {
      const pick = random()
      if (pick < 0.4) {
        // Either machine may try; only the one that owns the session at that moment may write it.
        const onDevice = random() < 0.5
        const text = `s${seed}-${step}`
        const reply = await turn(onDevice ? device : hub, id, text)
        if (reply.ok) { sent.push(text); done[onDevice ? "deviceTurns" : "hubTurns"]++ } else done.refused++
        expect(reply.ok).toBe(onDevice === held)
      } else if (pick < 0.6) {
        const reply = await control(device.client, held ? "release" : "take", id)
        if (reply.ok) { held = !held; done.moves++ }
      } else if (pick < 0.7) {
        await device.stop()
        device = await startDevice(dir)
        done.restarts++
      } else await syncNow(device.client)
    }
    if (held) expect(await control(device.client, "release", id)).toMatchObject({ ok: true })
    await syncNow(device.client)
    const hubEvents = events(hub.daemon, id)
    expect(userTexts(hubEvents)).toEqual(sent)
    same(events(device.daemon, id), hubEvents)
    const seqs = hubEvents.map((event) => event.seq)
    expect(new Set(seqs).size).toBe(seqs.length)
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)
    for (const fn of cleanups.splice(0).reverse()) await fn()
  }
  for (const count of Object.values(done)) expect(count).toBeGreaterThan(0)
}, 60_000)

test("without sync.json nothing of sync exists: no tables, no triggers, no hub file", async () => {
  const node = await boot(tempDir("plain"))
  const project = tempDir("project")
  const id = await newSession(node.client, project)
  await turn(node, id, "hello")
  await node.client.send({ type: "memory.add", scope: "user", text: "a fact", category: "preferences" } as never)
  const db = new Database(path.join(node.dir, "mendd.db"), { readonly: true })
  try { expect(db.query("SELECT name FROM sqlite_master WHERE name LIKE 'sync_%'").all()).toEqual([]) } finally { db.close() }
  expect(await Bun.file(path.join(node.dir, "sync-hub.json")).exists()).toBe(false)
  expect(await node.client.send({ type: "sync.control", input: { action: "status" } } as never)).toMatchObject({ ok: true, result: { mode: "off" } })
})

/** An engine that asks for an approval on "ask …" and waits for a cancel on "wait …"; every other prompt is echoed. */
const scripted = () => ({
  ...echo(),
  async runTurn(input: { text: string; signal: AbortSignal; newItemId(): string; emit(event: unknown): void; ask(request: unknown): Promise<{ kind: string }> }) {
    const itemId = input.newItemId()
    input.emit({ type: "item.started", itemId, kind: "agent_message" })
    if (input.text.startsWith("wait")) {
      await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }))
      input.emit({ type: "item.completed", itemId, status: "ok", text: "stopped" })
      return { status: "ok" }
    }
    const answer = input.text.startsWith("ask") ? (await input.ask({ kind: "approval", title: "run it", detail: "echo hi", tool: "bash", permission: "execute" })).kind : "none"
    input.emit({ type: "item.completed", itemId, status: "ok", text: `re: ${input.text} (${answer})` })
    return { status: "ok" }
  },
}) as unknown as EnginePort

/** A hub whose project exists only there, and a device that knows it under a path that does not exist on this machine. */
async function runPair(options: { run: boolean }) {
  const hubFolder = path.join(tempDir("hubroot"), "app")
  mkdirSync(hubFolder, { recursive: true })
  const hub = await boot(tempDir("hub"), { listen: "127.0.0.1:0", sync: { leaseMs: LEASE_MS }, engine: scripted })
  const seed = await newSession(hub.client, hubFolder)
  await turn(hub, seed, "first")
  const here = path.join(tempDir("deviceroot"), "app")
  const device = await startDevice(pairDevice(hub.dir, hub.daemon.remotePort!, "laptop", undefined, { run: options.run, pathMap: [{ from: here, to: hubFolder }] }).dir)
  await syncNow(device.client)
  return { hub, device, here, hubFolder, seed }
}
/** The same events with the project folder left out: a device knows the hub's folder under its own path. */
const sameElsewhere = (a: SessionEvent[], b: SessionEvent[]) => { const bare = (list: SessionEvent[]) => list.map((event) => canonical(event.type === "session.created" ? { ...event, directory: "" } : event)); expect(bare(a)).toEqual(bare(b)) }
const hubLast = (hub: { daemon: Daemon }, id: SessionId) => events(hub.daemon, id)
const texts = (list: SessionEvent[]) => list.flatMap((event) => event.type === "item.completed" && event.text ? [event.text] : [])

test("a device with a run token starts a chat in the hub's folder, the hub runs it, and the turn streams back through the mirror", async () => {
  const { hub, device, here } = await runPair({ run: true })
  const created = await device.client.send({ type: "session.create", directory: here, reuseEmpty: true })
  expect(created).toMatchObject({ ok: true })
  const id = (created as unknown as { result: { sessionId: SessionId } }).result.sessionId
  // The chat exists on the hub (it owns it), is a mirror here, and no chat was made in the missing local folder.
  expect(hub.daemon.store.hasSession(id)).toBe(true)
  expect(device.daemon.store.hasSession(id)).toBe(true)
  expect(device.daemon.store.sessionDirectory(id)).toBe(here)
  expect(hub.daemon.store.sessionDirectory(id)).not.toBe(here)
  // A chat a device starts begins in the hub's run-token mode (edits by default), whatever the hub's own default is; the hub can change it.
  expect(hub.daemon.store.permissionModeOf(id)).toBe("edits")
  expect(await hub.client.send({ type: "settings.set", patch: { syncRunPermission: "full" } } as never)).toMatchObject({ ok: true })
  const second = await device.client.send({ type: "session.create", directory: here, reuseEmpty: true })
  expect(hub.daemon.store.permissionModeOf((second as unknown as { result: { sessionId: SessionId } }).result.sessionId)).toBe("full")
  const sent = await device.client.send({ type: "user.submit", sessionId: id, text: "hello hub", attachments: [] })
  expect(sent).toMatchObject({ ok: true })
  await until(() => turnsDone(hub.daemon, id) === 1, "the turn ran on the hub", 3_000)
  await until(() => texts(events(device.daemon, id)).includes("re: hello hub (none)"), "the reply reached the device")
  sameElsewhere(events(device.daemon, id), hubLast(hub, id))
  // The device wrote nothing of its own: its usage statistics stay empty, the hub's engine ran the turn.
  expect(userTexts(events(hub.daemon, id))).toEqual(["hello hub"])
})

test("a prompt to a mirrored hub chat runs on the hub; its approval is answered from the device and a running turn is cancelled from it", async () => {
  const { hub, device, seed } = await runPair({ run: true })
  expect(await device.client.send({ type: "user.submit", sessionId: seed, text: "ask first", attachments: [] })).toMatchObject({ ok: true })
  await until(() => events(device.daemon, seed).some((event) => event.type === "server.request"), "the approval reached the device")
  const request = events(device.daemon, seed).find((event) => event.type === "server.request") as Extract<SessionEvent, { type: "server.request" }>
  expect(turnsDone(hub.daemon, seed)).toBe(1)
  expect(await device.client.send({ type: "request.resolve", sessionId: seed, requestId: request.requestId, decision: { kind: "approve", scope: "once" } })).toMatchObject({ ok: true })
  await until(() => texts(events(device.daemon, seed)).includes("re: ask first (approve)"), "the approved turn finished and came back")
  sameElsewhere(events(device.daemon, seed), hubLast(hub, seed))

  expect(await device.client.send({ type: "user.submit", sessionId: seed, text: "wait forever", attachments: [] })).toMatchObject({ ok: true })
  await until(() => events(device.daemon, seed).some((event) => event.type === "turn.started" && hub.daemon.store.lastTurnStatus(seed) === "running"), "the second turn runs")
  const started = events(device.daemon, seed).filter((event) => event.type === "turn.started").at(-1) as Extract<SessionEvent, { type: "turn.started" }>
  expect(await device.client.send({ type: "turn.cancel", sessionId: seed, turnId: started.turnId })).toMatchObject({ ok: true })
  await until(() => hub.daemon.store.lastTurnStatus(seed) !== "running" && device.daemon.store.lastTurnStatus(seed) !== "running", "the cancel ended the turn on both")
  expect(events(hub.daemon, seed).some((event) => event.type === "turn.cancelled")).toBe(true)
  sameElsewhere(events(device.daemon, seed), hubLast(hub, seed))
})

test("a plain sync token cannot run anything on the hub: the refusal names the hub and the way to allow it", async () => {
  const { hub, device, here, seed } = await runPair({ run: false })
  const created = await device.client.send({ type: "session.create", directory: here, reuseEmpty: true })
  expect(created).toMatchObject({ ok: false, error: { code: "forbidden", message: expect.stringContaining("--sync --run") } })
  const refused = await device.client.send({ type: "user.submit", sessionId: seed, text: "here", attachments: [] })
  expect(refused).toMatchObject({ ok: false, error: { message: expect.stringContaining("owned by hub") } })
  expect(turnsDone(hub.daemon, seed)).toBe(1)
})

test("a run token runs turns and nothing else: no shell, files, settings, permission changes, sub-agents, attachments or folders outside the hub's projects", async () => {
  const hub = await boot(tempDir("hub"), { listen: "127.0.0.1:0", sync: { leaseMs: LEASE_MS }, engine: scripted })
  const folder = tempDir("project")
  const id = await newSession(hub.client, folder)
  const token = remoteTokens(hub.dir).create({ name: "runner", sync: true, run: true }).token
  const peer = createClient({ name: "runner", remote: { hostname: "127.0.0.1", port: hub.daemon.remotePort!, token }, reconnect: false })
  await peer.connect()
  cleanups.push(() => peer.close())
  const refused = (message: string) => ({ ok: false, error: { code: "forbidden", message: expect.stringContaining(message) } })
  expect(await peer.send({ type: "settings.get" } as never)).toMatchObject(refused("--sync --run"))
  expect(await peer.send({ type: "session.permission.set", sessionId: id, mode: "full" } as never)).toMatchObject(refused("--sync --run"))
  expect(await peer.send({ type: "session.list", limit: 5 })).toMatchObject(refused("--sync --run"))
  expect(await peer.send({ type: "session.create", directory: folder, parentId: id })).toMatchObject(refused("no parent"))
  expect(await peer.send({ type: "session.create", directory: folder, agent: "build" })).toMatchObject(refused("no parent"))
  expect(await peer.send({ type: "session.create", directory: tempDir("elsewhere") })).toMatchObject(refused("not a project"))
  expect(await peer.send({ type: "session.create", directory: path.join(folder, "missing") })).toMatchObject(refused("not a project"))
  expect(await peer.send({ type: "user.submit", sessionId: id, text: "x", attachments: [{ sha256: "a".repeat(64), bytes: 1, mime: "text/plain" }] } as never)).toMatchObject(refused("text only"))
  expect(await peer.send({ type: "user.submit", sessionId: "ses_01M8C6XPXJAV89A3" as SessionId, text: "x", attachments: [] })).toMatchObject(refused("no such chat"))
  expect(await peer.send({ type: "request.resolve", sessionId: id, requestId: createIdFactory()("request"), decision: { kind: "approve", scope: "once", remember: { level: "user" } } } as never)).toMatchObject(refused("cannot save rules"))
  // What it may do: start a chat in a known folder, prompt it, and the hub's own turn runs.
  const made = await peer.send({ type: "session.create", directory: folder })
  expect(made).toMatchObject({ ok: true })
  const mine = (made as unknown as { result: { sessionId: SessionId } }).result.sessionId
  expect(await peer.send({ type: "user.submit", sessionId: mine, text: "run", attachments: [] })).toMatchObject({ ok: true })
  await until(() => turnsDone(hub.daemon, mine) === 1, "the hub ran the prompt")
})

test("with the hub unreachable, a chat in the hub's folder is refused saying the hub is not connected", async () => {
  const { hub, device, here } = await runPair({ run: true })
  await hub.stop()
  const created = await device.client.send({ type: "session.create", directory: here, reuseEmpty: true })
  expect(created).toMatchObject({ ok: false, error: { code: "forbidden", message: expect.stringContaining("hub is not connected") } })
})
