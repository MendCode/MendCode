/**
 * The daemon settings the kit applies to its dedicated data directory before every run (through `settings.set`,
 * the same command the product's own clients use). They hold the arms of the comparison equal to Codex's
 * `-s workspace-write` + approvals never:
 *
 *  - tier balanced ......................... the product's recommended bundle (prompt mode focus, balanced tools).
 *  - defaultPermission full ................ nothing waits for a human; explicit denies below still win.
 *  - sandbox workspace-write, network off .. shell commands can write only the project and temp dirs, no network.
 *  - permission.external_directory deny .... file tools cannot read or write outside the working directory.
 *
 * `run --approve` is also passed, so a residual approval is answered instead of blocking the turn.
 */
export const MENDCODE_EVAL_SETTINGS = {
  tier: "balanced",
  defaultPermission: "full",
  sandbox: { mode: "workspace-write", network: "off" },
  permission: { external_directory: "deny" },
} as const

/** Prompt mode and focus family applied per project by `mendcode prompt mode`. */
export const MENDCODE_PROMPT_MODE = { mode: "focus", focus: "auto" } as const

/** Environment switches that keep the arm offline and free of the operator's other tools. */
export const MENDCODE_EVAL_ENV = {
  /** The daemon would otherwise probe for a `claude` binary at start. */
  MENDCODE_CLAUDE: "0",
  /** The subscription backend's hosted web search and image generation. */
  MENDCODE_WEB_SEARCH: "0",
  MENDCODE_IMAGE_GEN: "0",
  MENDCODE_COMPUTER: "0",
  MENDCODE_BROWSER: "0",
  MENDCODE_TRACE: "0",
} as const
