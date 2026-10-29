import { mkdirSync } from "node:fs"
import path from "node:path"
import { createAIConfigService, AIConfigError } from "../../../packages/daemon/src/ai-config"
import type { AIConfigInput, Settings } from "@mendcode/protocol"
import { appHarness, ids, NOW, tempDir } from "./session-ui-harness"

export function b70Harness(width = 100, height = 30, readOnly = false) {
  const base = tempDir("mendcode-b70-")
  const directory = path.join(base, "project")
  const dataDir = path.join(base, "data")
  mkdirSync(directory)
  mkdirSync(dataDir)
  const sessionId = ids("session")
  const settings: Settings = { onboarded: true, models: { main: { model: "local:main", effort: "medium" }, small: { model: "local:small" } }, compactAtTokens: 48_000, budgets: { mode: "api-usage", warnUsd: null, stopUsd: null, expensiveModelRequiresConfirm: false, suppliedUsd: null, prices: { "local:main": { input: 2, output: 8 }, "local:small": { input: .1, output: .4 } } } }
  const catalog = { selectable: true, defaults: { model: "local:main" }, list: () => [
    { id: "local:main", name: "Main", provider: "local", efforts: ["low" as const, "medium" as const], contextWindow: 128_000 },
    { id: "local:small", name: "Small", provider: "local", efforts: [] },
    { id: "subscription", name: "Subscription", efforts: [] },
  ] }
  const service = createAIConfigService({ dir: dataDir, catalog, settings: () => settings, engine: "native", providers: () => [{ id: "local", baseUrl: "http://127.0.0.1:11434", enabled: true }], sessionDirectory: (id) => id === sessionId ? directory : undefined, now: () => NOW })
  const h = appHarness({ width, height, sessionId, directory, dataDir, ...(readOnly ? { remote: { host: "localhost", readOnly: true } } : {}), reply: (command) => {
    if (command.type === "ai.config") {
      if (readOnly) return { ok: false, error: { code: "invalid_command", message: "AI configuration requires a full-access connection" } }
      try { return { ok: true, result: service.run(command.directory, command.input) } }
      catch (error) { return { ok: false, error: { code: error instanceof AIConfigError ? error.code : "invalid_command", message: error instanceof Error ? error.message : String(error) } } }
    }
    if (command.type === "models.list") return { ok: true, result: { engine: "native", ...catalog, models: catalog.list(), roles: settings.models, effective: catalog.defaults } }
    if (command.type === "daemon.info") return { ok: true, result: { engine: "native", dataDir, pid: 1 } }
    return { ok: true }
  } })
  h.app.applySettings(settings)
  return { ...h, service, directory, dataDir, settings, request: (input: AIConfigInput) => service.run(directory, input) }
}
