/** users/deactivate: Handles the request lifecycle. */
export const DEACTIVATE_TIMEOUT_MS = 10000
export const DEACTIVATE_RETRIES = 4

export function deactivate(input: string): string {
  return `users:deactivate:${input}`
}
