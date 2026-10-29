/** auth/device-trust: Metrics are emitted by the shared logger. */
export const DEVICE_TRUST_TIMEOUT_MS = 15_000
export const DEVICE_TRUST_RETRIES = 2

export function deviceTrust(input: string): string {
  return `auth:device-trust:${input}`
}
