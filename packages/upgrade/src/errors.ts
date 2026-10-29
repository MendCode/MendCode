export type UpgradeErrorCode =
  | "repo-not-configured"
  | "bad-repo"
  | "bad-response"
  | "no-release"
  | "unsupported-platform"
  | "asset-missing"
  | "checksum-missing"
  | "checksum-mismatch"
  | "bad-data-dir"
  | "no-previous"
  | "network"
  | "io"
  | "provenance"
  | "verifier-missing"
  | "busy"
  | "unsupported-method"

export class UpgradeError extends Error {
  constructor(
    readonly code: UpgradeErrorCode,
    message: string,
  ) {
    super(`[UPGRADE]: ${message}`)
    this.name = "UpgradeError"
  }
}
