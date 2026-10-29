import type { ModelsReport, ReasoningPolicy, ReasoningReport, Settings } from "@mendcode/protocol"
import { appHarness, tempDir } from "./session-ui-harness"

export const B25_POLICY: ReasoningPolicy = { version: 1, mode: "off", remoteProcessing: false, provider: "openrouter", maxLeaseSteps: 2, maxDecisionsPerTurn: 8, failureMode: "pause" }
export function b25Harness(options: { width?: number; height?: number; reasoning?: Partial<ReasoningReport>; rejectSave?: boolean; rejectAuto?: boolean } = {}) {
  let reasoning: ReasoningReport = { config: { ...B25_POLICY }, consent: { ...B25_POLICY }, revision: "policy-1", valid: true, evaluatorReady: false, reasoningAuto: false, ...options.reasoning }
  let settings = { experimental: { continue_loop_on_deny: true, reasoning_auto: reasoning.reasoningAuto } } as Settings
  const models = (): ModelsReport => ({ engine: "native", selectable: true, defaults: { model: "local:main", effort: "low" }, roles: {}, effective: { model: "local:main", effort: "low" }, models: [{ id: "local:main", name: "Local", efforts: ["low", "medium", "high"], defaultEffort: "low" }], reasoning })
  const harness = appHarness({ width: options.width ?? 100, height: options.height ?? 30, dataDir: tempDir("mend-b25-ui-data-"), directory: tempDir("mend-b25-ui-project-"), reply(command) {
    if (command.type === "models.list") return { ok: true, result: models() }
    if (command.type === "reasoning.status") return { ok: true, result: reasoning }
    if (command.type === "reasoning.configure") {
      if (options.rejectSave || command.expectedRevision !== reasoning.revision) return { ok: false, error: { code: "invalid_command", message: "Policy changed; refresh before saving" } }
      reasoning = { ...reasoning, config: command.config, consent: command.config, revision: "policy-2" }
      return { ok: true, result: reasoning }
    }
    if (command.type === "settings.get") return { ok: true, result: { settings } }
    if (command.type === "settings.set") {
      if (options.rejectAuto) return { ok: false, error: { code: "invalid_command", message: "Settings update rejected" } }
      settings = { ...settings, ...command.patch } as Settings
      reasoning = { ...reasoning, reasoningAuto: settings.experimental?.reasoning_auto === true }
      return { ok: true, result: { settings } }
    }
    if (command.type === "recipes.list") return { ok: true, result: { recipes: [] } }
    return undefined
  } })
  return { ...harness, reasoning: () => reasoning, settings: () => settings }
}
