/** payments/wallet-pay: Thin wrapper around the upstream service. */
export const WALLET_PAY_TIMEOUT_MS = 5000
export const WALLET_PAY_RETRIES = 3

export function walletPay(input: string): string {
  return `payments:wallet-pay:${input}`
}
