import type { Database } from "bun:sqlite"
import type { SessionEvent, UsageInsights, UsageSession } from "@mendcode/protocol"

/**
 * Usage insights projections: turns per reasoning effort, skill loads, and per-session turns/tokens/active
 * time, each updated in O(1) inside the store's event transaction; plus the all-time figures (lifetime,
 * peak day, streaks) read from the existing daily tables. Nothing here scans history on read.
 */

const TERMINAL_TURNS = new Set(["turn.completed", "turn.cancelled", "turn.interrupted", "turn.failed"])
const SKILL_PREFIX = "skill: "
const MAX_SKILL = 100
const BACKFILL_KEY = "usage_insights_backfill"
const DAY_MS = 86_400_000
const LIMIT = 10

function skillOf(tool: unknown) {
  return typeof tool === "string" && tool.startsWith(SKILL_PREFIX) ? tool.slice(SKILL_PREFIX.length).trim().slice(0, MAX_SKILL) : undefined
}

const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`)

/** Longest run of consecutive days, and the run that ends on `today` or the day before (0 otherwise). */
export function streaks(days: readonly string[], today: string): { current: number; longest: number } {
  let longest = 0
  let run = 0
  let previous = Number.NaN
  let lastRunEnd = Number.NaN
  let lastRun = 0
  for (const day of days) {
    const at = dayMs(day)
    run = at - previous === DAY_MS ? run + 1 : 1
    previous = at
    longest = Math.max(longest, run)
    lastRunEnd = at
    lastRun = run
  }
  const gap = (dayMs(today) - lastRunEnd) / DAY_MS
  return { current: gap === 0 || gap === 1 ? lastRun : 0, longest }
}

export function createUsageInsights(input: { db: Database; dayOf: (at: number) => string }) {
  const { db, dayOf } = input
  const q = {
    effortOf: db.query<{ effort: string | null }, [string]>("SELECT effort FROM sessions WHERE id = ?"),
    bumpEffort: db.query("INSERT INTO usage_efforts(day, effort, turns) VALUES (?, ?, 1) ON CONFLICT(day, effort) DO UPDATE SET turns = turns + 1"),
    bumpSkill: db.query("INSERT INTO usage_skills(day, skill, runs) VALUES (?, ?, ?) ON CONFLICT(day, skill) DO UPDATE SET runs = runs + excluded.runs"),
    // first_day/last_day bound the days the session had turns or usage, so a range can pick the sessions active in it.
    bumpStats: db.query(`
      INSERT INTO usage_session_stats(session_id, turns, tokens, active_ms, first_day, last_day) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
      ON CONFLICT(session_id) DO UPDATE SET turns = turns + excluded.turns, tokens = tokens + excluded.tokens, active_ms = active_ms + excluded.active_ms,
        first_day = CASE WHEN first_day = '' OR excluded.first_day < first_day THEN excluded.first_day ELSE first_day END,
        last_day = MAX(last_day, excluded.last_day)`),
  }
  /** Start time of each session's running turn; a turn straddling a daemon restart adds no time. */
  const turnStarts = new Map<string, number>()

  function record(event: SessionEvent) {
    if (event.type === "turn.started") {
      turnStarts.set(event.sessionId, event.at)
      q.bumpEffort.run(dayOf(event.at), q.effortOf.get(event.sessionId)?.effort ?? "default")
      q.bumpStats.run(event.sessionId, 1, 0, 0, dayOf(event.at))
    } else if (TERMINAL_TURNS.has(event.type)) {
      const started = turnStarts.get(event.sessionId)
      turnStarts.delete(event.sessionId)
      if (started !== undefined) q.bumpStats.run(event.sessionId, 0, 0, Math.max(0, event.at - started), dayOf(event.at))
    } else if (event.type === "usage.recorded") {
      q.bumpStats.run(event.sessionId, 0, event.input + event.output, 0, dayOf(event.at))
    } else if (event.type === "item.started" && event.kind === "tool_call") {
      const skill = skillOf(event.meta?.tool)
      if (skill) q.bumpSkill.run(dayOf(event.at), skill, 1)
    }
  }

  /** One pass over the event log for skills and session stats, the first time these tables exist. */
  function backfill() {
    if (db.query("SELECT 1 FROM meta WHERE key = ?").get(BACKFILL_KEY)) return
    const rows = db.query<{ session_id: string; type: string; at: number; payload: string }, []>(`
      SELECT session_id, type, at, payload FROM events
      WHERE type IN ('turn.started', 'turn.completed', 'turn.cancelled', 'turn.interrupted', 'turn.failed', 'usage.recorded')
         OR (type = 'item.started' AND payload LIKE '%"tool":"skill: %')
      ORDER BY session_id, seq`)
    const skills = new Map<string, number>()
    const stats = new Map<string, { turns: number; tokens: number; ms: number; first: string; last: string }>()
    const starts = new Map<string, number>()
    for (const row of rows.iterate()) {
      const day = dayOf(row.at)
      const stat = stats.get(row.session_id) ?? { turns: 0, tokens: 0, ms: 0, first: day, last: day }
      stat.last = day
      stats.set(row.session_id, stat)
      if (row.type === "turn.started") {
        stat.turns++
        starts.set(row.session_id, row.at)
      } else if (TERMINAL_TURNS.has(row.type)) {
        const started = starts.get(row.session_id)
        starts.delete(row.session_id)
        if (started !== undefined) stat.ms += Math.max(0, row.at - started)
      } else if (row.type === "usage.recorded") {
        const usage = JSON.parse(row.payload) as { input?: number; output?: number }
        stat.tokens += (usage.input ?? 0) + (usage.output ?? 0)
      } else {
        const skill = skillOf((JSON.parse(row.payload) as { meta?: { tool?: unknown } }).meta?.tool)
        if (skill) {
          const key = `${dayOf(row.at)}\n${skill}`
          skills.set(key, (skills.get(key) ?? 0) + 1)
        }
      }
    }
    db.transaction(() => {
      for (const [key, runs] of skills) {
        const [day, skill] = key.split("\n") as [string, string]
        q.bumpSkill.run(day, skill, runs)
      }
      for (const [sessionId, stat] of stats) {
        q.bumpStats.run(sessionId, stat.turns, stat.tokens, stat.ms, stat.first)
        q.bumpStats.run(sessionId, 0, 0, 0, stat.last)
      }
      db.query("INSERT INTO meta(key, value) VALUES (?, '1')").run(BACKFILL_KEY)
    })()
  }

  const sessionRow = `
    SELECT s.session_id AS sessionId, COALESCE(x.title, '') AS title, COALESCE(x.directory, '') AS directory,
      s.tokens AS tokens, s.active_ms AS ms, s.turns AS turns
    FROM usage_session_stats s JOIN sessions x ON x.id = s.session_id`

  function read(input: { from: string; to: string; today: string }): UsageInsights {
    const lifetime = db.query<{ tokens: number | null; since: string | null }, []>("SELECT SUM(input + output) AS tokens, MIN(day) AS since FROM usage_daily").get()
    const peak = db.query<{ day: string; tokens: number }, []>("SELECT day, SUM(input + output) AS tokens FROM usage_daily GROUP BY day ORDER BY tokens DESC, day DESC LIMIT 1").get()
    const days = db
      .query<{ day: string }, []>("SELECT day FROM usage_daily UNION SELECT day FROM usage_activity WHERE prompts > 0 ORDER BY day")
      .all()
      .map((row) => row.day)
    const longest = db.query<UsageSession, []>(`${sessionRow} WHERE s.active_ms > 0 ORDER BY s.active_ms DESC LIMIT 1`).get()
    // A session is in the range when its active days (first turn or usage to the last) overlap it.
    const top = db
      .query<UsageSession, [string, string, number]>(`${sessionRow} WHERE s.last_day >= ? AND s.first_day <= ? ORDER BY s.tokens DESC, s.active_ms DESC LIMIT ?`)
      .all(input.from, input.to, LIMIT)
    return {
      ...(lifetime?.since ? { lifetime: { tokens: lifetime.tokens ?? 0, since: lifetime.since } } : {}),
      ...(peak ? { peakDay: peak } : {}),
      streak: streaks(days, input.today),
      ...(longest ? { longestSession: longest } : {}),
      efforts: db
        .query<{ effort: string; turns: number }, [string, string, number]>("SELECT effort, SUM(turns) AS turns FROM usage_efforts WHERE day BETWEEN ? AND ? GROUP BY effort ORDER BY turns DESC, effort LIMIT ?")
        .all(input.from, input.to, LIMIT),
      skills: db
        .query<{ skill: string; runs: number }, [string, string, number]>("SELECT skill, SUM(runs) AS runs FROM usage_skills WHERE day BETWEEN ? AND ? GROUP BY skill ORDER BY runs DESC, skill LIMIT ?")
        .all(input.from, input.to, LIMIT),
      topSessions: top,
    }
  }

  return { record, backfill, read }
}
