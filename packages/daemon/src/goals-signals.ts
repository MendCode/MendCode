import { isQuotaBody } from "@mendcode/engine-native"

/**
 * What a goal turn's last message can say about the goal when the engine has no goal tools (Claude Code, Codex): a last
 * line `GOAL_STATUS: complete` or `GOAL_STATUS: blocked - <why>`. The steering texts ask for it only in that case.
 */
export type GoalMarker = { status: "complete" | "blocked"; note?: string }

const MARKER = /^\s*GOAL_STATUS:\s*(complete|blocked)\b\s*[-:–—]?\s*(.*?)\s*$/i

/** The marker on the last non-empty line of `text`, if there is one. */
export function parseGoalMarker(text: string | undefined): GoalMarker | undefined {
  if (!text) return undefined
  const lines = text.trimEnd().split("\n")
  const match = MARKER.exec(lines.at(-1) ?? "")
  if (!match) return undefined
  const note = match[2]?.trim()
  return { status: match[1]!.toLowerCase() as "complete" | "blocked", ...(note ? { note: note.slice(0, 500) } : {}) }
}

const LIMIT_WORDS = /\b(?:usage|rate|plan|credit|token) (?:limit|quota)\b|\bhit your (?:usage )?limit\b|\bout of (?:extra )?(?:usage|credits)\b|\blimit (?:reached|exceeded)\b|\bresets? at\b/i

/**
 * Whether a failed turn's message says the account ran out of quota (a 429 that waiting does not cure): the native
 * engine's quota 429, or the wording Claude Code and Codex use. A plain rate-limit hiccup is retried by the engine
 * and never reaches here.
 */
export function isUsageLimitFailure(code: string, message: string) {
  return code === "usage_limit" || isQuotaBody(message) || LIMIT_WORDS.test(message)
}
