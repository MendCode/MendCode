import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { stat } from "node:fs/promises"
import path from "node:path"
import { MAX_SYNC_BLOB_CHUNK_BYTES, MAX_SYNC_UPLOAD_FILE_BYTES, type Command, SYNC_PAGE_BYTES, SYNC_PAGE_EVENTS, SYNC_TAIL_SESSIONS, type SessionEvent, type SessionId, type SyncPeerInput, type SyncProjectRef } from "@mendcode/protocol"
import type { SyncSessionRow, SyncState } from "@mendcode/store"
import { PORTABLE_SETTINGS } from "../config-bundle/classify"
import { hubLacksFolders } from "./run-peer"
import { blobRefs, canonical, settledPrefix, syncedMessages, SyncRefusal, withDirectory } from "./ingest"
import { applyMemory, memoryToWire } from "./memories"
import { createProjectIndex } from "./projects"
import { syncTarget, type SyncConfig } from "./config"
import type { SyncPorts } from "./index"

/** Requests one sync round may send: a large backlog drains over several rounds instead of holding the hub. */
const ROUND_REQUESTS = 64
/** Events of an unfinished turn held back at most (they wait until the turn ends); a longer turn is left out and noted. */
const MAX_CARRY_EVENTS = 20_000
const MAX_CARRY_BYTES = 16 * 1024 * 1024
/** Sessions untouched on the hub for longer are not copied here (they are still listed by `mendcode sync status`). */
const MIRROR_DAYS = 30
const MAX_BACKOFF_MS = 60_000
/** The longest wait between tries to reach the hub while a command is held or a chat runs there. */
const RECONNECT_MAX_MS = 2_000
/** Longest a following device waits before comparing its configuration with the hub again. */
const FOLLOW_SUMMARY_MAX = 300
/** Blobs whose download a round left unfinished keep their chunks for the next one (at most this many, 8 MiB each). */
const MAX_PARTIAL_BLOBS = 2

type Summary = { sessionId: SessionId; cseq: number; deleted?: true; title?: string; directory?: string; project?: SyncProjectRef; lastSeq?: number; createdAt?: number; updatedAt?: number; archived?: boolean; pinned?: boolean; busy?: boolean; lease?: { holder: string; epoch: number; until: number } }
/** Commands of a chat the hub owns that run there: the prompt, the cancel, an approval, and the queue's actions (send now, steer, drop, edit, move). */
export const HUB_COMMANDS: ReadonlySet<string> = new Set(["user.submit", "turn.cancel", "request.resolve", "queue.promote", "queue.steer", "queue.remove", "queue.edit", "queue.reorder"])
/** What the hub's `tail` answers: new events per session. */
type TailPage = { sessionId: SessionId; events: SessionEvent[]; hasMore: boolean; lastSeq: number }
/** Commands a device could not send because the hub was not reachable wait (bounded, for a limited time) and go out when it is back. */
const MAX_HELD = 32
const HELD_MAX_AGE_MS = 10 * 60_000
/** How long one `tail` waits on the hub for news, and how long a failed one waits before trying again (doubling). */
const TAIL_WAIT_MS = 20_000
const TAIL_RETRY_MS = 250
const TAIL_RETRY_MAX_MS = 5_000
/** A hub that does not know `tail` (an older build) is asked again after this long. */
const TAIL_UNSUPPORTED_MS = 10 * 60_000
type Meta = { title: string; archived: boolean; pinned: boolean }
class RoundDone extends Error {}
/** The hub could not be reached or did not answer: the round stops and backs off; nothing is marked. */
class TransportError extends Error {}
/** Errors that stop the whole round; anything else is about one session, which is noted and skipped. */
const roundError = (error: unknown) => error instanceof RoundDone || error instanceof TransportError

/**
 * The device side: mirrors the hub's sessions here, copies this machine's turns of the sessions it holds the lease of back to the
 * hub, and syncs memories and preference settings. One request at a time, a bounded number per round; nothing runs while the hub
 * is unreachable except a backed-off reconnect.
 */
export function createDevice(ports: SyncPorts, state: SyncState, config: SyncConfig) {
  const hub = config.remote
  const rows = new Map<string, SyncSessionRow>(state.sessions.list().map((row) => [row.sessionId, row]))
  const projects = createProjectIndex({ directories: () => ports.store.listSessions({ limit: 500, roots: true, archived: true }).map((session) => session.directory), rules: config.pathMap, now: ports.now })
  let client: { send(command: { type: "sync.peer"; input: SyncPeerInput }): Promise<{ ok: true; result?: Record<string, unknown> } | { ok: false; error: { code: string; message: string } }>; close(): void } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let round: Promise<void> | undefined
  let stopped = false
  let delay = ports.tickMs
  let budget = 0
  let rounds = 0
  const status = { connected: false, lastOkAt: 0, lastError: "" }
  const following = { at: 0, ok: true, summary: "", running: undefined as Promise<void> | undefined }
  /** Chats this machine started or prompted on the hub: their running turn is copied as it happens (not only once settled) until it ends. */
  const live = new Map<string, { directory: string; since: number; run?: true; watch?: true }>()
  const LIVE_TICK_MS = 300
  /** While the hub pushes a live chat's events, the polling round is only a safety net. */
  const LIVE_PUSHED_TICK_MS = 1_500
  const LIVE_FULL_ROUND_MS = 3_000
  let lastFull = 0
  let tailing: Promise<void> | undefined
  let tailClient: typeof client
  let tailHealthy = false
  let tailRetryAt = 0
  /** Ends the wait of the long poll in flight (the chat ended, or this daemon is stopping); the hub's side times out on its own. */
  let abortTail: (() => void) | undefined
  const held: Array<{ command: Command; at: number }> = []
  const uploaded = new Set<string>()
  const partials = new Map<string, Buffer[]>()

  /** A chat this machine runs on the hub (its turn is copied as it happens) is "hot"; one only on screen ("watch") rests between the hub's pushes. */
  const hot = () => { for (const entry of live.values()) if (entry.run) return true; return false }
  const liveTick = () => (tailHealthy && hot() ? LIVE_PUSHED_TICK_MS : hot() ? LIVE_TICK_MS : tailHealthy ? ports.tickMs : LIVE_PUSHED_TICK_MS)
  const save = (row: SyncSessionRow) => { rows.set(row.sessionId, row); state.sessions.put(row) }
  const drop = (sessionId: string) => { rows.delete(sessionId); state.sessions.delete(sessionId) }

  function guard(sessionId: SessionId, type: string): string | undefined {
    const row = rows.get(sessionId)
    if (!row || row.state !== "ok") return undefined
    if (row.role === "mirror") return `[SYNC]: this session is owned by ${hub}; continue it there, or take it here with \`mendcode sync take ${sessionId}\``
    if ((type === "queue.added" || type === "turn.started") && row.leaseUntil <= ports.now()) return `[SYNC]: this machine's lease on this session ran out (is ${hub} reachable?); it continues on ${hub}, or here once \`mendcode sync take ${sessionId}\` succeeds`
    row.activeAt = ports.now()
    return undefined
  }

  /** The folder is a project of the hub (missing here, known from the hub's mirrored chats): a chat started in it runs on the hub. */
  function remoteFolder(directory: string): boolean {
    if (existsSync(directory)) return false
    return ports.store.listSessions({ directory, limit: 50, roots: false, archived: true }).some((session) => rows.get(session.sessionId)?.role === "mirror")
  }
  /** Whether a command of a local client runs on the hub instead of here: a new chat in the hub's folder, or a prompt, cancel or approval for a chat the hub owns. */
  function routes(command: Command): boolean {
    if (command.type === "session.create") return !command.parentId && remoteFolder(command.directory)
    if (HUB_COMMANDS.has(command.type) || command.type === "session.cd" || command.type === "session.dirs") { const row = rows.get((command as { sessionId: SessionId }).sessionId); return row?.role === "mirror" && row.state === "ok" }
    return false
  }
  const folderRefusal = (name: string, what: string, error: { code: string; message: string }) => hubLacksFolders(error) ? `[SYNC]: ${name} refused ${what}: either this device's token was not made with \`remote token create --sync --run\`, or ${name} runs an older MendCode that does not know it yet (update ${name})` : error.message
  const unreachable = (what: string) => `[SYNC]: ${hub} is not connected, so ${what} cannot run there now; try again when it is back, or clone the project here`

  async function connect() {
    if (client) return
    const target = syncTarget(ports.dir, config)
    const { createClient } = await import("@mendcode/client")
    const next = createClient({ name: "sync", remote: target, reconnect: false, timeoutMs: 30_000, onConnection: (value) => { if (value === "closed" && client === next) client = undefined } })
    await next.connect()
    client = next as unknown as typeof client
    status.connected = true
  }
  async function call(input: SyncPeerInput, counted = true): Promise<Record<string, unknown>> {
    if (counted && budget-- <= 0) throw new RoundDone()
    let reply: Awaited<ReturnType<NonNullable<typeof client>["send"]>>
    try {
      await connect()
      reply = await client!.send({ type: "sync.peer", input })
    } catch (error) { throw new TransportError(error instanceof Error ? error.message : String(error)) }
    if (reply.ok) return reply.result ?? {}
    if (["unauthorized", "rate_limited", "protocol_version", "internal"].includes(reply.error.code)) throw new TransportError(`${hub}: ${reply.error.message}`)
    const code = reply.error.code === "target_mismatch" ? "conflict" : reply.error.code === "forbidden" || reply.error.code === "busy" ? reply.error.code : "invalid"
    throw new SyncRefusal(code, reply.error.message.replace(/^\[SYNC\]: /, ""))
  }

  /** Every local event of a session after `after`, in pages (bounded by the page size). */
  function localPage(sessionId: SessionId, after: number) {
    return ports.store.projectSync.sessionHistory(sessionId, after)
  }

  async function uploadBlobs(events: readonly SessionEvent[]) {
    for (const ref of blobRefs(events).copied) await putBlob(ref, true)
  }
  /** Sends one blob to the hub in chunks (the hub keeps it once whole and checked). A prompt's attachments are not counted against the round's requests. */
  async function putBlob(ref: { sha256: string; bytes: number; mime: string }, counted: boolean) {
    if (uploaded.has(ref.sha256)) return
    const bytes = ports.store.readBlob(ref.sha256)
    for (let offset = 0; offset < bytes.length; offset += MAX_SYNC_BLOB_CHUNK_BYTES) {
      const result = await call({ op: "blob-put", input: { sha256: ref.sha256, bytes: ref.bytes, mime: ref.mime, offset, data: Buffer.from(bytes.subarray(offset, offset + MAX_SYNC_BLOB_CHUNK_BYTES)).toString("base64") } }, counted)
      if (result.stored) break
    }
    uploaded.add(ref.sha256)
    if (uploaded.size > 4096) uploaded.delete(uploaded.values().next().value!)
  }
  /** The attachments of a prompt for a chat the hub runs: its images, PDFs and pasted text go to the hub first, so the prompt can name them there. */
  async function putAttachments(command: { type: string }) {
    if (command.type !== "user.submit") return
    for (const ref of (command as unknown as { attachments: Array<{ sha256: string; bytes: number; mime: string }> }).attachments) await putBlob(ref, false)
  }
  async function downloadBlobs(events: readonly SessionEvent[]) {
    const refs = blobRefs(events)
    for (const ref of refs.copied) {
      try { if (ports.store.readBlob(ref.sha256).length === ref.bytes) continue } catch {}
      // A blob of the size limit takes more requests than a round has left: what arrived stays, and the next round goes on from it.
      const chunks = partials.get(ref.sha256) ?? []
      partials.delete(ref.sha256)
      partials.set(ref.sha256, chunks)
      if (partials.size > MAX_PARTIAL_BLOBS) partials.delete(partials.keys().next().value!)
      for (let offset = chunks.reduce((sum, chunk) => sum + chunk.length, 0); ;) {
        const part = await call({ op: "blob-read", input: { sha256: ref.sha256, offset } }) as { data: string; done: boolean; mime: string }
        const chunk = Buffer.from(part.data, "base64")
        chunks.push(chunk)
        offset += chunk.length
        if (part.done || !chunk.length) break
      }
      partials.delete(ref.sha256)
      const bytes = Buffer.concat(chunks)
      if (bytes.length !== ref.bytes || createHash("sha256").update(bytes).digest("hex") !== ref.sha256) throw new SyncRefusal("invalid", `blob ${ref.sha256.slice(0, 12)} arrived damaged`)
      ports.store.putBlob(bytes, ref.mime)
    }
    return refs.skipped
  }

  /**
   * Pushes this machine's settled events of a session it holds the lease of. `create`: the session is new on the hub (a handoff);
   * its first page carries what the hub needs to make it. Returns false when nothing settled is waiting.
   */
  async function pushTail(row: SyncSessionRow, create: boolean): Promise<void> {
    const head = state.sessionHead(row.sessionId)!
    for (let first = create; ;) {
      if (head.last_seq <= row.remoteSeq && !first) return
      const page = localPage(row.sessionId, row.remoteSeq)!
      const count = settledPrefix(page.events)
      if (!count) {
        // Nothing runs here (syncOwned and move check), so a page that ends inside a turn means the turn is longer than one page, which the hub takes only whole.
        if (!page.hasMore) return
        const note = `one of its turns is too large to copy to ${hub}; this copy stays only here`
        save({ ...row, state: "unsyncable", note })
        throw new SyncRefusal("invalid", note)
      }
      const events = page.events.slice(0, count)
      await uploadBlobs(events)
      const complete = count === page.events.length && !page.hasMore
      const project = create ? await projects.ref(head.directory) : undefined
      const result = await call({
        op: "push", sessionId: row.sessionId, base: row.remoteSeq, epoch: row.epoch, lastSeq: complete ? head.last_seq : events.at(-1)!.seq,
        ...(create ? { create: { title: head.title, createdAt: head.created_at, directory: projects.toRemote(head.directory), ...(project ? { project } : {}) } } : {}),
        events: events as unknown as Array<Record<string, unknown>>,
      }) as { lastSeq: number; epoch: number }
      save({ ...row, remoteSeq: result.lastSeq, epoch: result.epoch, leaseUntil: ports.now() + ports.leaseMs })
      row = rows.get(row.sessionId)!
      first = false
      if (complete) return
    }
  }

  /** The lease was lost (it ran out while this machine was away, or the hub was written): keep going if nothing was missed, else keep this copy apart. */
  async function leaseLost(row: SyncSessionRow, why: string) {
    const head = state.sessionHead(row.sessionId)
    const unpushed = head !== undefined && head.last_seq > row.remoteSeq
    try {
      const taken = await call({ op: "lease", action: "acquire", sessionId: row.sessionId }) as { lease: { epoch: number; until: number }; lastSeq: number }
      if (taken.lastSeq === row.remoteSeq) return save({ ...row, epoch: taken.lease.epoch, leaseUntil: taken.lease.until })
      await call({ op: "lease", action: "release", sessionId: row.sessionId, epoch: taken.lease.epoch })
    } catch (error) { if (roundError(error)) throw error }
    if (!unpushed) return save({ ...row, role: "mirror", epoch: 0, leaseUntil: 0 })
    ports.log(`[SYNC]: session ${row.sessionId} diverged from ${hub}: ${why}`)
    save({ ...row, state: "diverged", note: `continued on ${hub} while this machine was away; this copy stays only here (${why})` })
  }

  async function syncOwned() {
    for (const row of [...rows.values()]) {
      if (row.role !== "owned" || row.state !== "ok") continue
      if (!ports.store.hasSession(row.sessionId)) {
        try { await call({ op: "lease", action: "release", sessionId: row.sessionId, epoch: row.epoch }) } catch (error) { if (roundError(error)) throw error }
        drop(row.sessionId)
        continue
      }
      try {
        if (!ports.busy(row.sessionId)) await pushTail(row, false)
        const current = rows.get(row.sessionId)!
        const head = state.sessionHead(row.sessionId)!
        const idle = !ports.busy(row.sessionId) && head.last_seq <= current.remoteSeq && ports.now() - current.activeAt > ports.idleReleaseMs
        if (idle) {
          await call({ op: "lease", action: "release", sessionId: row.sessionId, epoch: current.epoch })
          save({ ...current, role: "mirror", epoch: 0, leaseUntil: 0 })
        } else if (current.leaseUntil - ports.now() < ports.leaseMs / 2) {
          const renewed = await call({ op: "lease", action: "renew", sessionId: row.sessionId, epoch: current.epoch }) as { lease: { until: number } }
          save({ ...current, leaseUntil: renewed.lease.until })
        }
      } catch (error) {
        if (error instanceof SyncRefusal && (error.code === "forbidden" || error.code === "conflict")) await leaseLost(rows.get(row.sessionId)!, error.message)
        else if (roundError(error)) throw error
        else ports.log(`[SYNC]: session ${row.sessionId} not pushed: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`)
      }
    }
  }

  const metaOf = (head: { title: string; archived_at: number | null; pinned_at: number | null }): Meta => ({ title: head.title, archived: head.archived_at !== null, pinned: head.pinned_at !== null })
  /** Title, archive and pin, merged three ways: a field changed only here goes to the hub, anything else follows the hub. */
  async function mergeMeta(row: SyncSessionRow, remote: Meta) {
    const head = state.sessionHead(row.sessionId)
    if (!head) return row
    const local = metaOf(head)
    let seen: Partial<Meta> = {}
    try { seen = row.meta ? JSON.parse(row.meta) : {} } catch {}
    const ours: Partial<Meta> = {}
    for (const key of ["title", "archived", "pinned"] as const) {
      if (local[key] === remote[key]) continue
      if (seen[key] !== undefined && remote[key] === seen[key]) (ours as Record<string, unknown>)[key] = local[key]
      else if (key === "title") ports.store.renameSession(row.sessionId, remote.title)
      else if (key === "archived") ports.store.setSessionArchived(row.sessionId, remote.archived)
      else ports.store.setSessionPinned(row.sessionId, remote.pinned)
    }
    if (Object.keys(ours).length) await call({ op: "meta", sessionId: row.sessionId, ...ours })
    const next = { ...row, meta: JSON.stringify({ ...remote, ...ours }) }
    save(next)
    return next
  }

  /** Title, archive and pin changed here on a copy of the hub's session go to the hub without waiting for the hub to change it too. */
  async function pushLocalMeta() {
    for (const row of [...rows.values()]) {
      if (row.role !== "mirror" || row.state !== "ok" || !row.meta) continue
      const head = state.sessionHead(row.sessionId)
      if (!head) continue
      let seen: Partial<Meta> = {}
      try { seen = JSON.parse(row.meta) } catch { continue }
      const local = metaOf(head)
      const ours: Partial<Meta> = {}
      for (const key of ["title", "archived", "pinned"] as const) if (seen[key] !== undefined && local[key] !== seen[key]) (ours as Record<string, unknown>)[key] = local[key]
      if (!Object.keys(ours).length) continue
      try {
        await call({ op: "meta", sessionId: row.sessionId, ...ours })
        save({ ...row, meta: JSON.stringify({ ...seen, ...ours }) })
      } catch (error) {
        if (roundError(error)) throw error
        ports.log(`[SYNC]: session ${row.sessionId} title, archive or pin not sent: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`)
      }
    }
  }

  /** Copies the hub's settled new events of one session here. Returns false when the round's budget ran out before its end. */
  async function pull(summary: Summary, tail = false, pushed?: TailPage): Promise<number> {
    let row = rows.get(summary.sessionId)
    const exists = ports.store.hasSession(summary.sessionId)
    if (row && (row.role === "owned" || row.state !== "ok")) return 0
    // A session made on this machine is never overwritten by a copy.
    if (!row && exists) return 0
    if (!row && !tail && (summary.updatedAt ?? 0) < ports.now() - MIRROR_DAYS * 86_400_000) return 0
    // The hub's change feed says where the chat is on the hub, even when no event is new: the copy keeps that folder and the lists and the footer follow it.
    // (A live pull names the folder it guesses from this machine's side, so only the feed is authoritative.)
    if (row && row.role === "mirror" && !tail && summary.directory && row.hubDir !== summary.directory) {
      row = { ...row, hubDir: summary.directory }
      save(row)
      ports.changed(summary.sessionId)
    }
    let stored = 0
    let after = row?.remoteSeq ?? 0
    let carry: SessionEvent[] = []
    let carryBytes = 0
    let skippedBlobs = 0
    // The hub's push is the first page; what the polling round already copied meanwhile is not taken twice.
    let first = pushed ? { events: pushed.events.filter((event) => event.seq > after), hasMore: pushed.hasMore, lastSeq: pushed.lastSeq } : undefined
    for (;;) {
      if (after >= summary.lastSeq! && !carry.length) break
      const page = first ?? await call({ op: "history", sessionId: summary.sessionId, after: carry.at(-1)?.seq ?? after }) as { events: SessionEvent[]; hasMore: boolean; lastSeq: number }
      first = undefined
      for (const event of page.events) { carry.push(event); carryBytes += JSON.stringify(event).length }
      // `tail`: a chat running on the hub for this machine is copied as it runs, so its approvals and output show here at once.
      const count = tail ? carry.length : settledPrefix(carry)
      const complete = !page.hasMore && count === carry.length
      if (count) {
        const ready = carry.slice(0, count)
        const localDirs = new Map<string, string>()
        for (const directory of new Set(ready.flatMap((event) => event.type === "session.created" || event.type === "session.workspace.changed" ? [event.directory] : []))) {
          localDirs.set(directory, (await projects.resolve({ directory, ...(directory === summary.directory && summary.project ? { project: summary.project } : {}) })).directory)
        }
        const events = withDirectory(ready, (directory) => localDirs.get(directory) ?? directory)
        skippedBlobs += await downloadBlobs(events)
        const first = events[0]!
        const create = ports.store.hasSession(summary.sessionId) ? undefined : first.type === "session.created" ? { directory: first.directory, title: summary.title ?? first.title, createdAt: first.at } : undefined
        if (!create && !ports.store.hasSession(summary.sessionId)) throw new SyncRefusal("invalid", "the hub's history of this session does not start with its creation")
        const lastSeq = complete ? Math.max(page.lastSeq, events.at(-1)!.seq) : events.at(-1)!.seq
        const added = ports.store.projectSync.ingest({ sessionId: summary.sessionId, events, messages: syncedMessages(events), lastSeq, ...(create ? { create } : {}) })
        stored += added.length
        for (const event of added) ports.publish(event as SessionEvent)
        // A batch of streamed text changes nothing about the session's state: only other events refresh it.
        if (added.some((event) => event.type !== "item.delta")) {
          ports.release(summary.sessionId)
          ports.changed(summary.sessionId)
        }
        row = { ...(row ?? { sessionId: summary.sessionId, role: "mirror", epoch: 0, leaseUntil: 0, state: "ok", note: "", meta: "", activeAt: 0 }), remoteSeq: lastSeq, ...(!tail && summary.directory ? { hubDir: summary.directory } : {}) }
        if (skippedBlobs) row.note = `${skippedBlobs} attachment${skippedBlobs === 1 ? "" : "s"} over 8 MiB stay on ${hub}`
        save(row)
        after = lastSeq
        carry = carry.slice(count)
        carryBytes = carry.reduce((sum, event) => sum + JSON.stringify(event).length, 0)
      }
      if (carry.length > MAX_CARRY_EVENTS || carryBytes > MAX_CARRY_BYTES) {
        save({ ...(row ?? { sessionId: summary.sessionId, role: "mirror", remoteSeq: after, epoch: 0, leaseUntil: 0, meta: "", activeAt: 0 }), state: "unsyncable", note: "one of its turns is too large to copy" } as SyncSessionRow)
        return stored
      }
      if (!page.hasMore) break
    }
    if (row && summary.title !== undefined) await mergeMeta(row, { title: summary.title, archived: summary.archived === true, pinned: summary.pinned === true })
    return stored
  }

  /** Copies what the hub has written of the chats this machine runs there; a chat leaves the list once its turn has ended here. */
  async function pullLive() {
    for (const [sessionId, entry] of [...live]) {
      // A chat on a terminal's screen is followed while it is there; once no terminal holds it, it is followed like any other.
      if (entry.watch && !ports.watched?.(sessionId as SessionId)) {
        delete entry.watch
        if (!entry.run) { live.delete(sessionId); continue }
        entry.since = ports.now()
      }
      const stored = await pull({ sessionId: sessionId as SessionId, cseq: 0, directory: entry.directory, lastSeq: Number.MAX_SAFE_INTEGER }, true)
      const running = ports.store.hasSession(sessionId as SessionId) && (ports.store.lastTurnStatus(sessionId as SessionId) === "running" || ports.store.queueOf(sessionId as SessionId).length > 0)
      if (!stored && !running && ports.now() - entry.since > 2 * LIVE_TICK_MS) { if (entry.watch) delete entry.run; else live.delete(sessionId) }
    }
    if (!live.size) abortTail?.()
  }

  /** The hub's connection for the live tail: its own, so a wait for news never holds up a round or a command. */
  async function openTail() {
    const target = syncTarget(ports.dir, config)
    const { createClient } = await import("@mendcode/client")
    const next = createClient({ name: "sync-tail", remote: target, reconnect: false, timeoutMs: TAIL_WAIT_MS + 15_000, onConnection: (value) => { if (value === "closed" && tailClient === (next as unknown as typeof client)) tailClient = undefined } })
    await next.connect()
    tailClient = next as unknown as typeof client
    return tailClient!
  }
  /**
   * While a chat runs on the hub for this machine, a long poll on its own connection hands over the hub's new events as they are
   * stored, one round trip after the hub wrote them. A hub that does not know `tail` (an older build) or a failing connection
   * leaves the 300 ms polling round to do the work.
   */
  function startTail() {
    if (tailing || stopped || !live.size || ports.now() < tailRetryAt) return
    tailing = runTail().catch(() => {}).finally(() => {
      tailing = undefined
      tailHealthy = false
      try { tailClient?.close() } catch {}
      tailClient = undefined
    })
  }
  async function runTail() {
    for (let failures = 0; !stopped && live.size;) {
      const sessions = [...live.keys()].slice(0, SYNC_TAIL_SESSIONS).map((sessionId) => ({ sessionId: sessionId as SessionId, after: rows.get(sessionId)?.remoteSeq ?? 0 }))
      const before = sessions.reduce((sum, item) => sum + item.after, 0)
      let result: { sessions?: TailPage[] } | undefined
      try {
        const connection = tailClient ?? await openTail()
        // Connecting took long enough for the chat to end or this daemon to stop: no wait is started.
        if (stopped || !live.size) { connection.close(); return }
        tailHealthy = true
        const reply = await Promise.race([
          connection.send({ type: "sync.peer", input: { op: "tail", sessions, waitMs: TAIL_WAIT_MS } }),
          new Promise<never>((_, reject) => { abortTail = () => { abortTail = undefined; try { connection.close() } catch {} ; reject(new Error("stopped")) } }),
        ])
        if (!reply.ok && reply.error.code === "invalid_command") { tailHealthy = false; tailRetryAt = ports.now() + TAIL_UNSUPPORTED_MS; return }
        if (!reply.ok) throw new Error(reply.error.message)
        result = reply.result as { sessions?: TailPage[] }
      } catch {
        tailHealthy = false
        try { tailClient?.close() } catch {}
        tailClient = undefined
        if (stopped || !live.size) return
        await Bun.sleep(Math.min(TAIL_RETRY_MS * 2 ** failures++, TAIL_RETRY_MAX_MS))
        continue
      }
      failures = 0
      try {
        for (const page of result.sessions ?? []) {
          const entry = live.get(page.sessionId)
          if (entry) await exclusive(() => pull({ sessionId: page.sessionId, cseq: 0, directory: entry.directory, lastSeq: Number.MAX_SAFE_INTEGER }, true, page))
        }
      } catch (error) {
        if (!roundError(error)) ports.log(`[SYNC]: a live chat was not copied: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`)
        failures++
        await Bun.sleep(Math.min(TAIL_RETRY_MS * 2 ** failures, TAIL_RETRY_MAX_MS))
        continue
      }
      // Events the copy would not take (a chat kept apart) must not turn the wait into a busy loop.
      if (sessions.reduce((sum, item) => sum + (rows.get(item.sessionId)?.remoteSeq ?? 0), 0) === before && (result.sessions?.length ?? 0) > 0) await Bun.sleep(LIVE_TICK_MS)
    }
  }

  /** Where the one-time look for the hub's folder of copies made before it was kept has reached; undefined once nothing is missing. */
  let hubDirCursor: number | undefined = 0
  /**
   * A copy made before the hub's own folder was kept has none: the hub's change feed is read once from its start, only for the
   * folders, so the lists and the footer show it without the events being copied again.
   */
  async function backfillHubDirs() {
    while (hubDirCursor !== undefined) {
      if (![...rows.values()].some((row) => row.role === "mirror" && !row.hubDir)) { hubDirCursor = undefined; return }
      const page = await call({ op: "changes", after: hubDirCursor }) as { changes: Summary[]; cursor: number; hasMore: boolean }
      for (const change of page.changes) {
        const row = rows.get(change.sessionId)
        if (!change.deleted && change.directory && row?.role === "mirror" && !row.hubDir) {
          save({ ...row, hubDir: change.directory })
          // A terminal that listed the copy before this round shows the hub's folder at once.
          ports.changed(change.sessionId)
        }
      }
      if (!page.hasMore) { hubDirCursor = undefined; return }
      hubDirCursor = page.cursor
    }
  }

  async function pullChanges() {
    for (;;) {
      const after = Number(state.meta.get("session-cursor") ?? 0)
      const page = await call({ op: "changes", after }) as { changes: Summary[]; cursor: number; hasMore: boolean }
      for (const change of page.changes) {
        if (change.deleted) {
          const row = rows.get(change.sessionId)
          if (row?.role === "mirror" && !ports.busy(change.sessionId)) {
            if (ports.store.hasSession(change.sessionId)) ports.deleteSession(change.sessionId as SessionId)
            drop(change.sessionId)
          }
        } else {
          try { await pull(change) } catch (error) {
            if (roundError(error)) throw error
            const why = error instanceof Error ? error.message.replace(/^\[SYNC\]: /, "").slice(0, 300) : String(error)
            ports.log(`[SYNC]: session ${change.sessionId} not copied: ${why}`)
            const row = rows.get(change.sessionId)
            save({ ...(row ?? { sessionId: change.sessionId, role: "mirror", remoteSeq: 0, epoch: 0, leaseUntil: 0, meta: "", activeAt: 0 }), state: "unsyncable", note: why } as SyncSessionRow)
          }
        }
        state.meta.set("session-cursor", String(change.cseq))
      }
      if (!page.hasMore) return
    }
  }

  async function syncMemories() {
    for (;;) {
      const after = Number(state.meta.get("memory-cursor") ?? 0)
      const page = await call({ op: "memories", after }) as { rows: Parameters<typeof applyMemory>[1][]; cursor: number; hasMore: boolean }
      for (const row of page.rows) if (await applyMemory(state, row, projects, true)) state.forgetChange("memory", row.id)
      state.meta.set("memory-cursor", String(page.cursor))
      if (!page.hasMore) break
    }
    for (;;) {
      const after = Number(state.meta.get("memory-local-cursor") ?? 0)
      const changes = state.changes("memory", after, 200)
      if (!changes.length) return
      const wire = []
      for (const change of changes) { const row = await memoryToWire(state, change, projects); if (row) wire.push(row) }
      if (wire.length) await call({ op: "memories-put", rows: wire })
      state.meta.set("memory-local-cursor", String(changes.at(-1)!.cseq))
    }
  }

  /** Preference settings, per key and three ways like session metadata; on a conflict the hub's value wins. */
  async function syncSettings() {
    const remote = (await call({ op: "settings" }) as { values: Record<string, unknown> }).values
    const all = ports.store.settings.get() as Record<string, unknown>
    const local = Object.fromEntries(Object.entries(all).filter(([key]) => PORTABLE_SETTINGS.has(key)))
    let seen: Record<string, unknown> = {}
    try { seen = JSON.parse(state.meta.get("settings-seen") ?? "{}") } catch {}
    const push: Record<string, unknown> = {}
    const take: Record<string, unknown> = {}
    for (const key of new Set([...Object.keys(local), ...Object.keys(remote)])) {
      const [l, r, s] = [canonical(local[key]), canonical(remote[key]), canonical(seen[key])]
      if (l === r) continue
      if (r === s) push[key] = local[key] ?? null
      else take[key] = remote[key] ?? null
    }
    if (Object.keys(push).length) await call({ op: "settings-put", patch: push })
    if (Object.keys(take).length) await ports.applySettings(take)
    const now = ports.store.settings.get() as Record<string, unknown>
    state.meta.set("settings-seen", JSON.stringify(Object.fromEntries(Object.entries(now).filter(([key]) => PORTABLE_SETTINGS.has(key)))))
  }

  async function runRound() {
    budget = ROUND_REQUESTS
    rounds++
    try {
      await pullLive()
      // While a chat runs on the hub for this machine, rounds are quick and carry only that chat; the full round comes every few.
      await sendHeld()
      if (hot() && ports.now() - lastFull < LIVE_FULL_ROUND_MS) { delay = liveTick(); status.connected = true; status.lastOkAt = ports.now(); status.lastError = ""; return }
      lastFull = ports.now()
      await syncOwned()
      await pullChanges()
      await backfillHubDirs()
      await pushLocalMeta()
      if (config.memories) await syncMemories()
      if (config.settings && rounds % 6 === 1) await syncSettings()
      delay = live.size ? liveTick() : ports.tickMs
    } catch (error) {
      if (!(error instanceof RoundDone)) throw error
      delay = Math.min(ports.tickMs, 250)
    }
    status.connected = true
    status.lastOkAt = ports.now()
    status.lastError = ""
    void follow(false)
  }
  /**
   * With `follow` on, the hub is compared with this machine's portable configuration every `followMs` (and by `sync now`) and brought
   * level with what the owner's full token for the saved remote may do; never with the sync token. Off, this costs one boolean read per round.
   */
  function follow(force: boolean): Promise<void> {
    if (!config.follow || stopped) return Promise.resolve()
    if (following.running) return following.running
    if (!force && ports.now() - following.at < ports.followMs) return Promise.resolve()
    following.at = ports.now()
    following.running = ports.parity({ remote: hub }).then((outcome) => { following.ok = true; following.summary = outcome.summary.slice(0, FOLLOW_SUMMARY_MAX) }, (error) => { following.ok = false; following.summary = (error instanceof Error ? error.message : String(error)).slice(0, FOLLOW_SUMMARY_MAX) }).finally(() => { following.running = undefined })
    return following.running
  }
  function schedule() {
    if (stopped) return
    if (live.size) startTail()
    // A live chat quickens the rounds while the hub answers; while it does not, the round waits its back-off (it doubles up to RECONNECT_MAX_MS) instead of reconnecting three times a second.
    timer = setTimeout(() => void now().catch(() => {}), live.size ? Math.min(delay, status.connected ? liveTick() : RECONNECT_MAX_MS) : delay)
    ;(timer as { unref?(): void }).unref?.()
  }
  /** One round now (or the one already running); a failure backs off. */
  function now(): Promise<void> {
    if (round) return round
    clearTimeout(timer)
    round = runRound().catch((error) => {
      status.lastError = error instanceof Error ? error.message.slice(0, 300) : String(error)
      status.connected = false
      try { client?.close() } catch {}
      client = undefined
      // Something is waiting on the link (a held command, a chat running on the hub): look for the hub again soon, not after a long back-off.
      delay = held.length || live.size ? Math.min(Math.max(delay * 2, LIVE_TICK_MS), RECONNECT_MAX_MS) : Math.min(Math.max(delay * 2, ports.tickMs), MAX_BACKOFF_MS)
      throw error
    }).finally(() => { round = undefined; schedule() })
    return round
  }

  /** Work that talks to the hub on its own, after the round running now and before the next. */
  async function exclusive<T>(work: () => Promise<T>): Promise<T> {
    while (round) await round.catch(() => {})
    clearTimeout(timer)
    budget = Number.MAX_SAFE_INTEGER
    const running = work()
    round = running.then(() => {}, () => {}).finally(() => { round = undefined; schedule() })
    return running
  }

  /**
   * Sends a local client's command to the hub, which runs it there (a chat, a prompt, a cancel, an approval); the result comes back
   * through the mirror. Only what the hub's `sync-run` token allows goes through; the hub's own refusal is passed on as it is.
   */
  async function forward(command: Command): Promise<{ ok: true; result?: Record<string, unknown> } | { ok: false; code: string; message: string }> {
    const { id: _id, clientId: _clientId, ...bare } = command as Command & { id: string; clientId: string }
    const what = command.type === "session.create" ? "a new chat" : command.type === "user.submit" ? "this prompt" : command.type === "turn.cancel" ? "a cancel" : command.type === "session.cd" ? "a directory change" : command.type === "session.dirs" ? "the folder list" : command.type === "request.resolve" ? "an answer" : "this change to the queue"
    return exclusive(async () => {
      let reply: Awaited<ReturnType<NonNullable<typeof client>["send"]>>
      // The model of a hub chat is the hub's: the one this device picked is not sent, and the hub refuses a prompt that names one.
      const outgoing = bare.type === "session.create" ? { ...bare, directory: projects.toRemote(bare.directory), reuseEmpty: undefined } : bare.type === "session.cd" || bare.type === "session.dirs" ? { ...bare, path: projects.toRemote(bare.path) } : bare.type === "user.submit" && bare.selection?.model ? { ...bare, selection: bare.selection.agent ? { agent: bare.selection.agent } : undefined } : bare
      // A connection the hub's restart ended is found out by this send: it reconnects once before the hub counts as away.
      for (let attempt = 0; ; attempt++) {
        try {
          await connect()
          await putAttachments(outgoing)
          reply = await (client as unknown as { send(command: unknown): Promise<typeof reply> }).send(outgoing)
          // A connection the hub's restart or a dropped network ended answers with this error instead of throwing.
          if (!reply.ok && reply.error.code === "internal" && /connection closed/.test(reply.error.message)) throw new TransportError(reply.error.message)
          break
        } catch (error) {
          // The hub refused an attachment (too large, not accepted): that is its answer, not a lost link.
          if (error instanceof SyncRefusal) return { ok: false as const, code: "forbidden", message: error.message }
          status.connected = false; try { client?.close() } catch {} ; client = undefined
          if (attempt === 0 && bare.type !== "session.create") continue
          // What belongs to an existing chat waits and goes out, in order, when the link is back.
          if (HUB_COMMANDS.has(bare.type) && held.length < MAX_HELD) {
            held.push({ command: (bare.type === "user.submit" ? outgoing : bare) as Command, at: ports.now() })
            return { ok: true as const, result: { held: true } }
          }
          return { ok: false as const, code: "forbidden", message: unreachable(what) }
        }
      }
      if (!reply.ok) return { ok: false as const, code: reply.error.code, message: bare.type === "session.cd" || bare.type === "session.dirs" ? folderRefusal(hub, what, reply.error) : reply.error.message }
      // Listing folders changes nothing the mirror shows; a directory change comes back as the hub's workspace event.
      if (bare.type === "session.dirs") return { ok: true as const, ...(reply.result ? { result: reply.result } : {}) }
      const sessionId = (bare.type === "session.create" ? reply.result?.sessionId : (bare as { sessionId: string }).sessionId) as SessionId | undefined
      if (typeof sessionId === "string") {
        live.set(sessionId, { directory: bare.type === "session.create" ? projects.toRemote(bare.directory) : live.get(sessionId)?.directory ?? ports.store.sessionDirectory(sessionId) ?? "", since: ports.now(), run: true, ...(live.get(sessionId)?.watch ? { watch: true as const } : {}) })
        try { await pullLive() } catch (error) { if (!roundError(error)) throw error }
        if (HUB_COMMANDS.has(bare.type) || bare.type === "session.create") startTail()
      }
      return { ok: true as const, ...(reply.result ? { result: reply.result } : {}) }
    })
  }

  /** Sends what waited for the link, oldest first, in the order it was given; one that is too old is dropped, and a failed link keeps the rest. */
  async function sendHeld() {
    while (held.length) {
      const next = held[0]!
      if (ports.now() - next.at > HELD_MAX_AGE_MS) { held.shift(); ports.log(`[SYNC]: ${next.command.type} waited more than ${HELD_MAX_AGE_MS / 60_000} minutes for ${hub} and was dropped`); continue }
      let reply: Awaited<ReturnType<NonNullable<typeof client>["send"]>>
      try {
        await connect()
        await putAttachments(next.command)
        reply = await (client as unknown as { send(command: unknown): Promise<typeof reply> }).send(next.command)
      } catch (error) {
        if (error instanceof SyncRefusal) { held.shift(); ports.log(`[SYNC]: ${next.command.type} held while ${hub} was away was refused: ${error.message.slice(0, 300)}`); continue }
        throw new TransportError(error instanceof Error ? error.message : String(error)) }
      held.shift()
      if (!reply.ok) ports.log(`[SYNC]: ${next.command.type} held while ${hub} was away was refused: ${reply.error.message.slice(0, 300)}`)
      const sessionId = (next.command as { sessionId?: SessionId }).sessionId
      if (sessionId && live.has(sessionId)) { const entry = live.get(sessionId)!; entry.since = ports.now(); entry.run = true }
      else if (sessionId && next.command.type === "user.submit") live.set(sessionId, { directory: live.get(sessionId)?.directory ?? ports.store.sessionDirectory(sessionId) ?? "", since: ports.now(), run: true, ...(live.get(sessionId)?.watch ? { watch: true as const } : {}) })
    }
  }

  /**
   * Copies a file attached to a prompt for a chat the hub owns into that chat's uploads folder on the hub, in chunks, and answers the
   * path there. Nothing is read whole: a file of the size limit passes through in pieces.
   */
  async function upload(sessionId: SessionId, file: string): Promise<{ path: string; size: number; copied: true }> {
    const row = rows.get(sessionId)
    if (row?.role !== "mirror" || row.state !== "ok") throw new SyncRefusal("invalid", "this chat is not one the hub runs")
    const info = await stat(file).catch(() => undefined)
    if (!info?.isFile()) throw new SyncRefusal("invalid", `not a file: ${file}`)
    const name = path.basename(file)
    if (info.size > MAX_SYNC_UPLOAD_FILE_BYTES) throw new SyncRefusal("invalid", `${name} is ${(info.size / 1_048_576).toFixed(1)} MB; the largest file copied to ${hub} is ${MAX_SYNC_UPLOAD_FILE_BYTES / 1_048_576} MB`)
    if (info.size === 0) throw new SyncRefusal("invalid", `${name} is empty`)
    return exclusive(async () => {
      const source = Bun.file(file)
      let stored: { path: string } | undefined
      try {
        for (let offset = 0; offset < info.size && !stored; offset += MAX_SYNC_BLOB_CHUNK_BYTES) {
          const data = Buffer.from(await source.slice(offset, Math.min(offset + MAX_SYNC_BLOB_CHUNK_BYTES, info.size)).arrayBuffer()).toString("base64")
          const result = await call({ op: "file-put", sessionId, name, size: info.size, offset, data }, false) as { stored: boolean; path?: string }
          if (result.stored && result.path) stored = { path: result.path }
        }
      } catch (error) {
        if (error instanceof TransportError) { status.connected = false; try { client?.close() } catch {} ; client = undefined; throw new SyncRefusal("forbidden", `${hub} is not connected, so ${name} cannot be copied there now; try again when it is back`) }
        throw error
      }
      if (!stored) throw new SyncRefusal("invalid", `${hub} did not keep ${name} (it changed while it was copied)`)
      return { path: stored.path, size: info.size, copied: true as const }
    })
  }

  /** Moves a session's writer, holding off the background rounds meanwhile (one exchange with the hub at a time). */
  async function control(action: "take" | "release" | "handoff", sessionId: SessionId) {
    while (round) await round.catch(() => {})
    clearTimeout(timer)
    const work = move(action, sessionId)
    round = work.then(() => {}, () => {}).finally(() => { round = undefined; schedule() })
    return work
  }
  /** `take` makes this machine the writer, `release` gives it back, `handoff` gives a session made here to the hub. */
  async function move(action: "take" | "release" | "handoff", sessionId: SessionId) {
    budget = Number.MAX_SAFE_INTEGER
    if (ports.busy(sessionId)) throw new SyncRefusal("busy", "a turn is running here; wait for it to end")
    const row = rows.get(sessionId)
    if (action === "take") {
      if (!row || row.role !== "mirror") throw new SyncRefusal("invalid", row ? "this machine already writes this session" : "this session is not a copy of the hub's")
      const taken = await call({ op: "lease", action: "acquire", sessionId }, false) as { lease: { epoch: number; until: number }; lastSeq: number }
      await pull({ sessionId, cseq: 0, lastSeq: taken.lastSeq })
      const current = rows.get(sessionId)!
      if (current.remoteSeq < taken.lastSeq) {
        await call({ op: "lease", action: "release", sessionId, epoch: taken.lease.epoch }, false)
        throw new SyncRefusal("busy", "the hub's copy is not settled yet; try again")
      }
      save({ ...current, role: "owned", epoch: taken.lease.epoch, leaseUntil: taken.lease.until, activeAt: ports.now() })
      return { sessionId, owner: "this machine" }
    }
    if (row && row.state !== "ok") throw new SyncRefusal("invalid", row.note || "this copy is kept only here")
    if (!row && action === "handoff") {
      const head = state.sessionHead(sessionId)
      if (!head || head.parent_id) throw new SyncRefusal("invalid", "only a root session of this machine can be handed over")
      const fresh: SyncSessionRow = { sessionId, role: "owned", remoteSeq: 0, epoch: 0, leaseUntil: ports.now() + ports.leaseMs, state: "ok", note: "", meta: "", activeAt: ports.now() }
      save(fresh)
      try { await pushTail(fresh, true) } catch (error) { drop(sessionId); throw error }
    } else if (!row || row.role !== "owned") throw new SyncRefusal("invalid", `this machine does not write this session; ${hub} does`)
    else await pushTail(row, false)
    const current = rows.get(sessionId)!
    if (state.sessionHead(sessionId)!.last_seq > current.remoteSeq) throw new SyncRefusal("busy", "not every turn could be copied yet; try again")
    await call({ op: "lease", action: "release", sessionId, epoch: current.epoch }, false)
    const head = state.sessionHead(sessionId)!
    save({ ...current, role: "mirror", epoch: 0, leaseUntil: 0, hubDir: projects.toRemote(head.directory), meta: JSON.stringify(metaOf(head)) })
    ports.changed(sessionId)
    return { sessionId, owner: hub }
  }

  /**
   * A terminal opened a chat this machine holds a copy of: what the hub has of it is copied at once, and its new events come as the hub
   * stores them while a terminal keeps it open, instead of at the next polling round. A chat of this machine's own is nothing to copy.
   */
  function focus(sessionId: SessionId) {
    const row = rows.get(sessionId)
    if (stopped || row?.role !== "mirror" || row.state !== "ok") return
    const known = live.get(sessionId)
    if (known) known.watch = true
    else live.set(sessionId, { directory: ports.store.sessionDirectory(sessionId) ?? "", since: ports.now(), watch: true })
    // The long poll in flight names the chats it waits for: it starts again with this one among them.
    if (!known) abortTail?.()
    startTail()
    const directory = live.get(sessionId)!.directory
    void exclusive(() => pull({ sessionId, cseq: 0, directory, lastSeq: Number.MAX_SAFE_INTEGER }, true)).catch(() => {})
  }

  return {
    guard,
    focus,
    /** A chat the hub owns (this machine holds only its copy): the hub's name and the hub's own folder, for the lists and the footer. */
    hubOf(sessionId: string): { hub: string; hubDirectory?: string } | undefined {
      const row = rows.get(sessionId)
      return row?.role === "mirror" ? { hub, ...(row.hubDir ? { hubDirectory: row.hubDir } : {}) } : undefined
    },
    routes,
    forward,
    upload,
    /** A round that starts now, after any one already running (`mendcode sync now`). */
    async fresh() {
      while (round) await round.catch(() => {})
      await now()
    },
    control,
    follow,
    start() { delay = Math.min(ports.tickMs, 1000); schedule() },
    liveCount: () => live.size,
    async stop() {
      stopped = true
      clearTimeout(timer)
      abortTail?.()
      await round?.catch(() => {})
      await following.running
      await tailing
      try { client?.close() } catch {}
      client = undefined
    },
    status() {
      return {
        remote: hub, connected: status.connected, ...(held.length ? { held: held.length } : {}), ...(tailHealthy ? { live: "pushed" } : {}), lastOkAt: status.lastOkAt, ...(status.lastError ? { lastError: status.lastError } : {}),
        ...(config.follow ? { follow: { at: following.at, ok: following.ok, summary: following.summary } } : {}),
        sessions: [...rows.values()].map((row) => ({ sessionId: row.sessionId, title: state.sessionHead(row.sessionId)?.title ?? "", owner: row.state !== "ok" ? "this machine only" : row.role === "owned" ? "this machine" : hub, role: row.role, state: row.state, ...(row.note ? { note: row.note } : {}), ...(row.role === "owned" ? { leaseUntil: row.leaseUntil } : {}) })),
      }
    },
  }
}
export type Device = ReturnType<typeof createDevice>
