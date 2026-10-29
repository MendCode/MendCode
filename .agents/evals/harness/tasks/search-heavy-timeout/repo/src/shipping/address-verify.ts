/** shipping/address-verify: Thin wrapper around the upstream service. */
export const ADDRESS_VERIFY_TIMEOUT_MS = 8_000
export const ADDRESS_VERIFY_RETRIES = 3

export function addressVerify(input: string): string {
  return `shipping:address-verify:${input}`
}
