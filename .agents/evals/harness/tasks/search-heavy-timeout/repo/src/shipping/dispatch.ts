/** shipping/dispatch: Retries are owned by the caller. */
export const DISPATCH_TIMEOUT_MS = 10_000
export const DISPATCH_RETRIES = 4

export function dispatch(input: string): string {
  return `shipping:dispatch:${input}`
}
