import { createHash } from "node:crypto"
import { ID_PREFIXES, SessionId, type IdKind } from "@mendcode/protocol"
import { z } from "zod"
import { ProjectRestError } from "./project-git"

/**
 * Sync replay input to native events. A native history already carries v2 events and a v2 session ID. A donor (v1) history
 * carries versioned events (`message.updated.1`) about one aggregate; it is converted as a whole snapshot: the final state of
 * its messages and parts becomes turns, items and their text, with identifiers derived from the donor's, so replaying the
 * same donor history again is an exact retry. Runtime work, files and compaction have no native equivalent and are refused.
 */

export type ReplayEntry = { id: string; aggregateID: string; seq: number; type: string; data: Record<string, unknown> }
export type NativeReplay = { sessionId: SessionId; entries: Array<ReplayEntry & { aggregateID: SessionId }>; donor: boolean }

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
/** Converted histories stay bounded: one turn per user message, two events per item. */
const MAX_NATIVE_EVENTS = 20_000
/** Text of one item stays well inside an event (64 KiB inline text, 80 KiB per stored event). */
const MAX_ITEM_CHARS = 30_000
const MAX_TOOL_INPUT_CHARS = 3_800

function fail(code: ConstructorParameters<typeof ProjectRestError>[0], message: string): never {
  throw new ProjectRestError(code, message)
}

/** A native-shaped ID (prefix and 26 Crockford characters) derived from `key`, so the same donor ID always maps to the same native one. */
export function stableId(kind: IdKind, key: string): string {
  const bytes = createHash("sha256").update(`${kind}:${key}`).digest()
  let bits = 0
  let value = 0
  let out = ""
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5 && out.length < 26) {
      out += CROCKFORD[(value >> (bits - 5)) & 31]
      bits -= 5
    }
    value &= (1 << bits) - 1
    if (out.length === 26) break
  }
  return `${ID_PREFIXES[kind]}_${out}`
}

const DONOR_SUFFIX = /[.@]\d+$/
const DONOR_BASES: Record<string, string> = {
  "session.created": "created",
  "session.updated": "updated",
  "session.deleted": "deleted",
  "message.updated": "message",
  "message.removed": "removed",
  "message.part.updated": "part",
  "message.part.removed": "part-removed",
}
const donorBase = (type: string) => type.replace(DONOR_SUFFIX, "")
const isDonor = (type: string) => DONOR_SUFFIX.test(type)

const time = z.number().int().nonnegative()
const Created = z.looseObject({ sessionID: z.string(), info: z.looseObject({ parentID: z.string().nullish(), title: z.string().optional(), time: z.looseObject({ created: time }) }) })
const Updated = z.looseObject({ sessionID: z.string(), info: z.looseObject({ title: z.string().nullish() }) })
const DonorMessage = z.looseObject({
  id: z.string(),
  sessionID: z.string(),
  role: z.enum(["user", "assistant"]),
  time: z.looseObject({ created: time, completed: time.optional() }),
  parentID: z.string().optional(),
  error: z.looseObject({ name: z.string().optional(), data: z.looseObject({ message: z.string().optional() }).optional() }).optional(),
})
const MessageUpdated = z.looseObject({ sessionID: z.string(), info: DonorMessage })
const MessageRemoved = z.looseObject({ sessionID: z.string(), messageID: z.string() })
const PartUpdated = z.looseObject({ sessionID: z.string(), time, part: z.looseObject({ id: z.string(), messageID: z.string(), type: z.string() }) })
const PartRemoved = z.looseObject({ sessionID: z.string(), messageID: z.string(), partID: z.string() })
const TextPart = z.looseObject({ text: z.string(), synthetic: z.boolean().optional(), ignored: z.boolean().optional() })
const ReasoningPart = z.looseObject({ text: z.string() })
const ToolPart = z.looseObject({
  tool: z.string(),
  state: z.looseObject({ status: z.enum(["pending", "running", "completed", "error"]), input: z.record(z.string(), z.unknown()).optional(), output: z.string().optional(), error: z.string().optional(), title: z.string().optional() }),
})
/** Parts that carry no conversation content. */
const BOOKKEEPING = new Set(["step-start", "step-finish", "snapshot", "patch", "retry", "agent"])

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

function parse<T>(schema: z.ZodType<T>, entry: ReplayEntry): T {
  const parsed = schema.safeParse(entry.data)
  if (!parsed.success) fail("invalid_command", `Invalid donor event ${entry.type}`)
  return parsed.data
}

type StoredPart = { id: string; messageId: string; type: string; raw: Record<string, unknown>; order: number }
type StoredMessage = { info: z.infer<typeof DonorMessage>; order: number }

/** Final state of a donor history: its title, creation time and the messages and parts it ends with. */
function replayDonor(entries: ReplayEntry[]) {
  const aggregate = entries[0]!.aggregateID
  let created: z.infer<typeof Created>["info"] | undefined
  let title: string | undefined
  const messages = new Map<string, StoredMessage>()
  const parts = new Map<string, StoredPart>()
  let order = 0
  for (const entry of entries) {
    if (entry.aggregateID !== aggregate) fail("invalid_command", "Replay events must belong to one session")
    const base = donorBase(entry.type)
    const kind = DONOR_BASES[base]
    if (!isDonor(entry.type) || !kind) fail("unsupported", `Donor event ${entry.type} has no native projector; replay rejected`)
    if (kind === "created") {
      if (entry.seq !== 0 || created) fail("invalid_command", "Duplicate session creation")
      const data = parse(Created, entry)
      if (data.sessionID !== aggregate) fail("invalid_command", "Event belongs to another session")
      if (data.info.parentID) fail("unsupported", "Replay requires an independent root session")
      created = data.info
      title = data.info.title
      continue
    }
    if (!created) fail("invalid_command", "Replay requires a complete history starting with session creation")
    if (kind === "deleted") fail("unsupported", "A deleted donor session cannot be replayed")
    if (kind === "updated") {
      const data = parse(Updated, entry)
      if (data.sessionID !== aggregate) fail("invalid_command", "Event belongs to another session")
      if (typeof data.info.title === "string") title = data.info.title
      continue
    }
    if (kind === "message") {
      const data = parse(MessageUpdated, entry)
      if (data.sessionID !== aggregate || data.info.sessionID !== aggregate) fail("invalid_command", "Event belongs to another session")
      const known = messages.get(data.info.id)
      messages.set(data.info.id, { info: data.info, order: known?.order ?? order++ })
      continue
    }
    if (kind === "removed") {
      const data = parse(MessageRemoved, entry)
      messages.delete(data.messageID)
      for (const [id, part] of parts) if (part.messageId === data.messageID) parts.delete(id)
      continue
    }
    if (kind === "part") {
      const data = parse(PartUpdated, entry)
      const known = parts.get(data.part.id)
      parts.set(data.part.id, { id: data.part.id, messageId: data.part.messageID, type: data.part.type, raw: data.part, order: known?.order ?? order++ })
      continue
    }
    const data = parse(PartRemoved, entry)
    parts.delete(data.partID)
  }
  if (!created) fail("invalid_command", "Replay requires a complete history starting with session creation")
  return { created, title, messages, parts }
}

type Draft = { type: string; data: Record<string, unknown> }

/** Turns, items and text for the final donor state, in conversation order. */
function nativeDrafts(input: { donorSession: string; directory: string; replay: ReturnType<typeof replayDonor> }): Draft[] {
  const { donorSession, directory, replay } = input
  const out: Draft[] = [{ type: "session.created", data: { at: replay.created.time.created, directory, title: clip(replay.title ?? "Synced session", 200) } }]
  const ordered = [...replay.messages.values()].sort((a, b) => a.info.time.created - b.info.time.created || a.order - b.order)
  const partsOf = (messageId: string) => [...replay.parts.values()].filter((part) => part.messageId === messageId).sort((a, b) => a.order - b.order)
  const users = ordered.filter((message) => message.info.role === "user")
  const turnOf = new Map(users.map((message) => [message.info.id, { user: message, replies: [] as StoredMessage[] }]))
  let latest: ReturnType<typeof turnOf.get>
  for (const message of ordered) {
    if (message.info.role === "user") {
      latest = turnOf.get(message.info.id)
      continue
    }
    const turn = (message.info.parentID ? turnOf.get(message.info.parentID) : undefined) ?? latest
    if (!turn) fail("invalid_command", "Assistant message without a user message")
    turn.replies.push(message)
  }
  for (const { user, replies } of turnOf.values()) {
    const turnId = stableId("turn", `${donorSession}:${user.info.id}`)
    const queueId = stableId("queue", `${donorSession}:${user.info.id}`)
    const startedAt = user.info.time.created
    const text = partsOf(user.info.id)
      .filter((part) => part.type === "text" && !TextPart.parse(part.raw).synthetic && !TextPart.parse(part.raw).ignored)
      .map((part) => TextPart.parse(part.raw).text)
      .join("\n")
    for (const part of partsOf(user.info.id)) if (part.type === "file" || part.type === "subtask" || part.type === "compaction") fail("unsupported", `A donor ${part.type} part has no native equivalent; replay rejected`)
    out.push({ type: "turn.started", data: { at: startedAt, turnId, queueId } })
    const userItem = stableId("item", `${donorSession}:${user.info.id}`)
    out.push({ type: "item.started", data: { at: startedAt, turnId, itemId: userItem, kind: "user_message" } })
    out.push({ type: "item.completed", data: { at: startedAt, itemId: userItem, status: "ok", text: clip(text, MAX_ITEM_CHARS) } })
    if (!replies.length) fail("busy", "Replay requires a settled session; a user message without an answer is unfinished work")
    let endedAt = startedAt
    let failure: { code: string; message: string } | undefined
    for (const reply of replies) {
      if (reply.info.time.completed === undefined && !reply.info.error) fail("busy", "Replay requires a settled session; runtime work is never resumed")
      endedAt = Math.max(endedAt, reply.info.time.completed ?? reply.info.time.created)
      if (reply.info.error) failure = { code: clip(reply.info.error.name ?? "donor_error", 64), message: clip(reply.info.error.data?.message ?? reply.info.error.name ?? "The donor turn failed", 4000) }
      for (const part of partsOf(reply.info.id)) {
        const itemId = stableId("item", `${donorSession}:${part.id}`)
        if (part.type === "text" || part.type === "reasoning") {
          const body = (part.type === "text" ? TextPart : ReasoningPart).parse(part.raw)
          if (part.type === "text" && ((body as z.infer<typeof TextPart>).ignored || !body.text.trim())) continue
          out.push({ type: "item.started", data: { at: endedAt, turnId, itemId, kind: part.type === "text" ? "agent_message" : "reasoning" } })
          out.push({ type: "item.completed", data: { at: endedAt, itemId, status: "ok", text: clip(body.text, MAX_ITEM_CHARS) } })
        } else if (part.type === "tool") {
          const tool = ToolPart.parse(part.raw)
          if (tool.state.status === "pending" || tool.state.status === "running") fail("busy", "Replay requires a settled session; runtime work is never resumed")
          out.push({ type: "item.started", data: { at: endedAt, turnId, itemId, kind: "tool_call", meta: { tool: clip(tool.tool, 200), ...(tool.state.title ? { title: clip(tool.state.title, 200) } : {}) } } })
          out.push({
            type: "item.completed",
            data: { at: endedAt, itemId, status: tool.state.status === "error" ? "error" : "ok", text: clip((tool.state.status === "error" ? tool.state.error : tool.state.output) ?? "", MAX_ITEM_CHARS), ...(tool.state.input ? { toolInput: clip(JSON.stringify(tool.state.input), MAX_TOOL_INPUT_CHARS) } : {}) },
          })
        } else if (part.type === "file" || part.type === "subtask" || part.type === "compaction") fail("unsupported", `A donor ${part.type} part has no native equivalent; replay rejected`)
        else if (!BOOKKEEPING.has(part.type)) fail("unsupported", `Donor part type ${part.type} has no native equivalent; replay rejected`)
      }
    }
    out.push(failure ? { type: "turn.failed", data: { at: endedAt, turnId, error: failure } } : { type: "turn.completed", data: { at: endedAt, turnId } })
    if (out.length > MAX_NATIVE_EVENTS) fail("busy", "Converted donor history exceeds the replay limit")
  }
  return out
}

/** The history to validate and store: native entries as sent, or the conversion of a donor snapshot. */
export function normalizeReplay(input: { directory: string; events: ReplayEntry[] }): NativeReplay {
  const { events } = input
  const donors = events.filter((entry) => isDonor(entry.type)).length
  if (donors && donors !== events.length) fail("invalid_command", "A history cannot mix donor and native events")
  if (!donors) {
    const source = SessionId.safeParse(events[0]!.aggregateID)
    if (!source.success) fail("invalid_command", "Invalid native sync event")
    return { sessionId: source.data, entries: events.map((entry) => ({ ...entry, aggregateID: source.data })), donor: false }
  }
  if (events[0]!.seq !== 0) fail("unsupported", "A donor history replays as a complete snapshot starting at sequence zero")
  const sorted = [...events]
  for (const [index, entry] of sorted.entries()) if (entry.seq !== index) fail("invalid_command", "Replay requires one complete contiguous history starting at zero")
  const donorSession = events[0]!.aggregateID
  const drafts = nativeDrafts({ donorSession, directory: input.directory, replay: replayDonor(sorted) })
  const sessionId = stableId("session", donorSession) as SessionId
  return { sessionId, donor: true, entries: drafts.map((draft, index) => ({ id: `${sessionId}:${index}`, aggregateID: sessionId, seq: index, type: draft.type, data: draft.data })) }
}
