import { DEFAULT_COMPACT_AT_TOKENS } from "@mendcode/protocol/wire"
import type { AppState } from "./context"

/**
 * Where the session compacts until a call says so: the point the daemon lists for its model (MendCode's own, or the window
 * Claude Code is handed), else the user's setting. The same number before and after the first message.
 */
export function compactFallback(state: AppState): number {
  const model = state.effectiveModel?.model
  const listed = model ? state.modelReport?.models?.find((candidate) => candidate.id === model)?.compactAtTokens : undefined
  return listed ?? state.settingsNow.compactAtTokens ?? DEFAULT_COMPACT_AT_TOKENS
}
