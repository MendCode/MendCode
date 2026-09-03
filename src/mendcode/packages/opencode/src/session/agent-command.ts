import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import * as InstanceState from "@/effect/instance-state"
import { Database, eq } from "@/storage/db"
import { NotFoundError } from "@/storage/storage"
import { zod } from "@/util/effect-zod"
import { NonNegativeInt, withStatics } from "@/util/schema"
import { inArray } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { AgentCommandPolicy } from "./agent-command-policy"
import { AgentViewMetadata } from "./agent-view-metadata"
import { AgentCommandTable, BackgroundSessionTable, SessionTable } from "./session.sql"
import { AgentCommandID, SessionID } from "./schema"

export const CommandType = Schema.Literals([
  "request_summary",
  "rename",
  "tag",
  "pause_after_turn",
  "stop",
  "send_message",
  "peer_message",
]).pipe(withStatics((s) => ({ zod: zod(s) })))
export type CommandType = Schema.Schema.Type<typeof CommandType>

export const State = Schema.Literals([
  "pending",
  "accepted",
  "running",
  "completed",
  "rejected",
  "failed",
  "expired",
]).pipe(withStatics((s) => ({ zod: zod(s) })))
export type State = Schema.Schema.Type<typeof State>

const RequestSummaryPayload = Schema.Struct({
  instructions: Schema.optional(Schema.String),
})
const RenamePayload = Schema.Struct({
  title: Schema.String,
})
const TagPayload = Schema.Struct({
  tags: Schema.Array(Schema.String),
})
const PauseAfterTurnPayload = Schema.Struct({
  reason: Schema.optional(Schema.String),
})
const StopPayload = Schema.Struct({
  reason: Schema.optional(Schema.String),
})
const SendMessagePayload = Schema.Struct({
  text: Schema.String,
})
const PeerMessagePayload = Schema.Struct({
  text: Schema.String,
  sourceTitle: Schema.optional(Schema.String),
})

const Payload = Schema.Union([
  RequestSummaryPayload,
  RenamePayload,
  TagPayload,
  PauseAfterTurnPayload,
  StopPayload,
  SendMessagePayload,
  PeerMessagePayload,
])
type Payload = Schema.Schema.Type<typeof Payload>

export const Create = Schema.Union([
  Schema.Struct({
    sourceSessionID: SessionID,
    type: Schema.Literal("request_summary"),
    payload: Schema.optional(RequestSummaryPayload),
    expiresAt: Schema.optional(NonNegativeInt),
  }),
  Schema.Struct({
    sourceSessionID: SessionID,
    type: Schema.Literal("rename"),
    payload: RenamePayload,
    expiresAt: Schema.optional(NonNegativeInt),
  }),
  Schema.Struct({
    sourceSessionID: SessionID,
    type: Schema.Literal("tag"),
    payload: TagPayload,
    expiresAt: Schema.optional(NonNegativeInt),
  }),
  Schema.Struct({
    sourceSessionID: SessionID,
    type: Schema.Literal("pause_after_turn"),
    payload: Schema.optional(PauseAfterTurnPayload),
    expiresAt: Schema.optional(NonNegativeInt),
  }),
  Schema.Struct({
    sourceSessionID: SessionID,
    type: Schema.Literal("stop"),
    payload: Schema.optional(StopPayload),
    expiresAt: Schema.optional(NonNegativeInt),
  }),
  Schema.Struct({
    sourceSessionID: SessionID,
    type: Schema.Literal("send_message"),
    payload: SendMessagePayload,
    expiresAt: Schema.optional(NonNegativeInt),
  }),
  Schema.Struct({
    sourceSessionID: SessionID,
    type: Schema.Literal("peer_message"),
    payload: Schema.Struct({ text: Schema.String }),
    expiresAt: Schema.optional(NonNegativeInt),
  }),
])
  .annotate({ identifier: "AgentCommandCreate" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Create = Schema.Schema.Type<typeof Create>

export const Update = Schema.Struct({
  state: Schema.optional(State),
  error: Schema.optional(Schema.NullOr(Schema.String)),
  result: Schema.optional(Schema.NullOr(Schema.String)),
})
  .annotate({ identifier: "AgentCommandUpdate" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Update = Schema.Schema.Type<typeof Update>

const InfoBase = {
  id: AgentCommandID,
  sourceSessionID: SessionID,
  targetSessionID: SessionID,
  state: State,
  permissions: Schema.Array(Schema.String),
  policy: AgentCommandPolicy.Info,
  error: Schema.optional(Schema.String),
  result: Schema.optional(Schema.String),
  expiresAt: Schema.optional(NonNegativeInt),
  time: Schema.Struct({
    created: NonNegativeInt,
    updated: NonNegativeInt,
  }),
}

export const Info = Schema.Union([
  Schema.Struct({ ...InfoBase, type: Schema.Literal("request_summary"), payload: RequestSummaryPayload }),
  Schema.Struct({ ...InfoBase, type: Schema.Literal("rename"), payload: RenamePayload }),
  Schema.Struct({ ...InfoBase, type: Schema.Literal("tag"), payload: TagPayload }),
  Schema.Struct({ ...InfoBase, type: Schema.Literal("pause_after_turn"), payload: PauseAfterTurnPayload }),
  Schema.Struct({ ...InfoBase, type: Schema.Literal("stop"), payload: StopPayload }),
  Schema.Struct({ ...InfoBase, type: Schema.Literal("send_message"), payload: SendMessagePayload }),
  Schema.Struct({ ...InfoBase, type: Schema.Literal("peer_message"), payload: PeerMessagePayload }),
])
  .annotate({ identifier: "AgentCommand" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Info = Schema.Schema.Type<typeof Info>

export type ListInput = {
  sourceSessionID?: SessionID
  targetSessionID?: SessionID
  state?: State
}

export type CreateInput = Create & {
  targetSessionID: SessionID
}

export type UpdateInput = Update & {
  id: AgentCommandID
  targetSessionID?: SessionID
}

export class InvalidStateTransitionError extends Schema.TaggedErrorClass<InvalidStateTransitionError>()(
  "AgentCommandInvalidStateTransitionError",
  {
    commandID: AgentCommandID,
    from: State,
    to: State,
  },
) {
  override get message() {
    return `Invalid agent command state transition: ${this.from} -> ${this.to}`
  }
}

export class InvalidTargetError extends Schema.TaggedErrorClass<InvalidTargetError>()(
  "AgentCommandInvalidTargetError",
  {
    sourceSessionID: SessionID,
    targetSessionID: SessionID,
  },
) {
  override get message() {
    return "Session messages require a different target session."
  }
}

export const Event = {
  Created: BusEvent.define(
    "agent_command.created",
    Schema.Struct({
      commandID: AgentCommandID,
      sourceSessionID: SessionID,
      targetSessionID: SessionID,
      info: Info,
    }),
  ),
  Updated: BusEvent.define(
    "agent_command.updated",
    Schema.Struct({
      commandID: AgentCommandID,
      sourceSessionID: SessionID,
      targetSessionID: SessionID,
      info: Info,
    }),
  ),
}

type Row = typeof AgentCommandTable.$inferSelect

type Data = {
  type: CommandType
  payload: Payload
  permissions: readonly string[]
  policy?: AgentCommandPolicy.Info
  error?: string
  result?: string
  expiresAt?: number
}

type SessionRowLike = Pick<typeof SessionTable.$inferSelect, "directory" | "workspace_id">
type BackgroundRowLike = Pick<typeof BackgroundSessionTable.$inferSelect, "data">

function policyNeedsRefresh(policy?: AgentCommandPolicy.Info) {
  return !policy || policy.ownership?.targetWriter !== undefined
}

function toPolicySession(input?: SessionRowLike) {
  if (!input) return undefined
  return {
    directory: input.directory,
    workspaceID: input.workspace_id ?? undefined,
  }
}

function toPolicyOwnership(input?: BackgroundRowLike) {
  return undefined
}

export interface Interface {
  readonly get: (id: AgentCommandID) => Effect.Effect<Info, InstanceType<typeof NotFoundError>>
  readonly list: (input?: ListInput) => Effect.Effect<Info[]>
  readonly create: (input: CreateInput) => Effect.Effect<Info, InstanceType<typeof NotFoundError> | InvalidTargetError>
  readonly update: (
    input: UpdateInput,
  ) => Effect.Effect<Info, InstanceType<typeof NotFoundError> | InvalidStateTransitionError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AgentCommand") {}

const terminalStates = new Set<State>(["completed", "rejected", "failed", "expired"])
const defaultCommandTTL = 30 * 60 * 1_000
const maxPeerMessageTTL = 24 * 60 * 60 * 1_000
const maxPendingPerTarget = 3
const transitions: Record<State, readonly State[]> = {
  pending: ["accepted", "running", "rejected", "expired"],
  accepted: ["running", "completed", "rejected", "failed", "expired"],
  running: ["completed", "failed", "rejected", "expired"],
  completed: [],
  rejected: [],
  failed: [],
  expired: [],
}

function normalizeString(value: string | undefined, maxLength: number) {
  if (value === undefined) return undefined
  const trimmed = value.trim().slice(0, maxLength)
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizeTags(value: readonly string[]) {
  const seen = new Set<string>()
  return value
    .map((item) => item.trim().slice(0, 40))
    .filter((item) => {
      if (!item || seen.has(item)) return false
      seen.add(item)
      return true
    })
    .slice(0, 20)
}

function payloadFor(input: Create, sourceTitle?: string): Payload {
  if (input.type === "request_summary") return { instructions: normalizeString(input.payload?.instructions, 1_000) }
  if (input.type === "rename")
    return { title: normalizeString(input.payload.title, 120) ?? input.payload.title.trim().slice(0, 120) }
  if (input.type === "tag") return { tags: normalizeTags(input.payload.tags) }
  if (input.type === "send_message")
    return { text: normalizeString(input.payload.text, 4_000) ?? input.payload.text.trim().slice(0, 4_000) }
  if (input.type === "peer_message") {
    const text = normalizeString(input.payload.text, 4_000)
    if (!text) throw new Error("Session message text cannot be empty.")
    return {
      text,
      sourceTitle: normalizeString(sourceTitle, 120),
    }
  }
  return { reason: normalizeString(input.payload?.reason, 1_000) }
}

function canTransition(from: State, to: State) {
  if (from === to) return true
  if (terminalStates.has(from)) return false
  return transitions[from].includes(to)
}

function commandExpired(row: Row, now: number) {
  return row.state === "pending" && row.data.expiresAt !== undefined && row.data.expiresAt <= now
}

function commandOccupiesQueue(row: Row, now: number) {
  if (row.state === "pending") return !commandExpired(row, now)
  return row.state === "accepted" || row.state === "running"
}

function commandPayloadKey(input: Pick<Data, "type" | "payload">) {
  return `${input.type}:${JSON.stringify(input.payload)}`
}

function expireRow(row: Row, now: number): Row {
  return {
    ...row,
    state: "expired",
    time_updated: now,
    data: {
      ...row.data,
      error: row.data.error ?? "Command expired before the target accepted it.",
    },
  }
}

function notFound(id: AgentCommandID) {
  return new NotFoundError({ message: `Agent command not found: ${id}` })
}

function sessionNotFound(id: SessionID) {
  return new NotFoundError({ message: `Session not found: ${id}` })
}

function commandProjectID(row: Pick<Row, "source_session_id" | "target_session_id">) {
  const sessions = Database.use((db) =>
    db
      .select({ projectID: SessionTable.project_id })
      .from(SessionTable)
      .where(inArray(SessionTable.id, [row.source_session_id, row.target_session_id]))
      .all(),
  )
  if (sessions.length !== 2) return undefined
  if (sessions[0]!.projectID !== sessions[1]!.projectID) return undefined
  return sessions[0]!.projectID
}

function fallbackPolicy(
  row: Row,
  input?: { source?: SessionRowLike; target?: SessionRowLike; targetBackground?: BackgroundRowLike },
) {
  if (!policyNeedsRefresh(row.data.policy)) return row.data.policy
  return AgentCommandPolicy.evaluate({
    type: row.data.type,
    source: toPolicySession(input?.source),
    target: toPolicySession(input?.target),
    ownership: toPolicyOwnership(input?.targetBackground),
  })
}

function fromRow(
  row: Row,
  input?: { source?: SessionRowLike; target?: SessionRowLike; targetBackground?: BackgroundRowLike },
): Info {
  return Schema.decodeUnknownSync(Info)({
    id: row.id,
    sourceSessionID: row.source_session_id,
    targetSessionID: row.target_session_id,
    state: row.state,
    ...row.data,
    permissions: [...row.data.permissions],
    policy: fallbackPolicy(row, input),
    time: {
      created: row.time_created,
      updated: row.time_updated,
    },
  })
}

function matchesInput(info: Info, input?: ListInput) {
  if (!input) return true
  if (input.sourceSessionID && info.sourceSessionID !== input.sourceSessionID) return false
  if (input.targetSessionID && info.targetSessionID !== input.targetSessionID) return false
  if (input.state && info.state !== input.state) return false
  return true
}

function eventPayload(info: Info) {
  return {
    commandID: info.id,
    sourceSessionID: info.sourceSessionID,
    targetSessionID: info.targetSessionID,
    info,
  }
}

function metadataPatchForCommand(info: Info): AgentViewMetadata.Patch | undefined {
  if (info.state !== "accepted") return undefined
  if (info.type === "rename") return { title: info.payload.title }
  if (info.type === "tag") return { tags: info.payload.tags }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const metadata = yield* AgentViewMetadata.Service

    const expireDueCommands = Effect.fn("AgentCommand.expireDueCommands")(function* () {
      const projectID = (yield* InstanceState.context).project.id
      const now = Date.now()
      const expired = Database.use((db) => db.select().from(AgentCommandTable).all())
        .filter((row) => commandProjectID(row) === projectID && commandExpired(row, now))
        .map((row) => expireRow(row, now))
      for (const row of expired) {
        Database.use((db) =>
          db
            .update(AgentCommandTable)
            .set({ state: row.state, time_updated: row.time_updated, data: row.data })
            .where(eq(AgentCommandTable.id, row.id))
            .run(),
        )
        yield* bus.publish(Event.Updated, eventPayload(fromRow(row)))
      }
    })

    const get = Effect.fn("AgentCommand.get")(function* (id: AgentCommandID) {
      yield* expireDueCommands()
      const row = Database.use((db) => db.select().from(AgentCommandTable).where(eq(AgentCommandTable.id, id)).get())
      if (!row || commandProjectID(row) !== (yield* InstanceState.context).project.id)
        return yield* Effect.fail(notFound(id))
      const source = Database.use((db) =>
        db.select().from(SessionTable).where(eq(SessionTable.id, row.source_session_id)).get(),
      )
      const target = Database.use((db) =>
        db.select().from(SessionTable).where(eq(SessionTable.id, row.target_session_id)).get(),
      )
      const targetBackground = Database.use((db) =>
        db
          .select()
          .from(BackgroundSessionTable)
          .where(eq(BackgroundSessionTable.session_id, row.target_session_id))
          .get(),
      )
      return fromRow(row, { source, target, targetBackground })
    })

    const list = Effect.fn("AgentCommand.list")(function* (input?: ListInput) {
      yield* expireDueCommands()
      const currentProjectID = (yield* InstanceState.context).project.id
      const scopedProjectID =
        input?.sourceSessionID || input?.targetSessionID
          ? Database.use(
              (db) =>
                db
                  .select({ projectID: SessionTable.project_id })
                  .from(SessionTable)
                  .where(eq(SessionTable.id, input.sourceSessionID ?? input.targetSessionID!))
                  .get()?.projectID,
            )
          : currentProjectID
      if (!scopedProjectID || scopedProjectID !== currentProjectID) return []
      const rows = Database.use((db) => db.select().from(AgentCommandTable).all())
      return rows
        .filter((row) => commandProjectID(row) === scopedProjectID)
        .map((row) => {
          const source = Database.use((db) =>
            db.select().from(SessionTable).where(eq(SessionTable.id, row.source_session_id)).get(),
          )
          const target = Database.use((db) =>
            db.select().from(SessionTable).where(eq(SessionTable.id, row.target_session_id)).get(),
          )
          const targetBackground = Database.use((db) =>
            db
              .select()
              .from(BackgroundSessionTable)
              .where(eq(BackgroundSessionTable.session_id, row.target_session_id))
              .get(),
          )
          return fromRow(row, { source, target, targetBackground })
        })
        .filter((info) => matchesInput(info, input))
        .toSorted((a, b) => b.time.updated - a.time.updated || b.id.localeCompare(a.id))
    })

    const create = Effect.fn("AgentCommand.create")(function* (input: CreateInput) {
      yield* expireDueCommands()
      const result = Database.transaction((db) => {
        const now = Date.now()
        const source = db.select().from(SessionTable).where(eq(SessionTable.id, input.sourceSessionID)).get()
        const target = db.select().from(SessionTable).where(eq(SessionTable.id, input.targetSessionID)).get()
        const targetBackground = db
          .select()
          .from(BackgroundSessionTable)
          .where(eq(BackgroundSessionTable.session_id, input.targetSessionID))
          .get()
        if (!source) return sessionNotFound(input.sourceSessionID)
        if (!target || source.project_id !== target.project_id) return sessionNotFound(input.targetSessionID)
        if (input.type === "peer_message" && source.id === target.id) {
          return new InvalidTargetError({ sourceSessionID: source.id, targetSessionID: target.id })
        }
        const policy = AgentCommandPolicy.evaluate({
          type: input.type,
          source: toPolicySession(source),
          target: toPolicySession(target),
          ownership: toPolicyOwnership(targetBackground),
        })
        const payload = payloadFor(input, source.title)
        const duplicate = db
          .select()
          .from(AgentCommandTable)
          .where(eq(AgentCommandTable.target_session_id, input.targetSessionID))
          .all()
          .find(
            (row) =>
              commandOccupiesQueue(row, now) &&
              row.source_session_id === input.sourceSessionID &&
              commandPayloadKey(row.data) === commandPayloadKey({ type: input.type, payload }),
          )
        if (duplicate) return { info: fromRow(duplicate, { source, target, targetBackground }), created: false }
        const queuedForTarget = db
          .select()
          .from(AgentCommandTable)
          .where(eq(AgentCommandTable.target_session_id, input.targetSessionID))
          .all()
          .filter((row) => commandOccupiesQueue(row, now)).length
        const requestedExpiresAt = input.expiresAt ?? now + defaultCommandTTL
        const expiresAt =
          input.type === "peer_message" ? Math.min(requestedExpiresAt, now + maxPeerMessageTTL) : requestedExpiresAt
        const overLimit = queuedForTarget >= maxPendingPerTarget
        const autoAccept = input.type === "peer_message" && policy.decision === "safe_auto"
        const row = {
          id: AgentCommandID.ascending(),
          source_session_id: input.sourceSessionID,
          target_session_id: input.targetSessionID,
          state: (expiresAt <= now ? "expired" : overLimit ? "rejected" : autoAccept ? "accepted" : "pending") as State,
          time_created: now,
          time_updated: now,
          data: {
            type: input.type,
            payload,
            permissions: policy.permissions,
            policy,
            expiresAt,
            ...(overLimit
              ? {
                  error: `Target already has ${maxPendingPerTarget} queued commands; wait for one to finish before sending another.`,
                }
              : {}),
            ...(expiresAt <= now ? { error: "Command expired before it could be queued." } : {}),
          } satisfies Data,
        }
        db.insert(AgentCommandTable).values(row).run()
        return { info: fromRow(row, { source, target, targetBackground }), created: true }
      })
      if (result instanceof NotFoundError || result instanceof InvalidTargetError) return yield* Effect.fail(result)
      if (result.created) yield* bus.publish(Event.Created, eventPayload(result.info))
      return result.info
    })

    const update = Effect.fn("AgentCommand.update")(function* (input: UpdateInput) {
      yield* expireDueCommands()
      const projectID = (yield* InstanceState.context).project.id
      const info = Database.transaction((db) => {
        const row = db.select().from(AgentCommandTable).where(eq(AgentCommandTable.id, input.id)).get()
        if (!row || (input.targetSessionID && row.target_session_id !== input.targetSessionID))
          return notFound(input.id)
        if (commandProjectID(row) !== projectID) return notFound(input.id)
        const state = input.state ?? row.state
        if (!canTransition(row.state, state)) {
          return new InvalidStateTransitionError({ commandID: input.id, from: row.state, to: state })
        }
        const needsPolicyRefresh = policyNeedsRefresh(row.data.policy)
        const source = needsPolicyRefresh
          ? db.select().from(SessionTable).where(eq(SessionTable.id, row.source_session_id)).get()
          : undefined
        const target = needsPolicyRefresh
          ? db.select().from(SessionTable).where(eq(SessionTable.id, row.target_session_id)).get()
          : undefined
        const targetBackground = needsPolicyRefresh
          ? db
              .select()
              .from(BackgroundSessionTable)
              .where(eq(BackgroundSessionTable.session_id, row.target_session_id))
              .get()
          : undefined
        const next = {
          ...row,
          state,
          time_updated: Date.now(),
          data: {
            ...row.data,
            ...(needsPolicyRefresh ? { policy: fallbackPolicy(row, { source, target, targetBackground }) } : {}),
            ...(input.error !== undefined ? { error: normalizeString(input.error ?? undefined, 4_000) } : {}),
            ...(input.result !== undefined ? { result: normalizeString(input.result ?? undefined, 4_000) } : {}),
          },
        }
        db.update(AgentCommandTable)
          .set({ state, time_updated: next.time_updated, data: next.data })
          .where(eq(AgentCommandTable.id, input.id))
          .run()
        return fromRow(next)
      })
      if (info instanceof NotFoundError || info instanceof InvalidStateTransitionError) return yield* Effect.fail(info)
      yield* bus.publish(Event.Updated, eventPayload(info))
      const metadataPatch = metadataPatchForCommand(info)
      if (metadataPatch) {
        yield* metadata.patch({ sessionID: info.targetSessionID, ...metadataPatch })
        const completed = Database.transaction((db) => {
          const row = db.select().from(AgentCommandTable).where(eq(AgentCommandTable.id, info.id)).get()
          if (!row) return notFound(info.id)
          const next = {
            ...row,
            state: "completed" as const,
            time_updated: Date.now(),
            data: {
              ...row.data,
              result: info.type === "rename" ? "Renamed target Agent View row." : "Updated target Agent View tags.",
            },
          }
          db.update(AgentCommandTable)
            .set({ state: next.state, time_updated: next.time_updated, data: next.data })
            .where(eq(AgentCommandTable.id, info.id))
            .run()
          return fromRow(next)
        })
        if (completed instanceof NotFoundError) return yield* Effect.fail(completed)
        yield* bus.publish(Event.Updated, eventPayload(completed))
        return completed
      }
      return info
    })

    return Service.of({ get, list, create, update })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AgentViewMetadata.defaultLayer), Layer.provide(Bus.layer))

export * as AgentCommand from "./agent-command"
