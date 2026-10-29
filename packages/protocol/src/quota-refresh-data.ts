/**
 * The quota refresh probe's setting (`quotaRefresh` in the /customize profile, docs/usage-limit.md "Quota refresh"). Data only, so the
 * profile can be checked without loading the client. A provider's windows are known only when a turn on that provider ran; a probe asks
 * for them on a timer by sending the smallest request that makes the provider report them. It spends some of the quota it measures,
 * so it is off until the user lists a provider here.
 */

/** Providers whose windows a probe can ask for. */
export const QUOTA_REFRESH_PROVIDERS = ["codex", "claude"] as const
export type QuotaRefreshProvider = (typeof QUOTA_REFRESH_PROVIDERS)[number]
export const QUOTA_REFRESH_MIN_MINUTES = 5
export const QUOTA_REFRESH_DEFAULT_MINUTES = 15
export const QUOTA_REFRESH_MAX_MINUTES = 1_440
export const QUOTA_REFRESH_MAX_ENTRIES = QUOTA_REFRESH_PROVIDERS.length

export type QuotaRefreshEntry = { provider: QuotaRefreshProvider; everyMinutes?: number; model?: string }

/** The one-line truth shown beside the setting, in /customize and in the cards. */
export const QUOTA_REFRESH_COST = "each probe is a real request on your login and spends some of the quota it measures"
/** What the Claude probe is, said once: Claude Code adds its own prompt and tool definitions to every turn, so it is more than one word. */
export const QUOTA_REFRESH_CLAUDE = "Claude: one minimal Claude Code turn on Haiku (Claude Code's own prompt plus one word)"

/** One-line problems of a `quotaRefresh` value: a list of `{ provider, everyMinutes?, model? }`, each provider once. */
export function quotaRefreshProblems(value: unknown): string[] {
  if (!Array.isArray(value)) return ["quotaRefresh: expected a list of { provider, everyMinutes?, model? }"]
  if (value.length > QUOTA_REFRESH_MAX_ENTRIES) return [`quotaRefresh: at most ${QUOTA_REFRESH_MAX_ENTRIES} entries`]
  const seen = new Set<string>()
  for (const [index, entry] of value.entries()) {
    const at = `quotaRefresh[${index}]`
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [`${at}: expected { provider, everyMinutes?, model? }`]
    const { provider, everyMinutes, model, ...rest } = entry as Record<string, unknown>
    if (Object.keys(rest).length) return [`${at}: unknown field ${Object.keys(rest)[0]}`]
    if (typeof provider !== "string" || !(QUOTA_REFRESH_PROVIDERS as readonly string[]).includes(provider)) return [`${at}.provider: expected ${QUOTA_REFRESH_PROVIDERS.join("|")}`]
    if (seen.has(provider)) return [`${at}.provider: ${provider} is listed twice`]
    seen.add(provider)
    if (everyMinutes !== undefined && (!Number.isInteger(everyMinutes) || (everyMinutes as number) < QUOTA_REFRESH_MIN_MINUTES || (everyMinutes as number) > QUOTA_REFRESH_MAX_MINUTES)) return [`${at}.everyMinutes: an integer ${QUOTA_REFRESH_MIN_MINUTES}..${QUOTA_REFRESH_MAX_MINUTES}`]
    if (model !== undefined && (typeof model !== "string" || !/^[\w.:\-/]{1,80}$/.test(model))) return [`${at}.model: a model id`]
  }
  return []
}

/** The entries as stored; an invalid value is no entries (nothing ever runs), never half a list. */
export function normalizeQuotaRefresh(raw: unknown): QuotaRefreshEntry[] {
  return quotaRefreshProblems(raw).length ? [] : (raw as QuotaRefreshEntry[]).map((entry) => ({ provider: entry.provider, ...(entry.everyMinutes !== undefined ? { everyMinutes: entry.everyMinutes } : {}), ...(entry.model ? { model: entry.model } : {}) }))
}

/** The interval a provider's entry runs at, in ms. */
export const quotaRefreshIntervalMs = (entry: QuotaRefreshEntry) => (entry.everyMinutes ?? QUOTA_REFRESH_DEFAULT_MINUTES) * 60_000

/** `codex 15m, claude 30m` for /customize and the card. */
export const quotaRefreshText = (entries: readonly QuotaRefreshEntry[]) => entries.map((entry) => `${entry.provider} ${entry.everyMinutes ?? QUOTA_REFRESH_DEFAULT_MINUTES}m${entry.model ? ` ${entry.model}` : ""}`).join(", ")
