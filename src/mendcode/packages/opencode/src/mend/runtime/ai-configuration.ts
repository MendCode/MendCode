import { Auth } from "@/auth"
import * as AIConfig from "@/config/ai"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { resolveModelRoles } from "@/mend/config/models"
import {
  resolveModelRef,
  resolveCompoundProfiles,
  type Pricing,
  type ResolvedModelRef,
  type RoleInventory,
  type ValidationIssue,
} from "@/mend/config/compound-models"
import {
  AIConfigWriteError,
  applyJsoncPatch,
  discoverConfigTargets,
  parseConfigObject,
  readConfigTarget,
  resolveConfigTarget,
  validatePatch,
  writeAIConfig,
  type AIConfigPatch,
  type ConfigScope,
  type ConfigTarget,
} from "@/mend/config/ai-writer"
import { nativeCapability, type NativeCapability } from "@/provider/native-compaction"
import { Provider } from "@/provider/provider"
import { Effect, Context, Layer, Schema } from "effect"
import { Global } from "@mendcode/core/global"
import { Permission } from "@/permission"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { createHash } from "node:crypto"
import path from "node:path"

export type ConfigIntent = "economical" | "balanced" | "quality"
export type ConfigTaskKind = "repair" | "terminal" | "frontend" | "architecture" | "review" | "general"

export const PlanRequest = Schema.Struct({
  candidates: Schema.Array(AIConfig.ModelRef),
  intent: Schema.Literals(["economical", "balanced", "quality"]),
  taskKind: Schema.Literals(["repair", "terminal", "frontend", "architecture", "review", "general"]),
  selectedRoles: Schema.optional(Schema.Array(Schema.String)),
  scope: Schema.optional(Schema.Literals(["project", "global"])),
  target: Schema.optional(Schema.String),
  profileName: Schema.optional(Schema.String),
})
export type PlanRequest = Schema.Schema.Type<typeof PlanRequest>

export const ValidateRequest = Schema.Struct({
  patch: Schema.Unknown,
  scope: Schema.optional(Schema.Literals(["project", "global"])),
  target: Schema.optional(Schema.String),
  expectedHash: Schema.optional(Schema.String),
})
export type ValidateRequest = Schema.Schema.Type<typeof ValidateRequest>

export const ApplyRequest = Schema.Struct({
  scope: Schema.Literals(["project", "global"]),
  target: Schema.optional(Schema.String),
  patch: Schema.Unknown,
  expectedHash: Schema.String,
  causalSessionID: Schema.String,
})
export type ApplyRequest = Schema.Schema.Type<typeof ApplyRequest>

export const ConfigTargetSchema = Schema.Struct({
  scope: Schema.Literals(["project", "global"]),
  path: Schema.String,
  format: Schema.Literals(["json", "jsonc"]),
  exists: Schema.Boolean,
  writable: Schema.Boolean,
  digest: Schema.String,
})

export const ValidationIssueSchema = Schema.Struct({
  code: Schema.String,
  path: Schema.String,
  message: Schema.String,
})

const PricingSchema = Schema.Struct({
  inputUsdPer1M: Schema.NullOr(Schema.Finite),
  outputUsdPer1M: Schema.NullOr(Schema.Finite),
  cacheReadUsdPer1M: Schema.NullOr(Schema.Finite),
  cacheWriteUsdPer1M: Schema.NullOr(Schema.Finite),
  source: Schema.NullOr(Schema.String),
})

const AuthStatusSchema = Schema.Struct({
  configured: Schema.Boolean,
  mode: Schema.Literals(["oauth", "api", "wellknown", "env", "configured", "not-configured"]),
})

const NativeCapabilitySchema = Schema.Struct({
  supported: Schema.Boolean,
  protocol: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  binding: Schema.optional(Schema.Unknown),
})

const PublicModelSchema = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  name: Schema.String,
  apiOrigin: Schema.NullOr(Schema.String),
  status: Schema.String,
  variants: Schema.Array(Schema.String),
  capabilities: Schema.Struct({
    reasoning: Schema.Boolean,
    toolcall: Schema.Boolean,
    input: Schema.Unknown,
    output: Schema.Unknown,
    nativeCompaction: NativeCapabilitySchema,
  }),
  auth: AuthStatusSchema,
  pricing: PricingSchema,
})

const PublicRoleSchema = Schema.Struct({
  name: Schema.String,
  providerID: Schema.NullOr(Schema.String),
  modelID: Schema.NullOr(Schema.String),
  variant: Schema.NullOr(Schema.String),
  configured: Schema.Boolean,
  authMode: Schema.NullOr(Schema.String),
})

const ConfigSourceSchema = Schema.Struct({
  scope: Schema.Literals(["project", "global"]),
  path: Schema.String,
  format: Schema.Literals(["json", "jsonc"]),
  exists: Schema.Boolean,
  writable: Schema.Boolean,
  digest: Schema.String,
})

export const InspectResponse = Schema.Struct({
  version: Schema.Literal(1),
  models: Schema.Array(PublicModelSchema),
  roles: Schema.Array(PublicRoleSchema),
  configSources: Schema.Array(ConfigSourceSchema),
  pricingSources: Schema.Array(
    Schema.Struct({
      source: Schema.String,
      observedAt: Schema.String,
    }),
  ),
  effective: Schema.Struct({
    compaction: Schema.optional(Schema.Unknown),
    ai: Schema.optional(Schema.Unknown),
  }),
  missingInformation: Schema.Array(Schema.String),
})
export type InspectResponse = Schema.Schema.Type<typeof InspectResponse>

const AlternativeSchema = Schema.Struct({
  id: Schema.String,
  strategy: AIConfig.CompoundProfile.fields.strategy,
  primary: AIConfig.ModelRef,
  escalation: Schema.optional(AIConfig.ModelRef),
  critic: Schema.optional(AIConfig.ModelRef),
  limits: AIConfig.Limits,
  feasibility: Schema.Literals(["feasible", "blocked"]),
  estimatedMaxCostUsd: Schema.NullOr(Schema.Finite),
  costBasis: Schema.String,
  quality: Schema.Literal("unknown"),
  rationale: Schema.String,
  warnings: Schema.Array(Schema.String),
})

export const PlanResponse = Schema.Struct({
  version: Schema.Literal(1),
  alternatives: Schema.Array(AlternativeSchema),
  selectedAlternative: Schema.String,
  patch: Schema.Unknown,
  explanation: Schema.String,
  warnings: Schema.Array(Schema.String),
  evidence: Schema.Struct({
    observedAt: Schema.String,
    sources: Schema.Array(Schema.String),
    quality: Schema.Literal("unknown"),
  }),
  target: Schema.NullOr(ConfigTargetSchema),
  targetCandidates: Schema.Array(ConfigTargetSchema),
  expectedHash: Schema.NullOr(Schema.String),
})
export type PlanResponse = Schema.Schema.Type<typeof PlanResponse>

export const ValidateResponse = Schema.Struct({
  valid: Schema.Boolean,
  issues: Schema.Array(ValidationIssueSchema),
  warnings: Schema.Array(Schema.String),
  profiles: Schema.Record(Schema.String, Schema.Unknown),
  native: Schema.NullOr(Schema.Unknown),
  effective: Schema.Struct({
    compaction: Schema.Unknown,
    ai: Schema.NullOr(Schema.Unknown),
  }),
  target: Schema.NullOr(ConfigTargetSchema),
})
export type ValidateResponse = Schema.Schema.Type<typeof ValidateResponse>

export const ApplyResponse = Schema.Struct({
  changed: Schema.Boolean,
  changedKeys: Schema.Array(Schema.String),
  target: ConfigTargetSchema,
  beforeHash: Schema.String,
  afterHash: Schema.String,
  backupPath: Schema.NullOr(Schema.String),
  effective: ValidateResponse.fields.effective,
  warnings: Schema.Array(Schema.String),
})
export type ApplyResponse = Schema.Schema.Type<typeof ApplyResponse>

export type AIConfigurationErrorCode = "invalid" | "unavailable" | "conflict" | "permission" | "io"

export class AIConfigurationError extends Error {
  readonly code: AIConfigurationErrorCode
  readonly status: 400 | 403 | 409 | 422 | 500
  readonly details?: Record<string, unknown>

  constructor(
    code: AIConfigurationErrorCode,
    message: string,
    options?: { details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message, { cause: options?.cause })
    this.name = "AIConfigurationError"
    this.code = code
    this.status = code === "permission" ? 403 : code === "conflict" ? 409 : code === "unavailable" ? 422 : code === "io" ? 500 : 400
    this.details = options?.details
  }
}

type RuntimeSnapshot = {
  root: string
  config: Config.Info
  providers: Record<string, Provider.Info>
  auth: Record<string, Auth.Info>
  roles: RoleInventory
  globalDir?: string
  observedAt?: string
}

type PublicModel = InspectResponse["models"][number]

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function merge(base: unknown, patch: unknown): unknown {
  if (!record(base) || !record(patch)) return clone(patch)
  const result: Record<string, unknown> = { ...clone(base) }
  for (const [key, value] of Object.entries(patch)) result[key] = key in result ? merge(result[key], value) : clone(value)
  return result
}

function observedAt(input: RuntimeSnapshot) {
  return input.observedAt ?? new Date().toISOString()
}

function authStatus(provider: Provider.Info, auth: Auth.Info | undefined) {
  if (auth) return { configured: true, mode: auth.type } as const
  if (provider.key) return { configured: true, mode: "api" } as const
  if (provider.source === "env") return { configured: true, mode: "env" } as const
  if (provider.source === "api" || provider.source === "config") return { configured: true, mode: "configured" } as const
  return { configured: false, mode: "not-configured" } as const
}

function origin(value: string) {
  if (!value) return null
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

function pricing(model: Provider.Model): Pricing {
  const values = [model.cost.input, model.cost.output, model.cost.cache.read, model.cost.cache.write]
  const known = values.some((value) => Number.isFinite(value) && value > 0)
  return {
    inputUsdPer1M: known && Number.isFinite(model.cost.input) ? model.cost.input : null,
    outputUsdPer1M: known && Number.isFinite(model.cost.output) ? model.cost.output : null,
    cacheReadUsdPer1M: known && Number.isFinite(model.cost.cache.read) ? model.cost.cache.read : null,
    cacheWriteUsdPer1M: known && Number.isFinite(model.cost.cache.write) ? model.cost.cache.write : null,
    source: known ? origin(model.api.url) : null,
  }
}

function publicModel(provider: Provider.Info, model: Provider.Model, auth: Auth.Info | undefined): PublicModel {
  const native = nativeCapability({ provider, model, auth })
  return {
    providerID: provider.id,
    modelID: model.id,
    name: model.name,
    apiOrigin: origin(model.api.url),
    status: model.status,
    variants: Object.keys(model.variants ?? {}).toSorted(),
    capabilities: {
      reasoning: model.capabilities.reasoning,
      toolcall: model.capabilities.toolcall,
      input: model.capabilities.input,
      output: model.capabilities.output,
      nativeCompaction: native,
    },
    auth: authStatus(provider, auth),
    pricing: pricing(model),
  }
}

function sourceSummary(target: ConfigTarget) {
  return {
    scope: target.scope,
    path: target.path,
    format: target.format,
    exists: target.exists,
    writable: target.writable,
    digest: target.digest,
  }
}

function effectiveCompaction(config: Config.Info) {
  if (!config.compaction) return {}
  return {
    ...(config.compaction.strategy ? { strategy: config.compaction.strategy } : {}),
    ...(config.compaction.portable_mode ? { portable_mode: config.compaction.portable_mode } : {}),
    ...(config.compaction.timeout_ms !== undefined ? { timeout_ms: config.compaction.timeout_ms } : {}),
    ...(config.compaction.max_summary_tokens !== undefined ? { max_summary_tokens: config.compaction.max_summary_tokens } : {}),
    ...(config.compaction.on_native_error ? { on_native_error: config.compaction.on_native_error } : {}),
  }
}

function effectiveAI(config: Config.Info) {
  if (!config.ai) return undefined
  return {
    version: config.ai.version,
    orchestration: {
      enabled: config.ai.orchestration.enabled,
      profiles: Object.keys(config.ai.orchestration.profiles).toSorted(),
    },
  }
}

export async function inspectConfiguration(input: RuntimeSnapshot): Promise<InspectResponse> {
  const [projectTargets, globalTargets] = await Promise.all([
    discoverConfigTargets({ scope: "project", root: input.root, globalDir: input.globalDir }),
    discoverConfigTargets({ scope: "global", root: input.root, globalDir: input.globalDir }),
  ])
  const targets = [...projectTargets, ...globalTargets]
  const existing = targets.filter((target) => target.exists)
  const sources = existing.length ? existing : [projectTargets[0]!]
  const models = Object.values(input.providers).flatMap((provider) =>
    Object.values(provider.models).map((model) => publicModel(provider, model, input.auth[provider.id])),
  )
  const pricingSources = models
    .map((model) => model.pricing.source)
    .filter((source): source is string => Boolean(source))
    .filter((source, index, all) => all.indexOf(source) === index)
    .map((source) => ({ source, observedAt: observedAt(input) }))
  const missingInformation = [
    ...(models.some((model) => model.pricing.inputUsdPer1M === null || model.pricing.outputUsdPer1M === null)
      ? ["Pricing is unavailable for one or more models; unknown cost is not treated as free."]
      : []),
    ...(models.some((model) => model.auth.configured === false)
      ? ["One or more provider credentials are not configured in the current runtime."]
      : []),
    "Comparable dated quality evidence is not available; no intelligence ranking is claimed.",
  ]
  return {
    version: 1,
    models: models.toSorted((a, b) => `${a.providerID}/${a.modelID}`.localeCompare(`${b.providerID}/${b.modelID}`)),
    roles: Object.entries(input.roles)
      .map(([name, role]) => ({
        name,
        providerID: role.providerID,
        modelID: role.modelID,
        variant: role.variant ?? null,
        configured: role.configured ?? Boolean(role.providerID && role.modelID),
        authMode: role.authMode ?? null,
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name)),
    configSources: sources.map(sourceSummary),
    pricingSources,
    effective: {
      compaction: effectiveCompaction(input.config),
      ...(effectiveAI(input.config) ? { ai: effectiveAI(input.config) } : {}),
    },
    missingInformation,
  }
}

function modelKey(model: ResolvedModelRef) {
  return `${model.providerID}/${model.modelID}#${model.variant ?? ""}`
}

function candidateIssues(input: RuntimeSnapshot, candidates: readonly unknown[]) {
  const valid: Array<{ ref: AIConfig.ModelRef; model: ResolvedModelRef }> = []
  const issues: ValidationIssue[] = []
  for (const [index, candidate] of candidates.entries()) {
    const parsed = AIConfig.ModelRef.zod.safeParse(candidate)
    if (!parsed.success) {
      issues.push({ code: "invalid-candidate", path: `candidates.${index}`, message: "Candidate is not a valid ModelRef." })
      continue
    }
    const resolved = resolveModelRef(parsed.data, `candidates.${index}`, input.providers, input.roles)
    issues.push(...resolved.issues)
    if (resolved.model) valid.push({ ref: parsed.data, model: resolved.model })
  }
  const unique = valid.filter((item, index, all) => all.findIndex((other) => modelKey(other.model) === modelKey(item.model)) === index)
  return { valid: unique, issues }
}

function limits(strategy: AIConfig.Strategy): AIConfig.Limits {
  return {
    maxModelRequests: strategy === "single" ? 1 : strategy === "cascade" ? 2 : 3,
    maxTotalTokens: 32_000,
    maxRuntimeMs: 300_000,
    unknownCost: "allow-with-token-cap",
  }
}

function rate(model: ResolvedModelRef) {
  if (model.pricing.inputUsdPer1M === null || model.pricing.outputUsdPer1M === null) return null
  return Math.max(model.pricing.inputUsdPer1M, model.pricing.outputUsdPer1M)
}

function alternative(input: {
  id: string
  strategy: AIConfig.Strategy
  primary: { ref: AIConfig.ModelRef; model: ResolvedModelRef }
  escalation?: { ref: AIConfig.ModelRef; model: ResolvedModelRef }
  critic?: { ref: AIConfig.ModelRef; model: ResolvedModelRef }
  intent: ConfigIntent
}) {
  const profileLimits = limits(input.strategy)
  const unitRate = rate(input.primary.model)
  const estimatedMaxCostUsd = unitRate === null ? null : (unitRate * profileLimits.maxTotalTokens) / 1_000_000
  const warnings = [
    ...(estimatedMaxCostUsd === null ? ["The primary route has incomplete pricing; configure unknownCost explicitly before enforcing a dollar cap."] : []),
    ...(input.primary.model.authMode?.includes("subscription")
      ? ["Subscription quota is not represented as zero-dollar API billing."]
      : []),
  ]
  const rationale =
    input.strategy === "single"
      ? "One configured model keeps the run bounded and preserves ordinary single-model behavior."
      : input.strategy === "cascade"
        ? "Escalation is limited to one quality failure and reuses the isolated candidate."
        : "The independent critic has no tools and quality remains subject to deterministic validation and explicit evidence."
  return {
    id: input.id,
    strategy: input.strategy,
    primary: input.primary.ref,
    ...(input.escalation ? { escalation: input.escalation.ref } : {}),
    ...(input.critic ? { critic: input.critic.ref } : {}),
    limits: profileLimits,
    feasibility: "feasible" as const,
    estimatedMaxCostUsd,
    costBasis:
      estimatedMaxCostUsd === null
        ? "unknown: catalog input/output price coverage is incomplete"
        : `upper-bound estimate using ${profileLimits.maxTotalTokens} total tokens and the larger known primary token rate; not an invoice`,
    quality: "unknown" as const,
    rationale,
    warnings,
  }
}

function profilePatch(name: string, item: ReturnType<typeof alternative>): AIConfigPatch {
  return {
    ai: {
      version: 1,
      orchestration: {
        enabled: true,
        profiles: {
          [name]: {
            strategy: item.strategy,
            primary: item.primary,
            ...(item.escalation ? { escalation: item.escalation } : {}),
            ...(item.critic ? { critic: item.critic } : {}),
            limits: item.limits,
          },
        },
      },
    },
    compaction: {
      strategy: "auto",
      portable_mode: "incremental",
      timeout_ms: 60_000,
      max_summary_tokens: 4_096,
      on_native_error: "portable",
    },
  }
}

function candidateRefs(input: PlanRequest) {
  if (input.candidates.length) return input.candidates
  return (input.selectedRoles ?? []).map((role) => ({ role }))
}

export async function planConfiguration(input: RuntimeSnapshot, request: PlanRequest): Promise<PlanResponse> {
  const candidates = candidateIssues(input, candidateRefs(request))
  if (candidates.issues.length || !candidates.valid.length) {
    throw new AIConfigurationError("unavailable", "No feasible configured candidate models were supplied.", {
      details: { issues: candidates.issues },
    })
  }
  const profileName = request.profileName ?? `${request.taskKind}-${request.intent}`
  if (!/^[a-z][a-z0-9_-]{0,47}$/.test(profileName)) {
    throw new AIConfigurationError("invalid", "profileName must match [a-z][a-z0-9_-]{0,47}.")
  }
  const ordered = [...candidates.valid].sort((left, right) => {
    if (request.intent === "quality") return 0
    const leftNative = nativeCapability({ provider: left.model.provider, model: left.model.model }).supported
    const rightNative = nativeCapability({ provider: right.model.provider, model: right.model.model }).supported
    if (request.intent === "balanced" && leftNative !== rightNative) return leftNative ? -1 : 1
    const leftRate = rate(left.model)
    const rightRate = rate(right.model)
    if (leftRate === null && rightRate !== null) return 1
    if (leftRate !== null && rightRate === null) return -1
    if (leftRate !== null && rightRate !== null && leftRate !== rightRate) return leftRate - rightRate
    return 0
  })
  const alternatives = ordered.slice(0, 3).map((primary, index) =>
    alternative({ id: `single-${index + 1}`, strategy: "single", primary, intent: request.intent }),
  )
  if (ordered.length > 1) {
    alternatives.push(
      alternative({ id: "cascade", strategy: "cascade", primary: ordered[0]!, escalation: ordered[1], intent: request.intent }),
      alternative({ id: "critic", strategy: "critic", primary: ordered[0]!, critic: ordered[1], intent: request.intent }),
    )
  }
  const selected = alternatives[0]!
  let target: ConfigTarget | null = null
  let targetCandidates: ConfigTarget[] = []
  const scope = request.scope ?? "project"
  try {
    target = await resolveConfigTarget({ scope, root: input.root, target: request.target, globalDir: input.globalDir })
  } catch (error) {
    if (!(error instanceof AIConfigWriteError) || error.code !== "ambiguous") throw toAIConfigurationError(error)
    const discovered = await discoverConfigTargets({ scope, root: input.root, globalDir: input.globalDir })
    targetCandidates = discovered.filter((item) => item.exists)
  }
  const warnings = [
    ...new Set(alternatives.flatMap((item) => item.warnings)),
    "Quality is unknown because no comparable dated quality evidence was supplied; the order is a feasibility/cost tradeoff, not an intelligence ranking.",
    ...(target ? [] : ["Choose one observed configuration target before apply; no file was written."]),
  ]
  const sources = Object.values(input.providers)
    .flatMap((provider) => Object.values(provider.models).map((model) => origin(model.api.url)))
    .filter((value): value is string => Boolean(value))
    .filter((value, index, all) => all.indexOf(value) === index)
  return {
    version: 1,
    alternatives,
    selectedAlternative: selected.id,
    patch: profilePatch(profileName, selected),
    explanation: `For ${request.taskKind} with ${request.intent} intent, the preview uses only the supplied configured candidates and enables bounded orchestration plus fast auto/incremental compaction. Apply is explicit and does not start a workflow or change the active session model.`,
    warnings,
    evidence: { observedAt: observedAt(input), sources, quality: "unknown" },
    target,
    targetCandidates,
    expectedHash: target?.digest ?? null,
  }
}

function runtimeModel(value: unknown) {
  if (typeof value !== "string") return undefined
  const [providerID, ...rest] = value.split("/")
  const modelID = rest.join("/")
  if (!providerID || !modelID) return undefined
  return { providerID, modelID }
}

function configCompactionRole(config: Config.Info) {
  const agent = config.agent && record(config.agent) ? config.agent.compaction : undefined
  return record(agent) ? runtimeModel(agent.model) : undefined
}

function issue(code: string, path: string, message: string): ValidationIssue {
  return { code, path, message }
}

function schemaIssues(result: { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } }, prefix: string) {
  return result.error.issues.map((item) => issue("schema-invalid", `${prefix}.${item.path.map(String).join(".")}`, item.message))
}

function safeCompaction(value: unknown) {
  if (!record(value)) return value
  const keys = ["strategy", "portable_mode", "timeout_ms", "max_summary_tokens", "on_native_error"]
  return Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, value[key]]))
}

function nativeValidation(input: RuntimeSnapshot, compaction: Record<string, unknown> | undefined) {
  const strategy = compaction?.strategy
  if (strategy !== "native" && strategy !== "auto") return { issues: [], warnings: [], native: null }
  const active = runtimeModel(input.config.model) ?? runtimeModel(input.roles.default?.runtimeModel)
  if (!active) {
    return {
      issues: strategy === "native" ? [issue("native-binding-missing", "compaction.strategy", "Native compaction requires an active provider/model binding.")] : [],
      warnings: strategy === "auto" ? ["Auto native compaction will remain portable until an active model binding is available."] : [],
      native: null,
    }
  }
  const resolved = resolveModelRef(active, "compaction.activeModel", input.providers, input.roles)
  if (!resolved.model) {
    return {
      issues: strategy === "native" ? resolved.issues : [],
      warnings: strategy === "auto" ? ["The active model is not available in the current provider inventory; auto compaction remains portable."] : [],
      native: null,
    }
  }
  const capability = nativeCapability({
    provider: resolved.model.provider,
    model: resolved.model.model,
    auth: input.auth[resolved.model.providerID],
  })
  const role = configCompactionRole(input.config)
  const conflictingRole = role && (role.providerID !== active.providerID || role.modelID !== active.modelID)
  return {
    issues: [
      ...(strategy === "native" && !capability.supported
        ? [issue("native-unsupported", "compaction.strategy", capability.reason ?? "Native compaction is unsupported for the active route.")]
        : []),
      ...(strategy === "native" && conflictingRole
        ? [issue("native-role-conflict", "agent.compaction.model", "Native compaction is bound to the active inference model; the configured compaction role differs.")]
        : []),
    ],
    warnings: [
      ...(strategy === "auto" && !capability.supported
        ? [capability.reason ?? "Auto native compaction is unsupported for the active route; portable compaction will be used."]
        : []),
      ...(strategy === "auto" && conflictingRole
        ? ["A separate compaction role is a portable manual choice; auto native compaction remains bound to the active inference model."]
        : []),
    ],
    native: {
      activeModel: `${active.providerID}/${active.modelID}`,
      capability: {
        supported: capability.supported,
        ...(capability.protocol ? { protocol: capability.protocol } : {}),
        ...(capability.reason ? { reason: capability.reason } : {}),
        ...(capability.binding ? { binding: capability.binding } : {}),
      },
    },
  }
}

function profileValidation(input: RuntimeSnapshot, ai: AIConfig.Info | undefined) {
  if (!ai) return { issues: [], warnings: [], profiles: {} as Record<string, unknown> }
  const resolved = resolveCompoundProfiles(ai, input.providers, input.roles)
  const issues = [...resolved.issues]
  const warnings = [...resolved.warnings]
  for (const profile of Object.values(resolved.profiles)) {
    const legs = [profile.primary, profile.escalation, profile.critic].filter(
      (item): item is ResolvedModelRef => Boolean(item),
    )
    for (const leg of legs) {
      const provider = input.providers[leg.providerID]
      const auth = provider ? authStatus(provider, input.auth[leg.providerID]) : undefined
      if (!auth?.configured) {
        issues.push(issue("auth-unavailable", `profiles.${profile.name}`, `No configured credential is available for ${leg.providerID}/${leg.modelID}.`))
      }
      const unitRate = rate(leg)
      if (profile.limits.maxCostUsd !== undefined && unitRate === null) {
        if (profile.limits.unknownCost === "block") {
          issues.push(issue("unknown-cost", `profiles.${profile.name}.limits.maxCostUsd`, "The configured dollar limit cannot cover a route with unknown pricing."))
        } else {
          warnings.push(`Profile '${profile.name}' allows unknown dollar coverage and remains bounded by maxTotalTokens.`)
        }
      }
      if (profile.limits.maxCostUsd !== undefined && unitRate !== null) {
        const estimate = (unitRate * profile.limits.maxTotalTokens) / 1_000_000
        if (estimate > profile.limits.maxCostUsd) {
          issues.push(issue("cost-limit-too-low", `profiles.${profile.name}.limits.maxCostUsd`, `The conservative token-cap estimate (${estimate.toFixed(6)} USD) exceeds the configured limit.`))
        }
      }
    }
  }
  return {
    issues,
    warnings,
    profiles: Object.fromEntries(Object.entries(resolved.profiles).map(([name, profile]) => [name, profile.snapshot])),
  }
}

function changedKeys(value: unknown, prefix = ""): string[] {
  if (!record(value)) return prefix ? [prefix] : []
  return Object.entries(value).flatMap(([key, child]) => changedKeys(child, prefix ? `${prefix}.${key}` : key))
}

function toAIConfigurationError(error: unknown): AIConfigurationError {
  if (error instanceof AIConfigurationError) return error
  if (error instanceof AIConfigWriteError) {
    const code = error.code === "ambiguous" ? "unavailable" : error.code === "conflict" ? "conflict" : error.code
    return new AIConfigurationError(code, error.message, { details: error.details, cause: error })
  }
  return new AIConfigurationError("io", error instanceof Error ? error.message : String(error), { cause: error })
}

export async function validateConfiguration(input: RuntimeSnapshot, request: ValidateRequest): Promise<ValidateResponse> {
  try {
    validatePatch(request.patch)
  } catch (error) {
    throw toAIConfigurationError(error)
  }
  const base = input.config as unknown as Record<string, unknown>
  const effective = merge(base, request.patch) as Record<string, unknown>
  const issues: ValidationIssue[] = []
  const warnings: string[] = []
  let target: ConfigTarget | null = null
  if (request.target) {
    try {
      target = await resolveConfigTarget({
        scope: request.scope ?? "project",
        root: input.root,
        target: request.target,
        globalDir: input.globalDir,
      })
      const text = await readConfigTarget(target)
      if (text) parseConfigObject(text, target.path)
      if (request.expectedHash && request.expectedHash !== target.digest) {
        issues.push(issue("stale-target", "expectedHash", "The selected target does not match expectedHash."))
      }
    } catch (error) {
      const converted = toAIConfigurationError(error)
      issues.push(issue(converted.code, "target", converted.message))
    }
  }

  let ai: AIConfig.Info | undefined
  if (effective.ai !== undefined) {
    const parsed = AIConfig.Info.zod.safeParse(effective.ai)
    if (!parsed.success) issues.push(...schemaIssues(parsed, "ai"))
    else ai = parsed.data
  }
  const compactionValue = safeCompaction(effective.compaction)
  const compactionResult = AIConfig.Compaction.zod.safeParse(compactionValue ?? {})
  if (!compactionResult.success) issues.push(...schemaIssues(compactionResult, "compaction"))
  const profiles = profileValidation(input, ai)
  issues.push(...profiles.issues)
  warnings.push(...profiles.warnings)
  const native = nativeValidation(input, record(compactionValue) ? compactionValue : undefined)
  issues.push(...native.issues)
  warnings.push(...native.warnings)
  return {
    valid: issues.length === 0,
    issues,
    warnings: [...new Set(warnings)],
    profiles: profiles.profiles,
    native: native.native,
    effective: {
      compaction: compactionValue ?? {},
      ai: ai
        ? {
            version: ai.version,
            orchestration: { enabled: ai.orchestration.enabled, profiles: Object.keys(ai.orchestration.profiles).toSorted() },
          }
        : null,
    },
    target,
  }
}

type ConfigurationServiceInput = Omit<RuntimeSnapshot, "config" | "providers" | "auth" | "roles"> & {
  config: Config.Info
  providers: Record<string, Provider.Info>
  auth: Record<string, Auth.Info>
  roles: RoleInventory
}

export interface Interface {
  readonly inspect: () => Effect.Effect<InspectResponse, AIConfigurationError>
  readonly plan: (request: PlanRequest) => Effect.Effect<PlanResponse, AIConfigurationError>
  readonly validate: (request: ValidateRequest) => Effect.Effect<ValidateResponse, AIConfigurationError>
  readonly apply: (request: ApplyRequest, authorize?: ApplyAuthorization) => Effect.Effect<ApplyResponse, AIConfigurationError>
}

// An in-process tool may supply its existing causal permission context. HTTP
// input cannot supply this callback; those callers use the backend gate below.
export type ApplyAuthorization = (request: Omit<Permission.Request, "id" | "sessionID" | "tool">) => Effect.Effect<void>

export class Service extends Context.Service<Service, Interface>()("@opencode/AIConfiguration") {}

export const layer: Layer.Layer<Service, never, Config.Service | Provider.Service | Auth.Service | Permission.Service | Session.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const auth = yield* Auth.Service
    const permission = yield* Permission.Service
    const sessions = yield* Session.Service

    const snapshot: Effect.Effect<ConfigurationServiceInput, AIConfigurationError> = Effect.gen(function* () {
      const instance = yield* InstanceState.context
      const [current, providers, credentials, roles] = yield* Effect.all(
        [
          config.get(),
          provider.list(),
          auth.all().pipe(Effect.mapError(toAIConfigurationError)),
          Effect.tryPromise({
            try: () => resolveModelRoles(instance.worktree === "/" ? instance.directory : instance.worktree),
            catch: toAIConfigurationError,
          }),
        ],
        { concurrency: "unbounded" },
      )
      return {
        root: instance.worktree === "/" ? instance.directory : instance.worktree,
        config: current,
        providers,
        auth: credentials,
        roles: roles.roles,
        globalDir: Global.Path.config,
      } satisfies ConfigurationServiceInput
    })

    const run = <A>(body: (input: ConfigurationServiceInput) => Promise<A>): Effect.Effect<A, AIConfigurationError> =>
      Effect.flatMap(snapshot, (input) => Effect.tryPromise({ try: () => body(input), catch: toAIConfigurationError }))

    const inspect = () => run((input) => inspectConfiguration(input))
    const plan = (request: PlanRequest) => run((input) => planConfiguration(input, request))
    const validate = (request: ValidateRequest) => run((input) => validateConfiguration(input, request))
    const apply = (request: ApplyRequest, authorize?: ApplyAuthorization) =>
      Effect.gen(function* () {
        if (!request.causalSessionID.trim()) return yield* Effect.fail(new AIConfigurationError("invalid", "causalSessionID is required for apply."))
        const causalID = yield* Schema.decodeUnknownEffect(SessionID)(request.causalSessionID).pipe(
          Effect.mapError(() => new AIConfigurationError("permission", "Apply requires a valid causal session in this project.")),
        )
        const instance = yield* InstanceState.context
        const session = yield* sessions.get(causalID).pipe(
          Effect.mapError(() => new AIConfigurationError("permission", "The causal session does not exist in this project.")),
        )
        if (session.projectID !== instance.project.id || session.directory !== instance.directory) {
          return yield* Effect.fail(new AIConfigurationError("permission", "The causal session belongs to another project or directory."))
        }
        const input = yield* snapshot
        const selectedTarget = yield* Effect.tryPromise({
          try: () => resolveConfigTarget({ scope: request.scope, root: input.root, target: request.target, globalDir: input.globalDir }),
          catch: toAIConfigurationError,
        })
        if (selectedTarget.digest !== request.expectedHash) {
          return yield* Effect.fail(new AIConfigurationError("conflict", "Configuration target changed since the preview; nothing was written."))
        }
        const validation = yield* Effect.tryPromise({
          try: () => validateConfiguration(input, { ...request, target: selectedTarget.path }),
          catch: toAIConfigurationError,
        })
        if (!validation.valid) {
          return yield* Effect.fail(new AIConfigurationError("unavailable", "Configuration validation failed; nothing was written.", {
            details: { issues: validation.issues },
          }))
        }
        const permissionRequest = {
          permission: "edit",
          patterns: [request.scope === "global" ? selectedTarget.path : path.relative(input.root, selectedTarget.path)],
          always: [],
          metadata: {
            action: "ai_config.apply",
            target: selectedTarget.path,
            scope: request.scope,
            expectedHash: request.expectedHash,
            patchHash: createHash("sha256").update(JSON.stringify(request.patch)).digest("hex"),
            changedKeys: changedKeys(request.patch),
          },
        }
        const gates = request.scope === "global"
          ? [{ ...permissionRequest, permission: "external_directory", patterns: [selectedTarget.path] }, permissionRequest]
          : [permissionRequest]
        for (const gate of gates) {
          yield* (authorize ? authorize(gate) : permission.ask({
            ...gate,
            sessionID: causalID,
            // A JSON-supplied session ID is causality, not proof that this client
            // owns that session's per-turn grants or full-access selection.
            ruleset: Permission.merge(Permission.fromConfig(input.config.permission ?? {}), (session.permission ?? []).filter((rule) => rule.action === "deny")),
          })).pipe(Effect.catchCause(() => Effect.fail(new AIConfigurationError("permission", "Configuration apply was not approved; nothing was written."))))
        }
        const write = yield* Effect.tryPromise({
          try: () =>
            writeAIConfig({
              root: input.root,
              scope: request.scope,
              target: selectedTarget.path,
              expectedHash: request.expectedHash,
              patch: request.patch,
              globalDir: input.globalDir,
            }),
          catch: toAIConfigurationError,
        })
        yield* config.invalidate()
        return {
          changed: write.changed,
          changedKeys: changedKeys(request.patch),
          target: write.target,
          beforeHash: write.beforeHash,
          afterHash: write.afterHash,
          backupPath: write.backupPath ?? null,
          effective: validation.effective,
          warnings: validation.warnings,
        }
      })

    return Service.of({ inspect, plan, validate, apply })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Permission.defaultLayer),
  Layer.provide(Session.defaultLayer),
)

export { applyJsoncPatch }

export * as AIConfiguration from "./ai-configuration"
