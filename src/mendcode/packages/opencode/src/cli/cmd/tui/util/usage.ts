import type { AssistantMessage, Provider } from "@mendcode/sdk/v2"
import { Locale } from "@/util/locale"
import * as Model from "./model"

type ProviderIndex = Provider[] | ReadonlyMap<string, Provider>

type AssistantUsageInput = {
  modelID: string
  providerID: string
  variant?: string
  cost: number
  tokens: AssistantMessage["tokens"]
  live?: boolean
  source?: string
  scope?: "turn" | "total"
}

export type AssistantUsageSummary = {
  model: string
  scope: "turn" | "total"
  input: number
  output: number
  reasoning: number
  context: number
  contextPercent?: number
  contextLimit?: number
  cost: number
  tokens: string
  contextLabel: string
  costLabel?: string
  compact: string
  detail: string
}

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

const CONTEXT_USAGE_RESERVED = 20_000
const OUTPUT_TOKEN_MAX = 32_000
const COMPACT_CONTEXT_LABEL_WIDTH = 4

function safe(value: number | undefined) {
  if (!Number.isFinite(value)) return 0
  return value ?? 0
}

export function assistantTokenTotals(message: Pick<AssistantMessage, "tokens">) {
  const cacheRead = safe(message.tokens.cache?.read)
  const cacheWrite = safe(message.tokens.cache?.write)
  const input = safe(message.tokens.input) + cacheRead + cacheWrite
  const output = safe(message.tokens.output) + safe(message.tokens.reasoning)
  return {
    input,
    output,
    context: input + output,
  }
}

export function usableContextLimit(model: Provider["models"][string] | undefined) {
  const context = safe(model?.limit.context)
  if (context <= 0) return undefined

  const output = Math.min(safe(model?.limit.output) || OUTPUT_TOKEN_MAX, OUTPUT_TOKEN_MAX)
  const reserved = Math.min(CONTEXT_USAGE_RESERVED, output)
  const input = safe(model?.limit.input)

  return input > 0 ? Math.max(0, input - reserved) : Math.max(0, context - output)
}

export function compactContextTokenLabel(tokens: number | undefined) {
  const value = safe(tokens)
  if (value <= 0) return "".padStart(COMPACT_CONTEXT_LABEL_WIDTH)
  const abs = Math.abs(value)
  const label = (() => {
    if (abs >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`
    if (abs >= 100_000) {
      const rounded = Math.round(value / 1_000)
      return rounded >= 1_000 ? `${Math.round(value / 100_000) / 10}M` : `${rounded}K`
    }
    if (abs >= 10_000) return `${Math.round(value / 100) / 10}K`
    return String(Math.round(value))
  })()

  return label.slice(0, COMPACT_CONTEXT_LABEL_WIDTH).padEnd(COMPACT_CONTEXT_LABEL_WIDTH)
}

function formatUsage(input: AssistantUsageInput, providers?: ProviderIndex): AssistantUsageSummary | undefined {
  const tokens = assistantTokenTotals(input)
  if (tokens.context <= 0) return

  const scope = input.scope ?? "turn"
  const model = Model.name(providers, input.providerID, input.modelID)
  const modelInfo = Model.get(providers, input.providerID, input.modelID)
  const contextLimit = scope === "total" ? undefined : usableContextLimit(modelInfo)
  const contextPercent = contextLimit ? Math.round((tokens.context / contextLimit) * 100) : undefined
  const contextPct = contextPercent === undefined ? "" : ` ${contextPercent}%`
  const tokenLabel = `↑${Locale.number(tokens.input)} ↓${Locale.number(tokens.output)}`
  const contextLabel = `${scope === "total" ? "total" : "ctx"} ${Locale.number(tokens.context)}${contextPct}`
  const cost = safe(input.cost)
  const costLabel = cost > 0 ? money.format(cost) : undefined
  const variantLabel = input.variant && input.variant !== "default" ? input.variant : undefined
  const liveLabel = input.live ? `live ${input.source || "estimate"}` : undefined

  return {
    model,
    scope,
    cost,
    contextPercent,
    contextLimit,
    tokens: tokenLabel,
    contextLabel,
    costLabel,
    compact: [model, variantLabel, tokenLabel].filter(Boolean).join(" · "),
    detail: [liveLabel, model, variantLabel, tokenLabel, contextLabel, costLabel].filter(Boolean).join(" · "),
    ...tokens,
    reasoning: safe(input.tokens.reasoning),
  }
}

export function formatAssistantUsage(message: AssistantMessage, providers?: ProviderIndex) {
  return formatUsage(message, providers)
}

export function formatLatestAssistantContextUsage(
  messages: AssistantMessage[],
  providers?: ProviderIndex,
  options: { include?: (message: AssistantMessage) => boolean } = {},
) {
  for (const message of messages.toReversed()) {
    if (options.include && !options.include(message)) continue
    const usage = formatAssistantUsage(message, providers)
    if (usage) return usage
  }
}

export function formatAssistantLiveUsage(message: AssistantMessage, providers?: ProviderIndex) {
  if (!message.liveUsage) return
  return formatUsage(
    {
      modelID: message.modelID,
      providerID: message.providerID,
      variant: message.variant,
      cost: message.cost,
      tokens: {
        input: message.liveUsage.input,
        output: message.liveUsage.output,
        reasoning: message.liveUsage.reasoning,
        cache: message.liveUsage.cache,
      },
      live: true,
      source: message.liveUsage.source,
    },
    providers,
  )
}

type LiveUsage = NonNullable<AssistantMessage["liveUsage"]>

export function formatWorkingLiveTokenUsage(live: LiveUsage, options: { showReasoning?: boolean } = {}) {
  const input = safe(live.input) + safe(live.cache?.read) + safe(live.cache?.write)
  const output = safe(live.output) + safe(live.reasoning)
  const reasoning = safe(live.reasoning)
  const estimated = live.source === "estimate"
  const prefix = estimated ? "~" : ""
  const reasoningLabel = options.showReasoning && reasoning > 0 ? `${Locale.number(reasoning)} reasoning tokens` : ""
  const withReasoning = (label: string) => (reasoningLabel ? `${label} · ${reasoningLabel}` : label)
  if (live.phase === "output" && output > 0) return withReasoning(`↓${prefix}${Locale.number(output)}`)
  if (input > 0) return `↑${prefix}${Locale.number(input)}`
  if (output > 0) return withReasoning(`↓${prefix}${Locale.number(output)}`)
  return live.phase === "output" ? `↓${prefix}0` : `↑${prefix}0`
}

export function formatAssistantUsageTotal(messages: AssistantMessage[], providers?: ProviderIndex) {
  const used = messages.filter((message) => assistantTokenTotals(message).context > 0)
  const last = used.at(-1)
  if (!last) return

  const total = used.reduce(
    (sum, message) => {
      const tokens = assistantTokenTotals(message)
      sum.cost += safe(message.cost)
      sum.tokens.input += tokens.input
      sum.tokens.output += tokens.output
      return sum
    },
    {
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
  )

  return formatUsage(
    {
      modelID: last.modelID,
      providerID: last.providerID,
      variant: last.variant,
      cost: total.cost,
      tokens: total.tokens,
      scope: "total",
    },
    providers,
  )
}
