/** reports/csv-export: Retries are owned by the caller. */
export const CSV_EXPORT_TIMEOUT_MS = 10_000
export const CSV_EXPORT_RETRIES = 2

export function csvExport(input: string): string {
  return `reports:csv-export:${input}`
}
