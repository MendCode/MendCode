import { Context, Effect, Layer } from "effect"
import { NotFoundError } from "@/storage/storage"
import { BackgroundSession } from "./background"
import { AgentViewMetadata } from "./agent-view-metadata"
import { Session } from "./session"
import { SessionStatus } from "./status"
import { WorkflowRunTable } from "./session.sql"
import { Database } from "@/storage/db"

export type ListInput = Session.ListInput

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<BackgroundSession.Entry[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AgentView") {}

function foregroundSummary(input: { session: Session.Info; state: BackgroundSession.State; status?: SessionStatus.Info }) {
  if (input.status?.type === "retry") return input.status.message
  return input.session.path || input.session.directory || input.state
}

function normalizeDirectoryScope(value: string) {
  return value.replaceAll("\\", "/").replace(/\/+$/, "")
}

function matchesDirectoryScope(directory: string, scope: string) {
  const normalizedDirectory = normalizeDirectoryScope(directory)
  const normalizedScope = normalizeDirectoryScope(scope)
  return normalizedDirectory === normalizedScope || normalizedDirectory.startsWith(`${normalizedScope}/`)
}

function matchesListInput(input: {
  list?: ListInput
  background: BackgroundSession.Info
  status?: SessionStatus.Info
  session?: Session.Info
  metadata?: AgentViewMetadata.Info
}) {
  if (!input.list) return true
  const active =
    input.status?.type === "busy" ||
    input.status?.type === "retry" ||
    input.background.state === "queued" ||
    input.background.state === "working" ||
    input.background.state === "needs_input"
  if (input.list.start !== undefined && input.background.time.updated < input.list.start && !active) return false
  if (!input.session) {
    return !(input.list.directory || input.list.path || input.list.roots || input.list.search)
  }
  if (input.list.roots && input.session.parentID) return false
  if (input.list.search) {
    const query = input.list.search.toLowerCase()
    const title = input.metadata?.title ?? input.session.title
    if (!title.toLowerCase().includes(query)) return false
  }
  if (input.list.path !== undefined) {
    if (!input.list.path) return true
    if (input.session.path === input.list.path || input.session.path?.startsWith(`${input.list.path}/`)) return true
    if (input.list.directory && !input.session.path) return input.session.directory === input.list.directory
    return false
  }
  if (input.list.scope !== "project" && input.list.directory) {
    return matchesDirectoryScope(input.session.directory, input.list.directory)
  }
  return true
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const background = yield* BackgroundSession.Service
    const metadata = yield* AgentViewMetadata.Service
    const session = yield* Session.Service
    const status = yield* SessionStatus.Service

    const list = Effect.fn("AgentView.list")(function* (input?: ListInput) {
      const workflowRootSessionIDs = new Set(
        Database.use((db) =>
          db.select({ sessionID: WorkflowRunTable.root_session_id })
            .from(WorkflowRunTable)
            .all()
            .flatMap((row) => row.sessionID ? [row.sessionID] : []),
        ),
      )
      const sessions = (yield* session.list({ ...input, limit: undefined }))
        .filter((info) => !workflowRootSessionIDs.has(info.id))
      const sessionsByID = new Map(sessions.map((info) => [info.id, info]))
      const statuses = yield* status.list()
      const metadataBySessionID = new Map((yield* metadata.list()).map((info) => [info.sessionID, info]))
      const backgroundItems = yield* background.list()
      const backgroundEntries = (
        yield* Effect.all(
          backgroundItems.map((info) => {
            const metadataInfo = metadataBySessionID.get(info.sessionID)
            return (sessionsByID.has(info.sessionID) ? Effect.succeed(sessionsByID.get(info.sessionID)!) : session.get(info.sessionID)).pipe(
              Effect.map((sessionInfo) => ({
                entry: BackgroundSession.toEntry({
                  info,
                  status: statuses.get(info.sessionID),
                  metadata: metadataInfo,
                  session: BackgroundSession.sessionInfo(sessionInfo),
                }),
                matches: matchesListInput({
                  list: input,
                  background: info,
                  status: statuses.get(info.sessionID),
                  session: sessionInfo,
                  metadata: metadataInfo,
                }),
              })),
              Effect.catchIf(NotFoundError.isInstance, () =>
                Effect.succeed({
                  entry: BackgroundSession.toEntry({
                    info,
                    status: statuses.get(info.sessionID),
                    metadata: metadataInfo,
                  }),
                  matches: matchesListInput({
                    list: input,
                    background: info,
                    status: statuses.get(info.sessionID),
                    metadata: metadataInfo,
                  }),
                }),
              ),
            )
          }),
        )
      )
        .filter((item) => item.matches)
        .map((item) => item.entry)
      const backgroundIDs = new Set(backgroundEntries.map((entry) => entry.sessionID))
      const foregroundEntries = sessions
        .filter((info) => !backgroundIDs.has(info.id))
        .map((info) => {
          const currentStatus = statuses.get(info.id)
          const state = BackgroundSession.deriveState({ status: currentStatus })
          return BackgroundSession.toEntry({
            info: {
              sessionID: info.id,
              state,
              summary: foregroundSummary({ session: info, state, status: currentStatus }),
              pinned: false,
              time: {
                created: info.time.created,
                updated: info.time.updated,
              },
            },
            status: currentStatus,
            metadata: metadataBySessionID.get(info.id),
            session: BackgroundSession.sessionInfo(info),
          })
        })
      const entries = [...backgroundEntries, ...foregroundEntries].toSorted(
        (a, b) => b.time.updated - a.time.updated || b.sessionID.localeCompare(a.sessionID),
      )
      return input?.limit ? entries.slice(0, input.limit) : entries
    })

    return Service.of({ list })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(BackgroundSession.defaultLayer),
  Layer.provide(AgentViewMetadata.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(SessionStatus.defaultLayer),
)

export * as AgentView from "./agent-view"
