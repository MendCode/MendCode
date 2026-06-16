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
  sessionUsesSubagent: boolean
  localModel?: { providerID: string; modelID: string }
  localOverride?: { providerID: string; modelID: string }
  userModel?: PromptModelRef
  sessionModel?: PromptModelRef
  agentModel?: PromptModelRef
}) {
  if (!input.sessionUsesSubagent) return input.localModel
  if (input.localOverride) return input.localOverride
  if (input.userModel?.providerID && input.userModel.modelID) {
    return { providerID: input.userModel.providerID, modelID: input.userModel.modelID }
  }
  const sessionModelID = input.sessionModel?.modelID ?? input.sessionModel?.id
  if (input.sessionModel?.providerID && sessionModelID) {
    return { providerID: input.sessionModel.providerID, modelID: sessionModelID }
  }
  const agentModelID = input.agentModel?.modelID ?? input.agentModel?.id
  if (input.agentModel?.providerID && agentModelID) {
    return { providerID: input.agentModel.providerID, modelID: agentModelID }
  }
  return input.localModel
}

export function resolveSelectedPromptVariant(input: {
  sessionUsesSubagent: boolean
  localVariant?: string
  hasLocalOverride: boolean
  userModel?: PromptModelRef
  sessionModel?: PromptModelRef
}) {
  if (!input.sessionUsesSubagent || input.hasLocalOverride) return input.localVariant
  return input.userModel?.variant ?? input.sessionModel?.variant ?? input.localVariant
}
