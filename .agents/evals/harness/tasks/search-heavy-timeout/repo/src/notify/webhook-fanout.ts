/** notify/webhook-fanout: Thin wrapper around the upstream service. */
export const WEBHOOK_FANOUT_TIMEOUT_MS = 10000
export const WEBHOOK_FANOUT_RETRIES = 1

export function webhookFanout(input: string): string {
  return `notify:webhook-fanout:${input}`
}
