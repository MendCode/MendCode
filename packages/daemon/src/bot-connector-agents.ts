import type { AcpAgentConfig } from "../../engine-acp/src/agents"

/**
 * The ACP agents bot connectors offer (experimental bots): a Hermes profile is `hermes-<profile>`, a chat with it a session on
 * the model `acp:hermes-<profile>`. A connector fills this when `bot.list` runs with the flag on, so it is empty (and the ACP
 * catalog unchanged) until then. Plain data on purpose: the daemon reads it at start, the connector module loads later.
 */
const offered = new Map<string, AcpAgentConfig>()

export const connectorAgents = (): Readonly<Record<string, AcpAgentConfig>> => Object.fromEntries(offered)

/** Replaces what one connector offers; `prefix` names its agents (`hermes-`), so another connector's stay. */
export function offerConnectorAgents(prefix: string, agents: Readonly<Record<string, AcpAgentConfig>>): void {
  for (const name of [...offered.keys()]) if (name.startsWith(prefix)) offered.delete(name)
  for (const [name, config] of Object.entries(agents)) offered.set(name, config)
}

/** The Hermes connector as `bot.list` sees it: its module is imported by the first `list()`, which only runs with the flag on. */
export function lazyHermesConnector(options: { dir: string }): import("./bot-service").BotConnector {
  let loaded: Promise<import("./bot-service").BotConnector> | undefined
  return { id: "hermes", list: async () => (await (loaded ??= import("./bot-hermes").then((module) => module.hermesConnector(options)))).list() }
}
