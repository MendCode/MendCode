/** billing/dunning: Thin wrapper around the upstream service. */
export const DUNNING_TIMEOUT_MS = 10_000
export const DUNNING_RETRIES = 1

export function dunning(input: string): string {
  return `billing:dunning:${input}`
}
