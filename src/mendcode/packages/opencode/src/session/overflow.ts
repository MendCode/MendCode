import type { Config } from "@/config/config"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"

const COMPACTION_BUFFER = 20_000
export const DEFAULT_COMPACTION_THRESHOLD_PERCENT = 95

function normalizeThreshold(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return Math.max(1, Math.min(100, value))
}

function record(value: unknown) {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined
}

function compactionThreshold(value: unknown) {
  return normalizeThreshold(record(record(value)?.compaction)?.threshold)
}

function compactionTokenLimit(value: unknown) {
  const limit = record(record(value)?.compaction)?.token_limit
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return undefined
  return Math.floor(limit)
}

export function compactionThresholdPercent(input: {
  cfg?: unknown
  model?: { id?: string; providerID?: string }
}) {
  const cfg = record(input.cfg)
  const providerConfig = input.model?.providerID ? record(record(cfg?.provider)?.[input.model.providerID]) : undefined
  const modelConfig = input.model?.id ? record(record(providerConfig?.models)?.[input.model.id]) : undefined
  return (
    compactionThreshold(modelConfig) ??
    compactionThreshold(providerConfig) ??
    compactionThreshold(cfg) ??
    DEFAULT_COMPACTION_THRESHOLD_PERCENT
  )
}

export function configuredCompactionTokenLimit(input: {
  cfg?: unknown
  model?: { id?: string; providerID?: string }
}) {
  const cfg = record(input.cfg)
  const providerConfig = input.model?.providerID ? record(record(cfg?.provider)?.[input.model.providerID]) : undefined
  const modelConfig = input.model?.id ? record(record(providerConfig?.models)?.[input.model.id]) : undefined
  return compactionTokenLimit(modelConfig) ?? compactionTokenLimit(providerConfig) ?? compactionTokenLimit(cfg)
}

export function usable(input: { cfg: Config.Info; model: Provider.Model }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  const reserved =
    input.cfg.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model))
  return input.model.limit.input
    ? Math.max(0, input.model.limit.input - reserved)
    : Math.max(0, context - ProviderTransform.maxOutputTokens(input.model))
}

export function modelContextLimit(input: { model: Provider.Model }) {
  const context = input.model.limit.context
  if (context === 0) return 0
  return input.model.limit.input && input.model.limit.input > 0 ? input.model.limit.input : context
}

export function compactionThresholdTokens(input: { cfg: Config.Info; model: Provider.Model }) {
  const context = modelContextLimit(input)
  const tokenLimit = configuredCompactionTokenLimit(input)
  if (tokenLimit !== undefined) return Math.min(context, tokenLimit)
  return Math.floor(context * (compactionThresholdPercent(input) / 100))
}

export function isTokenOverflow(input: {
  cfg: Config.Info
  tokens: number
  model: Provider.Model
  respectAuto?: boolean
  mode?: "threshold" | "hard"
}) {
  if (input.mode === "hard") return input.model.limit.context !== 0 && input.tokens >= modelContextLimit(input)
  if (input.respectAuto !== false && input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false
  return input.tokens >= compactionThresholdTokens(input)
}

export function isOverflow(input: { cfg: Config.Info; tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
  const detailed =
    input.tokens.input +
    input.tokens.output +
    input.tokens.reasoning +
    input.tokens.cache.read +
    input.tokens.cache.write
  const count = detailed || input.tokens.total || 0
  return isTokenOverflow({ ...input, tokens: count })
}
