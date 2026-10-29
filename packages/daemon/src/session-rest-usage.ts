import type { RestMessage, SessionId } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"
import { localDay } from "./usage-today"

const counts = () => ({ sessions: 0, messages: 0, userMessages: 0, userWords: 0, tokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheTokens: 0, cost: 0, aiResponseMs: 0, toolMs: 0, changedFiles: 0 })
type Counts = ReturnType<typeof counts>
/** Most recent local days padded with empty rows; keeps the answer inside one daemon frame. */
export const DENSE_DAYS = 366
export function restUsage(input: { store: Store; messages(id: SessionId): RestMessage[]; now: number; start: number; limit: number; messageLimit: number }) {
  const sessions = input.store.listSessions({ roots: false, since: input.start, limit: Math.min(500, input.limit) })
  if (input.limit > 500) sessions.push(...input.store.listSessions({ roots: false, since: input.start, limit: input.limit - 500, offset: 500 }))
  const days = new Map<string, Counts & { day: string; time: number; ids: Set<string> }>()
  const tools = new Map<string, number>(), agents = new Map<string, number>(), models = new Map<string, { count: number; tokens: number; cost: number }>()
  let longestTaskMs = 0, sessionsWithCodeChanges = 0
  for (const session of sessions) {
    const rows = input.messages(session.sessionId).filter((message) => message.info.time.created >= input.start && message.info.time.created <= input.now).slice(-input.messageLimit)
    const files = new Set(input.store.turns.list(session.sessionId).filter((turn) => !turn.reverted && turn.at >= input.start).flatMap((turn) => input.store.turns.files.list(session.sessionId, turn.turnId).map((file) => file.path)))
    if (files.size) sessionsWithCodeChanges++
    for (const message of rows) {
      const time = message.info.time.created, day = localDay(time)
      let data = days.get(day)
      if (!data) {
        data = { ...counts(), day, time: new Date(`${day}T00:00:00`).getTime(), ids: new Set() }
        days.set(day, data)
      }
      data.ids.add(session.sessionId)
      data.messages++
      if (message.info.role === "user") {
        data.userMessages++
        data.userWords += message.parts.filter((part) => part.type === "text").map((part) => String(part.text ?? "")).join(" ").trim().split(/\s+/).filter(Boolean).length
      } else {
        const tokens = message.info.tokens as { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } | undefined
        const incoming = tokens?.input ?? 0, outgoing = tokens?.output ?? 0, reasoning = tokens?.reasoning ?? 0, cache = (tokens?.cache?.read ?? 0) + (tokens?.cache?.write ?? 0)
        const total = incoming + outgoing + reasoning + cache, cost = typeof message.info.cost === "number" ? message.info.cost : 0
        data.inputTokens += incoming
        data.outputTokens += outgoing
        data.reasoningTokens += reasoning
        data.cacheTokens += cache
        data.tokens += total
        data.cost += cost
        const duration = message.info.time.completed ? Math.max(0, message.info.time.completed - time) : 0
        data.aiResponseMs += duration
        longestTaskMs = Math.max(longestTaskMs, duration)
        const agent = String(message.info.agent ?? "build")
        agents.set(agent, (agents.get(agent) ?? 0) + 1)
        if (message.info.modelID) {
          const name = `${message.info.providerID ?? ""}/${message.info.modelID}`
          const value = models.get(name) ?? { count: 0, tokens: 0, cost: 0 }
          value.count++
          value.tokens += total
          value.cost += cost
          models.set(name, value)
        }
        for (const part of message.parts) if (part.type === "tool") {
          const name = String(part.tool)
          tools.set(name, (tools.get(name) ?? 0) + 1)
          const state = part.state as { time?: { start?: number; end?: number } } | undefined
          if (state?.time?.start !== undefined && state.time.end !== undefined) data.toolMs += Math.max(0, state.time.end - state.time.start)
        }
      }
    }
    const last = rows.at(-1)
    if (last) days.get(localDay(last.info.time.created))!.changedFiles += files.size
  }
  // Like the donor API, every local day from `start` to today is a row (zeroed when idle). Only the most recent DENSE_DAYS are padded, so an epoch `start`
  // stays inside one frame; older days appear only when they have activity.
  const midnight = new Date(input.now)
  midnight.setHours(0, 0, 0, 0)
  const first = new Date(Math.max(new Date(input.start).setHours(0, 0, 0, 0), new Date(midnight).setDate(midnight.getDate() - DENSE_DAYS + 1)))
  for (const cursor = new Date(first); cursor.getTime() <= midnight.getTime(); cursor.setDate(cursor.getDate() + 1)) {
    const day = localDay(cursor.getTime())
    if (!days.has(day)) days.set(day, { ...counts(), day, time: cursor.getTime(), ids: new Set() })
  }
  const projected = [...days.values()].sort((a, b) => a.day.localeCompare(b.day)).map(({ ids, ...day }) => ({ ...day, sessions: ids.size }))
  const totals = counts()
  for (const day of projected) for (const key of Object.keys(totals) as Array<keyof Counts>) totals[key] += day[key]
  totals.sessions = sessions.length
  let run = 0, longestStreak = 0, activeDays = 0, prior = 0
  for (const day of projected) {
    const at = new Date(`${day.day}T12:00:00Z`).getTime()
    if (day.tokens > 0 || day.userMessages > 0) {
      activeDays++
      run = prior && at - prior === 86_400_000 ? run + 1 : 1
      longestStreak = Math.max(longestStreak, run)
    } else run = 0
    prior = at
  }
  const top = (map: Map<string, number>) => [...map].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 8)
  return { days: projected, totals: { ...totals, activeDays, currentStreak: run, longestStreak, peakTokens: Math.max(0, ...projected.map((day) => day.tokens)), longestTaskMs, sessionsWithCodeChanges }, topTools: top(tools), topAgents: top(agents), topModels: [...models].map(([name, value]) => ({ name, ...value })).sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name)).slice(0, 8) }
}
