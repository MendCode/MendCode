import { DEFAULT_COMPACT_AT_TOKENS } from "@mendcode/protocol/wire"
import { contextLimit } from "../../view/context-meter"
import { modelLabel, sessionModelId } from "../../view/model-label"
import type { SessionStatsInput } from "../../view/session-stats"
import type { AppState } from "./context"
import { usageInForce } from "./usage-in-force"

/**
 * What the session stats are folded from: the usage the transcript already keeps from `usage.recorded` events, the context against
 * its limit, the model and its effort. Read synchronously from client state; nothing here asks the daemon for anything.
 */
export function liveStatsInput(state: AppState): SessionStatsInput {
  const transcript = state.transcript
  const usage = usageInForce(state)
  const last = transcript.lastCall
  const model = sessionModelId(state.effectiveModel?.model, usage?.model, state.modelReport)
  return {
    usage: transcript.sessionUsage,
    ...(last ? { last } : {}),
    calls: transcript.recentCalls,
    ...(transcript.sessionCost !== undefined ? { costMicros: transcript.sessionCost } : {}),
    ...(usage?.contextTokens !== undefined ? { contextTokens: usage.contextTokens, contextLimit: contextLimit(usage, state.settingsNow.compactAtTokens ?? DEFAULT_COMPACT_AT_TOKENS), ...(usage.contextApprox ? { contextApprox: true } : {}) } : {}),
    contexts: transcript.recentContexts,
    ...(model ? { model: modelLabel(model, state.modelReport) } : {}),
    ...(state.effectiveModel?.effort ? { effort: state.effectiveModel.effort } : {}),
  }
}
