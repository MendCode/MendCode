import type { AgentPort, AgentProfile } from "@mendcode/engine-native"
import { parseAgentFile, readLayerAgents, type ExtensionLayer, type FoundAgent } from "@mendcode/packages"
import type { AgentInfo, AgentsReport, PermissionMode, SessionId, Settings } from "@mendcode/protocol"

/** The agents the engine owns: `build` is today's behaviour, `plan` is plan mode (selecting it sets the permission mode). */
export const BUILTIN_AGENTS: readonly AgentInfo[] = [
  { name: "build", description: "The default agent: works on the task with every tool, asking as the permission mode says.", mode: "primary", source: "builtin", trusted: true },
  { name: "plan", description: "Plan mode: investigates read-only, then proposes a plan for approval before anything is changed.", mode: "primary", source: "builtin", trusted: true },
]

/**
 * `explore` is read-only. Its allow list names the code graph tools too: they reach it only while the `codegraph` feature
 * offers them (the tier denies them otherwise), so the list costs nothing where the graph is off. A user drops them with
 * `agent.explore.deny: ["graph_*", "code_search"]`.
 */
export const BUILTIN_SUBAGENTS: readonly AgentProfile[] = [
  { name: "general", description: "Research and multi-step work", mode: "subagent", prompt: "", deny: ["todo"] },
  { name: "explore", description: "Find files, search code and explain a codebase", mode: "subagent", tools: ["read", "grep", "glob", "list", "shell", "webfetch", "websearch", "graph_find", "graph_callers", "graph_file_api", "graph_map", "code_search"], prompt: "Explore the codebase at the requested thoroughness. When graph tools are offered, locate symbols and callers with them before reading files. Return locations (path:line), how they relate and the evidence for it, not an inventory of what you read." },
]

const toInfo = (agent: FoundAgent): AgentInfo => ({
  name: agent.name,
  description: agent.description,
  mode: agent.mode,
  ...(agent.hidden !== undefined ? { hidden: agent.hidden } : {}),
  ...Object.fromEntries(["disable", "color", "temperature", "top_p", "steps", "variant", "options"].filter((key) => agent[key as keyof FoundAgent] !== undefined).map((key) => [key, agent[key as keyof FoundAgent]])),
  source: agent.source,
  ...(agent.pkg ? { pkg: agent.pkg } : {}),
  file: agent.file,
  ...(agent.model ? { model: agent.model } : {}),
  ...(agent.effort ? { effort: agent.effort } : {}),
  ...(agent.tools ? { tools: agent.tools } : {}),
  ...(agent.deny ? { deny: agent.deny } : {}),
  ...(agent.permission ? { permission: agent.permission } : {}),
  ...(agent.permissionRules ? { permissionRules: agent.permissionRules } : {}),
  trusted: agent.trusted,
})

const toProfile = (agent: FoundAgent): AgentProfile => {
  const { file: _file, source: _source, pkg: _pkg, trusted: _trusted, hidden: _hidden, disable: _disable, color: _color, ...profile } = agent
  return profile
}

/**
 * Custom agents of a project: `agents/*.md` of every extension layer. Files are read when asked (a turn, a listing), so an
 * edit applies to the next turn without a restart. Project agents (the project's own and its packages') count only while
 * the directory is trusted for project tools, like custom tools.
 */
export function createAgentRegistry(options: {
  layers(directory: string): ExtensionLayer[]
  isTrusted(directory: string): boolean
  /** The session's project root; undefined for an unknown session. */
  directoryOf(sessionId: SessionId): string | undefined
  /** The primary agent stored for the session (`session.agent.set`). */
  selected(sessionId: SessionId): string | undefined
  isChild?(sessionId: SessionId): boolean
  planExitAgent?(): string | undefined
  settings?(): Settings
  select?(sessionId: SessionId, name: string): void
  /** Whether a model id is in the catalog: the `model` of a Claude agent file applies only then. */
  modelExists?(id: string): boolean
}) {
  const found = (directory: string) => {
    const result = readLayerAgents(options.layers(directory), { projectTrusted: options.isTrusted(directory), modelExists: options.modelExists })
    for (const [name, config] of Object.entries(options.settings?.().agent ?? {})) {
      const previous = result.agents.find((agent) => agent.name === name && agent.trusted)
      const builtin = [...BUILTIN_AGENTS, ...BUILTIN_SUBAGENTS].find((agent) => agent.name === name)
      const base = previous ?? builtin
      const data = { ...(base ? { ...base, prompt: "prompt" in base ? base.prompt : "" } : { description: name }), ...config, ...(base && "options" in base && base.options || config.options ? { options: { ...(base && "options" in base ? base.options : {}), ...config.options } } : {}) }
      for (const key of ["file", "source", "pkg", "trusted", "name"]) delete (data as Record<string, unknown>)[key]
      const text = `---\n${Object.entries(data).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n`
      const parsed = parseAgentFile({ text, stem: name, file: "settings.agent", source: "user" })
      if ("problem" in parsed) result.problems.push({ file: `settings.agent.${name}`, message: parsed.problem })
      else {
        result.agents = result.agents.filter((agent) => agent.name !== name || !agent.trusted)
        result.agents.push({ ...parsed.agent, trusted: true })
      }
    }
    return result
  }
  const usable = (directory: string) => found(directory).agents.filter((agent) => agent.trusted && !agent.disable)
  const disabled = (directory: string, name: string) => found(directory).agents.some((agent) => agent.name === name && agent.trusted && agent.disable)
  const defaultName = (directory: string) => {
    const name = options.settings?.().default_agent
    const configured = found(directory).agents.filter((agent) => agent.trusted)
    const entries = [...BUILTIN_AGENTS.map((builtin) => configured.find((agent) => agent.name === builtin.name) ?? builtin), ...configured.filter((agent) => !BUILTIN_AGENTS.some((builtin) => builtin.name === agent.name))].filter((agent) => !("disable" in agent && agent.disable))
    const agent = name ? entries.find((agent) => agent.name === name) : entries.find((agent) => agent.mode !== "subagent" && !agent.hidden)
    if (!agent || agent.mode === "subagent" || agent.hidden) throw new Error(name ? `invalid default agent ${name}: choose a visible primary agent` : "no visible primary agent is enabled")
    return agent.name
  }
  function selectable(directory: string, name: string, turn = false): string | undefined {
    if (disabled(directory, name)) return `agent ${name} is disabled`
    const all = found(directory).agents.filter((agent) => agent.name === name)
    const agent = all.find((agent) => agent.trusted)
    if (agent) {
      if (!turn && agent.mode === "subagent") return `agent ${name} is a subagent: it cannot run a session`
      return undefined
    }
    if (BUILTIN_AGENTS.some((agent) => agent.name === name) || turn && BUILTIN_SUBAGENTS.some((agent) => agent.name === name)) return undefined
    return all.length ? `agent ${name} comes from this project, which is not trusted for project tools yet (trust it in /tools)` : `unknown agent ${name}`
  }

  const port = (): AgentPort => ({
    primary(sessionId, override) {
      const directory = options.directoryOf(sessionId)
      if (!directory) return undefined
      const name = override ?? options.selected(sessionId) ?? "build"
      const agent = usable(directory).find((candidate) => candidate.name === name && (override || options.isChild?.(sessionId) || candidate.mode !== "subagent"))
      if (agent) return { ...toProfile(agent), ...(name === "plan" ? { permission: "plan" as const } : {}) }
      if (name === "plan" && !disabled(directory, name)) return { name: "plan", description: "Plan mode", mode: "primary", prompt: "", permission: "plan" }
      return override || options.isChild?.(sessionId) ? BUILTIN_SUBAGENTS.find((agent) => agent.name === name && !disabled(directory, name)) : undefined
    },
    planExit(sessionId, requested) {
      const name = requested?.trim() || options.planExitAgent?.()?.trim() || "build"
      const directory = options.directoryOf(sessionId)
      const agent = directory ? usable(directory).find((agent) => agent.name === name && name !== "plan" && agent.mode !== "subagent" && !agent.hidden) : undefined
      if (agent) return { name, profile: toProfile(agent) }
      if (directory && name !== "plan" && !selectable(directory, name) && BUILTIN_AGENTS.some((agent) => agent.name === name)) return { name }
      const fallback = directory ? defaultName(directory) : "build"
      const profile = directory ? usable(directory).find((agent) => agent.name === fallback) : undefined
      return { name: fallback, ...(profile ? { profile: toProfile(profile) } : {}) }
    },
    select: (sessionId, name) => options.select?.(sessionId, name),
    subagents: (cwd) => [...BUILTIN_SUBAGENTS.filter((builtin) => !disabled(cwd, builtin.name) && !usable(cwd).some((agent) => agent.name === builtin.name)), ...usable(cwd).filter((agent) => agent.mode !== "primary").map(toProfile)],
  })

  return {
    port,
    inspect(directory: string, name: string): (AgentInfo & AgentProfile) | undefined {
      const builtin = BUILTIN_AGENTS.find((agent) => agent.name === name)
      if (builtin) return { name: builtin.name, description: builtin.description, mode: builtin.mode, source: builtin.source, trusted: builtin.trusted, prompt: "", ...(name === "plan" ? { permission: "plan" as const } : {}) }
      const agent = usable(directory).find((agent) => agent.name === name)
      if (agent) return {
        ...toProfile(agent), source: agent.source, trusted: agent.trusted, file: agent.file,
        ...(agent.pkg ? { pkg: agent.pkg } : {}),
        ...(agent.hidden !== undefined ? { hidden: agent.hidden } : {}),
        ...(agent.disable !== undefined ? { disable: agent.disable } : {}),
        ...(agent.color !== undefined ? { color: agent.color } : {}),
      }
      const child = BUILTIN_SUBAGENTS.find((agent) => agent.name === name)
      return child ? { ...child, source: "builtin", trusted: true } : undefined
    },
    defaultName,
    auxiliary(directory: string, name: string) { return found(directory).agents.find((agent) => agent.name === name && agent.trusted) },
    /** What `agents.list` and `session.agent.set` answer. `current` is `plan` while the session is in plan mode, else its selected agent when that still runs, else `build`. */
    report(input: { directory: string; sessionId?: SessionId; permission?: PermissionMode }): AgentsReport {
      const { agents, problems, overridden } = found(input.directory)
      const selected = input.sessionId ? options.selected(input.sessionId) : undefined
      const runs = selected !== undefined && (input.sessionId && options.isChild?.(input.sessionId)
        ? [...BUILTIN_SUBAGENTS, ...agents.filter((agent) => agent.trusted && !agent.disable)].some((agent) => agent.name === selected && !disabled(input.directory, selected))
        : agents.some((agent) => agent.name === selected && agent.trusted && !agent.disable && agent.mode !== "subagent"))
      return {
        directory: input.directory,
        agents: [...BUILTIN_AGENTS.filter((agent) => !agents.some((found) => found.trusted && found.name === agent.name)), ...BUILTIN_SUBAGENTS.filter((agent) => !agents.some((found) => found.trusted && found.name === agent.name)).map(({ prompt: _prompt, ...agent }) => ({ ...agent, source: "builtin" as const, trusted: true })), ...agents.map(toInfo)],
        ...(input.sessionId ? { current: input.permission === "plan" ? "plan" : runs ? selected : "build" } : {}),
        problems,
        ...(overridden.length ? { overridden } : {}),
      }
    },
    /** Why `name` cannot be selected as a session's primary agent, or undefined when it can (`build` and `plan` always can). */
    selectable,
  }
}
export type AgentRegistry = ReturnType<typeof createAgentRegistry>
