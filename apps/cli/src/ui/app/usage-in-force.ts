import type { AppState } from "./context"

/** Engines that keep their own conversation and report their usage under their own name. */
const OWN_HISTORY = new Set(["claude", "codex"])

type Usage = NonNullable<AppState["transcript"]["lastUsage"]>

/**
 * Where a model id runs: the native loop, or the engine of another program that keeps its own conversation. Undefined when
 * that cannot be told, and when the daemon itself runs on one engine of another program: then nothing can switch engines.
 */
function engineOf(model: string, report: AppState["modelReport"]): string | undefined {
  if (model.startsWith("acp:")) return "acp"
  const entry = report?.models.find((candidate) => candidate.id === model)
  return entry?.engine ?? (report?.engine === "native" ? "native" : undefined)
}

/** The engine a call ran on, as far as its usage tells: Claude Code and Codex name themselves, and only an engine that keeps its own context states its window. */
function engineOfUsage(usage: Usage): string {
  return OWN_HISTORY.has(usage.provider) ? usage.provider : usage.contextWindow !== undefined ? "external" : "native"
}

/**
 * The session's last call, while it says something about the model in force. After a switch to another engine its context is
 * not that model's: the new engine starts from the handoff, so the footer, the dock and the stats show no context until it
 * answers once. Unknown engines (no model list yet) keep the last call.
 */
export function usageInForce(state: AppState): Usage | undefined {
  const usage = state.transcript.lastUsage
  const current = state.effectiveModel?.model
  if (!usage || !current) return usage
  const now = engineOf(current, state.modelReport)
  if (now === undefined) return usage
  const then = engineOfUsage(usage)
  if (now === "native" || then === "native" || OWN_HISTORY.has(then)) return now === then ? usage : undefined
  return usage
}
