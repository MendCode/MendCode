import { and, eq, sql } from "@/storage/db"
import { Database } from "@/storage/db"
import { BackgroundTaskTable } from "./background-task.sql"
import { MessageV2 } from "./message-v2"
import { BackgroundSessionTable, MessageTable, PartTable, SessionStatusTable } from "./session.sql"
import { SessionID } from "./schema"

export const STALE_SESSION_RECOVERY_MS = 60 * 1000

export type StaleSessionRecoveryInput = {
  statusType: "busy" | "retry" | "idle"
  statusUpdatedAt?: number
  latestTool?: { tool?: string; status?: string; updatedAt: number }
  latestAssistant?: { finish?: string; completedAt?: number; updatedAt: number }
  now?: number
}

export function shouldRecoverStaleSession(input: StaleSessionRecoveryInput) {
  if (input.statusType === "retry") return false
  const now = input.now ?? Date.now()
  const unfinished =
    input.latestTool?.status === "running" ||
    input.latestTool?.status === "pending" ||
    (input.latestAssistant !== undefined && input.latestAssistant.completedAt === undefined && !input.latestAssistant.finish)
  if (!unfinished) return false

  // A busy heartbeat is runtime ownership evidence. An idle/missing status is
  // not, so only the durable turn/tool timestamps can keep that orphan fresh.
  const latestActivity = Math.max(
    input.latestTool?.updatedAt ?? 0,
    input.latestAssistant?.updatedAt ?? 0,
    input.statusType === "busy" ? (input.statusUpdatedAt ?? 0) : 0,
  )
  return latestActivity > 0 && now - latestActivity >= STALE_SESSION_RECOVERY_MS
}

/**
 * Closes abandoned foreground turns at startup without replaying their user
 * prompt. Background/workflow sessions retain their own durable lease/reclaim
 * protocol and are deliberately excluded here.
 */
export function recoverStaleSessionStatuses(now = Date.now()) {
  return Database.use((db) => {
    const incompleteAssistants = db
      .select()
      .from(MessageTable)
      .where(sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'
        AND json_extract(${MessageTable.data}, '$.time.completed') IS NULL`)
      .all()

    const bySession = new Map<SessionID, typeof incompleteAssistants>()
    for (const assistant of incompleteAssistants) {
      const rows = bySession.get(assistant.session_id) ?? []
      rows.push(assistant)
      bySession.set(assistant.session_id, rows)
    }

    const recovered: SessionID[] = []
    const reason = "Runtime interrupted before the assistant response completed."
    for (const [sessionID, assistants] of bySession) {
      if (db.select().from(BackgroundSessionTable).where(eq(BackgroundSessionTable.session_id, sessionID)).get()) continue
      if (db.select().from(BackgroundTaskTable).where(eq(BackgroundTaskTable.task_id, sessionID)).get()) continue

      const latestAssistant = assistants.toSorted((left, right) => right.time_updated - left.time_updated)[0]
      if (!latestAssistant) continue
      const status = db.select().from(SessionStatusTable).where(eq(SessionStatusTable.session_id, sessionID)).get()
      const toolRows = db
        .select()
        .from(PartTable)
        .where(
          and(
            eq(PartTable.session_id, sessionID),
            eq(PartTable.message_id, latestAssistant.id),
            sql`json_extract(${PartTable.data}, '$.type') = 'tool'`,
          ),
        )
        .all()
      const latestTool = toolRows.toSorted((left, right) => right.time_updated - left.time_updated)[0]
      const latestToolData = latestTool?.data.type === "tool" ? latestTool.data : undefined

      if (
        !shouldRecoverStaleSession({
          statusType: status?.data.type ?? "idle",
          statusUpdatedAt: status?.time_updated,
          latestTool: latestToolData
            ? { tool: latestToolData.tool, status: latestToolData.state.status, updatedAt: latestTool.time_updated }
            : undefined,
          latestAssistant: {
            finish: latestAssistant.data.role === "assistant" ? latestAssistant.data.finish : undefined,
            completedAt: latestAssistant.data.role === "assistant" ? latestAssistant.data.time.completed : undefined,
            updatedAt: latestAssistant.time_updated,
          },
          now,
        })
      )
        continue

      for (const assistant of assistants) {
        if (assistant.data.role !== "assistant" || assistant.data.time.completed !== undefined) continue
        const parts = db
          .select()
          .from(PartTable)
          .where(and(eq(PartTable.session_id, sessionID), eq(PartTable.message_id, assistant.id)))
          .all()
        for (const part of parts) {
          if (part.data.type !== "tool") continue
          if (part.data.state.status !== "pending" && part.data.state.status !== "running") continue
          const state = part.data.state
          db.update(PartTable)
            .set({
              time_updated: now,
              data: {
                ...part.data,
                state: {
                  status: "error",
                  error: reason,
                  input: state.input,
                  ...(state.status === "running" && state.metadata ? { metadata: state.metadata } : {}),
                  time: {
                    start: state.status === "running" ? state.time.start : now,
                    end: now,
                  },
                },
              },
            })
            .where(eq(PartTable.id, part.id))
            .run()
        }

        db.update(MessageTable)
          .set({
            time_updated: now,
            data: {
              ...assistant.data,
              finish: "error",
              error: new MessageV2.AbortedError({ message: reason }).toObject(),
              time: { ...assistant.data.time, completed: now },
            },
          })
          .where(eq(MessageTable.id, assistant.id))
          .run()
      }
      db.delete(SessionStatusTable).where(eq(SessionStatusTable.session_id, sessionID)).run()
      recovered.push(sessionID)
    }
    return recovered
  })
}
