import type { PermissionMode, SessionId } from "@mendcode/protocol"
import { toolMatches, type AgentDefinition } from "@mendcode/packages"

/** What the engine needs of an agent: the file's settings and its prompt, without where it came from. */
export type AgentProfile = Pick<AgentDefinition, "name" | "description" | "mode" | "model" | "effort" | "tools" | "deny" | "permission" | "permissionRules" | "prompt" | "temperature" | "top_p" | "options" | "steps" | "variant">

/** The engine's view of custom agents; the daemon reads the agent files (and their trust) behind it. */
export interface AgentPort {
  /** The primary agent selected for a session, `undefined` for the default (`build`). Read at the start of each turn. */
  primary(sessionId: SessionId, override?: string): AgentProfile | undefined
  /** The sub-agents `task` may call by name from a project root (trusted ones only). Read at the start of each turn. */
  subagents(cwd: string): AgentProfile[]
  planExit?(sessionId: SessionId, requested?: string): { name: string; profile?: AgentProfile }
  select?(sessionId: SessionId, name: string): void
}

/** From most restrictive to most permissive; an agent's `permission` lowers a session's mode to it, never raises it. */
const MODE_RANK: Record<PermissionMode, number> = { plan: 0, ask: 1, smart: 2, edits: 3, full: 4 }

export function capPermission(mode: PermissionMode, cap: PermissionMode | undefined): PermissionMode {
  return cap && MODE_RANK[mode] > MODE_RANK[cap] ? cap : mode
}

/** Whether an agent may use `tool`: on its allow list (when it has one) and not denied. */
export function agentAllows(agent: Pick<AgentProfile, "tools" | "deny">, tool: string): boolean {
  if (agent.tools && !toolMatches(tool, agent.tools)) return false
  return !(agent.deny && toolMatches(tool, agent.deny))
}

/** The system prompt section an agent adds. Empty when the agent has no prompt body. */
export function agentSection(agent: Pick<AgentProfile, "name" | "prompt" | "temperature" | "top_p" | "options" | "steps" | "variant">): string {
  return agent.prompt.trim() ? `# Agent: ${agent.name}\n\n${agent.prompt.trim()}` : ""
}

/** Agents the `task` description names by default (`subagentCatalog`): the built-ins and a few more. */
export const SUBAGENT_CATALOG_SIZE = 6
/** `agent: "?"` asks for the whole list instead of running anything; `?` is never a valid agent name. */
export const LIST_AGENTS = "?"
const CATALOG_DESCRIPTION = 80

const shortDescription = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > CATALOG_DESCRIPTION ? `${line.slice(0, CATALOG_DESCRIPTION - 1)}…` : line
}

/**
 * The agents block of the `task` tool's description: the first `size` agents (built-ins come first), one short line each,
 * then how many more there are and how to list them. It is sent on every request, so it stays the same size however many
 * agents are installed; the full descriptions come from `agent: "?"` and a prompt only ever reaches the child it runs.
 */
export function subagentCatalog(agents: readonly Pick<AgentProfile, "name" | "description">[], size = SUBAGENT_CATALOG_SIZE): string {
  const shown = agents.slice(0, Math.max(0, size))
  const rest = agents.length - shown.length
  const more = rest ? `${shown.length ? `+${rest} more` : `${rest} agents`}: agent "${LIST_AGENTS}" lists them` : ""
  return ["Sub-agents (name one in `agent`):", ...shown.map((agent) => `- ${agent.name}: ${shortDescription(agent.description)}`), ...(more ? [more] : [])].join("\n")
}

/** Names other agent tools give their general sub-agent (Claude Code's `general-purpose`): a model trained on them writes these. */
const GENERAL_ALIASES = new Set(["general", "general-purpose", "general_purpose", "generalpurpose", "general purpose", "default", "generalist"])

/**
 * The sub-agent a `task` call means: the exact name, the same name in other case, or the general one for its usual aliases
 * (undefined when there is no custom `general`, which is what omitting `agent` runs). Anything else comes back unchanged and
 * is refused with the list of names.
 */
export function subagentName(named: string | undefined, known: ReadonlyMap<string, unknown> | undefined): string | undefined {
  if (!named || known?.has(named)) return named
  const lower = named.trim().toLowerCase()
  const sameCase = [...(known?.keys() ?? [])].find((name) => name.toLowerCase() === lower)
  if (sameCase) return sameCase
  if (GENERAL_ALIASES.has(lower)) return known?.has("general") ? "general" : undefined
  return named
}

/** What `agent: "?"` answers: every agent the caller may name, with its whole description (never its prompt). */
export function subagentListing(agents: readonly Pick<AgentProfile, "name" | "description">[]): string {
  return agents.length ? agents.map((agent) => `- ${agent.name}: ${agent.description}`).join("\n") : "No sub-agents here; omit agent for a general one."
}
