import type { Database } from "bun:sqlite"
import type { SessionEvent, UsageActivityDay, UsageDay, UsageInsights, UsageModel, UsageTool } from "@mendcode/protocol"
import { streaks } from "./usage-insights"

type Range = { from: string; to: string; directories: string[] }
type Started = { turn?: number; items: Map<string, { at: number; kind: string; tool?: string }> }
const ENDED = new Set(["turn.completed", "turn.cancelled", "turn.interrupted", "turn.failed"])
const VISIBLE = "session_id IN (SELECT id FROM sessions WHERE directory IN (SELECT value FROM json_each(?3)))"

/** Per-session projections keep scope queries indexed. Existing global projections retain their history. */
export function createUsageScopes(input: { db: Database; dayOf(at: number): string; toolBucket(tool?: string): string }) {
  const { db, dayOf, toolBucket } = input
  db.run(`
    CREATE TABLE IF NOT EXISTS usage_scope_daily (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, day TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
      input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, reasoning INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0, cost_micros INTEGER NOT NULL DEFAULT 0,
      cost_unknown_calls INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(day, session_id, provider, model)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS usage_scope_activity (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, day TEXT NOT NULL,
      prompts INTEGER NOT NULL DEFAULT 0, words INTEGER NOT NULL DEFAULT 0, ai_ms INTEGER NOT NULL DEFAULT 0,
      tool_ms INTEGER NOT NULL DEFAULT 0, longest_ms INTEGER NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0, active_ms INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(day, session_id)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS usage_scope_tools (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, day TEXT NOT NULL, tool TEXT NOT NULL,
      calls INTEGER NOT NULL DEFAULT 0, ms INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(day, session_id, tool)
    ) WITHOUT ROWID;
    -- Tokens command-output filters kept out of the context (estimate), per session, day and filter. Not backfilled.
    CREATE TABLE IF NOT EXISTS usage_scope_savings (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, day TEXT NOT NULL, source TEXT NOT NULL,
      calls INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(day, session_id, source)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS usage_scope_labels (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, day TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(day, session_id, kind, label)
    ) WITHOUT ROWID;
  `)
  const usage = db.query(`INSERT INTO usage_scope_daily VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(day, session_id, provider, model) DO UPDATE SET input = input + excluded.input, output = output + excluded.output,
      reasoning = reasoning + excluded.reasoning, cache_read = cache_read + excluded.cache_read, cache_write = cache_write + excluded.cache_write,
      cost_micros = cost_micros + excluded.cost_micros, cost_unknown_calls = cost_unknown_calls + excluded.cost_unknown_calls, calls = calls + 1`)
  const activity = db.query(`INSERT INTO usage_scope_activity VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day, session_id) DO UPDATE SET prompts = prompts + excluded.prompts, words = words + excluded.words,
      ai_ms = ai_ms + excluded.ai_ms, tool_ms = tool_ms + excluded.tool_ms, longest_ms = MAX(longest_ms, excluded.longest_ms),
      turns = turns + excluded.turns, active_ms = active_ms + excluded.active_ms`)
  const tool = db.query(`INSERT INTO usage_scope_tools VALUES (?, ?, ?, 1, ?, ?)
    ON CONFLICT(day, session_id, tool) DO UPDATE SET calls = calls + 1, ms = ms + excluded.ms, errors = errors + excluded.errors`)
  const saving = db.query(`INSERT INTO usage_scope_savings VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(day, session_id, source) DO UPDATE SET calls = calls + 1, tokens = tokens + excluded.tokens`)
  const label = db.query(`INSERT INTO usage_scope_labels VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(day, session_id, kind, label) DO UPDATE SET count = count + 1`)
  const effort = db.query<{ effort: string | null }, [string]>("SELECT effort FROM sessions WHERE id = ?")
  const starts = new Map<string, Started>()

  function record(event: SessionEvent) {
    const day = dayOf(event.at)
    const s: Started = starts.get(event.sessionId) ?? { items: new Map() }
    const bump = (prompts = 0, words = 0, ai = 0, tools = 0, peak = 0, turns = 0, ms = 0) => activity.run(event.sessionId, day, prompts, words, ai, tools, peak, turns, ms)
    if (event.type === "usage.recorded") {
      usage.run(event.sessionId, day, event.provider, event.model, event.input, event.output, event.reasoning, event.cacheRead, event.cacheWrite, event.costMicros ?? 0, event.costMicros === undefined ? 1 : 0)
    } else if (event.type === "queue.added" && !event.compact && !event.notice) {
      bump(1, event.text.trim() ? event.text.trim().split(/\s+/).length : 0)
    } else if (event.type === "turn.started") {
      s.turn = event.at
      starts.set(event.sessionId, s)
      bump(0, 0, 0, 0, 0, 1)
      label.run(event.sessionId, day, "effort", effort.get(event.sessionId)?.effort ?? "default")
    } else if (event.type === "item.started" && ["agent_message", "reasoning", "tool_call"].includes(event.kind)) {
      const name = typeof event.meta?.tool === "string" ? event.meta.tool : undefined
      s.items.set(event.itemId, { at: event.at, kind: event.kind, ...(name ? { tool: name } : {}) })
      starts.set(event.sessionId, s)
      if (event.kind === "tool_call" && name?.startsWith("skill: ")) {
        const skill = name.slice(7).trim().slice(0, 100)
        if (skill) label.run(event.sessionId, day, "skill", skill)
      }
    } else if (event.type === "item.completed") {
      const item = s.items.get(event.itemId)
      if (!item) return
      s.items.delete(event.itemId)
      const ms = Math.max(0, event.at - item.at)
      if (item.kind === "tool_call") {
        bump(0, 0, 0, ms)
        tool.run(event.sessionId, day, toolBucket(item.tool), ms, event.status === "error" ? 1 : 0)
        const saved = event.meta?.savedTokens
        if (typeof saved === "number" && saved > 0) saving.run(event.sessionId, day, typeof event.meta?.filter === "string" ? event.meta.filter.slice(0, 64) : "filter", Math.floor(saved))
      } else bump(0, 0, ms, 0, ms)
    } else if (ENDED.has(event.type)) {
      if (s.turn !== undefined) bump(0, 0, 0, 0, 0, 0, Math.max(0, event.at - s.turn))
      starts.delete(event.sessionId)
    }
  }

  // Upgrade once, transactionally, including databases with more than a client event window of history.
  if (!db.query("SELECT 1 FROM meta WHERE key = 'usage_scopes_backfill'").get()) {
    db.transaction(() => {
      for (const row of db.query<{ payload: string }, []>("SELECT payload FROM events ORDER BY session_id, seq").iterate()) record(JSON.parse(row.payload) as SessionEvent)
      db.run("INSERT INTO meta(key, value) VALUES ('usage_scopes_backfill', '1')")
    })()
    starts.clear()
  }

  function rows<T>(sql: string, range: Range): T[] {
    return db.query<T, [string, string, string]>(sql).all(range.from, range.to, JSON.stringify(range.directories))
  }
  function daily(range: Range): UsageDay[] {
    return rows(`SELECT day, SUM(input) AS input, SUM(output) AS output, SUM(reasoning) AS reasoning,
      SUM(cache_read) AS cacheRead, SUM(cache_write) AS cacheWrite, SUM(cost_micros) AS costMicros,
      SUM(cost_unknown_calls) AS costUnknownCalls, SUM(calls) AS calls, COUNT(DISTINCT session_id) AS sessions
      FROM usage_scope_daily WHERE day BETWEEN ?1 AND ?2 AND ${VISIBLE} GROUP BY day ORDER BY day`, range)
  }
  function models(range: Range): UsageModel[] {
    return rows(`SELECT provider, model, SUM(input) AS input, SUM(output) AS output, SUM(calls) AS calls,
      SUM(cost_micros) AS costMicros, SUM(cost_unknown_calls) AS costUnknownCalls
      FROM usage_scope_daily WHERE day BETWEEN ?1 AND ?2 AND ${VISIBLE} GROUP BY provider, model ORDER BY calls DESC, provider, model`, range)
  }
  function activities(range: Range): UsageActivityDay[] {
    return rows(`SELECT day, SUM(prompts) AS prompts, SUM(words) AS words, SUM(ai_ms) AS aiMs, SUM(tool_ms) AS toolMs, MAX(longest_ms) AS longestAiMs
      FROM usage_scope_activity WHERE day BETWEEN ?1 AND ?2 AND ${VISIBLE} GROUP BY day ORDER BY day`, range)
  }
  function tools(range: Range, limit = 10): UsageTool[] {
    return db.query<UsageTool, [string, string, string, number]>(`SELECT tool, SUM(calls) AS calls, SUM(ms) AS ms, SUM(errors) AS errors
      FROM usage_scope_tools WHERE day BETWEEN ?1 AND ?2 AND ${VISIBLE} GROUP BY tool ORDER BY calls DESC, ms DESC, tool LIMIT ?4`)
      .all(range.from, range.to, JSON.stringify(range.directories), Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : -1)
  }
  /** Tokens the output filters saved in the range, by filter, biggest first. */
  function savings(range: Range): Array<{ source: string; calls: number; tokens: number }> {
    return rows<{ source: string; calls: number; tokens: number }>(`SELECT source, SUM(calls) AS calls, SUM(tokens) AS tokens
      FROM usage_scope_savings WHERE day BETWEEN ?1 AND ?2 AND ${VISIBLE} GROUP BY source ORDER BY tokens DESC, source LIMIT 20`, range)
  }
  function sessions(range: Range) {
    return rows<{ n: number }>(`SELECT COUNT(DISTINCT session_id) AS n FROM usage_scope_daily WHERE day BETWEEN ?1 AND ?2 AND ${VISIBLE}`, range)[0]?.n ?? 0
  }
  function insights(range: Range & { today: string }): UsageInsights {
    const all = { ...range, from: "0000-01-01", to: "9999-12-31" }
    const days = daily(all)
    const peak = [...days].sort((a, b) => b.input + b.output - a.input - a.output || b.day.localeCompare(a.day))[0]
    const activeDays = new Set([...days.map((d) => d.day), ...activities(all).filter((d) => d.prompts > 0).map((d) => d.day)])
    const sessionRows = (window: Range, longest = false) => rows<UsageInsights["topSessions"][number]>(`WITH u AS (
      SELECT session_id, SUM(input + output) AS tokens FROM usage_scope_daily WHERE day BETWEEN ?1 AND ?2 AND ${VISIBLE} GROUP BY session_id
    ), a AS (
      SELECT session_id, SUM(turns) AS turns, SUM(active_ms) AS ms FROM usage_scope_activity WHERE day BETWEEN ?1 AND ?2 AND ${VISIBLE} GROUP BY session_id
    ) SELECT x.id AS sessionId, x.title, x.directory, COALESCE(u.tokens, 0) AS tokens, COALESCE(a.ms, 0) AS ms, COALESCE(a.turns, 0) AS turns
      FROM sessions x LEFT JOIN u ON u.session_id = x.id LEFT JOIN a ON a.session_id = x.id
      WHERE u.session_id IS NOT NULL OR a.session_id IS NOT NULL ORDER BY ${longest ? "ms DESC, tokens DESC" : "tokens DESC, ms DESC"}, sessionId LIMIT ${longest ? 1 : 10}`, window)
    const longest = sessionRows(all, true).find((s) => s.ms > 0)
    const labels = (kind: string) => rows<{ label: string; count: number }>(`SELECT label, SUM(count) AS count FROM usage_scope_labels
      WHERE day BETWEEN ?1 AND ?2 AND ${VISIBLE} AND kind = '${kind}' GROUP BY label ORDER BY count DESC, label LIMIT 10`, range)
    return {
      ...(days.length ? { lifetime: { tokens: days.reduce((sum, d) => sum + d.input + d.output, 0), since: days[0]!.day } } : {}),
      ...(peak ? { peakDay: { day: peak.day, tokens: peak.input + peak.output } } : {}),
      streak: streaks([...activeDays].sort(), range.today),
      ...(longest ? { longestSession: longest } : {}),
      efforts: labels("effort").map((l) => ({ effort: l.label, turns: l.count })),
      skills: labels("skill").map((l) => ({ skill: l.label, runs: l.count })),
      topSessions: sessionRows(range),
    }
  }

  function sessionSavings(sessionId: string): Array<{ source: string; calls: number; tokens: number }> {
    return db.query<{ source: string; calls: number; tokens: number }, [string]>(`SELECT source, SUM(calls) AS calls, SUM(tokens) AS tokens
      FROM usage_scope_savings WHERE session_id = ? GROUP BY source ORDER BY tokens DESC, source LIMIT 20`).all(sessionId)
  }

  return { record, daily, models, activity: activities, tools, savings, sessionSavings, sessions, insights,
    directories: () => db.query<{ directory: string }, []>("SELECT DISTINCT directory FROM sessions ORDER BY directory").all().map((s) => s.directory),
  }
}
