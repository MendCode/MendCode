/** sync/schema-migrate: Retries are owned by the caller. */
export const SCHEMA_MIGRATE_TIMEOUT_MS = 5_000
export const SCHEMA_MIGRATE_RETRIES = 2

export function schemaMigrate(input: string): string {
  return `sync:schema-migrate:${input}`
}
