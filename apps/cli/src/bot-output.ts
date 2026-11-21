import type { BotInfo, BotListReport, BotProject, BotSchedule, ExternalBotInfo } from "@mendcode/protocol"

/** One bot as `bot list` and `bot show` print it: a MendCode bot, or one another app reaches MendCode through (Hermes). */
export type BotView = {
  name: string
  /** `mendcode`, or the connector id of the app the bot lives in. */
  origin: string
  state: BotInfo["state"]
  description?: string
  model?: string
  permission?: string
  projects: BotProject[]
  schedules: BotSchedule[]
}

const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
const STATE_WORDS: Record<BotInfo["state"], string> = { working: "working", waiting: "waiting for you", idle: "idle", problem: "problem" }

function ownView(bot: BotInfo): BotView {
  return { name: bot.name, origin: bot.identity.origin, state: bot.state, ...(bot.description ? { description: bot.description } : {}), ...(bot.model ? { model: bot.model } : {}), ...(bot.permission ? { permission: bot.permission } : {}), projects: bot.projects, schedules: bot.schedules ?? [] }
}

function externalView(bot: ExternalBotInfo): BotView {
  return { name: bot.name, origin: bot.origin, state: bot.state, ...(bot.description ? { description: bot.description } : {}), ...(bot.model ? { model: bot.model } : {}), projects: bot.projects ?? [], schedules: [] }
}

export function botViews(report: BotListReport): BotView[] {
  return [...report.bots.map(ownView), ...report.external.map(externalView)]
}

/** The bot named `name` (case-insensitive), a MendCode bot before an app's bot of the same name. */
export function findBot(report: BotListReport, name: string): BotView | undefined {
  const wanted = name.toLowerCase()
  return botViews(report).find((bot) => bot.name.toLowerCase() === wanted)
}

function span(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}
export const ago = (at: number, now: number) => `${span(now - at)} ago`

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

function counts(bot: BotView) {
  const sessions = bot.projects.flatMap((project) => project.sessions)
  return {
    chats: sessions.length,
    running: sessions.filter((session) => session.status === "running").length,
    waiting: sessions.filter((session) => session.status.startsWith("waiting_")).length,
    newest: Math.max(0, ...sessions.map((session) => session.updatedAt)),
  }
}

/** One line per bot: its state, how many chats and in how many folders, how many run or wait, its model and schedules. */
export function botListText(report: BotListReport, now: number): string {
  const bots = botViews(report)
  const lines: string[] = []
  if (!bots.length) lines.push("No bots. Make one with /bot new in the terminal (bots are experimental: /experimental bots on).")
  const width = Math.min(24, Math.max(0, ...bots.map((bot) => bot.name.length)))
  for (const bot of bots) {
    const { chats, running, waiting, newest } = counts(bot)
    const parts = [
      `${plural(chats, "chat")}${bot.projects.length > 1 ? ` in ${bot.projects.length} folders` : ""}`,
      ...(running ? [`${running} running`] : []),
      ...(waiting ? [`${waiting} waiting for you`] : []),
      ...(newest ? [`last ${ago(newest, now)}`] : []),
      ...(bot.model ? [clean(bot.model)] : []),
      ...(bot.schedules.length ? [plural(bot.schedules.length, "schedule")] : []),
      ...(bot.origin !== "mendcode" ? [`from ${clean(bot.origin)}`] : []),
    ]
    lines.push(`${clean(bot.name).padEnd(width)}  ${STATE_WORDS[bot.state].padEnd(15)}  ${parts.join(" · ")}`)
  }
  for (const problem of report.problems) lines.push(`problem: ${clean(problem.file)}: ${clean(problem.message)}`)
  return lines.join("\n") + "\n"
}

/** One bot: what it runs on, then each folder with its chats (newest first) and the bot's schedules. */
export function botShowText(bot: BotView, now: number): string {
  const head = [STATE_WORDS[bot.state], ...(bot.model ? [clean(bot.model)] : []), ...(bot.permission ? [`permission ${bot.permission}`] : []), ...(bot.origin !== "mendcode" ? [`from ${clean(bot.origin)}`] : [])]
  const lines = [`${clean(bot.name)}  ${head.join(" · ")}`]
  if (bot.description) lines.push(`  ${clean(bot.description)}`)
  if (!bot.projects.length) lines.push("", "No chats yet.")
  for (const project of bot.projects) {
    lines.push("", `${clean(project.directory)}  ${STATE_WORDS[project.state]} · ${plural(project.sessions.length, "chat")}`)
    for (const session of [...project.sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
      lines.push(`  ${clean(session.status).padEnd(18)} ${ago(session.updatedAt, now).padStart(8)}  ${session.sessionId}  ${clean(session.title) || "(untitled)"}`)
    }
  }
  if (bot.schedules.length) {
    lines.push("", "Schedules:")
    for (const schedule of bot.schedules) {
      const next = schedule.nextWakeAt !== undefined && schedule.nextWakeAt > now ? ` · next in ${span(schedule.nextWakeAt - now)}` : ""
      lines.push(`  ${clean(schedule.trigger)}  ${clean(schedule.name)}  ${clean(schedule.state)} · ${plural(schedule.runs, "run")}${next}  ${clean(schedule.directory)}`)
    }
  }
  return lines.join("\n") + "\n"
}
