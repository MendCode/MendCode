import type { Database } from "bun:sqlite"

/**
 * Everything the store knows about how one session spent its time and tokens, for a person or a model asked "how long did it
 * work, and on what": turns with their real start and end, active time per day and per hour (a turn's time and its usage are
 * spread over the hours it ran), usage per model, tools, the sub-agents Claude Code ran and their own totals, child sessions,
 * and the time spent waiting on approvals. Turns that ended without any recorded usage are counted, never guessed.
 */

const HOUR_MS = 3_600_000
/** Most recent active hours listed; days are always all listed. */
const MAX_HOURS = 72
const LONGEST_TURNS = 8
const TOP_TOOLS = 15

export type SessionStatsUsage = { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; costMicros: number }
export type SessionStatsTurn = { turnId: string; startedAt: number; endedAt: number | undefined; ms: number; status: "completed" | "cancelled" | "failed" | "running"; usage: SessionStatsUsage | undefined; partial: boolean }
export type SessionStatsBucket = { key: string; activeMs: number; turns: number; usage: SessionStatsUsage }
export type SessionStats = {
  sessionId: string
  title: string
  directory: string
  parentId: string | undefined
  createdAt: number
  lastEventAt: number | undefined
  events: number
  turns: { total: number; completed: number; cancelled: number; failed: number; running: number; activeMs: number; withoutUsage: number; partialUsage: number; longest: SessionStatsTurn[] }
  usage: { total: SessionStatsUsage; byModel: Array<{ provider: string; model: string; records: number } & SessionStatsUsage> }
  days: SessionStatsBucket[]
  hours: SessionStatsBucket[]
  hoursOmitted: number
  tools: { calls: number; errors: number; byTool: Array<{ tool: string; calls: number; errors: number }>; bySubAgents: number }
  subAgents: { runs: number; toolCalls: number; tokens: number; ms: number }
  children: { sessions: number; usage: SessionStatsUsage }
  approvals: { asked: number; waitMs: number }
  /** Local wall-clock offset the day and hour keys use, in minutes east of UTC. */
  utcOffsetMinutes: number
}

const zero = (): SessionStatsUsage => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, costMicros: 0 })
const USAGE_KEYS = Object.keys(zero()) as Array<keyof SessionStatsUsage>
const add = (into: SessionStatsUsage, from: SessionStatsUsage, share = 1) => {
  for (const key of USAGE_KEYS) into[key] += from[key] * share
}
const rounded = (usage: SessionStatsUsage): SessionStatsUsage => Object.fromEntries(Object.entries(usage).map(([key, value]) => [key, Math.round(value)])) as SessionStatsUsage

const pad = (value: number) => String(value).padStart(2, "0")
const localDay = (at: number) => { const date = new Date(at); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` }
const localHour = (at: number) => `${localDay(at)} ${pad(new Date(at).getHours())}:00`
const hourStart = (at: number) => { const date = new Date(at); date.setMinutes(0, 0, 0); return date.getTime() }

export function createSessionStatsRecords(db: Database) {
  const session = db.query<{ title: string; directory: string; parent_id: string | null; created_at: number }, [string]>("SELECT title, directory, parent_id, created_at FROM sessions WHERE id = ?")
  const counts = db.query<{ events: number; last: number | null }, [string]>("SELECT COUNT(*) AS events, MAX(at) AS last FROM events WHERE session_id = ?")
  const turnEvents = db.query<{ type: string; at: number; turn: string | null }, [string]>(`SELECT type, at, json_extract(payload, '$.turnId') AS turn FROM events
    WHERE session_id = ? AND type IN ('turn.started', 'turn.completed', 'turn.cancelled', 'turn.interrupted', 'turn.failed') ORDER BY seq`)
  const usageEvents = db.query<{ turn: string | null; provider: string; model: string; input: number | null; output: number | null; reasoning: number | null; cacheRead: number | null; cacheWrite: number | null; costMicros: number | null; partial: number | null }, [string]>(`SELECT
    json_extract(payload, '$.turnId') AS turn, json_extract(payload, '$.provider') AS provider, json_extract(payload, '$.model') AS model,
    json_extract(payload, '$.input') AS input, json_extract(payload, '$.output') AS output, json_extract(payload, '$.reasoning') AS reasoning,
    json_extract(payload, '$.cacheRead') AS cacheRead, json_extract(payload, '$.cacheWrite') AS cacheWrite, json_extract(payload, '$.costMicros') AS costMicros,
    json_extract(payload, '$.partial') AS partial
    FROM events WHERE session_id = ? AND type = 'usage.recorded' ORDER BY seq`)
  // A tool call's name is its title up to the first ": " (`shell: ls` is shell); the start says whose it is, the end how it went.
  const toolCalls = db.query<{ item: string | null; tool: string | null; agent: number }, [string]>(`SELECT json_extract(payload, '$.itemId') AS item,
    json_extract(payload, '$.meta.tool') AS tool, json_extract(payload, '$.meta.agentParent') IS NOT NULL AS agent
    FROM events WHERE session_id = ? AND type = 'item.started' AND json_extract(payload, '$.kind') = 'tool_call'`)
  const failedItems = db.query<{ item: string | null }, [string]>(`SELECT json_extract(payload, '$.itemId') AS item FROM events
    WHERE session_id = ? AND type = 'item.completed' AND json_extract(payload, '$.status') = 'error'`)
  const agentEnds = db.query<{ runs: number; toolCalls: number | null; tokens: number | null; ms: number | null }, [string]>(`SELECT COUNT(*) AS runs,
    SUM(json_extract(payload, '$.meta.toolCalls')) AS toolCalls, SUM(json_extract(payload, '$.meta.tokens')) AS tokens, SUM(json_extract(payload, '$.meta.durationMs')) AS ms
    FROM events WHERE session_id = ? AND type = 'item.completed' AND json_extract(payload, '$.meta.agentEnd') = 1`)
  const requests = db.query<{ type: string; at: number; id: string | null }, [string]>(`SELECT type, at, json_extract(payload, '$.requestId') AS id FROM events
    WHERE session_id = ? AND type IN ('server.request', 'server.request.resolved') ORDER BY seq`)
  const children = db.query<{ id: string }, [string]>("SELECT id FROM sessions WHERE parent_id = ?")

  function usageOf(row: { input: number | null; output: number | null; reasoning: number | null; cacheRead: number | null; cacheWrite: number | null; costMicros: number | null }): SessionStatsUsage {
    return { input: row.input ?? 0, output: row.output ?? 0, reasoning: row.reasoning ?? 0, cacheRead: row.cacheRead ?? 0, cacheWrite: row.cacheWrite ?? 0, costMicros: row.costMicros ?? 0 }
  }

  function childUsage(id: string, seen: Set<string>): { sessions: number; usage: SessionStatsUsage } {
    const total = { sessions: 0, usage: zero() }
    for (const child of children.all(id)) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      total.sessions++
      for (const row of usageEvents.all(child.id)) add(total.usage, usageOf(row))
      const nested = childUsage(child.id, seen)
      total.sessions += nested.sessions
      add(total.usage, nested.usage)
    }
    return total
  }

  return {
    get(sessionId: string, now: number): SessionStats | undefined {
      const info = session.get(sessionId)
      if (!info) return undefined
      const { events, last } = counts.get(sessionId) ?? { events: 0, last: null }

      const turns = new Map<string, SessionStatsTurn>()
      for (const row of turnEvents.all(sessionId)) {
        if (!row.turn) continue
        if (row.type === "turn.started") { turns.set(row.turn, { turnId: row.turn, startedAt: row.at, endedAt: undefined, ms: 0, status: "running", usage: undefined, partial: false }); continue }
        const turn = turns.get(row.turn)
        if (!turn || turn.endedAt !== undefined) continue
        turn.endedAt = row.at
        turn.status = row.type === "turn.completed" ? "completed" : row.type === "turn.failed" ? "failed" : "cancelled"
      }
      for (const turn of turns.values()) turn.ms = Math.max(0, (turn.endedAt ?? now) - turn.startedAt)

      const byModel = new Map<string, { provider: string; model: string; records: number } & SessionStatsUsage>()
      const total = zero()
      for (const row of usageEvents.all(sessionId)) {
        const usage = usageOf(row)
        add(total, usage)
        const key = `${row.provider}/${row.model}`
        const entry = byModel.get(key) ?? { provider: row.provider, model: row.model, records: 0, ...zero() }
        entry.records++
        add(entry, usage)
        byModel.set(key, entry)
        const turn = row.turn ? turns.get(row.turn) : undefined
        if (turn) {
          turn.usage ??= zero()
          add(turn.usage, usage)
          if (row.partial) turn.partial = true
        }
      }

      // A turn's time and usage go to the hours (and days) it ran in, in proportion to the time it spent in each.
      const days = new Map<string, SessionStatsBucket>()
      const hours = new Map<string, SessionStatsBucket>()
      const bucket = (map: Map<string, SessionStatsBucket>, key: string) => {
        const found = map.get(key) ?? { key, activeMs: 0, turns: 0, usage: zero() }
        map.set(key, found)
        return found
      }
      for (const turn of turns.values()) {
        const end = turn.endedAt ?? now
        bucket(days, localDay(turn.startedAt)).turns++
        bucket(hours, localHour(turn.startedAt)).turns++
        for (let from = turn.startedAt; from < end || from === turn.startedAt;) {
          const to = Math.min(end, hourStart(from) + HOUR_MS)
          const span = Math.max(0, to - from)
          const share = turn.ms > 0 ? span / turn.ms : 1
          for (const target of [bucket(days, localDay(from)), bucket(hours, localHour(from))]) {
            target.activeMs += span
            if (turn.usage) add(target.usage, turn.usage, share)
          }
          if (to <= from) break
          from = to
        }
      }

      const tools = new Map<string, { tool: string; calls: number; errors: number }>()
      let calls = 0
      let errors = 0
      let bySubAgents = 0
      const failed = new Set(failedItems.all(sessionId).map((row) => row.item))
      for (const row of toolCalls.all(sessionId)) {
        if (row.agent) { bySubAgents++; continue }
        // `shell: ls` is shell, `agent Map the faults` (a sub-agent's call) is agent.
        const name = (row.tool ?? "tool").split(": ")[0]!.trim().split(/\s+/)[0]!.slice(0, 60) || "tool"
        const entry = tools.get(name) ?? { tool: name, calls: 0, errors: 0 }
        entry.calls++
        calls++
        if (failed.has(row.item)) { entry.errors++; errors++ }
        tools.set(name, entry)
      }

      const asked = new Map<string, number>()
      let waitMs = 0
      for (const row of requests.all(sessionId)) {
        if (!row.id) continue
        if (row.type === "server.request") asked.set(row.id, row.at)
        else if (asked.has(row.id)) waitMs += Math.max(0, row.at - asked.get(row.id)!)
      }

      const agents = agentEnds.get(sessionId)
      const child = childUsage(sessionId, new Set([sessionId]))
      const ended = [...turns.values()].filter((turn) => turn.status !== "running")
      const allHours = [...hours.values()].filter((entry) => entry.activeMs > 0 || entry.turns > 0).sort((a, b) => a.key.localeCompare(b.key))
      const keptHours = allHours.slice(-MAX_HOURS)
      return {
        sessionId,
        title: info.title,
        directory: info.directory,
        parentId: info.parent_id ?? undefined,
        createdAt: info.created_at,
        lastEventAt: last ?? undefined,
        events,
        turns: {
          total: turns.size,
          completed: ended.filter((turn) => turn.status === "completed").length,
          cancelled: ended.filter((turn) => turn.status === "cancelled").length,
          failed: ended.filter((turn) => turn.status === "failed").length,
          running: turns.size - ended.length,
          activeMs: [...turns.values()].reduce((sum, turn) => sum + turn.ms, 0),
          withoutUsage: ended.filter((turn) => !turn.usage).length,
          partialUsage: ended.filter((turn) => turn.partial).length,
          longest: [...turns.values()].sort((a, b) => b.ms - a.ms).slice(0, LONGEST_TURNS).map((turn) => ({ ...turn, ...(turn.usage ? { usage: rounded(turn.usage) } : {}) })),
        },
        usage: { total: rounded(total), byModel: [...byModel.values()].sort((a, b) => b.output - a.output) },
        days: [...days.values()].sort((a, b) => a.key.localeCompare(b.key)).map((entry) => ({ ...entry, usage: rounded(entry.usage) })),
        hours: keptHours.map((entry) => ({ ...entry, usage: rounded(entry.usage) })),
        hoursOmitted: allHours.length - keptHours.length,
        tools: { calls, errors, byTool: [...tools.values()].sort((a, b) => b.calls - a.calls).slice(0, TOP_TOOLS), bySubAgents },
        subAgents: { runs: agents?.runs ?? 0, toolCalls: agents?.toolCalls ?? 0, tokens: agents?.tokens ?? 0, ms: agents?.ms ?? 0 },
        children: { sessions: child.sessions, usage: rounded(child.usage) },
        approvals: { asked: asked.size, waitMs },
        utcOffsetMinutes: -new Date(now).getTimezoneOffset(),
      }
    },
  }
}
