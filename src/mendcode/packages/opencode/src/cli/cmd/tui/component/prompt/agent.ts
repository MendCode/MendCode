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

type PromptModelRef = {
  providerID?: string
  modelID?: string
  id?: string
  variant?: string | null
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
  const localOverrideIsNewer =
    input.localOverride &&
    (!input.hasSession || !input.userModelCreatedAt || (input.localOverrideUpdatedAt ?? 0) > input.userModelCreatedAt)
  if (localOverrideIsNewer) return input.localOverride
  if (!input.hasSession) return input.localModel
  if (input.userModel?.providerID && input.userModel.modelID) {
    return { providerID: input.userModel.providerID, modelID: input.userModel.modelID }
  }
  const sessionModelID = input.sessionModel?.modelID ?? input.sessionModel?.id
  if (input.sessionModel?.providerID && sessionModelID) {
    return { providerID: input.sessionModel.providerID, modelID: sessionModelID }
  }
  if (input.sessionUsesSubagent) {
    const agentModelID = input.agentModel?.modelID ?? input.agentModel?.id
    if (input.agentModel?.providerID && agentModelID) {
      return { providerID: input.agentModel.providerID, modelID: agentModelID }
    }
  }
  return input.localModel
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
  const localOverrideIsNewer =
    input.hasLocalVariantOverride &&
    (!input.hasSession || !input.userModelCreatedAt || (input.localVariantOverrideUpdatedAt ?? 0) > input.userModelCreatedAt)
  if (localOverrideIsNewer) return input.localVariant
  if (!input.hasSession) return input.localVariant
  return input.userModel?.variant ?? input.sessionModel?.variant ?? input.localVariant
}
