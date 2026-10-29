import type { CommandReply } from "@mendcode/client"
import { BudgetPolicy, type Settings, type SetupReport } from "@mendcode/protocol"
import { createBudgets } from "../../../packages/daemon/src/budgets"
import { createPromptModes } from "../../../packages/daemon/src/prompt-modes"
import { appHarness, tempDir } from "./session-ui-harness"

/** Local services and fixed provider answers; no credentials or network. */
export function b61Harness(width = 100, height = 30) {
  const dataDir = tempDir(), directory = tempDir()
  const modes = createPromptModes(dataDir)
  let settings: Settings = { onboarded: true }
  let available = true
  let error = ""
  const budget = createBudgets({ dir: dataDir, settings: () => settings, seed: () => ({ costMicros: 0, knownCalls: 0, unknownCalls: 0 }) })
  const status = (): SetupReport => ({ engine: "native", aiReady: true, preset: settings.setupPreset ?? "default", prompt: modes.status(directory), helper: { ready: available, model: "local:small", ...(!available ? { reason: "Native completion service unavailable" } : {}) }, budget: budget.report("local:main"), roles: [{ role: "main", model: "local:main", ready: true }, { role: "small", model: "local:small", ready: available }], warnings: [], blockers: [] })
  const h = appHarness({ width, height, dataDir, directory, reply: async (command) => {
    let result: unknown
    switch (command.type) {
      case "setup.status": result = status(); break
      case "prompt.status": result = modes.status(directory); break
      case "prompt.set": result = modes.set(directory, { ...(command.mode ? { mode: command.mode } : {}), ...(command.focusID ? { focusID: command.focusID } : {}) }); break
      case "setup.preset": {
        settings = { ...settings, setupPreset: command.preset }
        if (command.preset === "minimal" || command.preset === "full") modes.set(directory, { mode: command.preset })
        result = { settings, prompt: modes.status(directory) }
        break
      }
      case "budget.set": settings = { ...settings, budgets: BudgetPolicy.parse(command.policy) }; result = { settings }; break
      case "settings.set": settings = { ...settings, ...command.patch } as Settings; result = { settings }; break
      case "setup.ask":
        if (error) return { ok: false, error: { code: "invalid_command", message: error } }
        result = { text: "Your main role is local:main. Use /model to review roles. API limits apply only to known USD costs.", model: "local:small" }
        break
      case "daemon.info": result = { engine: "native", model: "local:main", dataDir: "/tmp/b61-fixture", pid: 1, buildId: "b61-local" }; break
      case "mcp.status": result = { servers: [], issues: [] }; break
      case "memory.list": result = { memories: [] }; break
      case "recipes.list": result = { recipes: [{ name: "balanced", file: "builtin", source: "builtin", description: "", roles: {} }] }; break
    }
    return { ok: true, ...(result ? { result } : {}) } as CommandReply
  } })
  h.app.applySettings(settings)
  return { ...h, modes, directory, budget, status,
    available: (value: boolean) => { available = value },
    refuse: (message: string) => { error = message },
    settings: () => settings,
    policy: (policy: unknown) => { settings = { ...settings, budgets: BudgetPolicy.parse(policy) }; h.app.applySettings(settings) },
  }
}
