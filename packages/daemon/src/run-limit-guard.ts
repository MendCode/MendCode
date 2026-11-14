import type { ModelChoice, SessionId } from "@mendcode/protocol"
import type { EnginePort } from "@mendcode/kernel"
import type { RunLimits } from "./run-limits"

/** A scripted run's limits on what the model may use: an allow-list, exclusions, or no network. */
export const limitsTools = (limits: Pick<RunLimits, "tools" | "excludeTools" | "offline"> | undefined): boolean =>
  !!limits && (limits.tools !== undefined || !!limits.excludeTools?.length || !!limits.offline)

/** What a run limited to some tools is told when its model runs on an engine that would ignore the limits. */
export const unenforcedLimitsMessage = (model: string, engine: string) =>
  `[DAEMON]: --tools, --exclude-tools and --offline are enforced only on MendCode's own models; ${model} runs on ${engine}, which would ignore them, so nothing was run. Pick a model of a connected provider (\`mendcode models\`).`

/**
 * A run that limits the model's tools never reaches an engine that cannot hold it to them (Claude Code, Codex, pi, an ACP agent run their
 * own tools): the turn fails at once instead of running unrestricted. Only limits a client asked for count (`requestedTools`): the daemon's
 * own sessions (a PR review child, a bare sub-agent) keep running on those engines as before.
 */
export function withRunLimitGuard(input: {
  base: EnginePort
  limits(sessionId: SessionId): RunLimits | undefined
  /** The model a turn of the session runs on, and the engine outside MendCode that runs it (undefined for MendCode's own). */
  route(sessionId: SessionId, override?: ModelChoice): { model: string; engine: string | undefined }
}): EnginePort {
  return {
    ...input.base,
    async runTurn(turn) {
      if (input.limits(turn.sessionId)?.requestedTools !== true) return input.base.runTurn(turn)
      const { model, engine } = input.route(turn.sessionId, turn.selection?.model)
      if (engine) return { status: "error", code: "run_limits_unenforced", message: unenforcedLimitsMessage(model, engine) }
      return input.base.runTurn(turn)
    },
  }
}
