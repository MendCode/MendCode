import { MAX_SYNC_BLOB_CHUNK_BYTES, SYNC_CHANGES_PAGE, SYNC_MEMORY_PAGE, type SessionEvent, type SessionId, type SyncPeerInput } from "@mendcode/protocol"
import type { Store, SyncLease, SyncState } from "@mendcode/store"
import { existsSync } from "node:fs"
import { PORTABLE_SETTINGS } from "../config-bundle/classify"
import { createBlobStaging } from "../sync-blobs"
import { blobRefs, canonical, parseSyncEvents, settledPrefix, syncedMessages, SyncRefusal, withDirectory } from "./ingest"
import { applyMemory, memoryToWire } from "./memories"
import { createProjectIndex } from "./projects"
import type { SyncPorts } from "./index"

/**
 * The hub: the always-on daemon that owns sessions. Devices read its change feed and histories, and write a session only while
 * they hold its lease. A lease has a rising epoch; a device whose lease ran out (it died, or lost the network) is fenced: its
 * later writes are refused, and the hub writes the session again.
 */
export function createHub(ports: SyncPorts, state: SyncState) {
  const leaseMs = ports.leaseMs
  /** Every lease, also released ones (until 0), so an epoch never repeats. */
  const leases = new Map<string, SyncLease>(state.leases.list().map((lease) => [lease.sessionId, lease]))
  const projects = createProjectIndex({ directories: () => ports.store.listSessions({ limit: 500, roots: true, archived: true }).map((session) => session.directory), rules: [], now: ports.now })
  const staging = createBlobStaging(ports.store)
  const live = (lease: SyncLease | undefined) => lease !== undefined && lease.until > ports.now()
  const store: Store = ports.store

  function guard(sessionId: SessionId): string | undefined {
    const lease = leases.get(sessionId)
    if (!live(lease)) return undefined
    return `[SYNC]: this session is being written on ${lease!.holder} (its lease runs until ${new Date(lease!.until).toLocaleTimeString()}); hand it back there with \`mendcode sync release ${sessionId}\`, or wait for the lease to end`
  }
  function saveLease(lease: SyncLease) {
    leases.set(lease.sessionId, lease)
    state.leases.put(lease)
  }
  function root(sessionId: SessionId) {
    const head = state.sessionHead(sessionId)
    if (!head || head.parent_id) throw new SyncRefusal("invalid", "no such root session on the hub")
    return head
  }

  async function summary(sessionId: SessionId) {
    const head = state.sessionHead(sessionId)
    if (!head || head.parent_id) return undefined
    const lease = leases.get(sessionId)
    const project = await projects.ref(head.directory)
    return {
      title: head.title, directory: head.directory, ...(project ? { project } : {}), lastSeq: head.last_seq, createdAt: head.created_at, updatedAt: head.updated_at,
      archived: head.archived_at !== null, pinned: head.pinned_at !== null, busy: head.active_turn !== null || ports.busy(sessionId),
      ...(live(lease) ? { lease: { holder: lease!.holder, epoch: lease!.epoch, until: lease!.until } } : {}),
    }
  }

  async function push(holder: string, input: Extract<SyncPeerInput, { op: "push" }>) {
    const exists = store.hasSession(input.sessionId)
    let directory: string
    if (!exists) {
      if (!input.create) throw new SyncRefusal("invalid", "no such session on the hub")
      const resolved = await projects.resolve({ directory: input.create.directory, ...(input.create.project ? { project: input.create.project } : {}) })
      if (!resolved.mapped || !existsSync(resolved.directory)) throw new SyncRefusal("forbidden", `the project ${input.create.project?.id ?? input.create.directory} is not on the hub: clone it there (or add a pathMap rule to sync.json) and hand the session over again`)
      directory = resolved.directory
    } else {
      const head = root(input.sessionId)
      directory = head.directory
      const lease = leases.get(input.sessionId)
      // Every write needs this device's live lease. A resent handoff (its reply was lost, so the device does not know the epoch
      // yet) is matched by holder only; the retry check below still demands the exact events.
      if (!(live(lease) && lease!.holder === holder && (lease!.epoch === input.epoch || input.create))) throw new SyncRefusal("forbidden", "the lease of this session is no longer this device's; take it again")
    }
    const hubLast = exists ? state.sessionHead(input.sessionId)!.last_seq : 0
    if (input.base > hubLast) throw new SyncRefusal("conflict", `the device saw seq ${input.base}, which the hub never had (it ends at ${hubLast})`)
    const incoming = withDirectory(parseSyncEvents(input.sessionId, input.events, Math.min(input.base, hubLast)), () => directory)
    // What the hub already has must be resent exactly (a retry); only the rest is new. A device that did not see the hub's
    // newest events is in conflict: someone else wrote the session.
    if (input.base !== hubLast) {
      const stored = input.base < hubLast ? store.projectSync.sessionHistory(input.sessionId, input.base) : undefined
      const resent = new Map(incoming.map((event) => [event.seq, canonical(event)]))
      if (!stored || stored.hasMore || stored.events.some((event) => resent.get(event.seq) !== canonical(event))) throw new SyncRefusal("conflict", `the hub's copy moved on (seq ${hubLast}, the device saw ${input.base})`)
    }
    const events = incoming.filter((event) => event.seq > hubLast)
    if (!events.length) return { lastSeq: hubLast, stored: 0, epoch: leases.get(input.sessionId)?.epoch ?? 0 }
    if (settledPrefix(events) !== events.length) throw new SyncRefusal("invalid", "only settled turns can be pushed")
    for (const ref of blobRefs(events).copied) if (!staging.stored(ref.sha256, ref.bytes)) throw new SyncRefusal("invalid", `blob ${ref.sha256.slice(0, 12)} was not uploaded first`)
    const lastSeq = Math.max(input.lastSeq, events.at(-1)!.seq)
    const added = store.projectSync.ingest({ sessionId: input.sessionId, events, messages: syncedMessages(events), lastSeq, ...(!exists && input.create ? { create: { directory, title: input.create.title, createdAt: input.create.createdAt } } : {}) })
    // A handed-over session stays this device's (a lease) until its last page is in and it releases it.
    const lease = leases.get(input.sessionId)
    saveLease(exists ? { ...lease!, until: ports.now() + leaseMs } : { sessionId: input.sessionId, holder, epoch: (lease?.epoch ?? 0) + 1, until: ports.now() + leaseMs })
    for (const event of added) ports.publish(event as SessionEvent)
    ports.release(input.sessionId)
    ports.changed(input.sessionId)
    return { lastSeq: state.sessionHead(input.sessionId)!.last_seq, stored: added.length, epoch: leases.get(input.sessionId)!.epoch }
  }

  function lease(holder: string, input: Extract<SyncPeerInput, { op: "lease" }>) {
    const head = root(input.sessionId)
    const current = leases.get(input.sessionId)
    if (input.action === "acquire") {
      if (live(current) && current!.holder !== holder) throw new SyncRefusal("busy", `the session is held by ${current!.holder}`)
      if (live(current)) {
        saveLease({ ...current!, until: ports.now() + leaseMs })
        return { lease: leases.get(input.sessionId), lastSeq: head.last_seq }
      }
      if (head.active_turn !== null || ports.busy(input.sessionId)) throw new SyncRefusal("busy", "a turn is running on the hub; take it when it ends")
      saveLease({ sessionId: input.sessionId, holder, epoch: (current?.epoch ?? 0) + 1, until: ports.now() + leaseMs })
      ports.release(input.sessionId)
      ports.changed(input.sessionId)
      return { lease: leases.get(input.sessionId), lastSeq: head.last_seq }
    }
    const mine = current !== undefined && current.holder === holder && current.epoch === input.epoch
    if (input.action === "renew") {
      if (!mine || !live(current)) throw new SyncRefusal("forbidden", "the lease of this session is no longer this device's; take it again")
      saveLease({ ...current!, until: ports.now() + leaseMs })
      return { lease: leases.get(input.sessionId), lastSeq: head.last_seq }
    }
    if (!mine) throw new SyncRefusal("forbidden", "this device does not hold the lease")
    if (current!.until !== 0) saveLease({ ...current!, until: 0 })
    ports.changed(input.sessionId)
    return { released: true, lastSeq: head.last_seq }
  }

  /** Devices waiting in a `tail` for news of their chats: one per device (a newer wait replaces the older), woken by the hub's own events. */
  const tails = new Map<string, { ids: ReadonlySet<string>; wake(): void }>()
  ports.observe((event) => { if (tails.size) for (const entry of tails.values()) if (entry.ids.has(event.sessionId)) entry.wake() })
  /** What gathers after a first event before the answer leaves, so one answer carries a few events instead of each alone. */
  const TAIL_COALESCE_MS = 40

  async function tail(holder: string, input: Extract<SyncPeerInput, { op: "tail" }>, gone?: AbortSignal) {
    const collect = () => {
      const out: Array<{ sessionId: SessionId; events: SessionEvent[]; hasMore: boolean; lastSeq: number }> = []
      for (const { sessionId, after } of input.sessions) {
        const head = state.sessionHead(sessionId)
        if (!head || head.parent_id || head.last_seq <= after) continue
        const page = store.projectSync.sessionHistory(sessionId, after)!
        if (page.events.length) out.push({ sessionId, events: page.events, hasMore: page.hasMore, lastSeq: page.lastSeq })
      }
      return out
    }
    let sessions = collect()
    if (!sessions.length && input.waitMs > 0) {
      const woken = await new Promise<boolean>((resolve) => {
        let done = false
        const finish = (value: boolean) => { if (done) return; done = true; clearTimeout(timer); if (tails.get(holder) === entry) tails.delete(holder); resolve(value) }
        const entry = { ids: new Set<string>(input.sessions.map((item) => item.sessionId)), wake: () => finish(true) }
        const timer = setTimeout(() => finish(false), input.waitMs)
        gone?.addEventListener("abort", () => finish(false), { once: true })
        tails.get(holder)?.wake()
        tails.set(holder, entry)
      })
      if (woken) await new Promise((resolve) => setTimeout(resolve, TAIL_COALESCE_MS))
      sessions = collect()
    }
    return { sessions }
  }

  async function handle(holder: string, input: SyncPeerInput, gone?: AbortSignal): Promise<Record<string, unknown>> {
    switch (input.op) {
      case "hello": return { hub: true, leaseMs, now: ports.now() }
      case "changes": {
        const changes = state.changes("session", input.after, SYNC_CHANGES_PAGE)
        const out = []
        for (const change of changes) {
          const found = change.deleted ? undefined : await summary(change.id as SessionId)
          out.push(found ? { sessionId: change.id, cseq: change.cseq, ...found } : { sessionId: change.id, cseq: change.cseq, deleted: true })
        }
        return { changes: out, cursor: changes.at(-1)?.cseq ?? input.after, hasMore: changes.length === SYNC_CHANGES_PAGE }
      }
      case "history": {
        root(input.sessionId)
        const page = store.projectSync.sessionHistory(input.sessionId, input.after)!
        return { events: page.events, hasMore: page.hasMore, lastSeq: page.lastSeq }
      }
      case "tail": return tail(holder, input, gone)
      case "push": return push(holder, input)
      case "lease": return lease(holder, input)
      case "meta": {
        root(input.sessionId)
        if (input.title !== undefined) store.renameSession(input.sessionId, input.title)
        if (input.archived !== undefined) store.setSessionArchived(input.sessionId, input.archived)
        if (input.pinned !== undefined) store.setSessionPinned(input.sessionId, input.pinned)
        ports.changed(input.sessionId)
        return { ok: true }
      }
      case "blob-put": return staging.put(input.input)
      case "blob-read": {
        const info = state.blobInfo(input.input.sha256)
        if (!info || !existsSync(store.blobPath(input.input.sha256))) throw new SyncRefusal("invalid", "no such blob on the hub")
        const offset = input.input.offset
        if (offset > info.bytes) throw new SyncRefusal("invalid", "offset is past the end of the blob")
        const length = Math.min(MAX_SYNC_BLOB_CHUNK_BYTES, info.bytes - offset)
        const data = store.readBlob(input.input.sha256).subarray(offset, offset + length)
        return { sha256: input.input.sha256, mime: info.mime, bytes: info.bytes, offset, data: data.toString("base64"), done: offset + length >= info.bytes }
      }
      case "memories": {
        const changes = state.changes("memory", input.after, SYNC_MEMORY_PAGE)
        const rows = []
        for (const change of changes) { const row = await memoryToWire(state, change, projects); if (row) rows.push(row) }
        return { rows, cursor: changes.at(-1)?.cseq ?? input.after, hasMore: changes.length === SYNC_MEMORY_PAGE }
      }
      case "memories-put": {
        let applied = 0
        for (const row of input.rows) if (await applyMemory(state, row, projects, false)) applied++
        return { applied }
      }
      case "settings": {
        const settings = store.settings.get() as Record<string, unknown>
        return { values: Object.fromEntries(Object.entries(settings).filter(([key]) => PORTABLE_SETTINGS.has(key))) }
      }
      case "settings-put": {
        const refused = Object.keys(input.patch).filter((key) => !PORTABLE_SETTINGS.has(key))
        if (refused.length) throw new SyncRefusal("forbidden", `only preference settings sync; refused: ${refused.slice(0, 5).join(", ")}`)
        await ports.applySettings(input.patch)
        return { ok: true }
      }
    }
  }
  return { guard, handle, leases: () => [...leases.values()].filter(live) }
}
export type Hub = ReturnType<typeof createHub>
