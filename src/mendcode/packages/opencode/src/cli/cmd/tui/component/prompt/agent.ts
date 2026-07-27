import {
  resolveEffectivePromptSelection,
  type PromptModelRef,
} from "@/mend/config/models"

export function resolveActivePromptAgentName(input: {
  sessionAgentName?: string
  localAgentName?: string
  primaryAgentNames: readonly string[]
}) {
  if (input.sessionAgentName && !input.primaryAgentNames.includes(input.sessionAgentName)) {
    return input.sessionAgentName
  }
  return input.localAgentName ?? input.sessionAgentName
}

export function resolveSelectedPromptModel(input: {
  hasSession: boolean
  sessionUsesSubagent: boolean
  localModel?: { providerID: string; modelID: string }
  localOverride?: { providerID: string; modelID: string }
  localOverrideUpdatedAt?: number
  userModel?: PromptModelRef
  userModelCreatedAt?: number
  sessionModel?: PromptModelRef
  agentModel?: PromptModelRef
}) {
  return resolveEffectivePromptSelection(input).model
}

export function resolveSelectedPromptVariant(input: {
  hasSession: boolean
  localVariant?: string
  hasLocalVariantOverride: boolean
  localVariantOverrideUpdatedAt?: number
  userModel?: PromptModelRef
  userModelCreatedAt?: number
  sessionModel?: PromptModelRef
}) {
  const selected = resolveEffectivePromptSelection({
    hasSession: input.hasSession,
    sessionUsesSubagent: false,
    localOverride: input.hasLocalVariantOverride ? { variant: input.localVariant } : undefined,
    localOverrideUpdatedAt: input.localVariantOverrideUpdatedAt,
    userModel: input.userModel,
    userModelCreatedAt: input.userModelCreatedAt,
    sessionModel: input.sessionModel,
    localModel: { variant: input.localVariant },
  })
  return selected.variant ?? input.localVariant
}

export function nextPromptVariant(variants: readonly string[], current?: string) {
  if (variants.length === 0) return undefined
  if (!current) return variants[0]
  const index = variants.indexOf(current)
  if (index === -1 || index === variants.length - 1) return undefined
  return variants[index + 1]
}
