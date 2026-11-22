import type { BotActivityReport, ExternalBotInfo } from "@mendcode/protocol"
import type { TextSection } from "../../view/text-page"
import { relativeTime } from "../../view/session-list"
import { createTextPageState, preload } from "../lazy-pages"
import type { AppContext } from "./context"

/**
 * What a bot of another app does there (docs/agents.md "Hermes bots"): the page a row under a working bot opens. It shows the
 * session's newest messages as the app's own server gives them, to read; nothing is sent to the app and no MendCode session is
 * made. Loaded by the first such row opened.
 */
type Running = NonNullable<ExternalBotInfo["activity"]>[number]

const strip = (message: string) => message.replace(/^\[(?:BOT|BOTS|DAEMON|HERMES)\]:\s*/, "")
const WHO: Record<BotActivityReport["messages"][number]["role"], string> = { user: "Asked", assistant: "Answered", tool: "Tool" }

/** The page's sections: what is known of the session, then its messages oldest first (a run of tool calls is one section of bullets). */
export function activitySections({ bot, session, known, report, now }: { bot: Pick<ExternalBotInfo, "name" | "origin" | "app">; session: string; known?: Running | undefined; report?: BotActivityReport | undefined; now: number }): TextSection[] {
  const facts = [
    `- session ${session}${known?.source ? ` · started by ${known.source}` : ""}`,
    ...(known?.startedAt !== undefined ? [`- started ${relativeTime(now, known.startedAt)} ago${known.activeAt !== undefined ? ` · last active ${relativeTime(now, known.activeAt)} ago` : ""}`.replace(/now ago/g, "just now")] : []),
    `- read-only: it runs in ${bot.app ?? bot.origin}, not in MendCode`,
  ]
  const sections: TextSection[] = [{ heading: known?.title?.trim() || "Session", note: bot.name, lines: facts }]
  if (!report) return sections
  if (report.more) sections.push({ lines: ["Older messages are in the app."], muted: true })
  for (const message of report.messages) {
    const last = sections.at(-1)!
    const note = message.at !== undefined ? relativeTime(now, message.at) : ""
    if (message.role === "tool") {
      const line = `- ${message.tool ?? "tool"}${message.text ? `: ${message.text.replace(/\s+/g, " ")}` : ""}`
      if (last.heading === WHO.tool) last.lines.push(line)
      else sections.push({ heading: WHO.tool, ...(note ? { note } : {}), lines: [line], muted: true })
    } else sections.push({ heading: WHO[message.role], ...(note ? { note } : {}), lines: message.text.split("\n") })
  }
  if (!report.messages.length) sections.push({ lines: ["No messages yet."], muted: true })
  return sections
}

export async function openBotActivity(ctx: AppContext, { bot, session, known }: { bot: ExternalBotInfo; session: string; known?: Running | undefined }) {
  const { state, input, now, requestFrame } = ctx
  await preload("changelog")
  const title = `${bot.name} in ${bot.app ?? bot.origin}`
  const page = createTextPageState({ title, summary: "what it is doing there · read-only", sections: activitySections({ bot, session, known, now: now() }), status: "loading", hint: "reading the session…" })
  state.textPage = page
  state.textReturn = undefined
  state.page = "text"
  requestFrame()
  const reply = await input.send({ type: "bot.activity", origin: bot.origin, bot: bot.id, session })
  // Another page opened meanwhile: the answer is not shown over it.
  if (state.page !== "text" || state.textPage !== page) return
  // The app would not give the messages: what the list already knew of the session stays on the page, with the reason.
  state.textPage = reply.ok
    ? createTextPageState({ title, summary: "what it is doing there · read-only", sections: activitySections({ bot, session, known, report: reply.result as BotActivityReport, now: now() }) })
    : createTextPageState({ title, summary: "what it is doing there · read-only", sections: [...activitySections({ bot, session, known, now: now() }), { heading: "Messages not read", lines: [strip(reply.error.message)] }] })
  requestFrame()
}
