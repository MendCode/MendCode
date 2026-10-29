import path from "node:path"
import type { CommandInput } from "@mendcode/client"
import type { AgentsReport, AgentDebugReport } from "@mendcode/protocol"
import { AGENT_CREATE_PERMISSIONS, agentName } from "@mendcode/protocol/wire"
import type { AutomationDeps, Common } from "./automation"
import type { AgentAutomation } from "./agent-args"
import type { CatalogPrompt } from "./catalog-automation"
import { sessionSelection } from "./session-output"

type Context = AutomationDeps & { directory: string; request(command: CommandInput): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; code: string; message: string }>; result(data: Record<string, unknown>, human: string): number; fail(message: string, exit?: number, code?: string): number }
class Cancelled extends Error {}
class Usage extends Error {}
const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")

export function createAgentAutomation(ctx: Context) {
  return async (command: AgentAutomation & Common) => {
    const ask = async (request: CatalogPrompt) => {
      if (!ctx.prompt || command.json) throw new Usage(`Agent ${request.label.toLowerCase()} needs a terminal or explicit arguments`)
      const value = await ctx.prompt(request)
      if (value === undefined) throw new Cancelled()
      const error = request.validate?.(value)
      if (error) throw new Usage(error)
      return value
    }
    try {
      if (command.kind === "agent.list") {
        const reply = await ctx.request({ type: "agents.list", directory: ctx.directory })
        if (!reply.ok) return ctx.fail(reply.message, 1, reply.code)
        const report = reply.result as unknown as AgentsReport
        const agents = [...report.agents].sort((a, b) => Number(b.source === "builtin") - Number(a.source === "builtin") || a.name.localeCompare(b.name))
        const rows = agents.flatMap((agent) => [`${clean(agent.name)} (${agent.mode})${agent.trusted ? "" : " [untrusted]"}`, `  ${JSON.stringify(agent.permissionRules ?? agent.permission ?? [])}`])
        rows.push(...report.problems.map((problem) => `${clean(problem.file)}: ${clean(problem.message)}`))
        return ctx.result({ ...report, agents }, rows.join("\n") + "\n")
      }
      if (ctx.allowFiles === false) throw new Usage("Agent creation and debug are local only")
      if (command.kind === "agent.debug") {
        const reply = await ctx.request({ type: "agent.debug", directory: ctx.directory, name: command.name, ...(command.tool ? { tool: command.tool } : {}), ...(command.params ? { params: command.params } : {}) })
        if (!reply.ok) return ctx.fail(reply.message, 1, reply.code)
        const report = reply.result as unknown as AgentDebugReport
        const human = command.tool ? { tool: command.tool, input: report.input, result: report.result } : { ...report.agent, tools: report.tools }
        ctx.result(reply.result, JSON.stringify(human, null, 2) + "\n")
        return report.result?.isError ? 1 : 0
      }
      const scope = command.path ? "user" : await ask({ title: "Create agent", label: "Location", options: [{ value: "project", label: "Current project", hint: ctx.directory }, { value: "user", label: "Global", hint: command.dir ?? "Daemon data directory" }] }) as "user" | "project"
      const description = command.description ?? await ask({ title: "Create agent", label: "Description", validate: (text) => text.trim().length > 0 && text.trim().length <= 300 ? undefined : "Description must be 1–300 characters" })
      const permissions = command.permissions ?? (await ask({ title: "Create agent", label: "Permissions", multiple: true, initial: AGENT_CREATE_PERMISSIONS.join(","), options: AGENT_CREATE_PERMISSIONS.map((permission) => ({ value: permission, label: permission })) })).split(",").filter(Boolean)
      const mode = command.mode ?? await ask({ title: "Create agent", label: "Agent mode", initial: "all", options: [{ value: "all", label: "All", hint: "Primary and subagent roles" }, { value: "primary", label: "Primary", hint: "Main agent" }, { value: "subagent", label: "Subagent", hint: "Called by other agents" }] }) as "all" | "primary" | "subagent"
      const model = command.model ? await sessionSelection(ctx.client, { model: command.model }, {}) : undefined
      if (model && !model.ok) throw new Usage(model.message)
      const reply = await ctx.request({ type: "agent.create", directory: ctx.directory, scope, ...(command.path ? { path: path.resolve(ctx.directory, command.path) } : {}), ...(command.generate ? { generate: true, ...(command.name ? { name: command.name } : {}) } : { name: command.name ?? agentName(description) }), description: description.trim(), permissions: permissions as (typeof AGENT_CREATE_PERMISSIONS)[number][], mode, ...(model?.ok && model.model ? { model: model.model.model } : {}) })
      if (!reply.ok) return ctx.fail(reply.message, 1, reply.code)
      if (typeof reply.result.fallback === "string" && !command.json) ctx.err.write(`warning: ${clean(reply.result.fallback)}; wrote the plain template\n`)
      return ctx.result(reply.result, `${reply.result.file}\n`)
    } catch (error) {
      return ctx.fail(error instanceof Cancelled ? "Cancelled" : error instanceof Error ? error.message : String(error), error instanceof Cancelled ? 2 : error instanceof Usage ? 64 : 1, error instanceof Cancelled ? "cancelled" : error instanceof Usage ? "usage" : "failed")
    }
  }
}
