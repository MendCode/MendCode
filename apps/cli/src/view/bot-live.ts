import type { BotListReport, BotState } from "@mendcode/protocol"
import type { ActivityEvent } from "./session-activity"

/**
 * A bot's working/waiting/idle kept from the sessions the terminal already holds (experimental bots): a `session.activity` push for a
 * session of a listed bot patches the last `bot.list` report in place, so no request goes out. The daemon's own rule
 * (`botStateOf` in the daemon's bot-service): a wait over work over a recent failure over idle. A failure counts for ten minutes and
 * only while nothing of the bot has had newer activity that did not fail.
 */
const PROBLEM_WINDOW_MS = 10 * 60_000
export function stateOf(sessions: ReadonlyArray<{ status: string; updatedAt: number }>, now: number): BotState {
  if (sessions.some((session) => session.status.startsWith("waiting_"))) return "waiting"
  if (sessions.some((session) => session.status === "running")) return "working"
  const newestOk = Math.max(0, ...sessions.filter((session) => session.status !== "failed").map((session) => session.updatedAt))
  return sessions.some((session) => session.status === "failed" && now - session.updatedAt <= PROBLEM_WINDOW_MS && session.updatedAt >= newestOk) ? "problem" : "idle"
}

/** The session status a foreground state stands for in a bot report. */
export const botStatusOf = (state: ActivityEvent["state"]): string => state === "idle" || state === "queued" ? "idle" : state === "waiting_approval" ? "waiting_approval" : state === "error" ? "failed" : "running"

/** Which bot a listed session belongs to. */
export function botIndex(report: BotListReport | undefined): Map<string, string> {
  const index = new Map<string, string>()
  for (const bot of report?.bots ?? []) for (const project of bot.projects) for (const member of project.sessions) index.set(member.sessionId, bot.name)
  return index
}

/** The report with this push applied to the bot session it names, or undefined when no bot lists that session. */
export function patchBotReport(report: BotListReport, event: ActivityEvent, now: number = Date.now()): BotListReport | undefined {
  let found = false
  const status = botStatusOf(event.state)
  const bots = report.bots.map((bot) => {
    if (!bot.projects.some((project) => project.sessions.some((member) => member.sessionId === event.sessionId))) return bot
    found = true
    const projects = bot.projects.map((project) => {
      if (!project.sessions.some((member) => member.sessionId === event.sessionId)) return project
      const sessions = project.sessions.map((member) => (member.sessionId === event.sessionId ? { ...member, title: event.title, status, updatedAt: event.updatedAt } : member))
      return { ...project, sessions, state: stateOf(sessions, now) }
    })
    return { ...bot, projects, state: stateOf(projects.flatMap((project) => project.sessions), now) }
  })
  return found ? { ...report, bots } : undefined
}
