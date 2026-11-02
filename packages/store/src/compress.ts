import type { SessionEvent } from "@mendcode/protocol"
import { abbreviateMessage, expandMessage } from "./message-prefix"

/** Text and file content shorter than this stays as it is: the zstd frame would eat the gain. */
export const COMPRESS_MIN_BYTES = 1024
/** File content from this size is content-addressed (stored once, referenced by hash) instead of copied per snapshot row. */
export const DEDUP_MIN_BYTES = 256
const ZSTD_LEVEL = 3
const MAGIC = [0x00, 0x4d, 0x5a, 0x31] as const
const KIND_ZSTD = 0x5a
const KIND_RAW = 0x52
const KIND_REF = 0x46
const KIND_MESSAGE = 0x45
const HEADER_BYTES = 9
const SHA_BYTES = 32

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export type StoredValue = string | Uint8Array | null | undefined

const isWrapped = (value: Uint8Array) => value.byteLength >= HEADER_BYTES && MAGIC.every((byte, i) => value[i] === byte)

function wrap(kind: number, rawBytes: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + body.byteLength)
  out.set(MAGIC, 0)
  out[4] = kind
  new DataView(out.buffer).setUint32(5, rawBytes)
  out.set(body, HEADER_BYTES)
  return out
}

const rawBytesOf = (value: Uint8Array) => new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(5)
const bodyOf = (value: Uint8Array) => value.subarray(HEADER_BYTES)

function sha256(bytes: Uint8Array) {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
}

function hexToBytes(hex: string) {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

const bytesToHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

/** Logical size of a stored value without touching its payload. */
export function logicalBytes(value: StoredValue): number {
  if (value === null || value === undefined) return 0
  if (typeof value === "string") return Buffer.byteLength(value)
  return isWrapped(value) ? rawBytesOf(value) : value.byteLength
}

/** One content-addressed object: zstd when that made it smaller, raw otherwise. */
export type SnapshotObject = { sha256: string; bytes: number; z: boolean; data: Uint8Array }

/**
 * How the store shrinks what it writes. Everything stays readable by older builds' data: values written before this
 * existed are plain TEXT/BLOB and read back unchanged; only values wrapped with the `\0MZ1` header (or events flagged
 * `z`) go through here. `enabled: false` writes the legacy forms, which is how the "before" bytes are measured.
 */
export function createCodec(options: { enabled?: boolean; objects?: { put(text: string): string; load(hash: string): string | undefined } } = {}) {
  const enabled = options.enabled ?? true

  function zstd(bytes: Uint8Array): Uint8Array | undefined {
    const packed = Bun.zstdCompressSync(bytes, { level: ZSTD_LEVEL })
    return packed.byteLength + HEADER_BYTES < bytes.byteLength ? packed : undefined
  }

  return {
    enabled,

    /** JSON text of an engine message: plain TEXT when small, a zstd BLOB when that is smaller. */
    packText(text: string): string | Uint8Array {
      if (!enabled) return text
      if (text.length < COMPRESS_MIN_BYTES) return abbreviateMessage(text)
      // Keep the exact JSON envelope, sharing only content already present in the transcript.
      if (options.objects) {
        let message: Record<string, unknown> | undefined
        try { message = JSON.parse(text) } catch {}
        if (message?.role === "tool" && typeof message.content === "string" && message.content.length >= COMPRESS_MIN_BYTES && JSON.stringify(message) === text && decoder.decode(encoder.encode(message.content)) === message.content) {
          const envelope = { ...message, content: null }
          const hash = options.objects.put(message.content)
          const body = encoder.encode(JSON.stringify(envelope))
          const shared = new Uint8Array(SHA_BYTES + body.byteLength)
          shared.set(hexToBytes(hash))
          shared.set(body, SHA_BYTES)
          return wrap(KIND_MESSAGE, Buffer.byteLength(text), shared)
        }
      }
      const bytes = encoder.encode(text)
      if (decoder.decode(bytes) !== text) return text
      const packed = zstd(bytes)
      return packed ? wrap(KIND_ZSTD, bytes.byteLength, packed) : text
    },
    unpackText(value: StoredValue): string {
      if (value === null || value === undefined) return ""
      if (typeof value === "string") return expandMessage(value)
      if (!isWrapped(value)) return expandMessage(decoder.decode(value))
      if (value[4] === KIND_MESSAGE) {
        const body = bodyOf(value)
        const hash = bytesToHex(body.subarray(0, SHA_BYTES))
        const based = options.objects?.load(hash)
        if (based === undefined) throw new RangeError("[STORE]: shared model content is not available")
        const message = JSON.parse(decoder.decode(body.subarray(SHA_BYTES))) as Record<string, unknown>
        message.content = decoder.decode(Bun.zstdDecompressSync(Buffer.from(based, "base64")))
        return JSON.stringify(message)
      }
      if (value[4] === KIND_ZSTD) return decoder.decode(Bun.zstdDecompressSync(bodyOf(value)))
      return decoder.decode(bodyOf(value))
    },
    /** Raw size of a packed text: how much the row would take without compression. */
    textBytes: logicalBytes,

    /**
     * An event row. A tool result (or its live output) over the threshold keeps its JSON shape but carries `text` as
     * base64 zstd and `z` = the original length, so every json_extract over itemId/type/status still works; readers
     * call `parseEvent`. Everything else is stored as the JSON it always was.
     */
    packEvent(event: SessionEvent, json: string, toolCall: boolean): string {
      if (!enabled || json.length < COMPRESS_MIN_BYTES) return json
      if (event.type !== "item.completed" && event.type !== "item.delta") return json
      if (!toolCall && event.type !== "item.completed") return json
      const text = event.text
      if (typeof text !== "string" || text.length < COMPRESS_MIN_BYTES) return json
      const bytes = encoder.encode(text)
      if (decoder.decode(bytes) !== text) return json
      const packed = zstd(bytes)
      if (!packed) return json
      const based = Buffer.from(packed).toString("base64")
      if (options.objects && (toolCall || event.type === "item.completed" && event.toolInput !== undefined) && based.length < text.length * 0.8) return JSON.stringify({ ...event, text: "", z: text.length, zref: options.objects.put(text) })
      return based.length < text.length * 0.8 ? JSON.stringify({ ...event, text: based, z: text.length }) : json
    },

    /** Compressed content of one file snapshot side, deduplicated through `store` when large. */
    packContent(content: Uint8Array, store: (object: SnapshotObject) => void): Uint8Array {
      if (!enabled) return content
      if (content.byteLength < DEDUP_MIN_BYTES) return isWrapped(content) ? wrap(KIND_RAW, content.byteLength, content) : content
      const hash = sha256(content)
      const packed = zstd(content)
      store({ sha256: hash, bytes: content.byteLength, z: packed !== undefined, data: packed ?? content })
      return wrap(KIND_REF, content.byteLength, hexToBytes(hash))
    },
    /** The bytes of a snapshot side; `load` resolves a content-addressed object. Undefined when its object is gone. */
    unpackContent(value: Uint8Array | null, load: (sha256: string) => { z: boolean; data: Uint8Array } | undefined): Uint8Array | undefined {
      if (value === null) return new Uint8Array()
      if (!isWrapped(value)) return value
      if (value[4] === KIND_RAW) return bodyOf(value)
      if (value[4] === KIND_ZSTD) return Bun.zstdDecompressSync(bodyOf(value))
      const object = load(bytesToHex(bodyOf(value).subarray(0, SHA_BYTES)))
      if (!object) return undefined
      return object.z ? Bun.zstdDecompressSync(object.data) : object.data
    },
    contentBytes: logicalBytes,
  }
}

export type Codec = ReturnType<typeof createCodec>

/** Resolves a shared event object (event-objects.ts) to the base64 of its zstd bytes, the form a packed event carries in `text`. */
export type ObjectLoader = (sha256: string) => string | undefined

/** An `events` row: the envelope (session, sequence, time, type) lives in its columns. */
export type EventRow = { session_id: string; seq: number; type: string; at: number; payload: string }
/** A row read for a known session. */
export type OwnEventRow = { seq: number; type: string; at: number; payload: string }

/**
 * SQL for an inherited row's payload (`e` the parent's event, `p` its transcript_prefix address): a legacy payload gets
 * the reader's session and sequence written into its envelope; a compact one takes them from the address columns.
 */
export const INHERITED_PAYLOAD = `CASE WHEN substr(e.payload, 1, 12) = '{"sessionId"' THEN json_set(e.payload, '$.sessionId', p.session_id, '$.seq', p.seq) ELSE e.payload END`

/** Protocol ids/types contain no JSON escapes. Noncanonical legacy JSON is never compacted. */
function envelopePrefix(sessionId: string, seq: number, at: number, type: string): string {
  return `{"sessionId":"${sessionId}","seq":${seq},"at":${at},"type":"${type}"`
}

/** The stored form of an event row: its JSON without the leading envelope its columns already hold. Lossless by construction. */
export function compactEnvelope(payload: string, event: { sessionId: string; seq: number; at: number; type: string }): string {
  const prefix = envelopePrefix(event.sessionId, event.seq, event.at, event.type)
  if (!payload.startsWith(prefix)) return payload
  const next = payload.charCodeAt(prefix.length)
  if (next === 44 /* , */) return "{" + payload.slice(prefix.length + 1)
  return next === 125 /* } */ && payload.length === prefix.length + 1 ? "{}" : payload
}

const PROFILE_KEYS = ["instructions", "memory", "history", "toolResults", "toolSchemas", "media", "total"] as const
const PROFILE_TEXT = /,"profile":\{"estimatedTokens":\{"instructions":(\d+),"memory":(\d+),"history":(\d+),"toolResults":(\d+),"toolSchemas":(\d+),"media":(\d+),"total":(\d+)\},"firstTokenMs":(\d+|null),"durationMs":(\d+),"toolCount":(\d+),"imageCount":(\d+)\}/

/**
 * The stored form of a `usage.recorded` request profile: its eleven numbers in a fixed order instead of five nested key
 * names per call. Only the exact serialization of the protocol's profile is rewritten; `unpackEvent` restores the object.
 */
export function compactProfile(payload: string, type: string): string {
  if (type !== "usage.recorded") return payload
  return payload.replace(PROFILE_TEXT, (_, ...found: string[]) => `,"profile":[${found.slice(0, 11).join(",")}]`)
}

function expandProfile(values: unknown[]): Record<string, unknown> {
  const estimatedTokens: Record<string, unknown> = {}
  PROFILE_KEYS.forEach((key, index) => { estimatedTokens[key] = values[index] })
  return { estimatedTokens, firstTokenMs: values[7], durationMs: values[8], toolCount: values[9], imageCount: values[10] }
}

/** A payload written before envelopes moved to columns carries its envelope itself. */
export function hasEnvelope(payload: string): boolean {
  return payload.startsWith('{"sessionId"')
}

/** The full serialized event of a row, byte-identical to what was appended. */
export function eventPayload(row: EventRow): string {
  if (hasEnvelope(row.payload)) return row.payload
  const prefix = envelopePrefix(row.session_id, row.seq, row.at, row.type)
  return prefix + (row.payload === "{}" ? "}" : "," + row.payload.slice(1))
}

/** The event of a stored row, with the original key order (envelope first). */
export function eventFromColumns<T = SessionEvent>(sessionId: string, seq: number, at: number, type: string, payload: string, load?: ObjectLoader): T {
  if (hasEnvelope(payload)) return parseEvent<T>(payload, load)
  return unpackEvent({ sessionId, seq, at, type, ...(JSON.parse(payload) as Record<string, unknown>) }, load) as T
}

export function eventFromRow<T = SessionEvent>(row: EventRow, load?: ObjectLoader): T {
  return eventFromColumns<T>(row.session_id, row.seq, row.at, row.type, row.payload, load)
}

/** `JSON.parse` of a stored event payload, undoing `packEvent` (and, with `load`, the sharing of large output with forks). */
export function parseEvent<T = SessionEvent>(payload: StoredValue, load?: ObjectLoader): T {
  const event = JSON.parse(typeof payload === "string" ? payload : decoder.decode(payload ?? new Uint8Array())) as Record<string, unknown>
  return unpackEvent(event, load) as T
}

export function unpackEvent(event: Record<string, unknown>, load?: ObjectLoader): Record<string, unknown> {
  if (Array.isArray(event.profile) && event.profile.length === 11) event.profile = expandProfile(event.profile)
  if (typeof event.zref === "string") {
    const based = load?.(event.zref)
    if (based === undefined) throw new RangeError(`[STORE]: shared output ${event.zref.slice(0, 12)} is not available`)
    event.text = based
    delete event.zref
  }
  if (typeof event.z === "number" && typeof event.text === "string") {
    event.text = decoder.decode(Bun.zstdDecompressSync(Buffer.from(event.text, "base64")))
    delete event.z
  }
  return event
}

/** The text of a payload's `text` column read through json_extract, with its `z` flag. */
export function unpackText(text: string | null, z: number | null | undefined, shared?: string | null, load?: ObjectLoader): string | null {
  if (shared) {
    const based = load?.(shared)
    if (based === undefined) throw new RangeError(`[STORE]: shared output ${shared.slice(0, 12)} is not available`)
    text = based
  }
  if (text === null || typeof z !== "number") return text
  return decoder.decode(Bun.zstdDecompressSync(Buffer.from(text, "base64")))
}
