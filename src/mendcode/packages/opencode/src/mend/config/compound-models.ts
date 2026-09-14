import { Hash } from "@mendcode/core/util/hash"

import * as AIConfig from "@/config/ai"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import type { ModelRole } from "./models"

const PROFILE_NAME = /^[a-z][a-z0-9_-]{0,47}$/
const MAX_PROFILES = 16

export type RoleInventory = Record<string, ModelRole & { runtimeModel?: string | null; configured?: boolean }>
export type ProviderInventory = Record<string, Provider.Info> | readonly Provider.Info[]

export type ValidationIssue = {
  code: string
  path: string
  message: string
}

export type Pricing = {
  inputUsdPer1M: number | null
  outputUsdPer1M: number | null
  cacheReadUsdPer1M: number | null
  cacheWriteUsdPer1M: number | null
  source: string | null
}

export type ResolvedModelRef = {
  ref: AIConfig.ModelRef
  source: "role" | "direct"
  role?: string
  providerID: ProviderID
  modelID: ModelID
  variant?: string
  provider: Provider.Info
  model: Provider.Model
  authMode: string | null
  pricing: Pricing
}

export type ResolvedCompoundProfile = {
  name: string
  strategy: AIConfig.Strategy
  primary: ResolvedModelRef
  escalation?: ResolvedModelRef
  critic?: ResolvedModelRef
  limits: AIConfig.Limits
  configHash: string
  snapshot: {
    name: string
    strategy: AIConfig.Strategy
    primary: SerializableModelRef
    escalation?: SerializableModelRef
    critic?: SerializableModelRef
    limits: AIConfig.Limits
  }
}

export type SerializableModelRef = {
  source: "role" | "direct"
  role?: string
  providerID: string
  modelID: string
  variant?: string
  authMode: string | null
  pricing: Pricing
}

export type CompoundResolution = {
  profile?: ResolvedCompoundProfile
  issues: ValidationIssue[]
  warnings: string[]
}

export type CompoundProfilesResolution = {
  profiles: Record<string, ResolvedCompoundProfile>
  issues: ValidationIssue[]
  warnings: string[]
}

function asProviders(inventory: ProviderInventory) {
  if (Array.isArray(inventory)) return Object.fromEntries(inventory.map((item) => [item.id, item]))
  return inventory
}

function issue(code: string, path: string, message: string): ValidationIssue {
  return { code, path, message }
}

function sameModel(a: ResolvedModelRef, b: ResolvedModelRef) {
  return a.providerID === b.providerID && a.modelID === b.modelID && a.variant === b.variant
}

function modelPricing(provider: Provider.Info, model: Provider.Model): Pricing {
  const values = [model.cost.input, model.cost.output, model.cost.cache.read, model.cost.cache.write]
  // Provider.Model currently uses zero for both an actual free route and a
  // missing catalog price. Treat an all-zero entry as unknown so an advisor
  // cannot turn missing evidence into a claim of free inference.
  const known = values.some((value) => Number.isFinite(value) && value > 0)
  return {
    inputUsdPer1M: known && Number.isFinite(model.cost.input) ? model.cost.input : null,
    outputUsdPer1M: known && Number.isFinite(model.cost.output) ? model.cost.output : null,
    cacheReadUsdPer1M: known && Number.isFinite(model.cost.cache.read) ? model.cost.cache.read : null,
    cacheWriteUsdPer1M: known && Number.isFinite(model.cost.cache.write) ? model.cost.cache.write : null,
    source: known ? model.api.url || provider.id : null,
  }
}

function modelRefKind(ref: AIConfig.ModelRef): "role" | "direct" | undefined {
  if (!ref || typeof ref !== "object") return undefined
  const value = ref as Record<string, unknown>
  const hasRole = typeof value.role === "string"
  const hasDirect = typeof value.providerID === "string" || typeof value.modelID === "string"
  if (hasRole === hasDirect) return undefined
  return hasRole ? "role" : "direct"
}

export function resolveModelRef(
  ref: AIConfig.ModelRef | undefined,
  path: string,
  providers: Record<string, Provider.Info>,
  roles: RoleInventory,
): { model?: ResolvedModelRef; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = []
  if (!ref) {
    issues.push(issue("missing-model-ref", path, "A model reference is required."))
    return { issues }
  }

  const kind = modelRefKind(ref)
  if (!kind) {
    issues.push(
      issue(
        "invalid-model-ref",
        path,
        "ModelRef must contain exactly {role} or {providerID,modelID[,variant]}; fields cannot be mixed.",
      ),
    )
    return { issues }
  }

  let providerID: string | undefined
  let modelID: string | undefined
  let variant: string | undefined
  let role: string | undefined
  if (kind === "role") {
    role = (ref as Extract<AIConfig.ModelRef, { role: string }>).role.trim()
    if (!role) {
      issues.push(issue("empty-role", `${path}.role`, "Role name cannot be empty."))
      return { issues }
    }
    const selected = roles[role]
    if (!selected?.providerID || !selected.modelID) {
      issues.push(issue("unconfigured-role", `${path}.role`, `Role '${role}' is not configured with a provider/model.`))
      return { issues }
    }
    providerID = selected.providerID
    modelID = selected.modelID
    variant = selected.variant ?? undefined
  } else {
    const direct = ref as Extract<AIConfig.ModelRef, { providerID: string; modelID: string }>
    providerID = direct.providerID.trim()
    modelID = direct.modelID.trim()
    variant = direct.variant?.trim() || undefined
    if (!providerID) issues.push(issue("empty-provider", `${path}.providerID`, "providerID cannot be empty."))
    if (!modelID) issues.push(issue("empty-model", `${path}.modelID`, "modelID cannot be empty."))
  }

  if (!providerID || !modelID) return { issues }
  const provider = providers[providerID]
  if (!provider) {
    issues.push(issue("unknown-provider", `${path}.providerID`, `Provider '${providerID}' is not available.`))
    return { issues }
  }
  const model = provider.models[modelID]
  if (!model) {
    issues.push(issue("unknown-model", `${path}.modelID`, `Model '${providerID}/${modelID}' is not available.`))
    return { issues }
  }
  if (variant && !model.variants?.[variant]) {
    issues.push(
      issue(
        "unknown-variant",
        `${path}.variant`,
        `Variant '${variant}' is not advertised by model '${providerID}/${modelID}'.`,
      ),
    )
    return { issues }
  }

  const roleInfo = role ? roles[role] : undefined
  return {
    model: {
      ref,
      source: kind,
      ...(role ? { role } : {}),
      providerID: ProviderID.make(providerID),
      modelID: ModelID.make(modelID),
      ...(variant ? { variant } : {}),
      provider,
      model,
      authMode: roleInfo?.authMode ?? null,
      pricing: modelPricing(provider, model),
    },
    issues,
  }
}

function serializable(ref: ResolvedModelRef): SerializableModelRef {
  return {
    source: ref.source,
    ...(ref.role ? { role: ref.role } : {}),
    providerID: ref.providerID,
    modelID: ref.modelID,
    ...(ref.variant ? { variant: ref.variant } : {}),
    authMode: ref.authMode,
    pricing: ref.pricing,
  }
}

function snapshotFor(input: {
  name: string
  profile: AIConfig.CompoundProfile
  primary: ResolvedModelRef
  escalation?: ResolvedModelRef
  critic?: ResolvedModelRef
}) {
  return {
    name: input.name,
    strategy: input.profile.strategy,
    primary: serializable(input.primary),
    ...(input.escalation ? { escalation: serializable(input.escalation) } : {}),
    ...(input.critic ? { critic: serializable(input.critic) } : {}),
    limits: input.profile.limits,
  }
}

export function resolveCompoundProfile(
  name: string,
  profile: AIConfig.CompoundProfile,
  inventory: ProviderInventory,
  roles: RoleInventory = {},
): CompoundResolution {
  const issues: ValidationIssue[] = []
  const warnings: string[] = []
  if (!PROFILE_NAME.test(name)) {
    issues.push(issue("invalid-profile-name", `profiles.${name}`, "Profile name must match [a-z][a-z0-9_-]{0,47}."))
  }

  const providers = asProviders(inventory)
  const primary = resolveModelRef(profile.primary, `profiles.${name}.primary`, providers, roles)
  issues.push(...primary.issues)

  const hasEscalation = profile.escalation !== undefined
  const hasCritic = profile.critic !== undefined
  if (profile.strategy === "single") {
    if (hasEscalation) issues.push(issue("irrelevant-escalation", `profiles.${name}.escalation`, "single profiles cannot define escalation."))
    if (hasCritic) issues.push(issue("irrelevant-critic", `profiles.${name}.critic`, "single profiles cannot define critic."))
  }
  if (profile.strategy === "cascade") {
    if (!hasEscalation) issues.push(issue("missing-escalation", `profiles.${name}.escalation`, "cascade profiles require escalation."))
    if (hasCritic) issues.push(issue("irrelevant-critic", `profiles.${name}.critic`, "cascade profiles cannot define critic."))
  }
  if (profile.strategy === "critic") {
    if (!hasCritic) issues.push(issue("missing-critic", `profiles.${name}.critic`, "critic profiles require critic."))
    if (hasEscalation) issues.push(issue("irrelevant-escalation", `profiles.${name}.escalation`, "critic profiles use critic, not escalation."))
  }

  const minimumRequests = profile.strategy === "single" ? 1 : profile.strategy === "cascade" ? 2 : 3
  if (profile.limits.maxModelRequests < minimumRequests) {
    issues.push(
      issue(
        "insufficient-request-budget",
        `profiles.${name}.limits.maxModelRequests`,
        `${profile.strategy} profiles require at least ${minimumRequests} model requests, including bounded fallback/revision legs.`,
      ),
    )
  }

  const escalation = hasEscalation
    ? resolveModelRef(profile.escalation, `profiles.${name}.escalation`, providers, roles)
    : { model: undefined, issues: [] as ValidationIssue[] }
  const critic = hasCritic
    ? resolveModelRef(profile.critic, `profiles.${name}.critic`, providers, roles)
    : { model: undefined, issues: [] as ValidationIssue[] }
  issues.push(...escalation.issues, ...critic.issues)

  if (primary.model && escalation.model && sameModel(primary.model, escalation.model)) {
    warnings.push(`Profile '${name}' uses the same primary and escalation model; cascade quality is unlikely to change.`)
  }
  if (primary.model && critic.model && sameModel(primary.model, critic.model)) {
    issues.push(issue("critic-must-differ", `profiles.${name}.critic`, "critic must differ from primary by provider/model/variant."))
  }

  if (issues.length || !primary.model) return { issues, warnings }
  const snapshot = snapshotFor({
    name,
    profile,
    primary: primary.model,
    ...(escalation.model ? { escalation: escalation.model } : {}),
    ...(critic.model ? { critic: critic.model } : {}),
  })
  return {
    profile: {
      name,
      strategy: profile.strategy,
      primary: primary.model,
      ...(escalation.model ? { escalation: escalation.model } : {}),
      ...(critic.model ? { critic: critic.model } : {}),
      limits: profile.limits,
      configHash: Hash.fast(JSON.stringify(snapshot)),
      snapshot,
    },
    issues,
    warnings,
  }
}

export function resolveCompoundProfiles(
  input: AIConfig.Info | undefined,
  inventory: ProviderInventory,
  roles: RoleInventory = {},
): CompoundProfilesResolution {
  const profiles: Record<string, ResolvedCompoundProfile> = {}
  const issues: ValidationIssue[] = []
  const warnings: string[] = []
  if (!input) return { profiles, issues, warnings }
  const configured = input.orchestration?.profiles ?? {}
  const names = Object.keys(configured)
  if (names.length > MAX_PROFILES) {
    issues.push(issue("too-many-profiles", "ai.orchestration.profiles", `At most ${MAX_PROFILES} profiles may be configured.`))
  }
  for (const name of names) {
    const result = resolveCompoundProfile(name, configured[name]!, inventory, roles)
    issues.push(...result.issues)
    warnings.push(...result.warnings)
    if (result.profile) profiles[name] = result.profile
  }
  return { profiles, issues, warnings }
}
