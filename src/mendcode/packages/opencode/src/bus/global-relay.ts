import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "fs"
import { appendFile, mkdir, stat, truncate } from "fs/promises"
import path from "path"
import { Global } from "@mendcode/core/global"
import type { GlobalEvent } from "./global"

type RelayEnvelope = {
  source: string
  sequence: number
  time: number
  event: GlobalEvent
}

const RELAY_INTERVAL_MS = 40
const RELAY_FLUSH_DELAY_MS = 25
const RELAY_BATCH_MAX_BYTES = 256 * 1024
const RELAY_PENDING_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_RELAY_MAX_BYTES = 8 * 1024 * 1024
const SOURCE_ID = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`
const RELAY_PATH = process.env.MENDCODE_GLOBAL_EVENT_RELAY_FILE || path.join(Global.Path.state, "global-events.jsonl")

let sequence = 0
let offset = 0
let carry = ""
let started = false
let flushTimer: ReturnType<typeof setTimeout> | undefined
let flushPromise: Promise<void> | undefined
let pendingBytes = 0
const pendingLines: Array<{ data: string; bytes: number }> = []

export function globalEventRelayPath() {
  return RELAY_PATH
}

function ensureRelayDir() {
  mkdirSync(path.dirname(RELAY_PATH), { recursive: true })
}

function shouldRelay(event: GlobalEvent) {
  const type = event.payload?.type
  return type !== "server.connected" && type !== "server.heartbeat" && type !== "message.part.delta"
}

function relayMaxBytes() {
  const value = Number(process.env.MENDCODE_GLOBAL_EVENT_RELAY_MAX_BYTES)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_RELAY_MAX_BYTES
}

export function appendGlobalEvent(event: GlobalEvent) {
  if (!shouldRelay(event)) return
  try {
    const maxBytes = relayMaxBytes()
    const envelope: RelayEnvelope = {
      source: SOURCE_ID,
      sequence: ++sequence,
      time: Date.now(),
      event,
    }
    const line = JSON.stringify(envelope) + "\n"
    const bytes = Buffer.byteLength(line)
    if (bytes > maxBytes || bytes > RELAY_PENDING_MAX_BYTES) return

    // GlobalBus.emit runs on the shared server event loop. Queue the disk write
    // so event delivery and provider/tool work never wait on JSONL persistence.
    // Relay delivery is best-effort, so discard the oldest backlog when the
    // filesystem cannot keep up instead of retaining events without a bound.
    while (pendingLines.length > 0 && pendingBytes + bytes > RELAY_PENDING_MAX_BYTES) {
      const dropped = pendingLines.shift()
      if (dropped) pendingBytes -= dropped.bytes
    }
    if (pendingBytes + bytes > RELAY_PENDING_MAX_BYTES) return
    pendingLines.push({ data: line, bytes })
    pendingBytes += bytes
    scheduleFlush()
  } catch {
    // Relay is best-effort; in-process subscribers already received the event.
  }
}

function scheduleFlush() {
  if (flushTimer !== undefined || flushPromise !== undefined) return
  flushTimer = setTimeout(() => {
    flushTimer = undefined
    void flushGlobalEventRelay()
  }, RELAY_FLUSH_DELAY_MS)
  flushTimer.unref?.()
}

async function writeBatch(lines: Array<{ data: string; bytes: number }>, maxBytes: number) {
  let batch = ""
  let batchBytes = 0

  const flushBatch = async () => {
    if (!batch) return
    await mkdir(path.dirname(RELAY_PATH), { recursive: true })
    const currentSize = await stat(RELAY_PATH).then((result) => result.size).catch(() => 0)
    if (currentSize >= maxBytes || currentSize + batchBytes > maxBytes) {
      await truncate(RELAY_PATH, 0)
      offset = 0
      carry = ""
    }
    await appendFile(RELAY_PATH, batch, { mode: 0o600 })
    batch = ""
    batchBytes = 0
  }

  for (const line of lines) {
    if (line.bytes > maxBytes) continue
    if (batchBytes > 0 && batchBytes + line.bytes > Math.min(maxBytes, RELAY_BATCH_MAX_BYTES)) {
      await flushBatch()
    }
    batch += line.data
    batchBytes += line.bytes
  }
  await flushBatch()
}

function flushQueuedEvents() {
  if (flushPromise !== undefined) return flushPromise
  if (pendingLines.length === 0) return Promise.resolve()

  const lines = pendingLines.splice(0)
  pendingBytes = 0
  flushPromise = writeBatch(lines, relayMaxBytes())
    .catch(() => {
      // Relay is best-effort; in-process subscribers already received events.
    })
    .finally(() => {
      flushPromise = undefined
      if (pendingLines.length > 0) scheduleFlush()
    })
  return flushPromise
}

/** Flush queued relay writes for deterministic tests and graceful shutdown. */
export function flushGlobalEventRelay() {
  if (flushTimer !== undefined) {
    clearTimeout(flushTimer)
    flushTimer = undefined
  }
  return flushQueuedEvents()
}

function readAvailable(emit: (event: GlobalEvent) => void) {
  if (!existsSync(RELAY_PATH)) return
  let size = 0
  try {
    size = statSync(RELAY_PATH).size
  } catch {
    return
  }
  if (size < offset) {
    offset = 0
    carry = ""
  }
  if (size === offset) return

  let fd: number | undefined
  try {
    fd = openSync(RELAY_PATH, "r")
    while (offset < size) {
      const length = Math.min(size - offset, 256 * 1024)
      const buffer = Buffer.allocUnsafe(length)
      const read = readSync(fd, buffer, 0, length, offset)
      if (read <= 0) break
      offset += read
      const chunk = carry + buffer.subarray(0, read).toString("utf8")
      const lines = chunk.split("\n")
      carry = lines.pop() ?? ""
      for (const line of lines) {
        if (!line) continue
        try {
          const envelope = JSON.parse(line) as RelayEnvelope
          if (envelope.source === SOURCE_ID) continue
          if (!envelope.event?.payload?.type) continue
          emit(envelope.event)
        } catch {
          // Ignore a malformed or partial writer line and keep tailing.
        }
      }
    }
  } catch {
    return
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function startGlobalEventRelay(emit: (event: GlobalEvent) => void) {
  if (started) return
  started = true
  try {
    ensureRelayDir()
    offset = existsSync(RELAY_PATH) ? statSync(RELAY_PATH).size : 0
  } catch {
    offset = 0
  }
  const timer = setInterval(() => readAvailable(emit), RELAY_INTERVAL_MS)
  timer.unref?.()
}
