import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync, truncateSync } from "fs"
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
const DEFAULT_RELAY_MAX_BYTES = 8 * 1024 * 1024
const SOURCE_ID = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`
const RELAY_PATH = process.env.MENDCODE_GLOBAL_EVENT_RELAY_FILE || path.join(Global.Path.state, "global-events.jsonl")

let sequence = 0
let offset = 0
let carry = ""
let started = false

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

function capRelayFile(maxBytes: number) {
  if (!existsSync(RELAY_PATH)) return
  const size = statSync(RELAY_PATH).size
  if (size < maxBytes) return
  truncateSync(RELAY_PATH, 0)
  offset = 0
  carry = ""
}

export function appendGlobalEvent(event: GlobalEvent) {
  if (!shouldRelay(event)) return
  try {
    ensureRelayDir()
    const maxBytes = relayMaxBytes()
    const envelope: RelayEnvelope = {
      source: SOURCE_ID,
      sequence: ++sequence,
      time: Date.now(),
      event,
    }
    const line = JSON.stringify(envelope) + "\n"
    if (Buffer.byteLength(line) > maxBytes) return
    capRelayFile(maxBytes)
    appendFileSync(RELAY_PATH, line, { mode: 0o600 })
  } catch {
    // Relay is best-effort; in-process subscribers already received the event.
  }
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
