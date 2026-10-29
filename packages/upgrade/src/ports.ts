/** Filesystem operations the upgrade needs. Every path comes from `<dataDir>/bin` or `<dataDir>/upgrade.json`. */
export type UpgradeFs = {
  /** Creates the directory and its parents. */
  mkdir(dir: string): Promise<void>
  writeFile(file: string, bytes: Uint8Array): Promise<void>
  chmod(file: string, mode: number): Promise<void>
  /** Atomic replace: the target either keeps its old content or has the new one. */
  rename(from: string, to: string): Promise<void>
  copyFile(from: string, to: string): Promise<void>
  exists(file: string): Promise<boolean>
  /** Removes the file; a missing file is not an error. */
  remove(file: string): Promise<void>
  /** The file's text, or undefined when it does not exist. */
  readText(file: string): Promise<string | undefined>
  readBytes(file: string): Promise<Uint8Array>
  lock(dataDir: string): Promise<() => Promise<void>>
}

/** Everything with side effects, injected so the whole flow runs offline in tests. */
export type UpgradePorts = {
  fetchJson(url: string): Promise<unknown>
  /** `apiUrl` is where an authenticated client reads the same asset; a client without a token uses `url`. */
  download(url: string, maxBytes?: number, apiUrl?: string): Promise<Uint8Array>
  fs: UpgradeFs
  now(): number
  /**
   * Must verify the release before activation: GitHub provenance of `bytes` and, on Darwin, the executable's signature; or,
   * when `bundle` (a keyless cosign bundle for `bytes`) is given, that signature bound to the release workflow and tag.
   * Throws `UpgradeError("verifier-missing")` when the tool that verifies is not installed.
   */
  verifyProvenance?(input: { bytes: Uint8Array; bundle?: Uint8Array; repo: string; tag: string; platform: import("./releases").Platform; metadata?: boolean }): Promise<void>
}
