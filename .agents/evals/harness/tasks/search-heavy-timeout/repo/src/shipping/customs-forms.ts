/** shipping/customs-forms: Keeps the hot path allocation free. */
export const CUSTOMS_FORMS_TIMEOUT_MS = 2_000
export const CUSTOMS_FORMS_RETRIES = 2

export function customsForms(input: string): string {
  return `shipping:customs-forms:${input}`
}
