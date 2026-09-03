import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./peers.txt"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { NonNegativeInt } from "@/util/schema"

const MAX_SESSIONS = 32
const MAX_ACTIVITY_LENGTH = 120

export const Parameters = Schema.Struct({
  limit: Schema.optional(NonNegativeInt).annotate({
    description: "Maximum number of session descriptors to return. The server caps this at 32.",
  }),
})

export type SessionDescriptor = {
  sessionID: string
  title: string
  state: string
  activity?: string
  workspaceID?: string
  updatedAt: number
}

function statusDescriptor(status: SessionStatus.Info) {
  if (status.type === "idle") return { state: "idle" as const }
  if (status.type === "retry") {
    return {
      state: "retry" as const,
      activity: status.message.slice(0, MAX_ACTIVITY_LENGTH),
    }
  }
  const activity = status.message?.trim() || status.kind
  return {
    state: "busy" as const,
    ...(activity ? { activity: activity.slice(0, MAX_ACTIVITY_LENGTH) } : {}),
  }
}

export function sessionDescriptors(input: {
  sessions: readonly Session.Info[]
  statuses: ReadonlyMap<string, SessionStatus.Info>
  currentSessionID: string
  limit?: number
}): SessionDescriptor[] {
  const limit = Math.min(MAX_SESSIONS, Math.max(1, Math.floor(input.limit ?? MAX_SESSIONS)))
  return input.sessions
    .filter((session) => session.id !== input.currentSessionID)
    .toSorted((a, b) => b.time.updated - a.time.updated || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((session) => {
      const status = statusDescriptor(input.statuses.get(session.id) ?? { type: "idle" })
      return {
        sessionID: session.id,
        title: session.title.slice(0, 160),
        ...status,
        ...(session.workspaceID ? { workspaceID: session.workspaceID } : {}),
        updatedAt: session.time.updated,
      }
    })
}

export const SessionsTool = Tool.define<typeof Parameters, { count: number }, Session.Service | SessionStatus.Service>(
  "sessions",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const statuses = yield* SessionStatus.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const [items, statusMap] = yield* Effect.all([sessions.list({ limit: MAX_SESSIONS + 1 }), statuses.list()])
          const otherSessions = sessionDescriptors({
            sessions: items,
            statuses: statusMap,
            currentSessionID: ctx.sessionID,
            limit: params.limit,
          })
          const output = otherSessions.length
            ? otherSessions
                .map((session) =>
                  [
                    `sessionID=${session.sessionID}`,
                    `title=${JSON.stringify(session.title)}`,
                    `state=${session.state}`,
                    session.activity ? `activity=${JSON.stringify(session.activity)}` : undefined,
                    session.workspaceID ? `workspaceID=${session.workspaceID}` : undefined,
                    `updatedAt=${session.updatedAt}`,
                  ]
                    .filter(Boolean)
                    .join(" "),
                )
                .join("\n")
            : "No other sessions are available in this project."
          return {
            title: `Sessions (${otherSessions.length})`,
            output,
            metadata: { count: otherSessions.length },
          }
        }),
    }
  }),
)
