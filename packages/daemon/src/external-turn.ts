import type { TurnInput } from "@mendcode/kernel"
import { capPermission, type AgentProfile } from "@mendcode/engine-native"

/**
 * Per-turn changes for a turn that runs on an engine MendCode does not run itself (Claude Code, an ACP agent). Those
 * engines own their tools and context, so what MendCode can apply is the agent's permission ceiling (a `plan` agent
 * makes the turn read-only) and its instructions, which go in front of the message the engine receives. The message
 * the user sees, and the authority text the permission checks read, stay as typed.
 */
export function withExternalAgent(turn: TurnInput, profile: Pick<AgentProfile, "name" | "prompt" | "permission"> | undefined): TurnInput {
  if (!profile) return turn
  const instructions = profile.prompt.trim()
  const text = instructions ? `[Instructions of agent "${profile.name}" for this message]\n${instructions}\n[End of agent instructions]\n\n${turn.text}` : turn.text
  const cap = profile.permission
  return { ...turn, text, ...(cap ? { permissionMode: () => capPermission(turn.permissionMode(), cap) } : {}) }
}

/**
 * Conversation the engine did not run (a switch of engine, a fork, a merged fork) goes in front of the user's message as
 * quoted context. The message itself is never changed or shortened, and the authority text the permission checks read
 * stays as typed.
 */
export function withHandoff(turn: TurnInput, blocks: readonly string[]): TurnInput {
  if (!blocks.length) return turn
  return { ...turn, text: `${blocks.join("\n\n")}\n\n${turn.text}` }
}
