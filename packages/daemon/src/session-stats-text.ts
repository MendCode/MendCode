import type { SessionStats, SessionStatsBucket, SessionStatsUsage } from "@mendcode/store"

/** `session stats` as plain text for a person or a model: every figure the store has, labelled, with what is unknown said so. */

const minutes = (ms: number) => {
  if (ms > 0 && ms < 60_000) return `${Math.max(1, Math.round(ms / 1_000))} s`
  const total = Math.round(ms / 60_000)
  return total >= 60 ? `${Math.floor(total / 60)} h ${String(total % 60).padStart(2, "0")} min` : `${total} min`
}
const tokens = (value: number) => (value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)}M` : value >= 10_000 ? `${Math.round(value / 1_000)}k` : String(value))
const usageLine = (usage: SessionStatsUsage) =>
  `in ${tokens(usage.input)} · out ${tokens(usage.output)} (reasoning ${tokens(usage.reasoning)}) · cache read ${tokens(usage.cacheRead)} · cache write ${tokens(usage.cacheWrite)}${usage.costMicros ? ` · $${(usage.costMicros / 1_000_000).toFixed(2)}` : ""}`
const stamp = (at: number, offsetMinutes: number) => {
  const local = new Date(at + offsetMinutes * 60_000)
  return local.toISOString().slice(0, 16).replace("T", " ")
}
const bucketLine = (entry: SessionStatsBucket) => `  ${entry.key}  active ${minutes(entry.activeMs).padStart(12)}  turns started ${String(entry.turns).padStart(3)}  out ${tokens(entry.usage.output).padStart(6)}  cache read ${tokens(entry.usage.cacheRead).padStart(7)}`

export function sessionStatsText(stats: SessionStats) {
  const offset = stats.utcOffsetMinutes
  const zone = `UTC${offset >= 0 ? "+" : "-"}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}:${String(Math.abs(offset) % 60).padStart(2, "0")}`
  const turns = stats.turns
  const lines = [
    `session ${stats.sessionId} ${JSON.stringify(stats.title || "untitled")}`,
    `directory ${stats.directory}${stats.parentId ? ` · fork of ${stats.parentId}` : ""}`,
    `times are local (${zone}) · created ${stamp(stats.createdAt, offset)}${stats.lastEventAt ? ` · last event ${stamp(stats.lastEventAt, offset)}` : ""} · ${stats.events} events`,
    "",
    `turns ${turns.total}: ${turns.completed} completed, ${turns.cancelled} cancelled, ${turns.failed} failed, ${turns.running} running`,
    `active time (sum of turn durations, waits for approvals included) ${minutes(turns.activeMs)} · waiting on ${stats.approvals.asked} approvals ${minutes(stats.approvals.waitMs)}`,
    `usage ${usageLine(stats.usage.total)}`,
    ...stats.usage.byModel.map((entry) => `  ${entry.provider}/${entry.model} (${entry.records} records): ${usageLine(entry)}`),
    ...(turns.withoutUsage ? [`  ${turns.withoutUsage} ended turns have no recorded usage (unknown, not zero)`] : []),
    ...(turns.partialUsage ? [`  ${turns.partialUsage} turns ended without the engine's total: their usage is the sum of the calls it reported`] : []),
    `sub-agents ${stats.subAgents.runs} runs · ${stats.subAgents.toolCalls} tool calls · ${tokens(stats.subAgents.tokens)} tokens · ${minutes(stats.subAgents.ms)} of agent time (they can run in parallel)`,
    ...(stats.children.sessions ? [`child sessions ${stats.children.sessions}: ${usageLine(stats.children.usage)}`] : []),
    `tool calls ${stats.tools.calls} (${stats.tools.errors} errors) + ${stats.tools.bySubAgents} by sub-agents: ${stats.tools.byTool.map((entry) => `${entry.tool} ${entry.calls}${entry.errors ? ` (${entry.errors} err)` : ""}`).join(", ")}`,
    "",
    "longest turns:",
    ...turns.longest.map((turn) => `  ${stamp(turn.startedAt, offset)} → ${turn.endedAt ? stamp(turn.endedAt, offset) : "running"}  ${minutes(turn.ms)}  ${turn.status}  ${turn.usage ? `${usageLine(turn.usage)}${turn.partial ? " (partial)" : ""}` : "usage unknown"}`),
    "",
    "per day (a turn's time and usage are split over the hours it ran):",
    ...stats.days.map(bucketLine),
    "",
    `per hour${stats.hoursOmitted ? ` (the last ${stats.hours.length}; ${stats.hoursOmitted} earlier hours omitted, see --json)` : ""}:`,
    ...stats.hours.map(bucketLine),
  ]
  return `${lines.join("\n")}\n`
}
