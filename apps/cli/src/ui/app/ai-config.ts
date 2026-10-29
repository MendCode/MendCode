import type { AIConfigInput } from "@mendcode/protocol"
import type { AppContext } from "./context"
import { preload } from "../lazy-pages"

export function createAIConfig(ctx: AppContext) {
  const { input, state, requestFrame } = ctx
  const view = () => state.aiConfigState ??= { selected: 0, tab: 0, scroll: 0, confirming: false, busy: false }
  const directory = () => input.directory ?? "."

  async function request(config: AIConfigInput) {
    const current = view()
    current.busy = true
    current.error = undefined
    requestFrame()
    try {
      const reply = await input.send({ type: "ai.config", directory: directory(), input: config })
      if (!reply.ok) throw new Error(reply.error.message)
      const report = reply.result as import("@mendcode/protocol").AIConfigReport
      if (report.action === "inspect") current.inspection = report
      else if (report.action === "plan") { current.plan = report; current.validation = undefined; current.applied = undefined; current.confirming = false; current.tab = 1; current.scroll = 0 }
      else if (report.action === "validate") current.validation = report
      else { current.applied = report; current.confirming = false; current.tab = 2 }
      return report
    } catch (error) { current.error = error instanceof Error ? error.message.replace(/^\[DAEMON\]: /, "") : String(error); current.confirming = false }
    finally { current.busy = false; requestFrame() }
  }

  async function plan() {
    const current = view()
    const model = current.inspection?.models[current.selected]
    if (!model?.configured) { current.error = "Select a configured model"; requestFrame(); return }
    await request({ action: "plan", candidates: [{ model: model.id }], intent: "balanced", taskKind: "general", scope: "project" })
  }

  async function validate() {
    const planned = view().plan
    if (!planned) return
    return request({ action: "validate", patch: planned.patch, scope: planned.target.scope, target: planned.target.path, expectedHash: planned.expectedHash })
  }

  async function confirm() {
    if (input.remote?.readOnly) return
    const checked = await validate()
    if (checked?.action === "validate" && checked.valid) { view().confirming = true; view().tab = 2; view().scroll = 0; requestFrame() }
  }

  async function command(args: string) {
    await preload("ai-config")
    state.page = "ai-config"
    view().confirming = false
    await request({ action: "inspect" })
    if (!args || args === "inspect") return
    if (args === "plan") return plan()
    if (args === "validate") { await validate(); return }
    if (args === "apply") return confirm()
    try {
      const match = /^(plan|validate)\s+(\{.*\})$/s.exec(args)
      if (!match) throw new Error("Usage: /ai-config [inspect | plan | validate | apply]; plan/validate accept JSON")
      const body = JSON.parse(match[2]!) as Record<string, unknown>
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected a JSON object")
      await request({ ...body, action: match[1] } as AIConfigInput)
    } catch (error) { view().error = error instanceof Error ? error.message : String(error); requestFrame() }
  }

  async function key(key: string) {
    const current = view()
    if (current.busy) return
    if (current.confirming) {
      if (key === "\x1b" || key === "q") current.confirming = false
      else if (key === "\r" && current.plan && !input.remote?.readOnly) await request({ action: "apply", patch: current.plan.patch, scope: current.plan.target.scope, target: current.plan.target.path, expectedHash: current.plan.expectedHash, sessionId: state.sessionId, confirm: true })
    } else if (key === "\x1b" || key === "q") state.page = "chat"
    else if (key === "r") { current.plan = undefined; current.validation = undefined; current.applied = undefined; current.scroll = 0; await request({ action: "inspect" }) }
    else if (key === "p") await plan()
    else if (key === "v") { await validate(); current.tab = 2 }
    else if (key === "a") await confirm()
    else if (["1", "2", "3"].includes(key)) { current.tab = Number(key) - 1; current.scroll = 0 }
    else if (key === "\x1b[A" || key === "\x1b[B") current.selected = Math.max(0, Math.min((current.inspection?.models.length ?? 1) - 1, current.selected + (key.endsWith("A") ? -1 : 1)))
    else if (key === "\x1b[5~" || key === "\x1b[6~") current.scroll = Math.max(0, current.scroll + (key === "\x1b[5~" ? -5 : 5))
    else if ((key === "[" || key === "]") && current.plan) {
      const choices = current.plan.alternatives.filter((item) => item.feasibility === "feasible")
      const index = choices.findIndex((item) => item.id === current.plan!.selectedAlternative)
      const next = choices[(index + (key === "]" ? 1 : choices.length - 1)) % choices.length]
      if (next) {
        current.plan.selectedAlternative = next.id
        current.plan.patch = { ...current.plan.patch, roles: { ...current.plan.patch.roles, main: next.primary } }
        current.applied = undefined
        const checked = await validate()
        if (checked?.action === "validate") current.plan.diff = checked.diff
      }
    }
    requestFrame()
  }
  return { aiConfigCommand: command, aiConfigKey: key }
}
