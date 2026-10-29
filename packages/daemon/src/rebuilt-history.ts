import type { ModelMessage } from "@mendcode/engine-native"
import type { SessionTranscriptItem, SessionTranscriptTurn } from "@mendcode/protocol"
import { estimateTokens } from "@mendcode/protocol/wire"
import { HANDOFF_END } from "./handoff"

/** One tool output is kept to this many characters (its start and its end): a long log should not take the room of ten turns. */
const OUTPUT_CHARS = 6_000
const INPUT_CHARS = 2_000
const REQUEST_CHARS = 2_000

/** What a rebuild writes: the native engine's user and assistant messages, never a tool result (no tool of its own ran). */
export type RebuiltMessage = Extract<ModelMessage, { role: "user" | "assistant" }>

export type RebuiltHistory = {
  messages: RebuiltMessage[]
  /** Turns rebuilt whole, and the older ones left out (readable with `session_read`). */
  turns: number
  omitted: number
  tokens: number
}

const clipMiddle = (text: string, max: number) => (text.length > max ? `${text.slice(0, Math.floor(max * 0.6))}\n… [${text.length - max} characters cut] …\n${text.slice(text.length - Math.floor(max * 0.4))}` : text)
const defang = (text: string) => text.replaceAll(HANDOFF_END, "[End of handoff ]")

/** A tool call another engine ran, as a record in the assistant's text: the native model cannot call that tool, so it is never a tool call. */
function toolRecord(item: SessionTranscriptItem): string {
  const status = item.status === "ok" || item.status === undefined ? "ok" : item.status
  const input = item.input?.trim() ? ` ${clipMiddle(item.input.trim(), INPUT_CHARS)}` : ""
  const output = item.text.trim() ? `\n${clipMiddle(item.text.trimEnd(), OUTPUT_CHARS)}` : ""
  return `[ran ${item.tool ?? "tool"}${input} → ${status}]${output}`
}

/** One turn as the messages the native engine keeps: what the user sent, then what the assistant answered and ran, in order. Reasoning stays out (another model's, unsigned). */
export function turnMessages(turn: SessionTranscriptTurn): RebuiltMessage[] {
  const messages: RebuiltMessage[] = []
  let answer: string[] = []
  const flush = () => {
    if (answer.length) messages.push({ role: "assistant", content: defang(answer.join("\n\n")), toolCalls: [] })
    answer = []
  }
  for (const item of turn.items) {
    if (item.kind === "user_message") {
      const text = item.text.trim()
      if (!text) continue
      flush()
      const content = item.source === "shell" ? `Typed in the terminal: $ ${text}` : item.source === "notice" ? `System notice: ${text}` : text
      const last = messages.at(-1)
      if (last?.role === "user") last.content = `${last.content}\n\n${defang(content)}`
      else messages.push({ role: "user", content: defang(content) })
    } else if (item.kind === "agent_message") {
      if (item.text.trim()) answer.push(item.text.trim())
    } else if (item.kind === "tool_call") answer.push(toolRecord(item))
  }
  flush()
  if (turn.outcome === "cancelled" || turn.outcome === "interrupted" || turn.outcome === "failed") messages.push({ role: "assistant", content: `(turn ${turn.outcome})`, toolCalls: [] })
  return messages
}

const size = (messages: readonly RebuiltMessage[]) => messages.reduce((sum, message) => sum + message.content.length, 0)

/**
 * The conversation another engine ran, as native messages: the newest turns whole (tool outputs cut at both ends) while they
 * fit `budgetTokens`, and the original request when its turn did not fit. The head says where it came from and what was left
 * out. Nothing here calls a model; a compaction of the result writes the summary.
 */
export function rebuildHistory(input: { turns: readonly SessionTranscriptTurn[]; skipped: number; budgetTokens: number; fromStart: boolean; from: string; to: string; sessionId: string }): RebuiltHistory | undefined {
  const rendered = input.turns.map((turn) => ({ turn, messages: turnMessages(turn) })).filter((entry) => entry.messages.length)
  if (!rendered.length) return undefined
  let room = input.budgetTokens * 4
  const chosen: typeof rendered = []
  for (let index = rendered.length - 1; index >= 0; index--) {
    const cost = size(rendered[index]!.messages)
    // The newest turn always comes, even past the budget: its outputs are already cut.
    if (chosen.length && cost > room) break
    chosen.unshift(rendered[index]!)
    room -= cost
  }
  const omitted = rendered.length - chosen.length + input.skipped
  const first = input.fromStart ? input.turns[0]?.items.find((item) => item.kind === "user_message" && item.source === undefined && item.text.trim()) : undefined
  const carriesFirst = chosen[0]?.turn === input.turns[0]
  const head = [
    `[Handoff: this session ran on ${input.from} until now and continues on ${input.to}. Its turns follow as they happened; what it ran appears as [ran …] records in the answers, not as tools you can call. Continue from them, do not run them again.]`,
    ...(first && !carriesFirst ? [`Original request:\n${defang(clipMiddle(first.text.trim(), REQUEST_CHARS))}`] : []),
    ...(omitted > 0 ? [`[${omitted} earlier ${omitted === 1 ? "turn is" : "turns are"} not included. They stay in MendCode session ${input.sessionId}; session_read pages through them.]`] : []),
  ].join("\n\n")
  const messages = chosen.flatMap((entry) => entry.messages)
  if (messages[0]?.role === "user") messages[0] = { ...messages[0], content: `${head}\n${HANDOFF_END}\n\n${messages[0].content}` }
  else messages.unshift({ role: "user", content: `${head}\n${HANDOFF_END}` })
  return { messages, turns: chosen.length, omitted, tokens: estimateTokens(size(messages)) }
}
