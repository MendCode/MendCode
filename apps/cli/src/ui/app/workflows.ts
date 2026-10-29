import { createWorkflowsPageState, parseWorkflowCommand } from "../lazy-pages"
import type { WorkflowId, WorkflowSummary } from "@mendcode/protocol"
import type { WorkflowControlAction } from "../../view/workflows-page"
import type { AppContext } from "./context"

export function createWorkflows(ctx: AppContext) {
  const { input, state, requestFrame, report, say, fail } = ctx

  async function loadWorkflows() {
    const reply = await input.send({ type: "workflow.list", ...(state.workflowsState.scope === "project" ? { directory: input.directory ?? "" } : {}) })
    if (reply.ok) {
      state.workflows = (reply.result?.workflows ?? []) as WorkflowSummary[]
      state.workflowsLoaded = true
      state.workflowsError = ""
      state.workflowsState = { ...state.workflowsState, selected: Math.max(0, Math.min(state.workflowsState.selected, state.workflows.length - 1)) }
    } else state.workflowsError = reply.error.message
    requestFrame()
  }

  async function openWorkflows() {
    state.page = "workflows"
    state.workflowsState = createWorkflowsPageState()
    state.workflowsLoaded = false
    state.workflowsError = ""
    requestFrame()
    await loadWorkflows()
  }

  async function controlWorkflow(workflowId: string, action: WorkflowControlAction | "retry" | "approve" | "reject", taskId?: string) {
    const reply = await input.send({ type: "workflow.control", workflowId: workflowId as WorkflowId, action, ...(taskId ? { taskId } : {}) })
    report(reply)
    if (reply.ok && action === "delete") state.workflows = state.workflows.filter((run) => run.workflowId !== workflowId)
    requestFrame()
  }

  /** `/workflows <name|file>`: previews what will run (every check command, the applied permission); `--yes` starts it. */
  async function workflowCommand(args: string) {
    const parsed = parseWorkflowCommand(args)
    if (!parsed.ok) {
      state.notice = parsed.error
      return
    }
    const { spec } = parsed
    if (spec.kind === "accept") {
      const reply = await input.send({ type: "workflow.control", workflowId: spec.workflowId as WorkflowId, action: "accept", reason: spec.reason })
      if (reply.ok) say("workflow accepted as completed", "success")
      else fail(reply.error.message)
      return
    }
    if (spec.kind === "resume") {
      const reply = await input.send({ type: "workflow.control", workflowId: spec.workflowId as WorkflowId, action: "resume" })
      if (reply.ok) say("workflow resumed", "success")
      else fail(reply.error.message)
      return
    }
    if (spec.kind === "budget") {
      const reply = await input.send({ type: "workflow.script", workflowId: spec.workflowId as WorkflowId, action: "budget", budget: spec.budget })
      if (reply.ok) say(`caps raised: ${Object.entries(spec.budget).map(([key, value]) => `${key} ${value}`).join(", ")} — /workflows resume ${spec.workflowId}`, "success")
      else fail(reply.error.message)
      return
    }
    if (spec.kind === "update" || spec.kind === "new" || spec.kind === "convert") {
      if (input.remote) return say("script files are local; this terminal is connected to a remote daemon", "warning")
      const message = await scriptFileCommand(spec)
      if (message) state.notice = message
      return
    }
    let plan: unknown
    let scriptName: string | undefined
    if (spec.kind === "run") {
      if (input.remote) return say("script workflows start only on the machine that runs them", "warning")
      if ("file" in spec.source) {
        const file = spec.source.file.startsWith("/") ? spec.source.file : `${input.directory ?? "."}/${spec.source.file}`
        const script = await Bun.file(file).text().catch(() => undefined)
        if (script === undefined) return fail(`cannot read ${spec.source.file}`)
        plan = { script, origin: "file", ...(spec.args ? { args: spec.args } : {}) }
      } else plan = { scriptRef: spec.source.ref, ...(spec.args ? { args: spec.args } : {}) }
      scriptName = "file" in spec.source ? spec.source.file : spec.source.ref
    } else if ("file" in spec.source) {
      if (input.remote) return say("workflow files disabled while remote; use a workflow name", "warning")
      const file = spec.source.file.startsWith("/") ? spec.source.file : `${input.directory ?? "."}/${spec.source.file}`
      plan = await Bun.file(file).json().catch(() => undefined)
      if (plan === undefined) return fail(`cannot read ${spec.source.file} as JSON`)
    } else plan = { ref: spec.source.ref }
    const directory = input.directory ?? ""
    const preview = await input.send({ type: "workflow.preview", directory, plan: plan as never })
    if (!preview.ok) return fail(preview.error.message)
    const problems = (preview.result?.problems ?? []) as string[]
    if (problems.length) return fail(problems.slice(0, 3).join(" · "))
    const summary = preview.result?.summary as { name: string; tasks: Array<{ kind?: string; map?: { maxItems: number } }>; checks: string[]; permission: string; phases?: unknown[]; overlapPolicy?: string; maxConcurrent?: number; script?: { hash: string; origin: string; meta: { phases?: unknown[]; budget?: Record<string, number> } } } | undefined
    if (!spec.confirmed && summary?.script) {
      // What a script may spend and what it is, before it runs: the user's approval is the `--yes` that follows this line.
      const caps = Object.entries(summary.script.meta.budget ?? {}).map(([key, value]) => `${key} ${value}`).join(", ") || "no caps declared (10 agent calls)"
      state.notice = `${summary.name}: script ${scriptName ?? ""} · ${summary.script.origin} · sha256 ${summary.script.hash.slice(0, 12)} · caps ${caps} · up to ${summary.maxConcurrent ?? 16} agents at once · ${spec.permission ?? summary.permission}${summary.checks.length ? ` · checks: ${summary.checks.join(", ")}` : ""} — add --yes to start`
      return
    }
    if (!spec.confirmed) {
      const checks = summary?.checks.length ? ` · checks: ${summary.checks.join(", ")}` : " · no checks"
      const composed = [summary?.overlapPolicy ? `overlap ${summary.overlapPolicy}` : undefined, summary?.phases?.length ? `${summary.phases.length} phases` : undefined, ...summary?.tasks.filter((task) => task.kind === "map").map((task) => `map ≤${task.map?.maxItems ?? 0}`) ?? []].filter(Boolean)
      state.notice = `${summary?.name ?? "workflow"}: ${summary?.tasks.length ?? 0} tasks${composed.length ? ` · ${composed.join(" · ")}` : ""} · ${spec.permission ?? summary?.permission ?? "ask"}${checks} — add --yes to start`
      return
    }
    const reply = await input.send({ type: "workflow.start", directory, plan: plan as never, ...(spec.permission ? { permission: spec.permission } : {}), ...(state.sessionId ? { originSessionId: state.sessionId } : {}) })
    if (!reply.ok) return fail(reply.error.message)
    const workflow = reply.result?.workflow as WorkflowSummary | undefined
    say(`workflow ${workflow?.name ?? ""} · ${workflow?.state ?? "running"}`, "success")
    await openWorkflows()
  }

  /** `/workflows new|convert|update`: script files on this machine. Returns the line to show. */
  async function scriptFileCommand(spec: Extract<ReturnType<typeof parseWorkflowCommand> & { ok: true }, { ok: true }>["spec"]): Promise<string | undefined> {
    const base = input.directory ?? "."
    const resolve = (file: string) => (file.startsWith("/") ? file : `${base}/${file}`)
    if (spec.kind === "new") {
      if (!input.dataDir) return "no data directory: write the script yourself and run it with /workflows run <file.js>"
      const { workflowStarter } = await import("../../view/workflow-script")
      const file = `${input.dataDir}/workflows/${spec.name}.js`
      if (await Bun.file(file).exists()) return `workflows/${spec.name}.js already exists`
      await Bun.write(file, workflowStarter(spec.name))
      return `wrote workflows/${spec.name}.js in your data folder — edit it, then /workflows run ${spec.name}`
    }
    if (spec.kind === "convert") {
      const plan = await Bun.file(resolve(spec.file)).json().catch(() => undefined)
      if (plan === undefined) return `cannot read ${spec.file} as JSON`
      const { planToScript } = await import("../../view/workflow-convert")
      const converted = planToScript(plan, spec.file)
      if (!converted.ok) return converted.problems.slice(0, 2).join(" · ")
      const out = resolve(spec.file.replace(/\.json$/, "") + ".js")
      if (await Bun.file(out).exists()) return `${out} already exists`
      await Bun.write(out, converted.script)
      return `wrote ${out}${converted.notes.length ? ` · ${converted.notes[0]}` : ""} — /workflows run ${spec.file.replace(/\.json$/, ".js")}`
    }
    if (spec.kind === "update") {
      const script = await Bun.file(resolve(spec.file)).text().catch(() => undefined)
      if (script === undefined) return `cannot read ${spec.file}`
      const reply = await input.send({ type: "workflow.script", workflowId: spec.workflowId as WorkflowId, action: "update", script })
      return reply.ok ? `script updated — /workflows resume ${spec.workflowId} re-runs only the changed calls` : reply.error.message
    }
    return undefined
  }

  /** Live workflows of this project: asked once at start, then kept by `workflow.changed`. */
  async function loadLiveWorkflows() {
    const reply = await input.send({ type: "workflow.list", ...(input.directory ? { directory: input.directory } : {}) })
    for (const run of ((reply.ok ? reply.result?.workflows : undefined) ?? []) as WorkflowSummary[]) noteWorkflow(run, false)
    requestFrame()
  }

  function noteWorkflow(run: WorkflowSummary, deleted: boolean) {
    if (input.directory && run.directory !== input.directory) return
    state.workflows = [...state.workflows.filter((existing) => existing.workflowId !== run.workflowId), ...(deleted ? [] : [run])]
    if (!deleted && !["completed", "failed", "stopped"].includes(run.state)) state.liveWorkflows.set(run.workflowId, run.state === "needs_input" || run.state === "blocked")
    else state.liveWorkflows.delete(run.workflowId)
  }

  return { loadWorkflows, openWorkflows, controlWorkflow, workflowCommand, loadLiveWorkflows, noteWorkflow }
}
