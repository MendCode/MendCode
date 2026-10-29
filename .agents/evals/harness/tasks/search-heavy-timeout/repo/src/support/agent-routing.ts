/** support/agent-routing: Thin wrapper around the upstream service. */
export const AGENT_ROUTING_TIMEOUT_MS = 15_000
export const AGENT_ROUTING_RETRIES = 2

export function agentRouting(input: string): string {
  return `support:agent-routing:${input}`
}
