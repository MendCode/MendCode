import type { Database } from "bun:sqlite"
import type { Goal, GoalId, GoalStatus, SessionId } from "@mendcode/protocol"

/** What the daemon keeps with a goal besides what clients see. */
export type StoredGoal = {
  goal: Goal
  /** The budget-limit steering was already delivered: it is sent once. */
  budgetNoticeSent: boolean
  /** A steering the next goal turn starts with (the objective was edited while a turn ran). */
  pendingSteer?: "objective_updated"
}

type GoalRow = {
  id: string
  session_id: string
  objective: string
  objective_file: string | null
  status: string
  token_budget: number | null
  tokens_used: number
  time_used_ms: number
  active_since: number | null
  stalled: string | null
  note: string | null
  budget_notice_sent: number
  pending_steer: string | null
  created_at: number
  updated_at: number
}

const COLUMNS = "id, session_id, objective, objective_file, status, token_budget, tokens_used, time_used_ms, active_since, stalled, note, budget_notice_sent, pending_steer, created_at, updated_at"

function toStored(row: GoalRow): StoredGoal {
  return {
    goal: {
      goalId: row.id as GoalId,
      sessionId: row.session_id as SessionId,
      objective: row.objective,
      ...(row.objective_file ? { objectiveFile: row.objective_file } : {}),
      status: row.status as GoalStatus,
      ...(row.token_budget !== null ? { tokenBudget: row.token_budget } : {}),
      tokensUsed: row.tokens_used,
      timeUsedSeconds: Math.floor(row.time_used_ms / 1000),
      ...(row.active_since !== null ? { activeSince: row.active_since } : {}),
      ...(row.stalled ? { stalled: row.stalled } : {}),
      ...(row.note ? { note: row.note } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    budgetNoticeSent: row.budget_notice_sent === 1,
    ...(row.pending_steer === "objective_updated" ? { pendingSteer: "objective_updated" as const } : {}),
  }
}

/** The fields `update` may change; `null` clears an optional one. */
export type GoalPatch = {
  objective?: string
  objectiveFile?: string | null
  status?: GoalStatus
  tokenBudget?: number | null
  activeSince?: number | null
  stalled?: string | null
  note?: string | null
  budgetNoticeSent?: boolean
  pendingSteer?: "objective_updated" | null
}

/** Goals kept per session (the current one and its history); older ones are dropped when a new one is added. */
export const GOALS_KEPT_PER_SESSION = 20

/**
 * Session goals, one row each. The current goal of a session is its only row that is not superseded; a replaced or
 * cleared goal keeps its row as history. Deleting the session deletes its goals. Usage is added with `addUsage` so it
 * never races a status change.
 */
export function createGoals(input: { db: Database; now: () => number }) {
  const { db, now } = input
  const byId = db.query<GoalRow, [string]>(`SELECT ${COLUMNS} FROM goals WHERE id = ?`)
  const current = db.query<GoalRow, [string]>(`SELECT ${COLUMNS} FROM goals WHERE session_id = ? AND superseded_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1`)

  function read(goalId: string): StoredGoal | undefined {
    const row = byId.get(goalId)
    return row ? toStored(row) : undefined
  }

  return {
    /** The session's current goal, if it has one. */
    current(sessionId: SessionId): StoredGoal | undefined {
      const row = current.get(sessionId)
      return row ? toStored(row) : undefined
    },
    get: read,
    /** The session's goals, newest first (the current one included). */
    history(sessionId: SessionId, limit = GOALS_KEPT_PER_SESSION): Goal[] {
      return db
        .query<GoalRow, [string, number]>(`SELECT ${COLUMNS} FROM goals WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(sessionId, limit)
        .map((row) => toStored(row).goal)
    },
    /** Adds a goal and supersedes the session's current one. Returns the new goal and the one it replaced. */
    insert(goal: { goalId: GoalId; sessionId: SessionId; objective: string; objectiveFile?: string; tokenBudget?: number }): { created: StoredGoal; replaced?: StoredGoal } {
      return db.transaction(() => {
        const previous = current.get(goal.sessionId)
        const at = now()
        if (previous) db.query("UPDATE goals SET superseded_at = ? WHERE id = ?").run(at, previous.id)
        db.query("INSERT INTO goals(id, session_id, objective, objective_file, status, token_budget, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)").run(
          goal.goalId,
          goal.sessionId,
          goal.objective,
          goal.objectiveFile ?? null,
          goal.tokenBudget ?? null,
          at,
          at,
        )
        db.query("DELETE FROM goals WHERE session_id = ?1 AND id NOT IN (SELECT id FROM goals WHERE session_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2)").run(goal.sessionId, GOALS_KEPT_PER_SESSION)
        return { created: read(goal.goalId)!, ...(previous ? { replaced: toStored(previous) } : {}) }
      })()
    },
    /** Applies a patch to one goal; undefined when it does not exist. */
    update(goalId: GoalId, patch: GoalPatch): StoredGoal | undefined {
      const sets: string[] = []
      const values: Array<string | number | null> = []
      const set = (column: string, value: string | number | null) => {
        sets.push(`${column} = ?`)
        values.push(value)
      }
      if (patch.objective !== undefined) set("objective", patch.objective)
      if (patch.objectiveFile !== undefined) set("objective_file", patch.objectiveFile)
      if (patch.status !== undefined) set("status", patch.status)
      if (patch.tokenBudget !== undefined) set("token_budget", patch.tokenBudget)
      if (patch.activeSince !== undefined) set("active_since", patch.activeSince)
      if (patch.stalled !== undefined) set("stalled", patch.stalled)
      if (patch.note !== undefined) set("note", patch.note)
      if (patch.budgetNoticeSent !== undefined) set("budget_notice_sent", patch.budgetNoticeSent ? 1 : 0)
      if (patch.pendingSteer !== undefined) set("pending_steer", patch.pendingSteer)
      set("updated_at", now())
      db.query(`UPDATE goals SET ${sets.join(", ")} WHERE id = ?`).run(...values, goalId)
      return read(goalId)
    },
    /** Adds usage to a goal in one statement. */
    addUsage(goalId: GoalId, usage: { tokens?: number; ms?: number }): StoredGoal | undefined {
      db.query("UPDATE goals SET tokens_used = tokens_used + ?, time_used_ms = time_used_ms + ?, updated_at = ? WHERE id = ?").run(Math.max(0, Math.floor(usage.tokens ?? 0)), Math.max(0, Math.floor(usage.ms ?? 0)), now(), goalId)
      return read(goalId)
    },
    /** Supersedes the session's current goal (it stays in the history). Returns it as it was. */
    clear(sessionId: SessionId): StoredGoal | undefined {
      const row = current.get(sessionId)
      if (!row) return undefined
      db.query("UPDATE goals SET superseded_at = ? WHERE id = ?").run(now(), row.id)
      return toStored(row)
    },
    /** Sessions whose current goal is active and not stalled: the ones that keep working when the daemon runs. */
    activeSessions(): SessionId[] {
      return db
        .query<{ session_id: string }, []>("SELECT session_id FROM goals WHERE superseded_at IS NULL AND status = 'active' AND stalled IS NULL")
        .all()
        .map((row) => row.session_id as SessionId)
    },
    /** Current goals with a turn recorded as running (`activeSince` set): the daemon that ran it is gone. */
    withRunningTurn(): StoredGoal[] {
      return db
        .query<GoalRow, []>(`SELECT ${COLUMNS} FROM goals WHERE superseded_at IS NULL AND active_since IS NOT NULL`)
        .all()
        .map(toStored)
    },
  }
}
export type GoalsStore = ReturnType<typeof createGoals>
