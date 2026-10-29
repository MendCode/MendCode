import { estimateTokens } from "@mendcode/protocol/wire"
import type { SessionTranscriptItem, SessionTranscriptTurn } from "@mendcode/protocol"

/** Tokens of earlier conversation an engine switch, a fork or a merge-back carries (`handoffTokenCap` setting). */
export const DEFAULT_HANDOFF_TOKENS = 16_000
const CHARS_PER_TOKEN = 4
/** Closes the carried block; the conversation inside cannot forge it. */
export const HANDOFF_END = "[End of handoff]"
const REQUEST_CHARS = 2_000
const MESSAGE_CHARS = 3_000
const NOTICE_CHARS = 400
const COMMAND_CHARS = 160
const OUTPUT_CHARS = 300
const COMMANDS_PER_TURN = 8
const FILES_PER_TURN = 12
const MIN_ROOM = 200
const CUT_MARK = " [cut]"
/** Room kept for the "earlier turns are not included" note and for the heading of the original request. */
const NOTE_RESERVE = 240
const REQUEST_BLOCK_OVERHEAD = 40
const FILE_TOOLS = new Set(["edit", "write", "notebook_edit"])

export type HandoffPlan = {
  /** The selected turns as plain text: the original request when it is far back, a note of what was left out, then the newest turns oldest first. */
  body: string
  /** Turns carried in full or cut, and turns left out. */
  turns: number
  omitted: number
  /** About `body.length / 4`. */
  tokens: number
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)} [cut]` : text)
const defang = (text: string) => text.replaceAll(HANDOFF_END, "[End of handoff ]")
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()
const tail = (text: string, max: number) => (text.length > max ? `…${text.slice(text.length - max)}` : text)

function parsed(input: string | undefined): Record<string, unknown> | undefined {
  if (!input) return undefined
  try {
    const value = JSON.parse(input) as unknown
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function commandLine(item: SessionTranscriptItem): string | undefined {
  const args = parsed(item.input)
  const command = typeof args?.command === "string" ? args.command : item.input && !args ? item.input : undefined
  if (!command?.trim()) return undefined
  const output = oneLine(item.text)
  return `- $ ${clip(oneLine(command), COMMAND_CHARS)} -> ${item.status === "ok" || item.status === undefined ? "ok" : item.status}${output ? `: ${tail(output, OUTPUT_CHARS)}` : ""}`
}

function editedFile(item: SessionTranscriptItem): string | undefined {
  if (!item.tool || !FILE_TOOLS.has(item.tool) || (item.status && item.status !== "ok")) return undefined
  const args = parsed(item.input)
  const value = args?.path ?? args?.filePath ?? args?.file_path ?? args?.notebook_path
  return typeof value === "string" && value ? clip(value, 200) : undefined
}

/** One turn as text: the user's message, what it ran and edited, the assistant's answer. Secrets are already markers (the transcript is redacted). */
export function renderTurn(turn: SessionTranscriptTurn): string {
  const lines: string[] = []
  const answers: string[] = []
  const commands: string[] = []
  const files = new Set<string>()
  for (const item of turn.items) {
    if (item.kind === "user_message") {
      if (item.source === "shell") {
        if (item.text.trim()) commands.push(`- $ ${clip(oneLine(item.text), COMMAND_CHARS)} (typed by the user)`)
      } else if (item.source === "notice") lines.push(`System notice: ${clip(oneLine(item.text), NOTICE_CHARS)}`)
      else if (item.text.trim()) lines.push(`User: ${clip(item.text.trim(), MESSAGE_CHARS)}`)
    } else if (item.kind === "agent_message") {
      if (item.text.trim()) answers.push(clip(item.text.trim(), MESSAGE_CHARS))
    } else if (item.kind === "tool_call") {
      if (item.tool === "shell") {
        const line = commandLine(item)
        if (line) commands.push(line)
      } else {
        const file = editedFile(item)
        if (file) files.add(file)
      }
    }
  }
  if (commands.length) lines.push("Commands:", ...commands.slice(0, COMMANDS_PER_TURN), ...(commands.length > COMMANDS_PER_TURN ? [`- (${commands.length - COMMANDS_PER_TURN} more commands)`] : []))
  if (files.size) lines.push(`Edited: ${[...files].slice(0, FILES_PER_TURN).join(", ")}${files.size > FILES_PER_TURN ? ` and ${files.size - FILES_PER_TURN} more` : ""}`)
  if (answers.length) lines.push(`Assistant: ${answers.join("\n")}`)
  if (turn.outcome === "cancelled" || turn.outcome === "interrupted" || turn.outcome === "failed") lines.push(`(turn ${turn.outcome})`)
  return lines.length ? defang(lines.join("\n")) : ""
}

/**
 * Picks what fits in `capTokens` (4 characters each) of the conversation `turns` (oldest first): the newest turns whole,
 * as many as fit, plus, when `fromStart` and the first one fell out, the original request. Command outcomes and the files
 * edited are carried as short lines. No model is asked to summarise anything: what is carried is the text, cut per
 * message, and what is left out is counted, so the receiver can read it back with `session_read` when it can.
 */
export function planHandoff(input: { turns: readonly SessionTranscriptTurn[]; capTokens: number; fromStart: boolean; sessionId: string; skipped?: number }): HandoffPlan {
  const cap = Math.max(0, Math.floor(input.capTokens)) * CHARS_PER_TOKEN
  const skipped = input.skipped ?? 0
  const rendered = input.turns.map((turn) => ({ turn, text: renderTurn(turn) })).filter((entry) => entry.text)
  if (!rendered.length || cap === 0) return { body: "", turns: 0, omitted: rendered.length + skipped, tokens: 0 }
  const first = input.fromStart ? input.turns.find((turn) => turn.items.some((item) => item.kind === "user_message" && item.source === undefined && item.text.trim())) : undefined
  const request = first ? first.items.find((item) => item.kind === "user_message" && item.source === undefined && item.text.trim())?.text.trim() : undefined
  /** Newest turns first until `room` is used up. */
  const pick = (room: number) => {
    const picked: Array<{ text: string; turn: SessionTranscriptTurn }> = []
    for (let index = rendered.length - 1; index >= 0; index--) {
      const entry = rendered[index]!
      if (entry.text.length + 2 <= room) {
        picked.push(entry)
        room -= entry.text.length + 2
      } else {
        // The newest turn is never dropped: a cut turn is better than a conversation with nothing from the last answer.
        if (!picked.length && room > MIN_ROOM) picked.push({ turn: entry.turn, text: `${entry.text.slice(0, room - 2 - CUT_MARK.length)}${CUT_MARK}` })
        break
      }
    }
    return picked.reverse()
  }
  const budget = Math.max(0, cap - NOTE_RESERVE)
  let chosen = pick(budget)
  // The original request costs its own block unless the first turn made it in whole.
  if (request && !chosen.some((entry) => entry.turn === first)) chosen = pick(Math.max(0, budget - Math.min(REQUEST_CHARS, request.length) - REQUEST_BLOCK_OVERHEAD))
  const carriesFirst = first !== undefined && chosen.some((entry) => entry.turn === first)
  const omitted = rendered.length - chosen.length + skipped
  const parts: string[] = []
  if (request && !carriesFirst) parts.push(`Original request:\n${defang(clip(request, REQUEST_CHARS))}`)
  if (omitted > 0) parts.push(`[${omitted} earlier ${omitted === 1 ? "turn is" : "turns are"} not included. They stay in MendCode session ${input.sessionId}; an agent with session_read can page through them.]`)
  parts.push(...chosen.map((entry) => entry.text))
  const body = parts.join("\n\n")
  return { body, turns: chosen.length, omitted, tokens: estimateTokens(body.length) }
}
