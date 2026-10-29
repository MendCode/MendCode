import { MODEL_ROLES, type ModelChoice, type SetupPreset, type SetupReport } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"
import { canonicalDir } from "@mendcode/tools"
import { invalidChoice, modelEngine, resolveModel, type ModelCatalog } from "./models"
import { rolesFor } from "./profiles"
import type { createBudgets } from "./budgets"
import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

export function createSetupService(input: {
  dir: string; store: Store; catalog: ModelCatalog; engine: string; complete: boolean
  budgets: ReturnType<typeof createBudgets>
  login?(): Promise<{ ok: boolean; message?: string }>
  inventory?(): Array<{ id: string; enabled: boolean; authReady?: boolean | null }>
  prompt(directory: string): { mode: string; focusID: string }
}) {
  async function readiness(directory: string): Promise<SetupReport> {
    const root = canonicalDir(directory)
    const settings = input.store.settings.get()
    const roles = rolesFor(settings, root)
    const login = input.login ? await input.login().catch(() => ({ ok: false })) : undefined
    const providers = input.inventory?.() ?? []
    function problem(choice: ModelChoice, helper = false) {
      if (input.catalog.selectable) {
        const invalid = invalidChoice(choice, input.catalog, helper ? "small" : "main")
        if (invalid) return invalid
      }
      const model = input.catalog.list().find((entry) => entry.id === choice.model)
      if (helper && (modelEngine(choice, input.catalog) || choice.model.startsWith("acp:"))) return "Whole-session engine cannot run setup helper calls"
      if (model?.provider) {
        const provider = providers.find((entry) => entry.id === model.provider)
        if (!provider?.enabled || !provider.authReady) return "API provider credentials unavailable"
      } else if (login && !login.ok) return "Subscription login unavailable"
      return undefined
    }
    const main = resolveModel({ role: "main", roles, catalog: input.catalog })
    const helper = resolveModel({ role: "small", roles, catalog: input.catalog })
    const helperProblem = !input.complete ? "Setup helper needs the native completion service" : problem(helper, true)
    const mainProblem = problem(main)
    const budget = input.budgets.report(main.model)
    return {
      engine: input.engine, aiReady: !mainProblem, preset: settings.setupPreset ?? "default",
      helper: { model: helper.model, ready: !helperProblem, ...(helperProblem ? { reason: helperProblem } : {}) },
      prompt: input.prompt(root), budget,
      roles: MODEL_ROLES.map((role) => {
        const choice = resolveModel({ role, roles, catalog: input.catalog })
        const reason = problem(choice, role !== "main")
        return { role, model: choice.model, ready: !reason, ...(reason ? { reason } : {}) }
      }),
      blockers: [...(mainProblem ? [mainProblem] : []), ...budget.enforcement.blockers],
      warnings: [...budget.enforcement.warnings, ...(helperProblem ? [helperProblem] : [])],
    }
  }
  async function plan(directory: string) {
    const status = await readiness(directory)
    const result = { status: status.blockers.length ? "blocked-before-ai-use" : "ready", readiness: status, actions: [
      ...(status.aiReady ? [] : [{ command: "/connect", required: true, effect: "Configure the selected provider outside committed files" }]),
      { command: "/model", required: false, effect: "Review model roles and recipes" },
      { command: "/setup", required: false, effect: "Choose budget, prompt and welcome settings" },
      ...(status.helper.ready ? [] : [{ command: "/model", required: false, effect: status.helper.reason! }]),
    ], callsProviders: false, writesConfig: false, installsPackages: false, writesShellProfile: false }
    const file = path.join(input.dir, "setup", "plan.json")
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file + ".tmp", JSON.stringify(result, null, 2) + "\n", { mode: 0o600 })
    renameSync(file + ".tmp", file)
    return { ...result, path: file }
  }
  async function doctor(directory: string) {
    const status = await readiness(directory)
    return { ok: status.blockers.length === 0, aiReady: status.aiReady, failures: status.blockers, warnings: status.warnings, readiness: status }
  }
  function presetPatch(preset: SetupPreset) {
    if (preset === "default" || preset === "custom") return { setupPreset: preset }
    const full = preset === "full"
    return { setupPreset: preset, defaultPermission: "ask", memoryEnabled: full, memoryUse: full, memoryGenerate: full, memoryRequireApproval: true, view: full ? "full" : "minimal" }
  }
  return { readiness, plan, doctor, presetPatch }
}
