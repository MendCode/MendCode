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
