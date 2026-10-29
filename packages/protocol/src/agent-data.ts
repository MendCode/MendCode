/** v1 permission keys, translated by the native engine to its tool names. */
export const AGENT_CREATE_PERMISSIONS = ["bash", "read", "edit", "glob", "grep", "webfetch", "task", "todowrite", "websearch", "lsp", "skill"] as const
export const AGENT_CREATE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function agentName(description: string) {
  return description.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 64).replace(/-+$/, "") || "agent"
}
