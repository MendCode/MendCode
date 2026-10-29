import path from "node:path"

/** Every tunable of the legacy MendCode import lives here. */

/** The legacy MendCode database inside its data directory. */
export const V1_DB_FILE = "mendcode-local.db"
export const V1_MEMORY_DIR = "memory"
export const V1_MEMORY_FILES = { saved: "entries.jsonl", archived: "archived.jsonl" } as const

/** Credential files of v1: their names are reported, their content is never opened. */
export const V1_CREDENTIAL_FILES = ["auth.json", "mcp-auth.json"] as const

/** v1 directories that are measured and reported but never imported. `*.db` files other than the main one are added at run time. */
export const NOT_MIGRATED_DIRS = [
  { name: "session-transcripts", reason: "derived from the database; the sessions are imported from it" },
  { name: "storage", reason: "pre-database JSON already folded into the database" },
  { name: "snapshot", reason: "v1 file-revert snapshots; v2 keeps no equivalent" },
  { name: "worktree", reason: "v1 git worktrees; they belong to v1 projects on disk" },
  { name: "archive", reason: "v1 archive; not part of the live history" },
  { name: "log", reason: "v1 logs" },
  { name: path.join("memory", "dream"), reason: "v1 dream working files; v2 runs its own dream" },
  { name: "generated_images", reason: "v1 generated images" },
  { name: "bin", reason: "v1 binaries" },
  { name: "tui", reason: "v1 terminal UI state" },
] as const
export const OTHER_DB_REASON = "another v1 database; only mendcode-local.db is imported"
export const CREDENTIALS_REASON = "not migrated (credentials)"

/** The v2 engine that owns a migrated session's model history: the daemon's `store.engineMessages.*(…, "native")`. */
export const ENGINE_KEY = "native"
/** `engineBindings` engine name that marks a session as completely imported; its external id is the v1 session id. */
export const MARKER_ENGINE = "migrate-v1"
/** Messages of model history written per session. */
export const MAX_CONTEXT_MESSAGES = 200
/** Characters of one tool result kept in the model history. */
export const MAX_CONTEXT_TOOL_CHARS = 30_000
/** The native engine's first message after a compaction (engine-native `SUMMARY_PREFIX`; a test keeps the two equal). */
export const SUMMARY_PREFIX = "Summary of the conversation so far (earlier messages were compacted):"
export const OMITTED_NOTE = "[The earlier part of this conversation was left out when it was imported from MendCode 1.]"

/** Inline text must also fit the store's event size limit once JSON-escaped; bigger text goes to a blob. */
export const INLINE_JSON_BUDGET = 60 * 1024
export const PREVIEW_CHARS = 4_000
export const MAX_ATTACHMENTS = 32
export const MAX_TITLE = 200
export const MAX_META_VALUE = 200
export const MAX_MEMORY_TEXT = 2_000
export const MAX_MEMORY_CATEGORY = 64

export const MAX_REPORT_ERRORS = 200
export const PROGRESS_EVERY = 50
/** Entries one directory measurement visits before it reports a lower bound instead of an exact size. */
export const MAX_WALK_ENTRIES = 500_000

export const REPORT_SCHEMA = "mendcode-next.migrate-v1@1"
export const REPORT_DIR = "migrations"
export const MIGRATE_EXIT = { ok: 0, errors: 1, usage: 64, refused: 65 } as const
