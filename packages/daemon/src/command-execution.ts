import type { AgentInfo, ModelChoice, PermissionMode } from "@mendcode/protocol"
import { catalogChoice } from "./catalog-control"
import { commandArguments, expandCommandTemplate, type CustomCommand } from "./custom-commands"
import { invalidChoice, modelEngine, usableEffort, type ModelCatalog } from "./models"

export function createCommandExecution(options: {
  catalog: ModelCatalog
  engine?: string
  /**
   * Holds an inline shell command (arguments already bound as quoted words) for the engine and returns the marker that stands for
   * its output in the prompt text. The engine runs it as a `shell` tool call of the turn: permission mode, rules, approval card and sandbox.
   */
  inlineShell(command: string): string
  prompt(input: { directory: string; server: string; name: string; args: Record<string, string> }): Promise<string>
}) {
  function choice(reference: string): ModelChoice {
    const hash = reference.lastIndexOf("#")
    const model = hash > 0 ? reference.slice(0, hash) : reference
    const slash = model.indexOf("/")
    const base = slash > 0 ? catalogChoice({ provider: model.slice(0, slash), model: model.slice(slash + 1) }, options.catalog) : { model }
    return { ...base, ...(hash > 0 ? { variant: reference.slice(hash + 1) } : {}) }
  }

  /**
   * `model` and `agent` of another tool's command (or a skill) name that tool's models and agents (`sonnet`, `Explore`):
   * each is applied only when it exists here, otherwise dropped so the session's model and the current agent stay.
   */
  function soft(command: CustomCommand, agents: AgentInfo[]): CustomCommand {
    if (!command.foreign) return command
    const { agent: requestedAgent, model: requestedModel, ...rest } = command
    const agent = requestedAgent ? agents.find((entry) => entry.name.toLowerCase() === requestedAgent.toLowerCase() && entry.trusted && !entry.hidden)?.name : undefined
    let model: string | undefined
    if (requestedModel) {
      try { model = invalidChoice(choice(requestedModel), options.catalog) ? undefined : requestedModel } catch { model = undefined }
    }
    return { ...rest, ...(agent ? { agent } : {}), ...(model ? { model } : {}) }
  }

  return {
    async prepare(input: { command: CustomCommand; args: string; directory: string; current: ModelChoice; sessionModel: ModelChoice; hasSelection: boolean; currentAgent: string; agents: AgentInfo[]; permission: PermissionMode; trusted: boolean }) {
      const definition = soft(input.command, input.agents)
      const agentName = definition.agent ?? input.currentAgent
      const agent = input.agents.find((entry) => entry.name === agentName && entry.trusted && !entry.hidden)
      if (!agent) throw new Error(`unknown or untrusted agent ${agentName}`)
      const subtask = definition.subtask === true || agent.mode === "subagent" && definition.subtask !== false
      const explicit = definition.model ?? (definition.agent ? agent.model : undefined)
      const model = explicit ? choice(explicit) : input.current
      const selected = options.catalog.selectable || explicit !== undefined || input.hasSelection
      const problem = selected ? invalidChoice(model, options.catalog) : undefined
      if (problem) throw new Error(problem)
      // A command's model and agent apply to Claude Code and ACP turns like any per-turn selection; a subtask needs the native task tool.
      const external = modelEngine(model, options.catalog) || modelEngine(input.sessionModel, options.catalog) || model.model.startsWith("acp:") || input.sessionModel.model.startsWith("acp:")
      if ((subtask || definition.agent || explicit || input.hasSelection) && options.engine && options.engine !== "native") throw new Error("command execution attributes require the native engine")
      if (subtask && external) throw new Error("subtask commands require a native session and model")
      let text: string
      if (definition.mcp) {
        const values = commandArguments(input.args)
        const args: Record<string, string> = {}
        for (const [index, argument] of definition.mcp.arguments.entries()) {
          const value = values[index]
          if (argument.required && !value) throw new Error(`missing MCP prompt argument ${argument.name}`)
          if (value !== undefined) args[argument.name] = value
        }
        if (values.length > definition.mcp.arguments.length) throw new Error("too many MCP prompt arguments")
        text = await options.prompt({ directory: input.directory, server: definition.mcp.server, name: definition.mcp.name, args })
      } else {
        if (/!`[^`]+`/.test(definition.body)) {
          if (input.permission === "plan" || agent.permission === "plan") throw new Error("inline shell is unavailable in plan mode")
          if (definition.source === "project" && !input.trusted) throw new Error("trust this project's tools before executing inline shell (/tools)")
          if (external || options.engine && options.engine !== "native") throw new Error("inline shell in commands needs the native engine and a native model")
        }
        text = await expandCommandTemplate(definition.body, input.args, (command) => options.inlineShell(command))
      }
      return { text, subtask, agent: agentName, ...(explicit !== undefined || input.hasSelection || subtask && selected ? { model: usableEffort(model, options.catalog) } : {}) }
    },
  }
}
