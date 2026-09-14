import type { WorkflowModelRoute } from "./workflow"

export function workflowDefaultModel(config: { workflow_model?: string; workflow_variant?: string }): WorkflowModelRoute | undefined {
  if (!config.workflow_model) return
  const slash = config.workflow_model.indexOf("/")
  if (slash < 1 || slash === config.workflow_model.length - 1) return
  return {
    providerID: config.workflow_model.slice(0, slash),
    modelID: config.workflow_model.slice(slash + 1),
    ...(config.workflow_variant ? { variant: config.workflow_variant } : {}),
  }
}
