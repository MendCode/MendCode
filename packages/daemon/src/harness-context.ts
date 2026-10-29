import { estimateTokens, usageContext } from "@mendcode/protocol/wire"
import type { ContextMessage, ContextReport, ContextSection, SessionEvent, SessionTranscriptTurn } from "@mendcode/protocol"

type Usage = Extract<SessionEvent, { type: "usage.recorded" }>

const PREVIEW = 80

/**
 * `/context` for a session Claude Code or Codex runs: they keep the request themselves, so MendCode reports what it knows.
 * The last call's measured context is exact; the history is MendCode's transcript of the turns (messages, answers, tool
 * calls with their output) at chars / 4; what the measurement holds beyond it is the harness's own prompt and tools. A
 * harness that compacted on its own holds less history than the transcript, so the remainder is never negative.
 */
export function harnessContextReport(input: { harness: string; model: string; turns: readonly SessionTranscriptTurn[]; lastUsage?: Usage | undefined; contextWindow?: number | undefined; compactAtTokens: number }): ContextReport {
  const byRole = { user: { chars: 0, count: 0 }, assistant: { chars: 0, count: 0 }, tool: { chars: 0, count: 0 } }
  const sized: ContextMessage[] = []
  let images = 0
  const add = (role: ContextMessage["role"], text: string) => {
    if (!text) return
    byRole[role].chars += text.length
    byRole[role].count++
    sized.push({ role, chars: text.length, tokens: estimateTokens(text.length), preview: text.replace(/\s+/g, " ").trim().slice(0, PREVIEW) })
  }
  for (const turn of input.turns) for (const item of turn.items) {
    if (item.kind === "user_message") {
      add("user", item.text)
      images += item.attachments?.length ?? 0
    } else if (item.kind === "agent_message") add("assistant", item.text)
    else if (item.kind === "tool_call") add("tool", `${item.tool ?? "tool"} ${item.input ?? ""}\n${item.text}`)
  }
  const section = (id: string, label: string, chars: number, count?: number): ContextSection => ({ id, label, chars, tokens: estimateTokens(chars), ...(count === undefined ? {} : { count }) })
  const history = [
    section("history:user", "history · user", byRole.user.chars, byRole.user.count),
    section("history:assistant", "history · assistant", byRole.assistant.chars, byRole.assistant.count),
    section("history:tool", "history · tool results", byRole.tool.chars, byRole.tool.count),
  ]
  const historyTokens = history.reduce((sum, entry) => sum + entry.tokens, 0)
  const measured = input.lastUsage ? usageContext(input.lastUsage) : undefined
  const own = measured !== undefined ? Math.max(0, measured - historyTokens) : 0
  const system = own > 0 ? [{ id: "system:harness", label: `system · ${input.harness}'s own prompt and tools`, chars: own * 4, tokens: own }] : []
  const sections = [...system, ...history]
  const messages = history.reduce((sum, entry) => ({ chars: sum.chars + entry.chars, tokens: sum.tokens + entry.tokens, count: sum.count + (entry.count ?? 0) }), { chars: 0, tokens: 0, count: 0 })
  const categories = [section("system", "system", own * 4), { id: "messages", label: "messages", ...messages }]
  if (own > 0) categories[0]!.tokens = own
  return {
    model: input.model,
    ...(input.contextWindow ? { contextWindow: input.contextWindow } : {}),
    categories,
    sections,
    largest: [...sized].sort((a, b) => b.chars - a.chars).slice(0, 5),
    images,
    estimatedTokens: sections.reduce((sum, entry) => sum + entry.tokens, 0),
    ...(measured !== undefined ? { measuredTokens: measured } : {}),
    compactAtTokens: input.compactAtTokens,
  }
}
