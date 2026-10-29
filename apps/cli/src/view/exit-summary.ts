import { compact } from "./format"
import { PROGRAM_NAME } from "@mendcode/program"

/**
 * What v1 prints after leaving the full-screen UI (tui/util/session-exit-summary.ts): which session this was and
 * what it cost, so the user can resume it. Empty only for a chat with nothing in it: a reopened chat that ran no turn
 * still says how to come back (as opencode does), without a usage line. `color` dims the labels and marks the command.
 */
export type ExitSummaryInput = {
  sessionId: string
  title: string
  turns: number
  input: number
  output: number
  model?: string
  elapsedMs: number
  /** The chat has messages from before this run (a reopened session). */
  hasHistory?: boolean
  color?: boolean
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function exitSummary(input: ExitSummaryInput): string {
  if (input.turns === 0 && !input.hasHistory) return ""
  const dim = (text: string) => (input.color ? `\x1b[2m${text}\x1b[22m` : text)
  const bold = (text: string) => (input.color ? `\x1b[1m${text}\x1b[22m` : text)
  const title = input.title.trim() || "untitled"
  const usage = input.turns > 0 ? [input.model, `↑${compact(input.input)} ↓${compact(input.output)}`, `${input.turns} turn${input.turns === 1 ? "" : "s"}`, formatDuration(input.elapsedMs)].filter(Boolean).join(" · ") : ""
  return [`${dim("MendCode ·")} ${bold(title)}`, ...(usage ? [`  ${dim(usage)}`] : []), `  ${dim("resume:")} ${bold(`${PROGRAM_NAME} --session ${input.sessionId}`)}`, ""].join("\n")
}
