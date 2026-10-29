import { mkdirSync, existsSync, realpathSync } from "node:fs"
import path from "node:path"
import { acpAgentKey } from "@mendcode/engine-acp"
import type { AgentProfile } from "@mendcode/engine-native"
import { WorkflowEngineId, type ModelChoice, type ModelRoles, type WorkflowPlan, type WorkflowRun, type WorkflowTaskExecution, type WorkflowTaskSpec } from "@mendcode/protocol"
import { catalogModel, invalidChoice, resolveModel, usableEffort, type ModelCatalog } from "./models"

/** Worktrees are explicit, detached, and retained for review. No promotion, cleanup or shell interpolation. */
export function createWorkflowRouter(options: {
  dir: string
  catalog: ModelCatalog
  roles(directory: string): ModelRoles
  sessionModel(run: WorkflowRun): ModelChoice | undefined
  agent(directory: string, name: string): AgentProfile | undefined
  /** A reason an agent may not run on another engine (tier, safe mode), or undefined when it may. */
  crossEngine?(): string | undefined
}) {
  /** The engine a catalog model runs on: its own, ACP by model id, otherwise the native one. */
  const engineOf = (model: string) => catalogModel(options.catalog, model)?.engine ??(model.startsWith("acp:") ? acpAgentKey(model) : "native")
  /** Engines this daemon can run a workflow agent on: native, plus every engine of a catalog model. */
  const configuredEngines = () => ["native", ...new Set(options.catalog.list().flatMap((entry) => (entry.engine ? [entry.engine] : [])))]
  const pending = new Map<string, Promise<string>>()
  const git = async (cwd: string, argv: string[]) => {
    const child = Bun.spawn(["git", ...argv], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (code) throw new Error(err.trim().slice(-500) || `git exited ${code}`)
    return out.trim()
  }
  /** An agent that names an engine: it must be configured, the model must belong to it, and a non-native engine must be able to hold the call's limits. */
  function engineProblem(engine: string, model: ModelChoice | undefined, spec: { agent?: string | undefined; allowedTools?: unknown; permissions?: unknown; budget?: unknown } | undefined, directory: string): string | undefined {
    if (engine.startsWith("acp:")) return "ACP agents cannot enforce workflow task policies; choose a native provider model or a Claude Code, Codex or pi model"
    if (!configuredEngines().includes(engine)) return `unknown engine "${engine}"; configured: ${configuredEngines().join(", ")}`
    if (engine !== "native") {
      const refused = options.crossEngine?.()
      if (refused) return refused
      if (!model) return `engine "${engine}" needs an exact model of that engine (model: "...")`
      if (spec?.allowedTools || spec?.permissions || spec?.budget) return `engine "${engine}" cannot enforce allowedTools or per-agent budgets; use native, or drop them`
      const profile = spec?.agent && spec.agent !== "general" ? options.agent(directory, spec.agent) : undefined
      if (profile && (profile.tools || profile.deny?.some((tool) => tool !== "todo") || profile.permissionRules?.length)) return `engine "${engine}" cannot enforce agent "${spec?.agent}" tool or path rules; use general or native`
    }
    if (model && engineOf(model.model) !== engine) return `model ${model.model} runs on ${engineOf(model.model)}, not on ${engine}`
    return undefined
  }
  function resolve(directory: string, model: ModelChoice | undefined, name: string | undefined, session?: ModelChoice, engine?: string, spec?: Parameters<typeof engineProblem>[2]) {
    const agent = name ? options.agent(directory, name) : undefined
    if (name && name !== "build" && !agent) throw new Error(`unknown or untrusted workflow agent ${name}`)
    if (engine) {
      const problem = engineProblem(engine, model, spec, directory)
      if (problem) throw new Error(problem)
      if (engine !== "native") {
        const info = invalidChoice(model!, options.catalog, "main")
        if (info) throw new Error(info)
        return usableEffort(model!, options.catalog)
      }
    }
    const configured = options.roles(directory).workflow
    const choice = model ?? configured ?? (agent?.model ? { model: agent.model, ...(agent.effort ? { effort: agent.effort } : {}) } : options.catalog.selectable ? resolveModel({ role: "workflow", session, roles: options.roles(directory), catalog: options.catalog }) : undefined)
    if (choice) {
      if (choice.model.startsWith("acp:")) throw new Error("ACP agents cannot enforce workflow task policies; choose a native provider model")
      const problem = invalidChoice(choice, options.catalog, "workflow")
      if (problem) throw new Error(problem)
    }
    return choice ? usableEffort(choice, options.catalog) : undefined
  }
  async function workspace(run: WorkflowRun, spec: WorkflowTaskSpec, execution: WorkflowTaskExecution) {
    const mode = run.plan.workspace?.mode.includes("worktree") ? run.plan.workspace.mode : execution.workspace.mode
    if (!mode.includes("worktree")) return execution.directory
    if (execution.directory !== run.directory) {
      const top = await git(execution.directory, ["rev-parse", "--show-toplevel"])
      if (realpathSync(top) !== realpathSync(execution.directory)) throw new Error("workflow worktree is no longer available")
      return execution.directory
    }
    const shared = run.plan.workspace?.mode.includes("worktree")
    const owner = mode === "per-loop-worktree" && run.originSessionId ? run.originSessionId : run.workflowId
    const key = `${owner}/${shared ? "run" : spec.id}`
    let created = pending.get(key)
    if (!created) {
      created = (async () => {
        const target = path.join(options.dir, "workflows", "workspaces", owner, shared ? "run" : spec.id)
        if (existsSync(target)) {
          const top = await git(target, ["rev-parse", "--show-toplevel"])
          if (realpathSync(top) !== realpathSync(target)) throw new Error("invalid workflow workspace")
          return target
        }
        mkdirSync(path.dirname(target), { recursive: true })
        await git(run.directory, ["worktree", "add", "--detach", target, "HEAD"])
        return target
      })()
      pending.set(key, created)
      void created.catch(() => pending.delete(key))
    }
    return created
  }
  return {
    /** A script agent call, checked when the call is made and before any session exists: its routing problem, or undefined. */
    agentProblem(directory: string, spec: Extract<WorkflowTaskSpec, { kind: "agent" }>): string | undefined {
      try {
        resolve(directory, spec.model, spec.agent ?? "general", undefined, spec.engine, spec)
        return undefined
      } catch (error) {
        return `agent(${JSON.stringify(spec.title)}): ${error instanceof Error ? error.message : String(error)}`
      }
    },
    problems(directory: string, plan: WorkflowPlan) {
      const problems: string[] = []
      // A script's calls are made at run time (each is checked then), but an engine written as a literal is checked before the run starts.
      if (plan.script) {
        for (const match of plan.script.source.matchAll(/\bengine\s*:\s*(["'])([^"'\n]*)\1/g)) {
          const engine = match[2]!
          const problem = !WorkflowEngineId.safeParse(engine).success ? `engine must be "native", "claude", "codex", "pi" or "acp:<name>"` : engine.startsWith("acp:") || !configuredEngines().includes(engine) ? engineProblem(engine, undefined, undefined, directory) : undefined
          if (problem && !problems.includes(`script: ${problem}`)) problems.push(`script: ${problem}`)
        }
      }
      for (const entry of plan.tasks) {
        if (entry.kind === "check" || entry.kind === "human") continue
        const task = entry.kind === "map" ? { ...entry.map.taskTemplate, id: entry.id } : entry
        try { resolve(directory, task.model ?? plan.model, task.agent ?? plan.agent ?? "general") }
        catch (error) { problems.push(`task "${task.id}": ${error instanceof Error ? error.message : String(error)}`) }
      }
      return problems.slice(0, 5)
    },
    async prepare(run: WorkflowRun, spec: WorkflowTaskSpec, execution: WorkflowTaskExecution): Promise<WorkflowTaskExecution> {
      const frozen = run.tasks.find((task) => task.id === spec.id)?.execution
      const agent = spec.kind === "agent" ? execution.agent ?? "general" : undefined
      const model = spec.kind === "agent" ? frozen?.model ?? resolve(run.directory, execution.model, agent, options.sessionModel(run), spec.engine, spec) : undefined
      return { ...execution, directory: await workspace(run, spec, execution), ...(model ? { model } : {}), ...(agent ? { agent } : {}) }
    },
  }
}
