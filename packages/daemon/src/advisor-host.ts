import { featureOn, type AIConfigAdvisor, type ModelChoice, type ModelRoles, type SessionId, type Settings } from "@mendcode/protocol"
import { advisorLimits, createAdvisor, type AdvisorPort, type AdvisorUsage } from "@mendcode/engine-native"
import { claudeAlias } from "./claude-models"
import { runLoopCheck } from "./loop-checks"
import { invalidChoice, modelEngine, type ModelCatalog } from "./models"

/**
 * The daemon side of the advisor (docs/advisor.md): which sessions get one, the model call behind the native engine's
 * `advisor` tool, the Claude Code `--advisor` alias, and the status `/advisor` and the AI config page report.
 */

export type AdvisorStatus = { choice: ModelChoice; applied: true; engine: "native" | "claude" } | { choice: ModelChoice; applied: false; reason: string }

const sameChoice = (a: ModelChoice, b: ModelChoice | undefined) => !!b && a.model === b.model && (a.effort ?? "") === (b.effort ?? "")

/** Whether the advisor role applies to a session running `main`; undefined when no advisor model is set. */
export function advisorStatus(input: { settings: Settings; roles: ModelRoles; main: ModelChoice | undefined; catalog: ModelCatalog; safeMode?: boolean }): AdvisorStatus | undefined {
  const choice = input.roles.advisor
  if (!choice) return undefined
  const no = (reason: string): AdvisorStatus => ({ choice, applied: false, reason })
  if (!featureOn(input.settings, "advisor", { safeMode: input.safeMode === true })) return no("the advisor feature is off (tier or features.advisor)")
  const problem = invalidChoice(choice, input.catalog, "advisor")
  if (problem) return no(problem)
  if (sameChoice(choice, input.main)) return no("same model and effort as the main model; pick a different one")
  const advisorEngine = modelEngine(choice, input.catalog)
  const mainEngine = modelEngine(input.main, input.catalog)
  if (mainEngine === "claude") return advisorEngine === "claude" ? { choice, applied: true, engine: "claude" } : no("Claude Code sessions only take a Claude Code model as advisor")
  if (mainEngine) return no(`the ${mainEngine} engine has no advisor support`)
  if (input.main?.model.startsWith("acp:")) return no("ACP agents have no advisor support")
  // A Claude Code model advises a native session through one headless `claude -p` per consultation (advisor-claude.ts); other engines cannot.
  if (advisorEngine && advisorEngine !== "claude") return no(`${choice.model} runs through the ${advisorEngine} engine; a native session needs an API, ChatGPT or Claude Code model as advisor`)
  return { choice, applied: true, engine: "native" }
}

/** The AI config report's view of the advisor. */
export function advisorReport(status: AdvisorStatus | undefined, settings: Settings): AIConfigAdvisor {
  if (!status) return "off"
  return { model: status.choice.model, ...(status.choice.effort ? { effort: status.choice.effort } : {}), checkpoints: advisorLimits(settings.advisor).checkpoints, applied: status.applied, ...(status.applied ? {} : { reason: status.reason }) }
}

/** The Claude Code alias for `--advisor` when the advisor applies to a Claude Code session. */
export function claudeAdvisorAlias(status: AdvisorStatus | undefined): string | undefined {
  return status?.applied && status.engine === "claude" ? claudeAlias(status.choice).model : undefined
}

const DIFF_MAX_CHARS = 48_000

/** The working tree against HEAD, bounded; undefined outside a git checkout or on any failure. */
export async function advisorDiff(cwd: string, signal: AbortSignal): Promise<string | undefined> {
  const result = await runLoopCheck({ argv: ["git", "--no-optional-locks", "diff", "HEAD", "--no-color", "--no-ext-diff", "--unified=3"], cwd, signal, timeoutSeconds: 10 }).catch(() => undefined)
  if (!result || result.exitCode !== 0 || signal.aborted) return undefined
  return result.output.length > DIFF_MAX_CHARS ? result.output.slice(0, DIFF_MAX_CHARS) : result.output
}

/**
 * The native engine's advisor port. `complete` is one tool-less completion with the advisor model; the budget guard runs
 * first, and a refusal surfaces as a `budget` verdict. Usage is reported by the engine as a session usage event.
 */
export function createAdvisorHost(options: {
  status(sessionId: SessionId): AdvisorStatus | undefined
  settings(): Settings
  guard(input: { model: string; signal: AbortSignal }): Promise<void>
  complete(input: { system: string; prompt: string; signal: AbortSignal; model: ModelChoice }): Promise<{ text: string; usage?: AdvisorUsage | undefined; account?: string | undefined }>
  /** A Claude Code model answers through the `claude` CLI (advisor-claude.ts) instead of `complete`; `isClaude` says which models. */
  claude?: { isClaude(model: ModelChoice): boolean; complete(input: { system: string; prompt: string; signal: AbortSignal; model: ModelChoice }): Promise<{ text: string; usage?: AdvisorUsage | undefined; account?: string | undefined }> }
  timeoutMs?: number
}): AdvisorPort {
  const native = (sessionId: SessionId) => {
    const status = options.status(sessionId)
    return status?.applied && status.engine === "native" ? status.choice : undefined
  }
  const port = createAdvisor({
    modelFor: native,
    limitsFor: () => advisorLimits(options.settings().advisor),
    complete: async (input) => {
      try { await options.guard({ model: input.model.model, signal: input.signal }) }
      catch (error) { throw new Error(`budget: ${error instanceof Error ? error.message : String(error)}`) }
      return options.claude?.isClaude(input.model) ? options.claude.complete(input) : options.complete(input)
    },
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  })
  return { ...port, diff: advisorDiff }
}
