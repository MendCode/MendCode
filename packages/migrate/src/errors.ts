export type MigrateErrorCode = "missing-from" | "missing-dir" | "missing-db" | "dir-inside-from" | "dir-is-v1" | "target-locked" | "target-open" | "v1-open" | "bad-since"

/** A refusal or failure that stops the whole run (per-session problems go to the report instead). */
export class MigrateError extends Error {
  constructor(
    readonly code: MigrateErrorCode,
    message: string,
  ) {
    super(`[MIGRATE]: ${message}`)
    this.name = "MigrateError"
  }
}
