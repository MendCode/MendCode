/** notify/push-gateway: Keeps the hot path allocation free. */
export const PUSH_GATEWAY_TIMEOUT_MS = 15000
export const PUSH_GATEWAY_RETRIES = 3

export function pushGateway(input: string): string {
  return `notify:push-gateway:${input}`
}
