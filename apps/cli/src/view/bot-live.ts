import type { BotListReport, BotState } from "@mendcode/protocol"
import type { ActivityEvent } from "./session-activity"
import { externalBotId } from "./sidebar-multi"

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

/** Which bot a listed session belongs to: a MendCode bot's name, or an external bot's row id (`xbot:<origin>:<id>`, as the sidebar names it). */
export function botIndex(report: BotListReport | undefined): Map<string, string> {
  const index = new Map<string, string>()
  for (const bot of report?.bots ?? []) for (const project of bot.projects) for (const member of project.sessions) index.set(member.sessionId, bot.name)
  for (const bot of report?.external ?? []) for (const project of bot.projects ?? []) for (const member of project.sessions) index.set(member.sessionId, externalBotId(bot))
  return index
}

/**
 * A new report in which a connector failed (`connector:<origin>` in its problems) and listed nothing keeps that connector's bots from the
 * last report, marked stale: one failed refresh never empties the Bots section. A connector that answers, even with no bots, replaces them.
 */
export function keepKnownExternal(previous: BotListReport | undefined, next: BotListReport): BotListReport {
  if (!previous?.external.length) return next
  const failed = new Set(next.problems.filter((problem) => problem.file.startsWith("connector:")).map((problem) => problem.file.slice("connector:".length)))
  const answered = new Set(next.external.map((bot) => bot.origin))
  const kept = previous.external.filter((bot) => failed.has(bot.origin) && !answered.has(bot.origin)).map((bot) => ({ ...bot, stale: true }))
  return kept.length ? { ...next, external: [...next.external, ...kept] } : next
}

/** One bot (MendCode or external) with this push applied to the session it names; the same object when it lists no such session. */
function patchBot<T extends { projects?: BotListReport["bots"][number]["projects"] | undefined; state: BotState; appState?: BotState | undefined }>(bot: T, event: ActivityEvent, status: string, now: number): T {
  const held = (project: { sessions: ReadonlyArray<{ sessionId: string }> }) => project.sessions.some((member) => member.sessionId === event.sessionId)
  if (!bot.projects?.some(held)) return bot
  const projects = bot.projects.map((project) => {
    if (!held(project)) return project
    const sessions = project.sessions.map((member) => (member.sessionId === event.sessionId ? { ...member, title: event.title, status, updatedAt: event.updatedAt } : member))
    return { ...project, sessions, state: stateOf(sessions, now) }
  })
  const own = stateOf(projects.flatMap((project) => project.sessions), now)
  // An external bot's app may be busy on its own while its MendCode chats are idle: its reported state stands then, as in the daemon.
  return { ...bot, projects, state: own === "idle" && bot.appState ? bot.appState : own }
}

/** The report with this push applied to the bot session it names (a MendCode bot's or an external bot's chat), or undefined when no bot lists that session. */
export function patchBotReport(report: BotListReport, event: ActivityEvent, now: number = Date.now()): BotListReport | undefined {
  // A chat at rest whose sub-agents still work keeps its bot working, as its row in the list does.
  const own = botStatusOf(event.state)
  const status = event.agents && own !== "waiting_approval" ? "running" : own
  const bots = report.bots.map((bot) => patchBot(bot, event, status, now))
  const external = report.external.map((bot) => patchBot(bot, event, status, now))
  const found = bots.some((bot, at) => bot !== report.bots[at]) || external.some((bot, at) => bot !== report.external[at])
  return found ? { ...report, bots, external } : undefined
}
