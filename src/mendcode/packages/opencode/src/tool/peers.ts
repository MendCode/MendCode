import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./peers.txt"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { NonNegativeInt } from "@/util/schema"

const MAX_PEERS = 32
const MAX_ACTIVITY_LENGTH = 120

export const Parameters = Schema.Struct({
  limit: Schema.optional(NonNegativeInt).annotate({
    description: "Maximum number of peer descriptors to return. The server caps this at 32.",
  }),
})

export type PeerDescriptor = {
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

export function peerDescriptors(input: {
  sessions: readonly Session.Info[]
  statuses: ReadonlyMap<string, SessionStatus.Info>
  currentSessionID: string
  limit?: number
}): PeerDescriptor[] {
  const limit = Math.min(MAX_PEERS, Math.max(1, Math.floor(input.limit ?? MAX_PEERS)))
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

export const PeersTool = Tool.define<typeof Parameters, { count: number }, Session.Service | SessionStatus.Service>(
  "peers",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const statuses = yield* SessionStatus.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const [items, statusMap] = yield* Effect.all([sessions.list({ limit: MAX_PEERS + 1 }), statuses.list()])
          const peers = peerDescriptors({
            sessions: items,
            statuses: statusMap,
            currentSessionID: ctx.sessionID,
            limit: params.limit,
          })
          const output = peers.length
            ? peers
                .map((peer) =>
                  [
                    `sessionID=${peer.sessionID}`,
                    `title=${JSON.stringify(peer.title)}`,
                    `state=${peer.state}`,
                    peer.activity ? `activity=${JSON.stringify(peer.activity)}` : undefined,
                    peer.workspaceID ? `workspaceID=${peer.workspaceID}` : undefined,
                    `updatedAt=${peer.updatedAt}`,
                  ]
                    .filter(Boolean)
                    .join(" "),
                )
                .join("\n")
            : "No other peer sessions are available in this project."
          return {
            title: `Peers (${peers.length})`,
            output,
            metadata: { count: peers.length },
          }
        }),
    }
  }),
)
