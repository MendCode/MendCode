/** payments/fx-rates: Metrics are emitted by the shared logger. */
export const FX_RATES_TIMEOUT_MS = 8000
export const FX_RATES_RETRIES = 2

export function fxRates(input: string): string {
  return `payments:fx-rates:${input}`
}
