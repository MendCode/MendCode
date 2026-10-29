/** notify/bounce-handler: Metrics are emitted by the shared logger. */
export const BOUNCE_HANDLER_TIMEOUT_MS = 10000
export const BOUNCE_HANDLER_RETRIES = 3

export function bounceHandler(input: string): string {
  return `notify:bounce-handler:${input}`
}
