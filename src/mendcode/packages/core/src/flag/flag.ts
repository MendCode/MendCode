import { Config } from "effect"
import { InstallationChannel } from "../installation/version"

function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

function falsy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "false" || value === "0"
}

// Channels that default to the new effect-httpapi server backend. The legacy
// hono backend remains the default for stable (`prod`/`latest`) installs.
const HTTPAPI_DEFAULT_ON_CHANNELS = new Set(["dev", "beta", "local"])

function number(key: string) {
  const value = process.env[key]
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

/** Maps `OPENCODE_FOO` → `MENDCODE_FOO` for MendCode-owned env aliases. */
function mendKey(openKey: string) {
  if (!openKey.startsWith("OPENCODE_")) return openKey
  return `MENDCODE_${openKey.slice("OPENCODE_".length)}`
}

function truthyOpen(openKey: string) {
  return truthy(mendKey(openKey)) || truthy(openKey)
}

function falsyOpen(openKey: string) {
  return falsy(mendKey(openKey)) || falsy(openKey)
}

/** When set, `MENDCODE_*` wins over `OPENCODE_*` for the same logical flag. */
function envOpen(openKey: string) {
  const primary = process.env[mendKey(openKey)]
  if (primary !== undefined && primary !== "") return primary
  const fallback = process.env[openKey]
  if (fallback !== undefined && fallback !== "") return fallback
  return undefined
}

function numberOpen(openKey: string) {
  return number(mendKey(openKey)) ?? number(openKey)
}

const OPENCODE_EXPERIMENTAL = truthyOpen("OPENCODE_EXPERIMENTAL")
const OPENCODE_DISABLE_CLAUDE_CODE = truthyOpen("OPENCODE_DISABLE_CLAUDE_CODE")
const OPENCODE_DISABLE_CLAUDE_CODE_SKILLS =
  OPENCODE_DISABLE_CLAUDE_CODE || truthyOpen("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS")
const copy = envOpen("OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT")

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  OPENCODE_AUTO_SHARE: truthyOpen("OPENCODE_AUTO_SHARE"),
  OPENCODE_AUTO_HEAP_SNAPSHOT: truthyOpen("OPENCODE_AUTO_HEAP_SNAPSHOT"),
  OPENCODE_GIT_BASH_PATH: envOpen("OPENCODE_GIT_BASH_PATH"),
  OPENCODE_CONFIG: envOpen("OPENCODE_CONFIG"),
  OPENCODE_CONFIG_CONTENT: envOpen("OPENCODE_CONFIG_CONTENT"),
  OPENCODE_DISABLE_AUTOUPDATE: truthyOpen("OPENCODE_DISABLE_AUTOUPDATE"),
  OPENCODE_ALWAYS_NOTIFY_UPDATE: truthyOpen("OPENCODE_ALWAYS_NOTIFY_UPDATE"),
  OPENCODE_DISABLE_PRUNE: truthyOpen("OPENCODE_DISABLE_PRUNE"),
  OPENCODE_DISABLE_TERMINAL_TITLE: truthyOpen("OPENCODE_DISABLE_TERMINAL_TITLE"),
  OPENCODE_SHOW_TTFD: truthyOpen("OPENCODE_SHOW_TTFD"),
  OPENCODE_PERMISSION: envOpen("OPENCODE_PERMISSION"),
  OPENCODE_DISABLE_DEFAULT_PLUGINS: truthyOpen("OPENCODE_DISABLE_DEFAULT_PLUGINS"),
  OPENCODE_DISABLE_LSP_DOWNLOAD: truthyOpen("OPENCODE_DISABLE_LSP_DOWNLOAD"),
  OPENCODE_ENABLE_EXPERIMENTAL_MODELS: truthyOpen("OPENCODE_ENABLE_EXPERIMENTAL_MODELS"),
  OPENCODE_DISABLE_AUTOCOMPACT: truthyOpen("OPENCODE_DISABLE_AUTOCOMPACT"),
  OPENCODE_DISABLE_MODELS_FETCH: truthyOpen("OPENCODE_DISABLE_MODELS_FETCH"),
  OPENCODE_DISABLE_MOUSE: truthyOpen("OPENCODE_DISABLE_MOUSE"),
  OPENCODE_DISABLE_CLAUDE_CODE,
  OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: OPENCODE_DISABLE_CLAUDE_CODE || truthyOpen("OPENCODE_DISABLE_CLAUDE_CODE_PROMPT"),
  OPENCODE_DISABLE_CLAUDE_CODE_SKILLS,
  OPENCODE_DISABLE_EXTERNAL_SKILLS: truthyOpen("OPENCODE_DISABLE_EXTERNAL_SKILLS"),
  OPENCODE_FAKE_VCS: envOpen("OPENCODE_FAKE_VCS"),
  OPENCODE_SERVER_PASSWORD: envOpen("OPENCODE_SERVER_PASSWORD"),
  OPENCODE_SERVER_USERNAME: envOpen("OPENCODE_SERVER_USERNAME"),
  OPENCODE_ENABLE_QUESTION_TOOL: truthyOpen("OPENCODE_ENABLE_QUESTION_TOOL"),

  // Experimental
  OPENCODE_EXPERIMENTAL,
  OPENCODE_EXPERIMENTAL_FILEWATCHER: Config.boolean("OPENCODE_EXPERIMENTAL_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: Config.boolean("OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  OPENCODE_EXPERIMENTAL_ICON_DISCOVERY: OPENCODE_EXPERIMENTAL || truthyOpen("OPENCODE_EXPERIMENTAL_ICON_DISCOVERY"),
  OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthyOpen("OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  OPENCODE_ENABLE_EXA: truthyOpen("OPENCODE_ENABLE_EXA") || OPENCODE_EXPERIMENTAL || truthyOpen("OPENCODE_EXPERIMENTAL_EXA"),
  OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS: numberOpen("OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"),
  OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: numberOpen("OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX"),
  OPENCODE_EXPERIMENTAL_OXFMT: OPENCODE_EXPERIMENTAL || truthyOpen("OPENCODE_EXPERIMENTAL_OXFMT"),
  OPENCODE_EXPERIMENTAL_LSP_TY: truthyOpen("OPENCODE_EXPERIMENTAL_LSP_TY"),
  OPENCODE_EXPERIMENTAL_LSP_TOOL: OPENCODE_EXPERIMENTAL || truthyOpen("OPENCODE_EXPERIMENTAL_LSP_TOOL"),
  OPENCODE_EXPERIMENTAL_PLAN_MODE: OPENCODE_EXPERIMENTAL || truthyOpen("OPENCODE_EXPERIMENTAL_PLAN_MODE"),
  OPENCODE_EXPERIMENTAL_MARKDOWN: !falsyOpen("OPENCODE_EXPERIMENTAL_MARKDOWN"),
  OPENCODE_MODELS_URL: envOpen("OPENCODE_MODELS_URL"),
  OPENCODE_MODELS_PATH: envOpen("OPENCODE_MODELS_PATH"),
  OPENCODE_DISABLE_EMBEDDED_WEB_UI: truthyOpen("OPENCODE_DISABLE_EMBEDDED_WEB_UI"),
  OPENCODE_DB: envOpen("OPENCODE_DB"),
  OPENCODE_DISABLE_CHANNEL_DB: truthyOpen("OPENCODE_DISABLE_CHANNEL_DB"),
  OPENCODE_SKIP_MIGRATIONS: truthyOpen("OPENCODE_SKIP_MIGRATIONS"),
  OPENCODE_STRICT_CONFIG_DEPS: truthyOpen("OPENCODE_STRICT_CONFIG_DEPS"),

  OPENCODE_WORKSPACE_ID: envOpen("OPENCODE_WORKSPACE_ID"),
  // Defaults to true on dev/beta/local channels so internal users exercise the
  // new effect-httpapi server backend. Stable (`prod`/`latest`) installs stay
  // on the legacy hono backend until the rollout is complete. An explicit env
  // var ("true"/"1" or "false"/"0") always wins, providing an opt-in for
  // stable users and an escape hatch for dev/beta users.
  OPENCODE_EXPERIMENTAL_HTTPAPI:
    truthyOpen("OPENCODE_EXPERIMENTAL_HTTPAPI") ||
    (!falsyOpen("OPENCODE_EXPERIMENTAL_HTTPAPI") && HTTPAPI_DEFAULT_ON_CHANNELS.has(InstallationChannel)),
  OPENCODE_EXPERIMENTAL_WORKSPACES: OPENCODE_EXPERIMENTAL || truthyOpen("OPENCODE_EXPERIMENTAL_WORKSPACES"),
  OPENCODE_EXPERIMENTAL_EVENT_SYSTEM: OPENCODE_EXPERIMENTAL || truthyOpen("OPENCODE_EXPERIMENTAL_EVENT_SYSTEM"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get OPENCODE_DISABLE_PROJECT_CONFIG() {
    return truthyOpen("OPENCODE_DISABLE_PROJECT_CONFIG")
  },
  get OPENCODE_TUI_CONFIG() {
    return envOpen("OPENCODE_TUI_CONFIG")
  },
  get OPENCODE_CONFIG_DIR() {
    return envOpen("OPENCODE_CONFIG_DIR")
  },
  get OPENCODE_PURE() {
    return truthyOpen("OPENCODE_PURE")
  },
  get OPENCODE_PLUGIN_META_FILE() {
    return envOpen("OPENCODE_PLUGIN_META_FILE")
  },
  get OPENCODE_CLIENT() {
    return envOpen("OPENCODE_CLIENT") ?? "cli"
  },
}
