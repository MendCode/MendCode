import type { AgentInfo } from "@mendcode/protocol"
import type { ColorName, Span } from "../ui/theme"

export function agentColor(agent: Pick<AgentInfo, "color"> | undefined): Pick<Span, "fg" | "fgHex"> {
  const color = agent?.color
  if (color?.startsWith("#")) return { fgHex: color }
  return { fg: (color ?? "primary") as ColorName }
}

/** The colours sub-agents take, in the theme's own names so every theme keeps them apart. */
const SUBAGENT_COLORS: readonly ColorName[] = ["info", "warning", "success", "synType", "accent", "primary"]

/**
 * A sub-agent's own colour, from what it was asked: the same one on its card in the chat and on its row of the Agents strip, and
 * the same every time that session is drawn. Sub-agents at work side by side are told apart at a glance.
 */
export function subagentColor(description: string): ColorName {
  let hash = 2166136261
  for (const char of description.replace(/\s+/g, " ").trim()) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619)
  return SUBAGENT_COLORS[(hash >>> 0) % SUBAGENT_COLORS.length]!
}
