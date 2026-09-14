import { createHash } from "node:crypto"
import type { ModelMessage } from "ai"
import { mergeDeep, unique } from "remeda"
import { ConfigCache } from "@/config/cache"
import type * as Provider from "./provider"

export type CacheAuth = "api" | "oauth" | "unknown"
export type CacheTransport = "responses-http" | "responses-lite" | "claude-agent-sdk" | "other"

/** Internal marker consumed by the ChatGPT OAuth adapter and never sent upstream. */
export const CACHE_MODE_HEADER = "x-mendcode-cache-mode"
/** Internal managed-key marker consumed by provider adapters and never sent upstream. */
export const CACHE_KEY_HEADER = "x-mendcode-cache-key"
/** Internal provider-session marker consumed by adapters and never sent upstream. */
export const CACHE_SESSION_HEADER = "x-mendcode-cache-session-id"

export type CacheBinding = {
  providerID: string
  modelID: string
  apiModelID: string
  endpoint: string
  auth: CacheAuth
  transport: CacheTransport
  sdk: string
  accountScope?: string
}

export type CacheCapabilities = {
  /** The binding already has a supported cache-key representation. */
  key: boolean
  /** Explicit cache breakpoints are verified for this exact binding. */
  explicitBreakpoints: boolean
  /** A provider-declared retention period, or null when unknown. */
  retentionSeconds: number | null
  /** A provider-specific refresh request is verified for this exact binding. */
  refresh: boolean
  /** Lineage inheritance is verified for this exact binding. */
  lineage: boolean
}

export type CacheAdapterScope = "model" | "family" | "provider" | "fallback"

export type CacheAdapter = {
  id: string
  matches: (binding: CacheBinding) => boolean
  capabilities: (binding: CacheBinding) => CacheCapabilities
  /** Optional precedence; model-specific adapters should declare their scope. */
  scope?: CacheAdapterScope
  priority?: number
}

const FALLBACK_CAPABILITIES: CacheCapabilities = {
  key: false,
  explicitBreakpoints: false,
  retentionSeconds: null,
  refresh: false,
  lineage: false,
}

const OPENAI_CAPABILITIES: CacheCapabilities = {
  key: true,
  explicitBreakpoints: false,
  retentionSeconds: null,
  refresh: false,
  lineage: false,
}

const OPENROUTER_CAPABILITIES: CacheCapabilities = {
  key: true,
  explicitBreakpoints: false,
  retentionSeconds: null,
  refresh: false,
  lineage: false,
}

const LEGACY_CONTROL_CAPABILITIES: CacheCapabilities = {
  key: false,
  explicitBreakpoints: false,
  retentionSeconds: null,
  refresh: false,
  lineage: false,
}

const CLAUDE_CODE_CAPABILITIES: CacheCapabilities = {
  key: false,
  explicitBreakpoints: false,
  retentionSeconds: null,
  refresh: false,
  lineage: true,
}

const FALLBACK_ADAPTER: CacheAdapter = {
  id: "legacy-fallback",
  scope: "fallback",
  matches: () => true,
  capabilities: () => ({ ...FALLBACK_CAPABILITIES }),
}

/**
 * Built-in cache knowledge is deliberately conservative. New provider/model
 * adapters can be added here after their exact wire contract is verified.
 */
export const defaultCacheAdapters: readonly CacheAdapter[] = [
  {
    id: "openai",
    scope: "provider",
    matches: (binding) => binding.providerID === "openai" && binding.sdk === "@ai-sdk/openai",
    capabilities: () => ({ ...OPENAI_CAPABILITIES }),
  },
  {
    id: "openrouter",
    scope: "provider",
    matches: (binding) => binding.providerID === "openrouter" || binding.sdk === "@openrouter/ai-sdk-provider",
    capabilities: () => ({ ...OPENROUTER_CAPABILITIES }),
  },
  {
    id: "anthropic-controls",
    scope: "provider",
    matches: (binding) => binding.sdk === "@ai-sdk/anthropic" || binding.sdk === "@ai-sdk/google-vertex/anthropic",
    capabilities: () => ({ ...LEGACY_CONTROL_CAPABILITIES }),
  },
  {
    id: "bedrock-controls",
    scope: "provider",
    matches: (binding) => binding.sdk === "@ai-sdk/amazon-bedrock",
    capabilities: () => ({ ...LEGACY_CONTROL_CAPABILITIES }),
  },
  {
    id: "claude-code",
    scope: "provider",
    matches: (binding) => binding.providerID === "claude-code" && binding.sdk === "mendcode/claude-code",
    capabilities: () => ({ ...CLAUDE_CODE_CAPABILITIES }),
  },
  {
    ...FALLBACK_ADAPTER,
  },
]

const ADAPTER_PRIORITY: Record<CacheAdapterScope, number> = {
  fallback: 0,
  provider: 10,
  family: 20,
  model: 30,
}

function adapterPriority(adapter: CacheAdapter) {
  return adapter.priority ?? (adapter.scope ? ADAPTER_PRIORITY[adapter.scope] : ADAPTER_PRIORITY.family)
}

export function resolveCacheAdapter(
  binding: CacheBinding,
  adapters: readonly CacheAdapter[] = defaultCacheAdapters,
): CacheAdapter {
  const matches = adapters.filter((adapter) => adapter.matches(binding))
  if (matches.length === 0) return FALLBACK_ADAPTER

  const priority = Math.max(...matches.map(adapterPriority))
  const best = matches.filter((adapter) => adapterPriority(adapter) === priority)
  if (best.length > 1) {
    throw new Error(
      `Ambiguous cache adapters for ${binding.providerID}/${binding.modelID}: ${best.map((item) => item.id).join(", ")}`,
    )
  }
  return best[0]!
}

export type CacheRequestPolicy = {
  mode: ConfigCache.EffectiveMode
  scope: ConfigCache.Scope
  useCacheKey: boolean
  /** A deterministic cross-request key is allowed for this exact binding. */
  allowManagedKey: boolean
  useLineage: boolean
  useLegacyAnnotations: boolean
  adapterID: string
  reason: string
}

function verifiedPassiveBinding(binding: CacheBinding) {
  let hostname: string
  try {
    hostname = new URL(binding.endpoint).hostname
  } catch {
    return false
  }

  // Codex OAuth has a provider-native, session-scoped key in the Responses Lite
  // envelope. This is not a managed cross-session lineage key.
  if (binding.providerID === "openai" && binding.auth === "oauth" && binding.transport === "responses-lite") {
    return binding.sdk === "@ai-sdk/openai" && (hostname === "api.openai.com" || hostname === "chatgpt.com")
  }

  if (binding.auth !== "api" || binding.transport === "responses-lite") return false

  if (binding.providerID === "openai") {
    return binding.sdk === "@ai-sdk/openai" && hostname === "api.openai.com"
  }

  if (binding.providerID === "openrouter") {
    return (
      (binding.sdk === "@openrouter/ai-sdk-provider" || binding.sdk === "@ai-sdk/openai-compatible") &&
      hostname === "openrouter.ai"
    )
  }

  return false
}

function verifiedLineageBinding(binding: CacheBinding) {
  return (
    binding.providerID === "claude-code" &&
    binding.sdk === "mendcode/claude-code" &&
    binding.auth === "api" &&
    binding.transport === "claude-agent-sdk"
  )
}

function verifiedManagedKeyBinding(binding: CacheBinding) {
  if (binding.auth !== "api") return false
  if (binding.providerID === "openai") {
    return binding.transport === "responses-http" && binding.sdk === "@ai-sdk/openai"
  }
  if (binding.providerID === "openrouter") {
    return (
      binding.transport !== "responses-lite" &&
      (binding.sdk === "@openrouter/ai-sdk-provider" || binding.sdk === "@ai-sdk/openai-compatible")
    )
  }
  return false
}

export function resolveCacheRequestPolicy(input: {
  config?: ConfigCache.Info
  binding: CacheBinding
  projectScope?: string
  sessionID?: string
  fullMode?: boolean
}): CacheRequestPolicy {
  const selection = ConfigCache.selectCacheConfig({
    config: input.config,
    projectScope: input.projectScope,
    sessionID: input.sessionID,
    providerID: input.binding.providerID,
    modelID: input.binding.modelID,
    apiModelID: input.binding.apiModelID,
    fullMode: input.fullMode,
  })

  if (selection.mode === "off") {
    return {
      mode: "off",
      scope: selection.scope,
      useCacheKey: false,
      allowManagedKey: false,
      useLineage: false,
      useLegacyAnnotations: false,
      adapterID: "disabled",
      reason: selection.reason,
    }
  }

  const adapter = resolveCacheAdapter(input.binding)
  if (selection.mode === "legacy") {
    return {
      mode: "legacy",
      scope: selection.scope,
      useCacheKey: true,
      allowManagedKey: false,
      useLineage: false,
      useLegacyAnnotations: true,
      adapterID: adapter.id,
      reason: selection.reason,
    }
  }

  const capabilities = adapter.capabilities(input.binding)
  const useCacheKey = capabilities.key && verifiedPassiveBinding(input.binding)
  const allowManagedKey = useCacheKey && verifiedManagedKeyBinding(input.binding)
  const useLineage = capabilities.lineage && verifiedLineageBinding(input.binding)
  return {
    mode: "smart",
    scope: selection.scope,
    useCacheKey,
    allowManagedKey,
    useLineage,
    useLegacyAnnotations: adapter.id !== "claude-code",
    adapterID: adapter.id,
    reason: useCacheKey
      ? "verified passive cache binding"
      : useLineage
        ? "verified passive provider session lineage"
        : "binding is not verified for passive cache controls",
  }
}

/** Return an opaque, stable account discriminator without retaining credentials. */
export function opaqueCacheScope(value: string) {
  return `account:${createHash("sha256").update(value).digest("hex").slice(0, 32)}`
}

export function cacheBindingFromModel(
  model: Pick<Provider.Model, "id" | "providerID" | "api">,
  input: Partial<Pick<CacheBinding, "auth" | "transport" | "accountScope" | "endpoint">> = {},
): CacheBinding {
  return {
    providerID: model.providerID,
    modelID: model.id,
    apiModelID: model.api.id,
    endpoint: input.endpoint ?? model.api.url,
    auth: input.auth ?? "unknown",
    transport: input.transport ?? "other",
    sdk: model.api.npm,
    ...(input.accountScope ? { accountScope: input.accountScope } : {}),
  }
}

function normalizedEndpoint(endpoint: string) {
  try {
    const parsed = new URL(endpoint)
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password) return null
    parsed.hash = ""
    return parsed.toString().replace(/\/$/, "")
  } catch {
    return null
  }
}

const UNSUPPORTED = Symbol("unsupported-cache-fingerprint-value")

function canonicalize(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : UNSUPPORTED
  if (typeof value === "undefined") return { __mendcodeUndefined: true }
  if (typeof value !== "object") return UNSUPPORTED
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : UNSUPPORTED
  if (seen.has(value)) return UNSUPPORTED
  seen.add(value)

  const result = Array.isArray(value)
    ? value.map((item) => canonicalize(item, seen))
    : Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonicalize((value as Record<string, unknown>)[key], seen)]),
      )
  seen.delete(value)
  if (Array.isArray(result) && result.some((item) => item === UNSUPPORTED)) return UNSUPPORTED
  if (!Array.isArray(result) && Object.values(result).some((item) => item === UNSUPPORTED)) return UNSUPPORTED
  return result
}

function containsUnstableMedia(value: unknown, seen: Set<object> = new Set()): boolean {
  if (value === null || typeof value !== "object") return false
  if (seen.has(value)) return true
  seen.add(value)
  if (Array.isArray(value)) return value.some((item) => containsUnstableMedia(item, seen))
  const record = value as Record<string, unknown>
  if (["image", "input_image", "input_file", "file", "image_url", "file_url"].includes(String(record.type))) return true
  if ("image_url" in record || "file_url" in record) return true
  return Object.values(record).some((item) => containsUnstableMedia(item, seen))
}

/**
 * Hash only a reproducible cache prefix. The prompt itself is never retained.
 * Callers must supply the prefix after all relevant transforms and tools have
 * been resolved; a hash calculated earlier does not prove wire equality.
 */
export function fingerprintPrefix(input: {
  binding: CacheBinding
  projectScope: string
  prefix: unknown
  toolDefinitions: unknown
  settings: unknown
  serializationRevision: string
}) {
  const endpoint = normalizedEndpoint(input.binding.endpoint)
  if (
    !endpoint ||
    !input.projectScope ||
    !input.binding.accountScope ||
    input.binding.auth === "unknown" ||
    input.binding.transport === "other" ||
    !input.binding.providerID ||
    !input.binding.modelID ||
    !input.binding.apiModelID ||
    !input.binding.sdk ||
    !input.serializationRevision ||
    containsUnstableMedia(input.prefix) ||
    containsUnstableMedia(input.toolDefinitions) ||
    containsUnstableMedia(input.settings)
  )
    return null

  const payload = canonicalize(
    {
      binding: { ...input.binding, endpoint },
      projectScope: input.projectScope,
      prefix: input.prefix,
      toolDefinitions: input.toolDefinitions,
      settings: input.settings,
      serializationRevision: input.serializationRevision,
    },
    new Set(),
  )
  if (payload === UNSUPPORTED) return null
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex")
}

export function isManagedCacheKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9:_-]{1,256}$/.test(value)
}

function uniqueMessages(messages: ModelMessage[]) {
  return unique(messages)
}

/** Preserve the existing provider annotations while keeping the decision in one module. */
export function applyLegacyCaching(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
  const system = msgs.filter((msg) => msg.role === "system").slice(0, 2)
  const final = msgs.filter((msg) => msg.role !== "system").slice(-2)

  const providerOptions = {
    anthropic: {
      cacheControl: { type: "ephemeral" },
    },
    openrouter: {
      cacheControl: { type: "ephemeral" },
    },
    bedrock: {
      cachePoint: { type: "default" },
    },
    openaiCompatible: {
      cache_control: { type: "ephemeral" },
    },
    copilot: {
      copilot_cache_control: { type: "ephemeral" },
    },
    alibaba: {
      cacheControl: { type: "ephemeral" },
    },
  }

  for (const msg of uniqueMessages([...system, ...final])) {
    const useMessageLevelOptions =
      model.providerID === "anthropic" ||
      model.providerID.includes("bedrock") ||
      model.api.npm === "@ai-sdk/amazon-bedrock"
    const shouldUseContentOptions = !useMessageLevelOptions && Array.isArray(msg.content) && msg.content.length > 0

    if (shouldUseContentOptions) {
      const lastContent = msg.content[msg.content.length - 1]
      if (
        lastContent &&
        typeof lastContent === "object" &&
        lastContent.type !== "tool-approval-request" &&
        lastContent.type !== "tool-approval-response"
      ) {
        lastContent.providerOptions = mergeDeep(lastContent.providerOptions ?? {}, providerOptions)
        continue
      }
    }

    msg.providerOptions = mergeDeep(msg.providerOptions ?? {}, providerOptions)
  }

  return msgs
}

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
}

export function normalizeCacheObservation(input: {
  inputTokens?: unknown
  readTokens?: unknown
  writeTokens?: unknown
  observedAtMs: number
}) {
  if (!Number.isSafeInteger(input.observedAtMs) || input.observedAtMs < 0) {
    throw new RangeError("Cache observation timestamp must be a non-negative safe integer")
  }

  const inputTokens = nonNegativeInteger(input.inputTokens)
  const readCandidate = nonNegativeInteger(input.readTokens)
  const writeCandidate = nonNegativeInteger(input.writeTokens)
  const readTokens =
    inputTokens !== null && readCandidate !== null && readCandidate > inputTokens ? null : readCandidate
  const writeTokens =
    inputTokens !== null && writeCandidate !== null && writeCandidate > inputTokens ? null : writeCandidate
  const state = readTokens === null ? "unknown" : readTokens === 0 ? "miss_observed" : "hit_observed"
  const hitRatio = inputTokens !== null && inputTokens > 0 && readTokens !== null ? readTokens / inputTokens : null

  return {
    inputTokens,
    readTokens,
    writeTokens,
    hitRatio,
    observedAtMs: input.observedAtMs,
    state,
    expiresAtMs: null,
  } as const
}

export * as CachePolicy from "./cache-policy"
