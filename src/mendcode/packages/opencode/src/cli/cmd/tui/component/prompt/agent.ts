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
  localOverrideMessageID?: string
  userModel?: PromptModelRef
  userModelCreatedAt?: number
  userMessageID?: string
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
  localVariantOverrideMessageID?: string
  userModel?: PromptModelRef
  userModelCreatedAt?: number
  userMessageID?: string
  sessionModel?: PromptModelRef
}) {
  const localOverrideMatchesUserMessage =
    input.localVariantOverrideMessageID !== undefined &&
    input.userMessageID !== undefined &&
    input.localVariantOverrideMessageID === input.userMessageID
  const localOverrideIsNewer =
    input.hasLocalVariantOverride &&
    (localOverrideMatchesUserMessage ||
      !input.hasSession ||
      !input.userModelCreatedAt ||
      (input.localVariantOverrideUpdatedAt ?? 0) > input.userModelCreatedAt)
  if (localOverrideIsNewer) return input.localVariant
  if (!input.hasSession) return input.localVariant
  return input.userModel?.variant ?? input.sessionModel?.variant ?? input.localVariant
}

export function nextPromptVariant(variants: readonly string[], current?: string) {
  if (variants.length === 0) return undefined
  if (!current) return variants[0]
  const index = variants.indexOf(current)
  if (index === -1 || index === variants.length - 1) return undefined
  return variants[index + 1]
}
