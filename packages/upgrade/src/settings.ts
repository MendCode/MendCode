/**
 * Where releases come from. This module is the single place for the upgrade settings.
 *
 * The release repository is `MendCode/MendCode`. `MENDCODE_UPGRADE_REPO=owner/name` overrides it (a mirror, a fork, a test
 * repository). While the repository is private, anonymous requests are refused by GitHub: the updater reads `GH_TOKEN`,
 * `GITHUB_TOKEN` or `gh auth token` (see docs/upgrade.md) and sends it only to api.github.com.
 */
export const UPGRADE_REPO_PLACEHOLDER = "OWNER/mendcode"
export const UPGRADE_REPO = "MendCode/MendCode"

export const UPGRADE_REPO_ENV = "MENDCODE_UPGRADE_REPO"
export const GITHUB_API = "https://api.github.com"
/** Releases asked of the API in one page; older releases are never considered. */
export const RELEASES_PER_PAGE = 100
export const CHECKSUMS_ASSET = "SHA256SUMS"
export const RELEASE_INDEX_ASSET = "release-index.json"
/** Present on releases whose repository could produce GitHub build provenance (public repositories). */
export const PROVENANCE_ASSET = "provenance.sigstore.json"
/** Every signed payload `X` has its keyless cosign bundle at `X.sigstore.json`. */
export const SIGSTORE_SUFFIX = ".sigstore.json"
export const OIDC_ISSUER = "https://token.actions.githubusercontent.com"
export const BINARY_PREFIX = "mendcode"
/** Installed names inside `<dataDir>/bin`; an on-disk name that stays what it was (see docs/design/rename-inventory.md). */
export const BIN_NAME = "mendcode-next"
export const STATE_FILE = "upgrade.json"
export const CHANNELS = ["stable", "beta", "dev", "nightly"] as const
export const DEFAULT_CHANNEL = "stable"
export const FETCH_TIMEOUT_MS = 15_000
export const DOWNLOAD_TIMEOUT_MS = 300_000
/** A cosign verification reads the Sigstore trust root over the network before it checks the bundle. */
export const VERIFY_TIMEOUT_MS = 60_000
/** A release binary bigger than this is refused while downloading. */
export const MAX_DOWNLOAD_BYTES = 400 * 1024 * 1024
export const MAX_JSON_BYTES = 8 * 1024 * 1024
export const MAX_BUNDLE_BYTES = 1024 * 1024
export const EXECUTABLE_MODE = 0o755

/** Variables holding a GitHub token, in the order they are read; `gh auth token` is the last resort. */
export const TOKEN_ENVS = ["GH_TOKEN", "GITHUB_TOKEN"] as const
export const PRIVATE_REPO_HINT = "if the release repository is private, sign in with `gh auth login` or set GH_TOKEN to a token that can read its contents"

/** Exit codes, the same numbers as the rest of the CLI (`EXIT` in automation.ts). */
export const UPGRADE_EXIT = { ok: 0, failed: 1, usage: 64 } as const
/** Every JSON line carries this so scripts can pin the contract (same as automation.ts). It keeps the name it shipped under in development. */
export const UPGRADE_SCHEMA = "mendcode-next.cli.v1"