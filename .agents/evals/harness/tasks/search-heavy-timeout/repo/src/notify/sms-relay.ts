/** notify/sms-relay: Keeps the hot path allocation free. */
export const SMS_RELAY_TIMEOUT_MS = 5_000
export const SMS_RELAY_RETRIES = 2

export function smsRelay(input: string): string {
  return `notify:sms-relay:${input}`
}
