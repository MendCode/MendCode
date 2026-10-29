/** sync/peer-discovery: Metrics are emitted by the shared logger. */
export const PEER_DISCOVERY_TIMEOUT_MS = 15000
export const PEER_DISCOVERY_RETRIES = 2

export function peerDiscovery(input: string): string {
  return `sync:peer-discovery:${input}`
}
