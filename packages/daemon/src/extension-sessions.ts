import { acpAgentKey } from "@mendcode/engine-acp"
import type { ModelChoice, SessionId } from "@mendcode/protocol"
import type { ExtensionSessionPort } from "./extensions/session-api"
import { catalogModel, invalidChoice, modelEngine, type ModelCatalog } from "./models"
import type { RunLimitsStore } from "./run-limits"

/**
 * The daemon's side of `api.setModel`, `setThinkingLevel`, `setActiveTools` and `sendUserMessage`. A model change passes the same
 * checks as `/model` and must stay on the engine the session runs (switching engines hands the conversation over, which is the
 * user's call); an effort must be one the model lists. Tools are a narrowing limit kept with the session's other run limits.
 */
export function createExtensionSessions(deps: {
  directory(sessionId: SessionId): string | undefined
  /** The model the session's next turn would use. */
  current(sessionId: SessionId): ModelChoice
  /** The engine running the session's next turn: "native", or another engine's name (claude, codex, an acp: agent). */
  engineOf(sessionId: SessionId): string
  /** The catalog `/model` offers for a directory (extension providers included). */
  catalog(directory: string): Promise<ModelCatalog>
  /** Stores the session's own model the way `session.model.set` does. */
  choose(sessionId: SessionId, choice: ModelChoice): void
  runLimits: RunLimitsStore
  submit(sessionId: SessionId, text: string, delivery: "queue" | "steer"): Promise<{ ok: true } | { ok: false; error: string }>
}): ExtensionSessionPort {
  const id = (sessionId: string) => sessionId as SessionId
  return {
    directory: (sessionId) => deps.directory(id(sessionId)),
    model(sessionId) {
      if (!deps.directory(id(sessionId))) return undefined
      const choice = deps.current(id(sessionId))
      return { model: choice.model, ...(choice.effort ? { effort: choice.effort } : {}) }
    },
    async setModel(sessionId, wanted) {
      const directory = deps.directory(id(sessionId))
      if (!directory) return { ok: false, error: "setModel: unknown session" }
      const catalog = await deps.catalog(directory)
      const choice: ModelChoice = { model: wanted.model, ...(wanted.effort ? { effort: wanted.effort as ModelChoice["effort"] } : {}) }
      const problem = invalidChoice(choice, catalog)
      if (problem) return { ok: false, error: `setModel: ${problem}` }
      const current = deps.current(id(sessionId))
      const engineOf = (value: ModelChoice) => value.model.startsWith("acp:") ? acpAgentKey(value.model) : modelEngine(value, catalog) ?? "native"
      if (catalogModel(catalog, current.model) && engineOf(choice) !== engineOf(current)) return { ok: false, error: `setModel: ${choice.model} runs on another engine than this session (${engineOf(current)}); the user switches engines with /model` }
      deps.choose(id(sessionId), choice)
      return { ok: true }
    },
    activeTools: (sessionId) => deps.runLimits.get(id(sessionId))?.activeTools,
    setActiveTools(sessionId, tools) {
      if (!deps.directory(id(sessionId))) return "unknown session"
      // Claude Code, Codex and ACP sessions pick their tools in their own process: a limit there would answer ok and change nothing.
      const engine = deps.engineOf(id(sessionId))
      if (tools !== undefined && engine !== "native") return `the session runs on ${engine}, which keeps its own tool list; it applies to native sessions`
      deps.runLimits.configure(id(sessionId), { activeTools: tools === undefined ? null : tools })
    },
    async submit(sessionId, text, delivery) {
      if (!deps.directory(id(sessionId))) return { ok: false, error: "sendUserMessage: unknown session" }
      return deps.submit(id(sessionId), text, delivery)
    },
  }
}
