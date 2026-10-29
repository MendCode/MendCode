import type { BlobRef, ItemId, ItemKind, SessionId, TurnId } from "@mendcode/protocol"
import { MAX_INLINE_TEXT } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"
import { titleFrom } from "@mendcode/store"
import type { ContextBuilder } from "./engine-context"
import { derivedId } from "./ids"
import { skipPart, type SessionStats } from "./report"
import { INLINE_JSON_BUDGET, MAX_ATTACHMENTS, MAX_META_VALUE, MAX_TITLE, PREVIEW_CHARS } from "./settings"
import { isRecord, type JsonRecord, type V1Message, type V1Part, type V1Session } from "./v1-reader"

export type SessionEventDraft = Parameters<Store["sessionSink"]["append"]>[0]
/** One event to append, with the v1 instant it happened at. */
export type Step = { at: number; draft: SessionEventDraft }

/** Stores bytes and returns their reference; identical bytes give the same reference. */
export type BlobPort = { put(bytes: Uint8Array, mime: string): BlobRef }

export type SessionSource = {
  messages: V1Message[]
  /** The parts of one message; called once per message so only one message's parts are in memory. */
  partsOf(messageId: string): V1Part[]
}

export type MapInput = {
  session: V1Session
  sessionId: SessionId
  parentId?: SessionId
  source: SessionSource
  blobs: BlobPort
  stats: SessionStats
  context: ContextBuilder
}

const encoder = new TextEncoder()

const str = (value: unknown) => (typeof value === "string" ? value : "")
const finiteTime = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined)
const time = (record: JsonRecord, key: string) => (isRecord(record.time) ? finiteTime(record.time[key]) : undefined)
const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text)

/** Text cut to `max` characters without splitting a surrogate pair. */
function preview(text: string, max: number) {
  let end = Math.min(text.length, max)
  const last = text.charCodeAt(end - 1)
  if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--
  return `${text.slice(0, end)}…`
}

export type DataUrl = { mime: string; bytes: Uint8Array }

/** Decodes a `data:` URL; throws on anything that is not one or whose payload is not valid. */
export function decodeDataUrl(url: string): DataUrl {
  const match = /^data:([^,]*),([\s\S]*)$/.exec(url)
  if (!match) throw new TypeError("file part: not a data URL")
  const [, header = "", payload = ""] = match
  const fields = header.split(";")
  const base64 = fields.at(-1) === "base64"
  const mime = clip((base64 ? fields.slice(0, -1) : fields)[0]?.trim() || "application/octet-stream", 255)
  if (!base64) return { mime, bytes: encoder.encode(decodeURIComponent(payload)) }
  // URL-safe base64 (`-`/`_`) decodes to the same bytes once mapped back to the standard alphabet.
  const clean = payload.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/")
  if (clean.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new TypeError("file part: invalid base64 payload")
  return { mime, bytes: new Uint8Array(Buffer.from(clean, "base64")) }
}

function tryDecodeDataUrl(url: string): DataUrl | undefined {
  try {
    return decodeDataUrl(url)
  } catch {
    return undefined
  }
}

/** Maps a v1 tool state to the v2 item status. */
const toolStatus = (status: string) => (status === "completed" ? "ok" : status === "error" ? "error" : "interrupted")

/**
 * Turns one v1 session into v2 events, in order, while recording the model history it implies. Nothing is held
 * beyond one message's parts. `at` never decreases; every draft passes the protocol schemas.
 */
export function* mapSession({ session, sessionId, parentId, source, blobs, stats, context }: MapInput): Generator<Step> {
  let at = session.createdAt
  /** The instant of the next event: the wanted time, never earlier than the previous event. */
  const when = (wanted: number | undefined) => {
    if (wanted !== undefined && wanted > at) at = wanted
    return at
  }

  type OpenTurn = {
    turnId: TurnId
    lastAssistant: JsonRecord | undefined
    compaction: { itemId: ItemId; auto: boolean } | undefined
  }
  let turn: OpenTurn | undefined

  function placeText(text: string): { text?: string; blob?: BlobRef } {
    if (text.length === 0) return {}
    if (text.length <= MAX_INLINE_TEXT && JSON.stringify(text).length <= INLINE_JSON_BUDGET) return { text }
    stats.longTexts++
    return { text: preview(text, PREVIEW_CHARS), blob: blobs.put(encoder.encode(text), "text/plain") }
  }

  function* item(input: { key: string; kind: ItemKind; meta?: Record<string, string | number | boolean>; start?: number; end?: number; status: "ok" | "error" | "interrupted" | "unknown"; text?: string; attachments?: BlobRef[] }): Generator<Step> {
    const itemId = derivedId("item", `${session.id}:${input.key}`, at)
    const started = when(input.start)
    yield { at: started, draft: { type: "item.started", sessionId, turnId: turn!.turnId, itemId, kind: input.kind, ...(input.meta ? { meta: input.meta } : {}) } }
    const placed = placeText(input.text ?? "")
    const completed = when(input.end)
    yield {
      at: completed,
      draft: {
        type: "item.completed",
        sessionId,
        itemId,
        status: input.status,
        ...(placed.text !== undefined ? { text: placed.text } : {}),
        ...(placed.blob ? { blob: placed.blob } : {}),
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      },
    }
    stats.items[input.kind]++
  }

  function* startTurn(message: V1Message): Generator<Step> {
    const created = time(message.data, "created") ?? finiteTime(message.createdAt)
    const turnId = derivedId("turn", `${session.id}:${message.id}`, created ?? at)
    turn = { turnId, lastAssistant: undefined, compaction: undefined }
    yield { at: when(created), draft: { type: "turn.started", sessionId, turnId, queueId: derivedId("queue", `${session.id}:${message.id}`, created ?? at) } }
  }

  function* startCompaction(part: V1Part): Generator<Step> {
    if (!turn || turn.compaction) return
    const itemId = derivedId("item", `${session.id}:${part.id}`, at)
    const auto = part.data.auto === true
    yield { at: when(finiteTime(part.createdAt)), draft: { type: "item.started", sessionId, turnId: turn.turnId, itemId, kind: "compaction", meta: { auto } } }
    turn.compaction = { itemId, auto }
  }

  /** Completes the turn's open compaction with the summary text (or none: the compaction never produced one). */
  function* finishCompaction(summary: string, end: number | undefined, messageKey: string): Generator<Step> {
    if (!turn) return
    const open = turn.compaction
    turn.compaction = undefined
    if (!open) {
      yield* item({ key: `${messageKey}:summary`, kind: "compaction", meta: { auto: false }, status: summary.trim() ? "ok" : "unknown", text: summary, ...(end !== undefined ? { start: end, end } : {}) })
    } else {
      const placed = placeText(summary)
      yield {
        at: when(end),
        draft: { type: "item.completed", sessionId, itemId: open.itemId, status: summary.trim() ? "ok" : "unknown", ...(placed.text !== undefined ? { text: placed.text } : {}), ...(placed.blob ? { blob: placed.blob } : {}) },
      }
      stats.items.compaction++
    }
    context.compaction(summary)
  }

  function* endTurn(): Generator<Step> {
    if (!turn) return
    const open = turn
    if (open.compaction) yield* finishCompaction("", undefined, open.turnId)
    turn = undefined
    const last = open.lastAssistant
    const finished = when(last ? time(last, "completed") : undefined)
    const error = last && isRecord(last.error) ? last.error : undefined
    if (!last) {
      stats.turns.interrupted++
      yield { at: finished, draft: { type: "turn.interrupted", sessionId, turnId: open.turnId, reason: "restart" } }
    } else if (error) {
      if (error.name === "MessageAbortedError") {
        stats.turns.cancelled++
        yield { at: finished, draft: { type: "turn.cancelled", sessionId, turnId: open.turnId, by: "user" } }
      } else {
        stats.turns.failed++
        const detail = isRecord(error.data) ? str(error.data.message) : ""
        yield { at: finished, draft: { type: "turn.failed", sessionId, turnId: open.turnId, error: { code: "v1_error", message: clip(detail || str(error.name) || "v1 error", 4000) } } }
      }
    } else {
      stats.turns.completed++
      yield { at: finished, draft: { type: "turn.completed", sessionId, turnId: open.turnId } }
    }
  }

  function* userMessage(message: V1Message, parts: V1Part[]): Generator<Step> {
    const segments: string[] = []
    const attachments: BlobRef[] = []
    let compaction: V1Part | undefined
    for (const part of parts) {
      const type = str(part.data.type)
      if (type === "text") {
        if (part.data.synthetic === true || part.data.ignored === true) skipPart(stats, "text (synthetic or ignored)")
        else if (str(part.data.text).length > 0) segments.push(str(part.data.text))
        else skipPart(stats, "text (empty)")
      } else if (type === "file") {
        const filename = str(part.data.filename) || "file"
        const url = str(part.data.url)
        const decoded = url.startsWith("data:") && attachments.length < MAX_ATTACHMENTS ? tryDecodeDataUrl(url) : undefined
        if (decoded) {
          const ref = blobs.put(decoded.bytes, decoded.mime)
          attachments.push({ ...ref, name: clip(filename, 255) })
          stats.attachments.push({ sha256: ref.sha256, bytes: decoded.bytes.byteLength })
        } else if (url.startsWith("data:") && attachments.length < MAX_ATTACHMENTS) {
          // One damaged attachment must not cost the whole session: keep a marker in the message instead.
          skipPart(stats, "file (unreadable data)")
          segments.push(`[file: ${filename} (not attached: unreadable data)]`)
        } else if (url.startsWith("data:")) {
          stats.notAttached++
          segments.push(`[file: ${filename} (not attached: more than ${MAX_ATTACHMENTS} files)]`)
        } else segments.push(`[file: ${filename} ${url}]`)
      } else if (type === "compaction") compaction ??= part
      else skipPart(stats, type || "unknown")
    }
    const text = segments.join("\n\n")
    if (text.length > 0 || attachments.length > 0) {
      const created = time(message.data, "created") ?? finiteTime(message.createdAt)
      yield* item({ key: message.id, kind: "user_message", status: "ok", text, attachments, ...(created !== undefined ? { start: created, end: created } : {}) })
      context.user(text, attachments)
    } else if (!compaction) skipPart(stats, "user message (empty)")
    if (compaction) yield* startCompaction(compaction)
  }

  function* assistantMessage(message: V1Message, parts: V1Part[]): Generator<Step> {
    if (!turn) return
    turn.lastAssistant = message.data
    if (message.data.summary === true) {
      const summary = parts
        .filter((part) => part.data.type === "text" && part.data.ignored !== true)
        .map((part) => str(part.data.text))
        .join("\n\n")
      for (const part of parts) if (part.data.type !== "text") skipPart(stats, `${str(part.data.type) || "unknown"} (summary message)`)
      yield* finishCompaction(summary, time(message.data, "completed") ?? time(message.data, "created"), message.id)
      return
    }
    for (const part of parts) {
      const type = str(part.data.type)
      const start = time(part.data, "start") ?? finiteTime(part.createdAt)
      const end = time(part.data, "end")
      if (type === "reasoning") {
        const text = str(part.data.text)
        if (!text.trim()) skipPart(stats, "reasoning (empty)")
        else yield* item({ key: part.id, kind: "reasoning", status: "ok", text, ...(start !== undefined ? { start } : {}), ...(end !== undefined ? { end } : {}) })
      } else if (type === "text") {
        const text = str(part.data.text)
        if (part.data.ignored === true) skipPart(stats, "text (ignored)")
        else if (!text.trim()) skipPart(stats, "text (empty)")
        else {
          yield* item({ key: part.id, kind: "agent_message", status: "ok", text, ...(start !== undefined ? { start } : {}), ...(end !== undefined ? { end } : {}) })
          context.assistantText(text)
        }
      } else if (type === "tool") yield* toolCall(part)
      else if (type === "compaction") yield* startCompaction(part)
      else skipPart(stats, type === "file" ? "file (assistant message)" : type || "unknown")
    }
  }

  function* toolCall(part: V1Part): Generator<Step> {
    const state = isRecord(part.data.state) ? part.data.state : {}
    const name = str(part.data.tool) || "tool"
    const status = toolStatus(str(state.status))
    const title = str(state.title) || name
    const output = typeof state.output === "string" ? state.output : state.output === undefined || state.output === null ? "" : JSON.stringify(state.output)
    const failure = str(state.error)
    const text = status === "error" ? failure || output : status === "ok" ? output : ""
    const start = time(state, "start") ?? finiteTime(part.createdAt)
    const end = time(state, "end")
    yield* item({
      key: part.id,
      kind: "tool_call",
      meta: { tool: clip(name, MAX_META_VALUE), title: clip(title, MAX_META_VALUE) },
      status,
      text,
      ...(start !== undefined ? { start } : {}),
      ...(end !== undefined ? { end } : {}),
    })
    context.tool({
      callId: str(part.data.callID) || part.id,
      name,
      args: state.input ?? {},
      output: status === "interrupted" ? "interrupted: this tool call never finished in legacy MendCode" : text,
      isError: status !== "ok",
    })
  }

  const title = clip(session.title || titleFrom(firstUserText(source)), MAX_TITLE)
  yield { at: session.createdAt, draft: { type: "session.created", sessionId, directory: clip(session.directory, 4096), title, ...(parentId ? { parentId } : {}) } }

  for (const message of source.messages) {
    stats.messages++
    const role = str(message.data.role)
    if (role !== "user" && role !== "assistant") {
      skipPart(stats, `message (${role || "no role"})`)
      continue
    }
    const parts = source.partsOf(message.id)
    if (role === "user") {
      yield* endTurn()
      yield* startTurn(message)
      yield* userMessage(message, parts)
    } else {
      if (!turn) yield* startTurn(message)
      yield* assistantMessage(message, parts)
    }
  }
  yield* endTurn()
}

/** Title fallback for a session v1 left untitled: the first real user text. */
function firstUserText(source: SessionSource) {
  for (const message of source.messages) {
    if (message.data.role !== "user") continue
    for (const part of source.partsOf(message.id)) if (part.data.type === "text" && part.data.synthetic !== true && part.data.ignored !== true && str(part.data.text).trim()) return str(part.data.text)
  }
  return ""
}
