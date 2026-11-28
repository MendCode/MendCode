import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import type { EnginePort } from "@mendcode/kernel"
import type { SessionEvent, SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { remoteTokens } from "../src/remote"
import { canonical } from "../src/sync/ingest"

/**
 * A chat running on the hub for a device (docs/sync.md, "Running on the hub"): its events reach the device as the hub stores them,
 * the device acts on its queue, and what it does while the hub is away waits and goes out when the link is back. Two daemons in this
 * process on temp data dirs; a TCP relay between them can be cut, paused or made to look like an older hub.
 */
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })
const tempDir = (label: string) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `mend-live-${label}-`)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 8_000) {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error(`timed out: ${what}`)
    await Bun.sleep(10)
  }
}

const STREAM_DELTAS = 30
const STREAM_GAP_MS = 30
/** "stream": many deltas at a steady pace; "wait": runs until cancelled; anything else echoes. */
const engine = () => ({
  async runTurn(input: { text: string; signal: AbortSignal; newItemId(): string; emit(event: unknown): void }) {
    const itemId = input.newItemId()
    input.emit({ type: "item.started", itemId, kind: "agent_message" })
    if (input.text.startsWith("stream")) {
      for (let i = 0; i < STREAM_DELTAS; i++) { input.emit({ type: "item.delta", itemId, text: `w${i} ` }); await Bun.sleep(STREAM_GAP_MS) }
    } else if (input.text.startsWith("wait")) {
      await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }))
    }
    input.emit({ type: "item.completed", itemId, status: "ok", text: `re: ${input.text}` })
    return { status: "ok" }
  },
  needsCompaction: () => false,
  compact: async () => ({ status: "ok" }),
}) as unknown as EnginePort

type Relay = { port: number; cut(): void; pause(): void; resume(): void; olderHub(): void }
/** A TCP relay in front of the hub: `cut` drops every connection, `pause` also refuses new ones, `olderHub` hides the `tail` op like a build that lacks it. */
function relay(target: number): Relay {
  let paused = false
  let older = false
  const open = new Set<{ end(): void }>()
  type Writable = { write(data: Uint8Array): number; end(): void }
  type Side = { up?: Writable; early: Uint8Array[] }
  // A socket that is full takes part of a write: the rest waits here until it drains, so a burst of large frames arrives whole.
  const backlog = new WeakMap<object, Uint8Array[]>()
  const flush = (to: Writable) => {
    const queue = backlog.get(to)
    while (queue?.length) {
      const head = queue[0]!
      const taken = to.write(head)
      if (taken < head.length) { queue[0] = head.subarray(Math.max(taken, 0)); return }
      queue.shift()
    }
  }
  const send = (to: Writable, data: Uint8Array) => {
    const queue = backlog.get(to) ?? []
    backlog.set(to, queue)
    queue.push(data)
    flush(to)
  }
  const server = Bun.listen<Side>({
    hostname: "127.0.0.1", port: 0,
    socket: {
      async open(socket) {
        socket.data = { early: [] }
        if (paused) { socket.end(); return }
        open.add(socket)
        const up = await Bun.connect({ hostname: "127.0.0.1", port: target, socket: { data(_up, data) { send(socket, new Uint8Array(data)) }, drain(up) { flush(up) }, close() { socket.end() }, error() {} } })
        open.add(up)
        socket.data.up = up
        for (const chunk of socket.data.early.splice(0)) send(up, chunk)
      },
      drain(socket) { flush(socket) },
      data(socket, data) {
        const bytes = older ? Buffer.from(Buffer.from(data).toString("utf8").replaceAll('"op":"tail"', '"op":"tailx"')) : new Uint8Array(data)
        if (socket.data.up) send(socket.data.up, bytes)
        else socket.data.early.push(bytes)
      },
      close(socket) { open.delete(socket); socket.data.up?.end() },
      error() {},
    },
  })
  cleanups.push(() => server.stop(true))
  return {
    port: server.port,
    cut: () => { for (const socket of [...open]) socket.end(); open.clear() },
    pause() { paused = true; this.cut() },
    resume() { paused = false },
    olderHub() { older = true },
  }
}

async function boot(dir: string, extra: Partial<Parameters<typeof startDaemon>[0]> = {}) {
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "d.sock"), log: () => {}, engine, ...extra })
  const seen: SessionEvent[] = []
  const stamps = new Map<number, number>()
  const client = createClient({ socketPath: daemon.socketPath, name: "test", reconnect: false, timeoutMs: 10_000, onEvent: (event) => { seen.push(event); if (event.type === "item.delta") stamps.set(event.seq, performance.now()) } })
  await client.connect()
  let stopped = false
  cleanups.push(async () => { if (stopped) return; stopped = true; client.close(); await daemon.stop() })
  return { dir, daemon, client, seen, stamps }
}
type Node = Awaited<ReturnType<typeof boot>>

const events = (node: Node, sessionId: SessionId): SessionEvent[] => {
  const out: SessionEvent[] = []
  for (;;) {
    const page = node.daemon.store.readExactAfter(sessionId, out.at(-1)?.seq ?? 0, 1000)
    if (!page.length) return out
    out.push(...page)
  }
}
const turnsDone = (node: Node, sessionId: SessionId) => events(node, sessionId).filter((event) => event.type === "turn.completed" || event.type === "turn.cancelled").length
/** The same events with the project folder left out: the device knows the hub's folder under its own path. */
const bare = (list: SessionEvent[]) => list.map((event) => canonical(event.type === "session.created" ? { ...event, directory: "" } : event))

/** A hub with a project only it has, a device with a run token that reaches it through the relay, and a chat both know. */
async function pair() {
  const hubFolder = path.join(tempDir("hubroot"), "app")
  mkdirSync(hubFolder, { recursive: true })
  const hubDir = tempDir("hub")
  const hub = await boot(hubDir, { listen: "127.0.0.1:0", sync: { leaseMs: 60_000 } })
  const link = relay(hub.daemon.remotePort!)
  const seed = (await hub.client.send({ type: "session.create", directory: hubFolder }) as unknown as { result: { sessionId: SessionId } }).result.sessionId
  await hub.client.send({ type: "user.submit", sessionId: seed, text: "first", attachments: [] })
  await until(() => turnsDone(hub, seed) === 1, "the seed turn")
  const here = path.join(tempDir("deviceroot"), "app")
  const deviceDir = tempDir("device")
  const token = remoteTokens(hubDir).create({ name: "laptop", sync: true, run: true }).token
  mkdirSync(path.join(deviceDir, "remote"), { recursive: true })
  writeFileSync(path.join(deviceDir, "remote", "hub.sync-token"), `${token}\n`, { mode: 0o600 })
  writeFileSync(path.join(deviceDir, "remotes.json"), JSON.stringify({ remotes: { hub: { connect: `127.0.0.1:${link.port}` } } }), { mode: 0o600 })
  writeFileSync(path.join(deviceDir, "sync.json"), JSON.stringify({ remote: "hub", tokenFile: path.join(deviceDir, "remote", "hub.sync-token"), pathMap: [{ from: here, to: hubFolder }] }), { mode: 0o600 })
  const device = await boot(deviceDir, { sync: { tickMs: 600_000, leaseMs: 60_000, idleReleaseMs: 600_000 } })
  expect(await device.client.send({ type: "sync.control", input: { action: "now" } } as never)).toMatchObject({ ok: true })
  expect(await device.client.subscribe(seed, events(device, seed).at(-1)?.seq ?? 0)).toMatchObject({ ok: true })
  return { hub, device, link, seed }
}
const submit = (node: Node, sessionId: SessionId, text: string) => node.client.send({ type: "user.submit", sessionId, text, attachments: [] })
const deviceStatus = async (device: Node) => {
  const reply = await device.client.send({ type: "sync.control", input: { action: "status" } } as never)
  if (!reply.ok) throw new Error(JSON.stringify(reply))
  return reply.result as { held?: number; live?: string; connected: boolean }
}
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))]!

async function streamed(hub: Node, device: Node, seed: SessionId) {
  await hub.client.subscribe(seed, events(hub, seed).at(-1)?.seq ?? 0)
  expect(await submit(device, seed, "stream")).toMatchObject({ ok: true })
  await until(() => turnsDone(device, seed) === 2 && turnsDone(hub, seed) === 2, "the streamed turn reached the device")
}

test("a chat running on the hub streams to the device as the hub stores it, in order and without a gap", async () => {
  const { hub, device, seed } = await pair()
  await streamed(hub, device, seed)
  // The store has the turn a moment before the screen's subscriber has its last word.
  await until(() => device.stamps.size === STREAM_DELTAS, "every word reached the device's subscriber")
  expect(bare(events(device, seed))).toEqual(bare(events(hub, seed)))
  const seqs = [...device.stamps.keys()]
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
  expect(device.stamps.size).toBe(STREAM_DELTAS)
  // The hub writes a word every 30 ms; the device has each within a polling tick of it (300 ms), mostly far less.
  const delays = seqs.map((seq) => device.stamps.get(seq)! - (hub.stamps.get(seq) ?? NaN))
  expect(delays.every(Number.isFinite)).toBe(true)
  expect(percentile(delays, 0.5)).toBeLessThan(100)
  expect(Math.max(...delays)).toBeLessThan(300)
}, 30_000)

test("with the live tail in place, nothing polls faster than the safety round and an idle hub costs the device no live connection", async () => {
  const { hub, device, seed } = await pair()
  // The terminal holding the chat open follows it by push; once it lets go, an idle hub costs no connection.
  await until(async () => (await deviceStatus(device)).live === "pushed", "the open chat is followed by push")
  await device.client.send({ type: "client.unsubscribe", sessionId: seed })
  await device.client.send({ type: "sync.control", input: { action: "now" } } as never)
  await until(async () => (await deviceStatus(device)).live === undefined, "the device stops following a chat nobody holds open")
  expect(await submit(device, seed, "wait here")).toMatchObject({ ok: true })
  await until(async () => (await deviceStatus(device)).live === "pushed", "the device follows the chat by push")
  const started = events(device, seed).filter((event) => event.type === "turn.started").at(-1) as Extract<SessionEvent, { type: "turn.started" }>
  expect(await device.client.send({ type: "turn.cancel", sessionId: seed, turnId: started.turnId })).toMatchObject({ ok: true })
  await until(() => events(hub, seed).some((event) => event.type === "turn.cancelled"), "the cancel ran on the hub")
  await until(async () => (await deviceStatus(device)).live === undefined, "the device stops following once the turn ended")
}, 30_000)

test("a chat opened on the device while the hub runs a turn is brought up to date at once, not at the next polling round", async () => {
  const { hub, device, seed } = await pair()
  await device.client.send({ type: "client.unsubscribe", sessionId: seed })
  await device.client.send({ type: "sync.control", input: { action: "now" } } as never)
  // Someone else starts a turn on the hub; the device's round is ten minutes away.
  await hub.client.subscribe(seed, events(hub, seed).at(-1)?.seq ?? 0)
  expect(await submit(hub, seed, "stream")).toMatchObject({ ok: true })
  await until(() => events(hub, seed).filter((event) => event.type === "item.delta").length >= 6, "the hub streams")
  expect(events(device, seed).filter((event) => event.type === "item.delta").length).toBe(0)
  const before = performance.now()
  expect(await device.client.subscribe(seed, events(device, seed).at(-1)?.seq ?? 0)).toMatchObject({ ok: true })
  await until(() => device.stamps.size >= 6, "the open chat caught up")
  expect(performance.now() - before).toBeLessThan(1_000)
  // And it goes on by push while it stays open.
  await until(() => turnsDone(device, seed) === 2 && turnsDone(hub, seed) === 2, "the turn reached the open chat")
  expect(bare(events(device, seed))).toEqual(bare(events(hub, seed)))
}, 30_000)

test("a hub without the tail op is followed by polling and the chat still arrives whole", async () => {
  const { hub, device, link, seed } = await pair()
  link.olderHub()
  await streamed(hub, device, seed)
  expect(bare(events(device, seed))).toEqual(bare(events(hub, seed)))
  expect(await deviceStatus(device)).not.toHaveProperty("live")
}, 30_000)

test("a cut link in the middle of a stream is picked up again: every event arrives once and in order", async () => {
  const { hub, device, link, seed } = await pair()
  await hub.client.subscribe(seed, events(hub, seed).at(-1)?.seq ?? 0)
  expect(await submit(device, seed, "stream")).toMatchObject({ ok: true })
  await until(() => device.stamps.size >= 8, "the stream started")
  link.cut()
  await until(() => turnsDone(device, seed) === 2 && turnsDone(hub, seed) === 2, "the turn finished after the cut")
  expect(bare(events(device, seed))).toEqual(bare(events(hub, seed)))
  const seqs = events(device, seed).map((event) => event.seq)
  expect(new Set(seqs).size).toBe(seqs.length)
}, 30_000)

test("the queue of a hub chat is acted on from the device: edit, move, steer, drop and send now run on the hub", async () => {
  const { hub, device, seed } = await pair()
  expect(await submit(device, seed, "wait for it")).toMatchObject({ ok: true })
  await until(() => hub.daemon.store.lastTurnStatus(seed) === "running", "the turn runs on the hub")
  for (const text of ["one", "two", "three", "four"]) expect(await submit(device, seed, text)).toMatchObject({ ok: true })
  await until(() => hub.daemon.store.queueOf(seed).length === 4, "four queued on the hub")
  const queued = () => hub.daemon.store.queueOf(seed)
  const [one, two, three, four] = queued().map((entry) => entry.queueId)

  expect(await device.client.send({ type: "queue.edit", sessionId: seed, queueId: one!, text: "uno" })).toMatchObject({ ok: true })
  expect(queued().map((entry) => entry.text)).toEqual(["uno", "two", "three", "four"])

  expect(await device.client.send({ type: "queue.reorder", sessionId: seed, queueId: four!, to: "top" })).toMatchObject({ ok: true, result: { position: 0 } })
  expect(queued().map((entry) => entry.text)[0]).toBe("four")

  expect(await device.client.send({ type: "queue.remove", sessionId: seed, queueId: two! })).toMatchObject({ ok: true })
  expect(queued().map((entry) => entry.text)).toEqual(["four", "uno", "three"])

  expect(await device.client.send({ type: "queue.steer", sessionId: seed, queueId: three! })).toMatchObject({ ok: true })

  // Send now interrupts the waiting turn and starts that message next.
  expect(await device.client.send({ type: "queue.promote", sessionId: seed, queueId: one! })).toMatchObject({ ok: true })
  await until(() => events(hub, seed).some((event) => event.type === "turn.cancelled" || event.type === "turn.interrupted"), "send now stopped the waiting turn on the hub")
  // What the device shows is what the hub has.
  await until(() => bare(events(device, seed)).length === bare(events(hub, seed)).length, "the device caught up")
}, 30_000)

test("an action taken while the hub is away waits and goes out, in order, when the link is back", async () => {
  const { hub, device, link, seed } = await pair()
  expect(await submit(device, seed, "wait for it")).toMatchObject({ ok: true })
  await until(() => hub.daemon.store.lastTurnStatus(seed) === "running", "the turn runs on the hub")
  const started = events(device, seed).filter((event) => event.type === "turn.started").at(-1) as Extract<SessionEvent, { type: "turn.started" }>

  link.pause()
  const queuedWhileAway = await submit(device, seed, "after the gap")
  expect(queuedWhileAway).toMatchObject({ ok: true, result: { held: true } })
  const cancel = await device.client.send({ type: "turn.cancel", sessionId: seed, turnId: started.turnId })
  expect(cancel).toMatchObject({ ok: true, result: { held: true } })
  expect((await deviceStatus(device)).held).toBe(2)
  expect(hub.daemon.store.lastTurnStatus(seed)).toBe("running")

  link.resume()
  const resumedAt = Date.now()
  await until(() => events(hub, seed).some((event) => event.type === "turn.cancelled"), "the held cancel reached the hub")
  // The device looks for the hub again within a couple of seconds, not after a long back-off.
  expect(Date.now() - resumedAt).toBeLessThan(4_000)
  await until(() => events(hub, seed).some((event) => event.type === "queue.added" && event.text === "after the gap"), "the held prompt reached the hub")
  await until(async () => (await deviceStatus(device)).held === undefined, "nothing is held any more")
  // Sent in the order given: the prompt first, then the cancel of the turn that was running.
  const types = events(hub, seed).map((event) => event.type)
  expect(types.lastIndexOf("queue.added")).toBeLessThan(types.lastIndexOf("turn.cancelled"))
}, 30_000)

test("a new chat is not held while the hub is away: it is refused saying the hub is not connected", async () => {
  const { device, link } = await pair()
  link.pause()
  const here = (await device.client.send({ type: "session.list", limit: 5 } as never) as unknown as { result: { sessions: Array<{ directory: string }> } }).result.sessions[0]!.directory
  const created = await device.client.send({ type: "session.create", directory: here, reuseEmpty: true })
  expect(created).toMatchObject({ ok: false, error: { code: "forbidden", message: expect.stringContaining("hub is not connected") } })
}, 30_000)

test("an attachment staged while the prompt is written is already on the hub when the prompt goes, and a local chat stages nothing", async () => {
  const { hub, device, seed } = await pair()
  const bytes = new Uint8Array(900 * 1024)
  for (let at = 0; at < bytes.length; at++) bytes[at] = (at * 2654435761) >>> 24
  const ref = device.daemon.store.putBlob(bytes, "image/png")
  expect(hub.daemon.store.blobPath(ref.sha256) && (await Bun.file(hub.daemon.store.blobPath(ref.sha256)).exists())).toBe(false)
  expect(await device.client.send({ type: "attachment.stage", sessionId: seed, attachment: ref })).toMatchObject({ ok: true, result: { staged: true } })
  expect(Buffer.from(hub.daemon.store.readBlob(ref.sha256)).equals(Buffer.from(bytes))).toBe(true)
  const local = (await device.client.send({ type: "session.create", directory: tempDir("local") }) as unknown as { result: { sessionId: SessionId } }).result.sessionId
  expect(await device.client.send({ type: "attachment.stage", sessionId: local, attachment: ref })).toMatchObject({ ok: true, result: { staged: false } })
  // Sending the prompt finds it there: nothing more to copy.
  expect(await device.client.send({ type: "user.submit", sessionId: seed, text: "see this", attachments: [ref] })).toMatchObject({ ok: true })
  await until(() => events(hub, seed).some((event) => event.type === "queue.added" && event.text === "see this"), "the prompt reached the hub")
}, 30_000)

test("a PNG over 2048 pixels goes to the hub as a smaller PNG and the prompt names that copy; this machine keeps the original", async () => {
  const { encodeImagePng } = await import("../../tools/src/pet-png")
  const { decodePng } = await import("../../tools/src/pet-decode")
  const { hub, device, seed } = await pair()
  const width = 3000
  const height = 1900
  const rgba = new Uint8Array(width * height * 4)
  let state = 7
  for (let at = 0; at < rgba.length; at += 4) {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    rgba.set([(at / 4) % 251, ((at / 4) >> 8) & 255, (state >> 16) & 63, 255], at)
  }
  const original = encodeImagePng({ width, height, rgba })
  const ref = device.daemon.store.putBlob(original, "image/png")
  expect(await device.client.send({ type: "attachment.stage", sessionId: seed, attachment: ref })).toMatchObject({ ok: true, result: { staged: true } })
  expect(await Bun.file(hub.daemon.store.blobPath(ref.sha256)).exists()).toBe(false)
  expect(await device.client.send({ type: "user.submit", sessionId: seed, text: "see this", attachments: [ref] })).toMatchObject({ ok: true })
  await until(() => events(hub, seed).some((event) => event.type === "queue.added" && event.text === "see this"), "the prompt reached the hub")
  const added = events(hub, seed).find((event) => event.type === "queue.added" && event.text === "see this") as unknown as { attachments: Array<{ sha256: string; bytes: number }> }
  const sent = added.attachments[0]! as { sha256: string; bytes: number; mime: string }
  expect(sent.sha256).not.toBe(ref.sha256)
  expect(sent.bytes).toBeLessThan(ref.bytes)
  expect(hub.daemon.store.readBlob(sent.sha256).length).toBe(sent.bytes)
  // Noise is photograph-like: a JPEG where macOS writes one, else a smaller PNG.
  if (sent.mime === "image/png") {
    const onHub = decodePng(hub.daemon.store.readBlob(sent.sha256))
    expect(Math.max(onHub.width, onHub.height)).toBe(2048)
  } else expect(sent.mime).toBe("image/jpeg")
  expect(device.daemon.store.readBlob(ref.sha256).length).toBe(original.length)
}, 60_000)
