import { compactionThreshold, namespacedModel, type CompactionLimits } from "@mendcode/engine-native"
import { ACP_MODEL_PREFIX } from "@mendcode/engine-acp"
import { compactEstimate, compactNoticePercent, featureOn, usageContext, type ContextSample, type TierSettings } from "@mendcode/protocol/wire"
import { clampWindow, findModel, modelContextOf, type CompactionConfig, type ContextLimits, type ContextReport, type ModelInfo, type ProviderInfo, type SessionEvent, type Settings } from "@mendcode/protocol"

type Usage = Extract<SessionEvent, { type: "usage.recorded" }>
export type CompactPoint = Pick<ContextLimits, "compactAtSource" | "thresholdPercent" | "thresholdSource" | "capped"> & { tokens: number }
/**
 * The global absolute trigger: the daemon's MENDCODE_COMPACT_AT_TOKENS when it is a positive number, else the model's
 * `modelContext.compactAt` (`modelSetting`), else the `compactAtTokens` setting.
 */
export type GlobalTrigger = { tokens?: number | undefined; environment: boolean; modelSetting?: true }

export function globalTrigger(settings: Pick<Settings, "compactAtTokens">, environment: NodeJS.ProcessEnv = process.env, modelCompactAt?: number): GlobalTrigger {
  const fromEnvironment = Number(environment.MENDCODE_COMPACT_AT_TOKENS)
  if (fromEnvironment > 0) return { tokens: fromEnvironment, environment: true }
  return modelCompactAt ? { tokens: modelCompactAt, environment: false, modelSetting: true } : { tokens: settings.compactAtTokens, environment: false }
}

/**
 * The limits the native engine gives its compaction threshold for one model: the model list's window, then what the provider's
 * entry states (window, input and output limits, provider and model `compaction` overrides). A session's own window replaces
 * both the window and the input limit. Same assembly as the engine's `limitsFor`; the number itself is always the engine's.
 */
export function modelLimits(input: { model: ModelInfo | undefined; providers: readonly ProviderInfo[]; override?: number | undefined }): CompactionLimits {
  const { model } = input
  const provider = model?.provider ? input.providers.find((entry) => entry.id === model.provider) : undefined
  const entry = provider?.models.find((candidate) => namespacedModel(provider.id, candidate.id) === model!.id)
  const window = entry?.context ?? entry?.limit?.context ?? model?.contextWindow
  const inputLimit = entry?.inputLimit ?? entry?.limit?.input
  const outputLimit = entry?.outputLimit ?? entry?.limit?.output
  const rest = { ...(outputLimit ? { outputLimit } : {}), ...(provider?.compaction ? { provider: provider.compaction } : {}), ...(entry?.compaction ? { model: entry.compaction } : {}) }
  if (input.override) return { ...rest, contextWindow: input.override }
  return { ...(window ? { contextWindow: window } : {}), ...(inputLimit ? { inputLimit } : {}), ...rest }
}

/** Where the engine packs for these limits (its own `compactionThreshold`), and which setting produced that number. */
export function compactPoint(config: CompactionConfig, limits: CompactionLimits, trigger: GlobalTrigger): CompactPoint {
  const tokens = compactionThreshold(config, limits, trigger.tokens)
  const window = limits.inputLimit ?? limits.contextWindow
  const absolute = ([
    ["model-override", limits.model?.token_limit],
    ["provider-override", limits.provider?.token_limit],
    [trigger.environment ? "environment" : trigger.modelSetting ? "model-setting" : "compactAtTokens", trigger.tokens],
    ["compaction.token_limit", config.token_limit],
  ] as const).find(([, value]) => value !== undefined)
  if (absolute) return { tokens, compactAtSource: absolute[0], ...(window && window < absolute[1]! ? { capped: true as const } : {}) }
  if (!window) return { tokens, compactAtSource: "no-window-default" }
  const [thresholdSource, percent] = limits.model?.threshold !== undefined ? ["model-override", limits.model.threshold] as const
    : limits.provider?.threshold !== undefined ? ["provider-override", limits.provider.threshold] as const
    : config.threshold !== undefined ? ["compaction.threshold", config.threshold] as const : ["default", Math.round(tokens * 100 / window)] as const
  return { tokens, compactAtSource: "threshold", thresholdPercent: Math.max(1, Math.min(100, percent)), thresholdSource }
}

/**
 * The compaction point of a catalog model under the current settings (its `modelContext` included) for a session without its own
 * window; undefined for a model another engine or an ACP agent runs (it compacts on its own).
 */
export function modelCompactAt(input: { model: ModelInfo; providers: readonly ProviderInfo[]; settings: Pick<Settings, "compactAtTokens" | "compaction" | "modelContext">; environment?: NodeJS.ProcessEnv }): number | undefined {
  if (input.model.engine || input.model.id.startsWith(ACP_MODEL_PREFIX)) return undefined
  const setting = modelContextOf(input.settings, input.model)
  const override = setting?.window ? clampWindow(setting.window, input.model.maxContextWindow).tokens : undefined
  return compactPoint(input.settings.compaction ?? {}, modelLimits({ model: input.model, providers: input.providers, override }), globalTrigger(input.settings, input.environment, setting?.compactAt)).tokens
}

/**
 * A session's limits. The compaction point is the engine's own answer for the session as it stands (`report`: current settings,
 * model and window override), so it is right for a session no call has run in since the daemon started; the settings only
 * explain it, and an answer they do not reproduce is labelled `engine`. Without a report (an engine that runs the whole session)
 * the last recorded call says what it can: the engine's window, or where MendCode said it would pack.
 *
 * Context tokens are the provider's count after the last recorded call (what the footer shows); when a compaction packed the
 * history after that call, or no call is recorded, they are the engine's estimate of the current history.
 */
export function contextLimits(input: {
  report?: Pick<ContextReport, "model" | "contextWindow" | "compactAtTokens" | "estimatedTokens"> | undefined
  /** This session's `/context-window` override; without one the model's `modelContext` window applies. */
  override?: number | undefined
  catalog: readonly ModelInfo[]
  providers: readonly ProviderInfo[]
  settings: Pick<Settings, "compactAtTokens" | "compaction" | "modelContext">
  /** The session's last recorded model call. */
  lastUsage?: Usage | undefined
  /** A compaction packed the history after `lastUsage`. */
  packedSince?: boolean | undefined
  /** The session's chosen model when neither the engine nor a call names one. */
  fallbackModel?: string | undefined
  /** The session's recent model calls, oldest first, for the turns-left estimate; none after a compaction packed the history. */
  recentUsage?: readonly Usage[] | undefined
  /** The settings of the notice before a compaction (`compactNoticePercent`, the tier and `features`). */
  notice?: (TierSettings & Pick<Settings, "compactNoticePercent">) | undefined
  environment?: NodeJS.ProcessEnv
}): ContextLimits {
  const limits = measuredLimits(input)
  const forecast = forecastOf(limits, input.packedSince ? [] : input.recentUsage ?? [], input.notice)
  return forecast ? { ...limits, forecast } : limits
}

/** The context at the end of each of the last turns, oldest first, from the main calls (the ones that state a limit; a sub-agent's or plan mode's do not). */
export function turnSamples(usage: readonly Usage[]): ContextSample[] {
  const samples: ContextSample[] = []
  for (const event of usage) {
    const tokens = event.compactAt === undefined && event.contextWindow === undefined ? undefined : usageContext(event)
    if (tokens === undefined) continue
    const last = samples.at(-1)
    if (last?.turnId === event.turnId) last.tokens = tokens
    else samples.push({ turnId: event.turnId, tokens })
  }
  return samples.slice(-8)
}

/**
 * How far the limit is, as the terminal's notice says it. Nothing without a measured context or a limit, and nothing for a
 * session with automatic compaction off whose point is only the default for an unknown window: there is nothing to predict.
 */
function forecastOf(limits: ContextLimits, usage: readonly Usage[], notice: (TierSettings & Pick<Settings, "compactNoticePercent">) | undefined): ContextLimits["forecast"] {
  const limitTokens = limits.compactAtTokens ?? (limits.compactAtSource === "engine-managed" ? limits.contextWindow : undefined)
  if (limits.contextTokens === undefined || !limitTokens) return undefined
  if (limits.compactAtTokens && !limits.autoCompact && (limits.compactAtSource === "no-window-default" || !limits.contextWindow)) return undefined
  const estimate = compactEstimate({ tokens: limits.contextTokens, limitTokens, limit: limits.compactAtTokens ? "compaction" : "window", auto: limits.autoCompact, samples: turnSamples(usage) })
  const percent = notice && featureOn(notice, "compact_notice") ? compactNoticePercent(notice.compactNoticePercent) : undefined
  return { ...estimate, ...(percent === undefined ? {} : { noticePercent: percent }), noticeDue: percent !== undefined && (limits.contextTokens / limitTokens) * 100 >= percent }
}

function measuredLimits(input: Parameters<typeof contextLimits>[0]): ContextLimits {
  const { report, lastUsage } = input
  const autoCompact = input.settings.compaction?.auto !== false
  const measured = lastUsage && !input.packedSince ? usageContext(lastUsage) : undefined
  const context = measured !== undefined ? { contextTokens: measured, contextTokensSource: "last-call" as const }
    : report ? { contextTokens: report.estimatedTokens, contextTokensSource: "estimate" as const } : {}
  const model = report?.model ?? lastUsage?.model ?? input.fallbackModel ?? "unknown"
  const info = findModel(input.catalog, model)
  const setting = modelContextOf(input.settings, info)
  // The session's own window, else the model's `modelContext` window; never above the model's known maximum.
  const chosen = input.override ?? setting?.window
  const override = chosen ? clampWindow(chosen, info?.maxContextWindow).tokens : undefined
  const overrideSource = input.override ? "session" as const : "model-setting" as const
  const max = info?.maxContextWindow ? { maxContextWindow: info.maxContextWindow } : {}
  if (!report) {
    const window = override ?? lastUsage?.contextWindow ?? info?.contextWindow
    return {
      model,
      ...(window ? { contextWindow: window } : {}),
      contextWindowSource: override ? overrideSource : lastUsage?.contextWindow ? "engine" : window ? "catalog" : "unknown",
      ...max,
      ...(lastUsage?.compactAt ? { compactAtTokens: lastUsage.compactAt, compactAtSource: "last-call" as const } : { compactAtSource: "engine-managed" as const }),
      autoCompact,
      ...context,
    }
  }
  const limits = modelLimits({ model: info, providers: input.providers, override })
  const point = compactPoint(input.settings.compaction ?? {}, limits, globalTrigger(input.settings, input.environment, setting?.compactAt))
  const { tokens: _tokens, ...explained } = point
  const window = override ?? report.contextWindow ?? limits.contextWindow
  return {
    model: report.model,
    ...(window ? { contextWindow: window } : {}),
    contextWindowSource: override ? overrideSource : report.contextWindow ? "engine" : window ? "catalog" : "unknown",
    ...max,
    ...(!override && limits.inputLimit && limits.inputLimit !== window ? { inputLimit: limits.inputLimit } : {}),
    compactAtTokens: report.compactAtTokens,
    ...(point.tokens === report.compactAtTokens ? explained : { compactAtSource: "engine" as const }),
    autoCompact,
    ...context,
  }
}
