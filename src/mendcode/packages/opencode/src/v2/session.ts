import { SessionMessageTable, SessionTable } from "@/session/session.sql"
import { SessionID } from "@/session/schema"
import { WorkspaceID } from "@/control-plane/schema"
import { and, asc, desc, eq, gt, gte, isNull, like, lt, or, type SQL } from "@/storage/db"
import * as Database from "@/storage/db"
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect"
import { SessionMessage } from "./session-message"
import type { Prompt } from "./session-prompt"
import { EventV2 } from "./event"
import { ProjectID } from "@/project/schema"
import { SessionEvent } from "./session-event"
import { V2Schema } from "./schema"
import { optionalOmitUndefined } from "@/util/schema"
import { Modelv2 } from "./model"
import { Session as LegacySession } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionCompaction } from "@/session/compaction"
import { SessionStatus } from "@/session/status"
import { MessageV2 } from "@/session/message-v2"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"

export const Delivery = Schema.Literals(["immediate", "deferred"]).annotate({
  identifier: "Session.Delivery",
})
export type Delivery = Schema.Schema.Type<typeof Delivery>

export const DefaultDelivery = "immediate" satisfies Delivery

export const MessageView = Schema.Literals(["full", "tui"]).annotate({
  identifier: "Session.MessageView",
})
export type MessageView = Schema.Schema.Type<typeof MessageView>

export class Info extends Schema.Class<Info>("Session.Info")({
  id: SessionID,
  parentID: optionalOmitUndefined(SessionID),
  projectID: ProjectID,
  workspaceID: optionalOmitUndefined(WorkspaceID),
  path: optionalOmitUndefined(Schema.String),
  agent: optionalOmitUndefined(Schema.String),
  model: Modelv2.Ref.pipe(optionalOmitUndefined),
  time: Schema.Struct({
    created: V2Schema.DateTimeUtcFromMillis,
    updated: V2Schema.DateTimeUtcFromMillis,
    archived: optionalOmitUndefined(V2Schema.DateTimeUtcFromMillis),
  }),
  title: Schema.String,
  /*
  slug: Schema.String,
  directory: Schema.String,
  path: optionalOmitUndefined(Schema.String),
  parentID: optionalOmitUndefined(SessionID),
  summary: optionalOmitUndefined(Summary),
  share: optionalOmitUndefined(Share),
  title: Schema.String,
  version: Schema.String,
  time: Time,
  permission: optionalOmitUndefined(Permission.Ruleset),
  revert: optionalOmitUndefined(Revert),
  */
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Session.NotFoundError", {
  sessionID: SessionID,
}) {}

export interface Interface {
  readonly create: (input?: {
    agent?: string
    model?: Modelv2.Ref
    parentID?: SessionID
    workspaceID?: WorkspaceID
  }) => Effect.Effect<Info>
  readonly get: (sessionID: SessionID) => Effect.Effect<Info, NotFoundError>
  readonly list: (input: {
    limit?: number
    order?: "asc" | "desc"
    directory?: string
    path?: string
    workspaceID?: WorkspaceID
    roots?: boolean
    start?: number
    search?: string
    cursor?: {
      id: SessionID
      time: number
      direction: "previous" | "next"
    }
  }) => Effect.Effect<Info[], never>
  readonly messages: (input: {
    sessionID: SessionID
    limit?: number
    order?: "asc" | "desc"
    view?: MessageView
    cursor?: {
      id: SessionMessage.ID
      time: number
      direction: "previous" | "next"
    }
  }) => Effect.Effect<SessionMessage.Message[], never>
  readonly context: (sessionID: SessionID) => Effect.Effect<SessionMessage.Message[], never>
  readonly prompt: (input: {
    id?: EventV2.ID
    sessionID: SessionID
    prompt: Prompt
    delivery?: Delivery
  }) => Effect.Effect<SessionMessage.User, never>
  readonly shell: (input: { id?: EventV2.ID; sessionID: SessionID; command: string }) => Effect.Effect<void, never>
  readonly skill: (input: { id?: EventV2.ID; sessionID: SessionID; skill: string }) => Effect.Effect<void, never>
  readonly subagent: (input: {
    id?: EventV2.ID
    parentID: SessionID
    prompt: Prompt
    agent: string
    model?: Modelv2.Ref
  }) => Effect.Effect<void, NotFoundError>
  readonly switchAgent: (input: { sessionID: SessionID; agent: string }) => Effect.Effect<void, never>
  readonly switchModel: (input: { sessionID: SessionID; model: Modelv2.Ref }) => Effect.Effect<void, never>
  readonly compact: (sessionID: SessionID) => Effect.Effect<void, never>
  readonly wait: (sessionID: SessionID) => Effect.Effect<void, never>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Session") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const legacySession = yield* LegacySession.Service
    const legacyPrompt = yield* SessionPrompt.Service
    const legacyCompaction = yield* SessionCompaction.Service
    const legacyStatus = yield* SessionStatus.Service
    const agents = yield* Agent.Service
    const providers = yield* Provider.Service
    const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Message)

    const decode = (row: typeof SessionMessageTable.$inferSelect) =>
      decodeMessage({ ...row.data, id: row.id, type: row.type })

    const TUI_V2_TEXT_PREVIEW_CHARS = 128 * 1024
    const TUI_V2_METADATA_PREVIEW_CHARS = 4 * 1024
    const TUI_V2_DIFF_PREVIEW_CHARS = 512 * 1024
    const TUI_V2_CONTENT_PREVIEW_CHARS = 512 * 1024
    const TUI_V2_FIELD_PREVIEW_CHARS = 2 * 1024

    function previewString(input: string | undefined, maxChars: number, _label: string) {
      if (!input || input.length <= maxChars) return input
      return input.slice(0, maxChars)
    }

    function previewToolInputContent(input: string, label: string) {
      if (input.length <= TUI_V2_CONTENT_PREVIEW_CHARS) return input
      const marker = `\n[${label} preview truncated: omitted ${input.length - TUI_V2_CONTENT_PREVIEW_CHARS} chars; showing the beginning.]\n`
      const budget = Math.max(0, TUI_V2_CONTENT_PREVIEW_CHARS - marker.length)
      return `${input.slice(0, budget)}${marker}`
    }

    function previewDiff(input: string) {
      if (input.length <= TUI_V2_DIFF_PREVIEW_CHARS) return input
      const marker = "\n[Diff preview truncated: too large to render safely. Show more to inspect the full diff.]\n"
      const budget = Math.max(0, TUI_V2_DIFF_PREVIEW_CHARS - marker.length)
      if (budget <= 0) return marker.slice(0, TUI_V2_DIFF_PREVIEW_CHARS)
      const head = Math.floor(budget / 3)
      return `${input.slice(0, head)}${marker}${input.slice(input.length - (budget - head))}`
    }

    function previewUnknown(input: unknown, maxChars: number, label: string, depth = 0): unknown {
      if (typeof input === "string") return previewString(input, maxChars, label)
      if (!input || typeof input !== "object") return input
      if (depth >= 4) return input
      if (Array.isArray(input)) return input.map((item) => previewUnknown(item, maxChars, label, depth + 1))

      const result: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(input)) {
        const diffLike = key === "diff" || key === "patch"
        const nextMax = diffLike
          ? TUI_V2_DIFF_PREVIEW_CHARS
          : key === "content"
            ? TUI_V2_CONTENT_PREVIEW_CHARS
            : key === "output"
              ? maxChars
              : Math.min(maxChars, TUI_V2_FIELD_PREVIEW_CHARS)
        result[key] =
          diffLike && typeof value === "string"
            ? previewDiff(value)
            : key === "content" && typeof value === "string"
              ? previewToolInputContent(value, `${label}.${key}`)
              : previewUnknown(value, nextMax, `${label}.${key}`, depth + 1)
      }
      return result
    }

    function previewToolContent<T>(content: T): T {
      if (!Array.isArray(content)) return content
      return content.map((item) => {
        if (!item || typeof item !== "object" || !("type" in item) || item.type !== "text" || typeof item.text !== "string") return item
        return { ...item, text: previewString(item.text, TUI_V2_TEXT_PREVIEW_CHARS, "tool content") ?? "" }
      }) as T
    }

    function previewToolState(state: SessionMessage.ToolState): SessionMessage.ToolState {
      if (state.status === "pending") {
        return new SessionMessage.ToolStatePending({
          ...state,
          input: previewString(state.input, TUI_V2_FIELD_PREVIEW_CHARS, "tool input") ?? "",
        })
      }

      if (state.status === "running") {
        return new SessionMessage.ToolStateRunning({
          ...state,
          input: previewUnknown(state.input, TUI_V2_FIELD_PREVIEW_CHARS, "tool input") as Record<string, unknown>,
          structured: previewUnknown(
            state.structured,
            TUI_V2_METADATA_PREVIEW_CHARS,
            "tool structured output",
          ) as typeof state.structured,
          content: previewToolContent(state.content),
        })
      }
      if (state.status === "completed") {
        return new SessionMessage.ToolStateCompleted({
          ...state,
          input: previewUnknown(state.input, TUI_V2_FIELD_PREVIEW_CHARS, "tool input") as Record<string, unknown>,
          structured: previewUnknown(
            state.structured,
            TUI_V2_METADATA_PREVIEW_CHARS,
            "tool structured output",
          ) as typeof state.structured,
          content: previewToolContent(state.content),
        })
      }
      return new SessionMessage.ToolStateError({
        ...state,
        input: previewUnknown(state.input, TUI_V2_FIELD_PREVIEW_CHARS, "tool input") as Record<string, unknown>,
        structured: previewUnknown(
          state.structured,
          TUI_V2_METADATA_PREVIEW_CHARS,
          "tool structured output",
        ) as typeof state.structured,
        content: previewToolContent(state.content),
      })
    }

    function previewContent(content: SessionMessage.AssistantContent): SessionMessage.AssistantContent {
      if (content.type === "text") {
        return new SessionMessage.AssistantText({
          ...content,
          text: previewString(content.text, TUI_V2_TEXT_PREVIEW_CHARS, "assistant text") ?? "",
        })
      }
      if (content.type === "reasoning") {
        return new SessionMessage.AssistantReasoning({
          ...content,
          text: previewString(content.text, TUI_V2_TEXT_PREVIEW_CHARS, "assistant reasoning") ?? "",
        })
      }
      return new SessionMessage.AssistantTool({
        ...content,
        provider: content.provider
          ? {
              ...content.provider,
              metadata: previewUnknown(
                content.provider.metadata,
                TUI_V2_METADATA_PREVIEW_CHARS,
                "tool provider metadata",
              ) as typeof content.provider.metadata,
            }
          : content.provider,
        state: previewToolState(content.state),
      })
    }

    function previewMessageForTui(message: SessionMessage.Message): SessionMessage.Message {
      if (message.type === "shell") {
        return new SessionMessage.Shell({
          ...message,
          output: previewString(message.output, TUI_V2_TEXT_PREVIEW_CHARS, "shell output") ?? "",
        })
      }
      if (message.type === "user") {
        return new SessionMessage.User({
          ...message,
          text: previewString(message.text, TUI_V2_TEXT_PREVIEW_CHARS, "user message") ?? "",
        })
      }
      if (message.type === "synthetic") {
        return new SessionMessage.Synthetic({
          ...message,
          text: previewString(message.text, TUI_V2_TEXT_PREVIEW_CHARS, "synthetic message") ?? "",
        })
      }
      if (message.type === "compaction") {
        return new SessionMessage.Compaction({
          ...message,
          summary: previewString(message.summary, TUI_V2_TEXT_PREVIEW_CHARS, "compaction summary") ?? "",
          include: previewString(message.include, TUI_V2_TEXT_PREVIEW_CHARS, "compaction include"),
        })
      }
      if (message.type !== "assistant") return message
      return new SessionMessage.Assistant({
        ...message,
        content: message.content.map((content) => previewContent(content)),
      })
    }

    function decodeForView(row: typeof SessionMessageTable.$inferSelect, view: MessageView | undefined) {
      const message = decode(row)
      return view === "tui" ? previewMessageForTui(message) : message
    }

    function fromRow(row: typeof SessionTable.$inferSelect): Info {
      return new Info({
        id: SessionID.make(row.id),
        projectID: ProjectID.make(row.project_id),
        workspaceID: row.workspace_id ? WorkspaceID.make(row.workspace_id) : undefined,
        title: row.title,
        parentID: row.parent_id ? SessionID.make(row.parent_id) : undefined,
        path: row.path ?? "",
        agent: row.agent ?? undefined,
        model: row.model
          ? {
              id: Modelv2.ID.make(row.model.id),
              providerID: Modelv2.ProviderID.make(row.model.providerID),
              variant: Modelv2.VariantID.make(row.model.variant ?? "default"),
            }
          : undefined,
        time: {
          created: DateTime.makeUnsafe(row.time_created),
          updated: DateTime.makeUnsafe(row.time_updated),
          archived: row.time_archived ? DateTime.makeUnsafe(row.time_archived) : undefined,
        },
      })
    }

    const result: Interface = {
      create: Effect.fn("V2Session.create")(function* (input) {
        const created = yield* legacySession.create({
          agent: input?.agent,
          parentID: input?.parentID,
          workspaceID: input?.workspaceID,
          model: input?.model
            ? {
                providerID: ProviderID.make(input.model.providerID),
                id: ModelID.make(input.model.id),
                variant: input.model.variant,
              }
            : undefined,
        })
        return yield* result.get(created.id).pipe(Effect.orDie)
      }),
      get: Effect.fn("V2Session.get")(function* (sessionID) {
        const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get())
        if (!row) return yield* new NotFoundError({ sessionID })
        return fromRow(row)
      }),
      list: Effect.fn("V2Session.list")(function* (input) {
        const direction = input.cursor?.direction ?? "next"
        let order = input.order ?? "desc"
        // Query the adjacent rows in reverse, then flip them back into the requested order below.
        if (direction === "previous" && order === "asc") order = "desc"
        if (direction === "previous" && order === "desc") order = "asc"
        const conditions: SQL[] = []
        if (input.directory) conditions.push(eq(SessionTable.directory, input.directory))
        if (input.path)
          conditions.push(or(eq(SessionTable.path, input.path), like(SessionTable.path, `${input.path}/%`))!)
        if (input.workspaceID) conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
        if (input.roots) conditions.push(isNull(SessionTable.parent_id))
        if (input.start) conditions.push(gte(SessionTable.time_created, input.start))
        if (input.search) conditions.push(like(SessionTable.title, `%${input.search}%`))
        if (input.cursor) {
          conditions.push(
            order === "asc"
              ? or(
                  gt(SessionTable.time_created, input.cursor.time),
                  and(eq(SessionTable.time_created, input.cursor.time), gt(SessionTable.id, input.cursor.id)),
                )!
              : or(
                  lt(SessionTable.time_created, input.cursor.time),
                  and(eq(SessionTable.time_created, input.cursor.time), lt(SessionTable.id, input.cursor.id)),
                )!,
          )
        }
        const query = Database.Client()
          .select()
          .from(SessionTable)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(
            order === "asc" ? asc(SessionTable.time_created) : desc(SessionTable.time_created),
            order === "asc" ? asc(SessionTable.id) : desc(SessionTable.id),
          )

        const rows = input.limit === undefined ? query.all() : query.limit(input.limit).all()
        return (direction === "previous" ? rows.toReversed() : rows).map((row) => fromRow(row))
      }),
      messages: Effect.fn("V2Session.messages")(function* (input) {
        const direction = input.cursor?.direction ?? "next"
        let order = input.order ?? "desc"
        // Query the adjacent rows in reverse, then flip them back into the requested order below.
        if (direction === "previous" && order === "asc") order = "desc"
        if (direction === "previous" && order === "desc") order = "asc"
        const boundary = input.cursor
          ? order === "asc"
            ? or(
                gt(SessionMessageTable.time_created, input.cursor.time),
                and(
                  eq(SessionMessageTable.time_created, input.cursor.time),
                  gt(SessionMessageTable.id, input.cursor.id),
                ),
              )
            : or(
                lt(SessionMessageTable.time_created, input.cursor.time),
                and(
                  eq(SessionMessageTable.time_created, input.cursor.time),
                  lt(SessionMessageTable.id, input.cursor.id),
                ),
              )
          : undefined
        const where = boundary
          ? and(eq(SessionMessageTable.session_id, input.sessionID), boundary)
          : eq(SessionMessageTable.session_id, input.sessionID)

        const rows = Database.use((db) => {
          const query = db
            .select()
            .from(SessionMessageTable)
            .where(where)
            .orderBy(
              order === "asc" ? asc(SessionMessageTable.time_created) : desc(SessionMessageTable.time_created),
              order === "asc" ? asc(SessionMessageTable.id) : desc(SessionMessageTable.id),
            )
          const rows = input.limit === undefined ? query.all() : query.limit(input.limit).all()
          return direction === "previous" ? rows.toReversed() : rows
        })
        return rows.map((row) => decodeForView(row, input.view))
      }),
      context: Effect.fn("V2Session.context")(function* (sessionID) {
        const rows = Database.use((db) => {
          const compaction = db
            .select()
            .from(SessionMessageTable)
            .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "compaction")))
            .orderBy(desc(SessionMessageTable.time_created), desc(SessionMessageTable.id))
            .limit(1)
            .get()

          return db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.session_id, sessionID),
                compaction
                  ? or(
                      gt(SessionMessageTable.time_created, compaction.time_created),
                      and(
                        eq(SessionMessageTable.time_created, compaction.time_created),
                        gte(SessionMessageTable.id, compaction.id),
                      ),
                    )
                  : undefined,
              ),
            )
            .orderBy(asc(SessionMessageTable.time_created), asc(SessionMessageTable.id))
            .all()
        })
        return rows.map((row) => decode(row))
      }),
      prompt: Effect.fn("V2Session.prompt")(function* (input) {
        const current = yield* legacySession.get(input.sessionID).pipe(Effect.orDie)
        const agent = current.agent ?? (yield* agents.defaultAgent())
        const model = current.model
          ? { providerID: current.model.providerID, modelID: current.model.id }
          : yield* providers.defaultModel()
        const request = {
          sessionID: input.sessionID,
          agent,
          model,
          parts: [
            { type: "text" as const, text: input.prompt.text },
            ...(input.prompt.files ?? []).map((file) => ({
              type: "file" as const,
              mime: file.mime,
              filename: file.name,
              url: file.uri,
            })),
            ...(input.prompt.agents ?? []).map((attachment) => ({
              type: "agent" as const,
              name: attachment.name,
              source: attachment.source
                ? {
                    value: attachment.source.text,
                    start: attachment.source.start,
                    end: attachment.source.end,
                  }
                : undefined,
            })),
          ],
        }
        const message = yield* ((input.delivery ?? DefaultDelivery) === "deferred"
          ? legacyPrompt.promptAsync(request)
          : legacyPrompt.prompt(request)).pipe(Effect.orDie)
        const responseInfo = message.info
        const legacyUser =
          responseInfo.role === "user"
            ? message
            : Option.getOrUndefined(
                yield* legacySession.findMessage(
                  input.sessionID,
                  (candidate) => candidate.info.role === "user" && candidate.info.id === responseInfo.parentID,
                ),
              )
        if (!legacyUser || legacyUser.info.role !== "user")
          return yield* Effect.die(new Error("V2 prompt completed without its corresponding user turn"))
        const projected = yield* result.messages({ sessionID: input.sessionID, order: "desc" })
        const user = projected.find(
          (candidate): candidate is SessionMessage.User =>
            candidate.type === "user" &&
            DateTime.toEpochMillis(candidate.time.created) === legacyUser.info.time.created &&
            candidate.text === input.prompt.text,
        )
        if (!user) return yield* Effect.die(new Error("V2 prompt was accepted but its user event was not projected"))
        return user
      }),
      shell: Effect.fn("V2Session.shell")(function* (_input) {}),
      skill: Effect.fn("V2Session.skill")(function* (_input) {}),
      switchAgent: Effect.fn("V2Session.switchAgent")(function* (input) {
        EventV2.run(SessionEvent.AgentSwitched.Sync, {
          sessionID: input.sessionID,
          timestamp: DateTime.makeUnsafe(Date.now()),
          agent: input.agent,
        })
      }),
      switchModel: Effect.fn("V2Session.switchModel")(function* (input) {
        EventV2.run(SessionEvent.ModelSwitched.Sync, {
          sessionID: input.sessionID,
          timestamp: DateTime.makeUnsafe(Date.now()),
          model: input.model,
        })
      }),
      subagent: Effect.fn("V2Session.subagent")(function* (input) {
        const parent = yield* result.get(input.parentID)
        const session = yield* result.create({
          agent: input.agent,
          model: input.model,
          parentID: input.parentID,
          workspaceID: parent.workspaceID,
        })
        yield* result.prompt({
          prompt: input.prompt,
          sessionID: session.id,
        })
        yield* Effect.gen(function* () {
          yield* result.wait(session.id)
          const messages = yield* result.messages({ sessionID: session.id, order: "desc" })
          const assistant = messages.find((msg) => msg.type === "assistant")
          if (!assistant) return
          const text = assistant.content.findLast((part) => part.type === "text")
          if (!text) return
        }).pipe(Effect.forkChild())
      }),
      compact: Effect.fn("V2Session.compact")(function* (sessionID) {
        const current = yield* legacySession.get(sessionID).pipe(Effect.orDie)
        const defaultAgent = yield* agents.defaultAgent()
        const agent = MessageV2.latestUserInfo(sessionID)?.agent ?? current.agent ?? defaultAgent
        const model = current.model
          ? { providerID: current.model.providerID, modelID: current.model.id }
          : yield* providers.defaultModel()
        yield* legacyCompaction.create({ sessionID, agent, model, auto: false }).pipe(Effect.orDie)
        yield* legacyPrompt.loop({ sessionID })
      }),
      wait: Effect.fn("V2Session.wait")(function* (sessionID) {
        while ((yield* legacyStatus.get(sessionID)).type !== "idle") yield* Effect.sleep(50)
      }),
    }

    return Service.of(result)
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(SessionPrompt.defaultLayer),
    Layer.provide(SessionCompaction.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provide(LegacySession.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(Provider.defaultLayer),
  ),
)

export * as SessionV2 from "./session"
