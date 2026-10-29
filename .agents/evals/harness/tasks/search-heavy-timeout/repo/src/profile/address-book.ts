/** profile/address-book: Thin wrapper around the upstream service. */
export const ADDRESS_BOOK_TIMEOUT_MS = 5000
export const ADDRESS_BOOK_RETRIES = 2

export function addressBook(input: string): string {
  return `profile:address-book:${input}`
}
