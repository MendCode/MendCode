import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { MflowRoom, MflowLease, type MflowLeaseResult, type MflowLock, type MflowPeer } from "@mendcode/protocol"

type Room = { peers: MflowPeer[]; locks: MflowLock[] }
export const mflowKey = (value: string) => createHash("sha256").update(value).digest("hex")

/** One coordinator serializes every room transaction; leases survive a daemon restart until their TTL. */
export function createMflowCoordinator(input: { dir: string; now?: () => number }) {
  const now = input.now ?? Date.now
  const file = path.join(input.dir, "mflow", "rooms.json")
  function read(): Record<string, Room> {
    if (!existsSync(file)) return {}
    const document = JSON.parse(readFileSync(file, "utf8")) as Record<string, Room>
    if (Object.keys(document).length > 64) throw new Error("Mflow room limit exceeded")
    for (const room of Object.values(document)) {
      MflowRoom.parse(room)
      room.peers = room.peers.filter((peer) => peer.expiresAt > now())
      room.locks = room.locks.filter((lock) => lock.expiresAt > now())
    }
    return document
  }
  function save(document: Record<string, Room>) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(document), { mode: 0o600, flag: "wx" })
    renameSync(temporary, file)
  }
  const ownerId = (owner: string) => mflowKey(owner).slice(0, 16)
  function snapshot(room: string): Room {
    return read()[mflowKey(room)] ?? { peers: [], locks: [] }
  }
  function run(roomName: string, owner: string, raw: MflowLease): MflowLeaseResult {
    const request = MflowLease.parse(raw)
    const document = read()
    const key = mflowKey(roomName), id = ownerId(owner)
    for (const [roomKey, room] of Object.entries(document)) if (!room.peers.length && !room.locks.length) delete document[roomKey]
    if (!document[key] && Object.keys(document).length >= 64) throw new Error("Mflow room limit reached")
    const room = document[key] ??= { peers: [], locks: [] }
    const ttl = "ttlMs" in request ? request.ttlMs ?? 35_000 : 35_000
    if (request.action === "leave") {
      room.peers = room.peers.filter((peer) => peer.owner !== id)
      room.locks = room.locks.filter((lock) => lock.owner !== id)
    } else if (request.action === "join") {
      const peer = room.peers.find((peer) => peer.owner === id)
      if (peer) peer.expiresAt = now() + ttl
      else {
        if (room.peers.length >= 128) throw new Error("Mflow peer limit reached")
        room.peers.push({ owner: id, expiresAt: now() + ttl })
      }
    } else if (request.action === "acquire") {
      const files = [...new Set(request.files.map((file) => {
        const normalized = path.posix.normalize(file.replaceAll("\\", "/"))
        if (normalized === "." || normalized.startsWith("../") || normalized === ".." || normalized.startsWith("/") || /^[a-z]:/i.test(normalized)) throw new Error("Mflow lock paths must stay inside the room project")
        return normalized
      }))].sort()
      const conflict = room.locks.find((lock) => lock.files.some((file) => files.includes(file)) && (lock.mode === "write" || request.mode === "write"))
      if (conflict) return { ok: false, conflict: { files: conflict.files.filter((file) => files.includes(file)), expiresAt: conflict.expiresAt }, message: "File locked" }
      if (room.locks.length >= 512) throw new Error("Mflow lease limit reached")
      const lease: MflowLock = { leaseId: randomUUID(), owner: id, files, mode: request.mode, expiresAt: now() + ttl }
      room.locks.push(lease)
      save(document)
      return { ok: true, lease }
    } else {
      const lock = room.locks.find((lock) => lock.leaseId === request.leaseId && lock.owner === id)
      if (!lock) return { ok: false, message: "Unknown or expired lease" }
      if (request.action === "renew") lock.expiresAt = now() + 35_000
      else room.locks = room.locks.filter((entry) => entry !== lock)
      save(document)
      return { ok: true, ...(request.action === "renew" ? { lease: lock } : {}) }
    }
    save(document)
    return { ok: true, ...room }
  }
  function stats() {
    const rooms = Object.values(read()).filter((room) => room.peers.length || room.locks.length)
    return { roomCount: rooms.length, peerCount: rooms.reduce((count, room) => count + room.peers.length, 0) }
  }
  return { snapshot, run, ownerId, file, stats }
}
