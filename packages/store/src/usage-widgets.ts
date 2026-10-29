import type { Database } from "bun:sqlite"
import type { UsageReport } from "@mendcode/protocol"

/** Reads existing indexed projections; never returns file paths or contents. */
export function createUsageWidgets(db: Database) {
  return (range: { from: string; to: string; directories?: string[] }): Pick<UsageReport, "agents" | "outcomes"> => {
    const scoped = range.directories !== undefined
    const filter = scoped ? "AND s.directory IN (SELECT value FROM json_each(?3))" : ""
    const params = scoped ? [range.from, range.to, JSON.stringify(range.directories)] : [range.from, range.to]
    const agents = db.query<{ name: string; turns: number }, (string | number)[]>(`SELECT COALESCE(NULLIF(s.agent, ''), CASE WHEN s.permission_mode = 'plan' THEN 'plan' ELSE 'build' END) AS name,
      SUM(a.turns) AS turns FROM usage_scope_activity a JOIN sessions s ON s.id = a.session_id
      WHERE a.day BETWEEN ?1 AND ?2 ${filter} GROUP BY name HAVING turns > 0 ORDER BY turns DESC, name LIMIT 10`).all(...params)
    const end = new Date(`${range.to}T00:00:00`)
    end.setDate(end.getDate() + 1)
    const fileParams = [new Date(`${range.from}T00:00:00`).getTime(), end.getTime(), ...(scoped ? [JSON.stringify(range.directories)] : [])]
    const outcomes = db.query<{ changedFiles: number; sessionsWithCodeChanges: number }, (string | number)[]>(`WITH changed AS (
      SELECT DISTINCT f.session_id, f.path FROM turn_files f JOIN turns t ON t.session_id = f.session_id AND t.turn_id = f.turn_id
      JOIN sessions s ON s.id = f.session_id WHERE t.at >= ?1 AND t.at < ?2 AND t.reverted = 0 AND t.status = 'completed'
      AND f.before_state != 'skipped' AND f.after_state IN ('content', 'absent')
      AND (f.before_state != f.after_state OR f.before_content IS NOT f.after_content) ${filter}
    ) SELECT COUNT(*) AS changedFiles, COUNT(DISTINCT session_id) AS sessionsWithCodeChanges FROM changed`).get(...fileParams)!
    return { agents, outcomes: { ...outcomes, coverage: "retained-snapshots" } }
  }
}
