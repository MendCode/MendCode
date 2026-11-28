import type { Command, SessionEvent, SessionId, SyncControlInput, SyncPeerInput } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"
import { createSyncState } from "@mendcode/store/sync-state"
import { markHub, readSyncConfig, unmarkHub } from "./config"
import { createDevice, type Device } from "./device"
import { createHub, type Hub } from "./hub"
import { SyncRefusal } from "./ingest"

/** What session sync needs from the daemon. */
export type SyncPorts = {
  dir: string
  store: Store
  now(): number
  /** A turn, queued work, an approval or a side chat is live for the session. */
  busy(sessionId: SessionId): boolean
  publish(event: SessionEvent): void
  /** Whether a terminal holds the session open now (a subscriber): a copy of a hub chat is followed live while it is. */
  watched?(sessionId: SessionId): boolean
  /** Calls `listener` for every event this daemon appends to a session of its own (the hub's live chats). */
  observe(listener: (event: SessionEvent) => void): void
  changed(sessionId: SessionId): void
  /** Drops the session's in-memory state after its history changed underneath it. */
  release(sessionId: SessionId): void
  deleteSession(sessionId: SessionId): void
  applySettings(patch: Record<string, unknown>): Promise<void>
  /** Brings the hub level with this machine's portable configuration (docs/sync.md); only when `follow` is on. */
  parity(input: { remote: string }): Promise<{ summary: string }>
  /** How often a following device compares with its hub. */
  followMs: number
  log(message: string): void
  tickMs: number
  leaseMs: number
  idleReleaseMs: number
}

/**
 * Session sync, loaded only when `sync.json` (a device) or `sync-hub.json` (a hub) exists, or the first time a device syncs
 * with this daemon. A daemon is a hub or a device, never both: a device does not serve another one.
 */
export function createSync(ports: SyncPorts) {
  let hub: Hub | undefined
  let device: Device | undefined
  let state: ReturnType<typeof createSyncState> | undefined
  const guard = (sessionId: SessionId, type: string) => device?.guard(sessionId, type) ?? hub?.guard(sessionId)
  const hubOf = (sessionId: string) => device?.hubOf(sessionId)
  const open = () => state ??= ports.store.openSyncState(createSyncState, guard)

  function startDevice() {
    const config = readSyncConfig(ports.dir)
    if (!config) return
    const opened = open()
    opened.seedMemories()
    device = createDevice(ports, opened, config)
    device.start()
  }
  function startHub() {
    if (hub) return hub
    const opened = open()
    opened.enableHub()
    opened.seedMemories()
    markHub(ports.dir)
    return hub = createHub(ports, opened)
  }

  return {
    /** Why this machine may not write the session now (it is another machine's), or undefined. */
    guard,
    hubOf,
    /** A terminal opened the chat: a copy of a hub chat is brought up to date at once and followed while it stays open. */
    focus(sessionId: SessionId) { device?.focus(sessionId) },
    /** A local client's command that runs on the hub (a chat in the hub's folder, a prompt, cancel or approval of its chats), or undefined. */
    route(command: Command) { return device?.routes(command) ? (device.forward as (command: Command) => ReturnType<Device["forward"]>) : undefined },
    /** Whether the chat is one the hub runs (this machine holds a copy). */
    isHubChat: (sessionId: string) => hubOf(sessionId) !== undefined,
    /** Copies a file for a prompt of a hub chat into the chat's uploads folder on the hub; answers its path there. */
    upload(sessionId: SessionId, file: string) {
      if (!device) throw new SyncRefusal("invalid", "sync is off on this machine (`mendcode sync enable REMOTE`)")
      return device.upload(sessionId, file)
    },
    /** Starts copying an attachment of a hub chat's prompt to the hub while it is still being written; false when there is nothing to copy there. */
    stage(sessionId: SessionId, ref: { sha256: string; bytes: number; mime: string }) {
      return device ? device.stage(sessionId, ref) : Promise.resolve(false)
    },
    /** At daemon start: the role the data dir says, if any. */
    boot(asHub: boolean) {
      startDevice()
      if (!device && asHub) startHub()
    },
    /** `push` sends a frame to the asking device's connection (a pushed `tail`). */
    async peer(holder: string, input: SyncPeerInput, gone?: AbortSignal, push?: (body: Record<string, unknown>) => void) {
      if (device) throw new SyncRefusal("forbidden", "this machine syncs with another hub; it does not serve as one")
      return startHub().handle(holder, input, gone, push)
    },
    async control(input: SyncControlInput): Promise<Record<string, unknown>> {
      switch (input.action) {
        case "status": return device ? { mode: "device", ...device.status() } : hub ? { mode: "hub", leases: hub.leases().map((lease) => ({ sessionId: lease.sessionId, holder: lease.holder, until: lease.until })) } : { mode: "off" }
        case "reload": {
          await device?.stop()
          device = undefined
          if (!readSyncConfig(ports.dir)) {
            if (!hub) { ports.store.closeSyncState(); state = undefined }
            return { mode: hub ? "hub" : "off" }
          }
          if (hub) throw new SyncRefusal("forbidden", "this machine serves as a hub; turn that off first (`mendcode sync hub-off`)")
          startDevice()
          return { mode: "device" }
        }
        case "now":
          if (!device && !hub) startDevice()
          if (!device) throw new SyncRefusal("invalid", "sync is off on this machine (`mendcode sync enable REMOTE`)")
          await device.fresh()
          await device.follow(true)
          return { mode: "device", ...device.status() }
        case "hub-off": {
          if (hub && hub.leases().length) throw new SyncRefusal("busy", "a device still holds a session's lease; release it there first")
          hub = undefined
          unmarkHub(ports.dir)
          if (!device) {
            open().dropAll()
            ports.store.closeSyncState()
            state = undefined
          }
          return { mode: device ? "device" : "off" }
        }
        case "take": case "release": case "handoff":
          if (!device) throw new SyncRefusal("invalid", "sync is off on this machine (`mendcode sync enable REMOTE`)")
          return device.control(input.action, input.sessionId)
      }
    },
    async stop() { await device?.stop() },
  }
}
export type Sync = ReturnType<typeof createSync>
