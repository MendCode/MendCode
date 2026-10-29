import { parseConsole, CONSOLE_USAGE, SHARE_USAGE, type ConsoleAutomation, type ShareAutomation } from "./console-args"
import { MFLOW_USAGE, parseMflow, type MflowAutomation } from "./mflow-args"
import { mflowText } from "./mflow-output"
import { PROJECT_USAGE, parseProjectAutomation, projectOutput, type ProjectAutomation } from "./project-automation"
import { parseDebug, DEBUG_USAGE, DATABASE_USAGE, type DebugAutomation } from "./debug-args"
import path from "node:path"
import { MEMORY_USAGE, parseMemoryAutomation, type MemoryAutomation } from "./memory-automation"
import type { Client } from "@mendcode/client"
import type { GlobalEvent, Loop, MemoryEntry, PackageInfo, Profile, RecipesReport, Settings, SessionEvent, SessionId, SessionSummary, StorageCleanResult, StorageReport, StorageWorktreesReport, UsageReport, UsageWasteReport, WorkflowRun, WorkflowSummary } from "@mendcode/protocol"
import { MODEL_ROLES, TUI_OPERATIONS, DEFAULT_PROFILE, PROFILE_NAME, profileFor, promptCostLine, promptCostOf, promptCostWarning, type PromptStatus, type SchemaIndex, type SchemaPage } from "@mendcode/protocol/wire"
import { createHeadlessRun } from "./run"
import { COMPAT, compatEnvelope } from "./compat"
import { isScriptFile, parseRunArguments } from "./view/workflow-script"
import { relativeTime } from "./view/session-list"
import { labelString, sessionLabel } from "./view/session-label"
import { formatBytes } from "./view/storage-page"
import { compact } from "./view/usage-page"
import { statsText } from "./stats"
import { backlogChangeText, backlogCount, backlogLines, parseBacklogWords } from "./view/backlog"
import type { BacklogReport } from "@mendcode/protocol/wire"
import { parsePromptAutomation, type PromptAutomation } from "./prompt-automation"
import { parseSession, sessionDirectories, type SessionAutomation } from "./session-args"
import { sessionHuman, sessionModelPrefix, sessionSelection } from "./session-output"
import { parseGlobalOptions } from "./global-options"
import { COMPLETION_SHELLS, completionScript, contextText, systemText, type CompletionShell } from "./support-output"
import packageJson from "../package.json"
import { CATALOG_USAGE, parseCatalog, type CatalogAutomation } from "./catalog-args"
import { THEME_USAGE, parseTheme, type ThemeAutomation } from "./theme-args"
import { CONFIG_BUNDLE_USAGE, parseConfigBundle, type ConfigBundleAutomation } from "./config-bundle-args"
import { AGENT_USAGE, parseAgent, type AgentAutomation } from "./agent-args"
import { parseTransferExport, parseTransferImport, TRANSFER_EXPORT_USAGE, TRANSFER_IMPORT_USAGE, type TransferImport } from "./session-transfer-args"
import { jobAliases } from "./job-aliases"
import { LOOP_CONTROL_USAGE, loopAliases, parseLoopAutomation, isLoopAutomation, runLoopAutomation, type LoopAutomation } from "./loop-automation"
import { WORKTREE_USAGE, parseWorktree, type WorktreeAutomation } from "./worktree-args"
import { worktreeText } from "./worktree-output"
import { UNINSTALL_USAGE } from "@mendcode/upgrade/uninstall-args"
import { CACHE_USAGE, parseCache, type CacheAutomation } from "./cache-args"
import { APPLY_USAGE, parseApply, type ApplyAutomation } from "./apply-args"
import { packageArguments, packageCatalogText, type PackageAutomation } from "./package-args"
import { AI_CONFIG_USAGE, parseAIConfig, type AIConfigAutomation } from "./ai-config-args"
import { DAEMON_USAGE } from "./daemon-service"
import { TSM_USAGE, parseTsm, type TsmAutomation } from "./tsm-args"
import { tsmText } from "./tsm-output"
import { GITHUB_USAGE, PR_USAGE, parseGithub, type GithubAutomation } from "./github-args"
import { PROGRAM_NAME } from "@mendcode/program"

/** Every JSON line carries this so scripts can pin the contract. */
export const SCHEMA = "mendcode-next.cli.v1"
/** `denied` is `session send --wait` only: the turn completed but an approval was denied for lack of --approve and nothing ran after it (run.ts). */
export const EXIT = { ok: 0, failed: 1, stopped: 2, timeout: 3, needsInput: 4, denied: 5, usage: 64 } as const

const NAMES = ["backlog", "session", "memory", "loop", "workflow", "usage", "storage", "package", "recipe", "profile", "control-plane", "tui", "help", "stats", "prompt", "context", "status", "doctor", "debug", "generate", "completion", "export", "import", "worktree", "workflows", "packages", "marketplace", "runtime", "plugin", "plug", "plugin-auth", "db", "tsm", "github", "pr", "mflow", "console", "share", "login", "logout", "switch", "orgs", "open"] as const
const BOOLEAN_FLAGS = new Set(["json", "all", "wait", "approve", "dangerously-skip-permissions", "follow", "user", "now", "goal", "help", "clean", "dry-run", "vacuum", "compact", "worktrees", "project", "replace", "yes", "no-audit", "preview", "auto", "deterministic", "apply", "enable", "disable", "use", "no-use", "input", "no-input", "generate", "no-generate", "output", "no-output", "show-full", "all-projects", "active", "archived", "restore", "async", "keep-open", "idle", "version", "httpapi", "hono", "index", "sanitize", "latest", "reasoning", "no-reasoning", "no-tools", "metadata", "no-metadata", "timestamps", "no-timestamps", "purge", "switch"])
const VALUE_FLAGS = new Set(["dir", "commit", "title", "limit", "timeout", "after", "every", "daily", "runs", "days", "engine", "session", "format", "name", "criteria", "category", "status", "older-than", "delta-idle", "worktree-idle", "permission", "task", "reason", "note", "compat", "state", "preset", "proposal", "backup", "scope", "tags", "from-file", "from", "max-proposals", "mode", "provider", "model", "max-prompt-tokens", "max-entries", "project-max-entries", "global-compaction-max-entries", "dream-consolidation-policy", "tools", "focus", "role", "workflow", "data-dir", "parent", "agent", "variant", "effort", "max-count", "since", "search", "message-id", "timeout-ms", "interval-ms", "command", "query", "id", "description", "kind", "channel", "source-type", "source-url", "compat-mendcode", "compat-runtime-pack", "plan-file", "definition-id", "revision-id", "task-id", "source", "before", "run", "location", "url", "type", "entry", "request-id", "args", "out", "agents", "tokens", "usd", "minutes"])
/** Flags that may be given several times; their values are collected in order. */
const REPEAT_FLAGS = new Set(["check", "file", "glob", "include", "exclude"])
const DEFAULT_LIST_LIMIT = 50
const DEFAULT_USAGE_DAYS = 30
const NAME_CHARS = 60
const MAX_CHECKS = 5
const MAX_CHECK_CHARS = 300
const MAX_REASON_CHARS = 500
/** A script workflow start: a `.js` file or a saved script name, and the arguments it reads as `args`. */
type ScriptRun = { args?: Record<string, unknown> }
const WORKFLOW_PERMISSIONS = ["ask", "edits", "full"] as const
const WORKFLOW_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/
const WORKFLOW_SLUG = /^[a-z][a-z0-9_-]{0,39}$/
const WORKFLOW_CONTROL_ACTIONS = ["pause", "resume", "stop", "verify", "delete"] as const

export type Common = { json: boolean; dir?: string; projectDir?: string; compat?: typeof COMPAT }
export type Automation = Common &
  (
    | { kind: "help"; topic?: string }
    | { kind: "automation.ledger"; scope: "workflow" | "loop"; id: string; operation: "events" | "artifacts" | "receipt" | "export"; limit?: number; before?: number; run?: number; exportFormat: "json" | "markdown" }
    | ConsoleAutomation | ShareAutomation
    | MemoryAutomation
    | { kind: "tui"; operation: import("@mendcode/protocol/wire").TuiOperation; argument?: string; state: "home" | "session"; dryRun: boolean; session?: string; check?: boolean }
    | SessionAutomation
    | TransferImport
    | { kind: "memory.list"; status?: string }
    | { kind: "memory.add"; text: string; user: boolean; category?: string }
    | { kind: "memory.search"; query: string; limit?: number }
    | { kind: "loop.list"; all: boolean }
    | { kind: "loop.create"; objective: string; name: string; trigger: { kind: "manual" } | { kind: "interval"; everyMs: number } | { kind: "daily"; at: string }; budget: { mode: "goal"; maxRuns?: number } | { mode: "monitor" } | { mode: "fixed"; maxRuns: number }; criteria?: string; checks?: string[]; audit?: "none"; runNow: boolean }
    | { kind: "loop.control"; id: string; action: "pause" | "resume" | "stop" | "run" | "delete" }
    | { kind: "loop.fire"; id: string; note?: string }
    | { kind: "workflow.list"; all: boolean }
    | { kind: "workflow.preview"; target: string; script?: ScriptRun }
    | { kind: "workflow.new"; name: string; out?: string }
    | { kind: "workflow.convert"; target: string; out?: string }
    | { kind: "workflow.script"; id: string; budget: { agents?: number; tokens?: number; usd?: number; minutes?: number } }
    | { kind: "workflow.update"; id: string; file: string }
    | { kind: "workflow.save"; target: string; definitionId?: string; name?: string; description?: string; source?: import("@mendcode/protocol").WorkflowDefinition["source"] }
    | { kind: "workflow.definitions"; limit: number }
    | { kind: "workflow.revision"; revisionId: string }
    | { kind: "workflow.start"; target: string; permission?: WorkflowPermission; yes: boolean; wait: boolean; timeoutMs?: number; script?: ScriptRun }
    | { kind: "workflow.show"; id: string }
    | { kind: "workflow.control"; id: string; action: "pause" | "resume" | "stop" | "verify" | "delete" | "retry" | "accept" | "approve" | "reject"; taskId?: string; reason?: string; wait?: true; timeoutMs?: number }
    | { kind: "usage" | "stats"; days?: number; tools?: number; models?: true | number; scope?: "global" | "project" | "directory"; project?: string; waste?: true }
    | { kind: "storage"; clean: boolean; olderThanDays?: number; dryRun: boolean; vacuum: boolean; compact: boolean; offline?: boolean; deltaIdleDays?: number; worktrees: boolean; worktreeIdleDays?: number }
    | { kind: "package.list" }
    | { kind: "recipe.list" }
    | { kind: "profile.list" }
    | { kind: "profile.add"; name: string; folders: string[]; permission?: "ask" | "edits" | "full" }
    | { kind: "profile.remove"; name: string }
    | { kind: "recipe.apply"; name: string }
    | { kind: "package.install"; source: string; scope: PackageScope; replace: boolean }
    | { kind: "package.capture"; name: string; replace: boolean }
    | { kind: "lsp.install"; server: "typescript" | "python" | "go" }
    | { kind: "package.remove"; name: string; scope: PackageScope; purge: boolean }
    | { kind: "package.restore"; name: string; scope: PackageScope }
    | { kind: "package.enable"; name: string; scope: PackageScope; enabled: boolean; switch: boolean }
    | PromptAutomation
    | { kind: "permissions"; operation: "status" | "set-default" | "set-reviewer-role"; mode?: "approval" | "smart" | "full_access" | "ask" | "edits" | "full"; role?: import("@mendcode/protocol").ModelRole }
    | { kind: "version" }
    | { kind: "completion"; shell: CompletionShell }
    | { kind: "context"; id: string; limit: number }
    | { kind: "backlog"; words: Exclude<import("./view/backlog").BacklogWords, { kind: "error" } | { kind: "open" }> }
    | { kind: "system"; operation: Extract<import("@mendcode/client").CommandInput, { type: "system.query" }>["operation"] }
    | { kind: "files"; operation: "files" | "tree" | "search"; query?: string; glob?: string[]; limit?: number }
    | { kind: "generate"; backend: "protocol" | "httpapi"; index?: boolean; entry?: string }
    | CatalogAutomation
    | ThemeAutomation
    | ConfigBundleAutomation
    | AgentAutomation
    | LoopAutomation
    | ProjectAutomation
    | WorktreeAutomation
    | CacheAutomation | ApplyAutomation
    | PackageAutomation
    | { kind: "plugin.install"; spec: string; global: boolean; force: boolean }
    | { kind: "plugin.auth"; provider?: string; method: number }
    | { kind: "setup.control"; target: "setup" | "budget"; operation: "status" | "plan" | "doctor" }
    | AIConfigAutomation
    | DebugAutomation
    | TsmAutomation
    | GithubAutomation
    | MflowAutomation
  )
type PackageScope = "user" | "project"
export type WorkflowPermission = (typeof WORKFLOW_PERMISSIONS)[number]
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type ParseResult = { ok: true; command: Automation } | { ok: false; message: string; topic?: string } | { ok: "none" }

const USAGE: Record<string, string> = {
  plugin: `usage: ${PROGRAM_NAME} plugin <module|file://path> [--global|-g] [--force|-f] [--dir D] [--json]\n  offline pnpm cache only; project code requires trust; --pure skips external extensions`,
  plug: `usage: ${PROGRAM_NAME} plug <module|file://path> [--global|-g] [--force|-f] [--dir D] [--json]`,
  "plugin-auth": `usage: ${PROGRAM_NAME} plugin-auth [provider [method-index]] [--dir D] [--json]`,
  "control-plane": `usage: ${PROGRAM_NAME} control-plane permissions <status|set-default approval|smart|full_access|ask|edits|full|set-reviewer-role ROLE> [--dir D] [--json]\nusage: ${PROGRAM_NAME} control-plane tui <status|schema|profile|apply ID|apply-preset PRESET|rollback ID|preview|propose TEXT|project|render> [--state home|session] [--session ID] [--dry-run] [--dir D] [--json]\n  control-plane ai <status|env [status]>\n  control-plane system <status|doctor|check|toolchain|config-paths|config-layers|precedence|adapter-status>\n  control-plane setup <status|plan|doctor>\n  control-plane budget <status|doctor>`,
  context: `usage: ${PROGRAM_NAME} context <sessionID> [--limit N (1–100, default 20)] [--json] [--dir D]`,
  backlog: [`usage: ${PROGRAM_NAME} backlog <list|add|done|reopen|remove|clear> [--json] [--dir D]`, "  list                                   this project's items, open ones first", '  add [--file PATH] [--commit SHA] [--session ID] "text"', "  done|reopen|remove <id>", "  clear                                  removes the finished items", "The project is the directory the command runs in. A session's own shell may list; only you change the list."].join("\n"),
  status: `usage: ${PROGRAM_NAME} status [--json] [--dir D]`,
  doctor: `usage: ${PROGRAM_NAME} doctor [--json] [--dir D]`,
  debug: DEBUG_USAGE,
  db: DATABASE_USAGE,
  generate: `usage: ${PROGRAM_NAME} generate [--httpapi] [--dir D]\n  default: generate the socket protocol schema\n  --httpapi: print the OpenAPI 3.1 contract of the opt-in HTTP adapter (offline, no daemon)`,
  completion: `usage: ${PROGRAM_NAME} completion [bash|zsh|fish|powershell]`,
  session: [
    `usage: ${PROGRAM_NAME} session <command> [--dir PROJECT] [--json] (prefix --dir DATA selects daemon storage)`,
    "  list [--all] [--all-projects] [--max-count N] [--project PATH] [--state STATE] [--active] [--since MS] [--search TEXT] [--agent A] [--model P/M]",
    "  create [--title T] [--parent ID] [--agent A] [--model P/M] [--variant V] [--effort LEVEL]",
    "  get|status|inspect <id> [--limit N]           metadata or a bounded progress snapshot",
    "  stats <id> [--json]                            time per turn, day and hour, tokens per model, tools, sub-agents, approval waits",
    "  rename <id> <title...> · fork <id> [--message-id ID] · delete <id> · export <id>",
    '  send <id> ["text"] [--async|--wait] [--approve|--dangerously-skip-permissions] [--agent A] [--model P/M] [--variant V] [--effort LEVEL] [--file PATH]... [--command NAME]',
    "  wait <id> [--timeout-ms MS] [--interval-ms MS] [--idle]",
    "  events <id> [--after SEQ] [--follow] [--keep-open] [--limit N]",
    "  cancel <id>                                   cancel the active turn",
    "  pause <id> · resume <id>                      hold new turns after the running one · release them",
    "  stop <id>                                     cancel the running turn and its sub-agents",
    "  shorthands: ps (list --active) · logs <id> [-f] (events) · kill <id> (cancel) · run --bg … · attach <id> (open the TUI)",
    "  archive <id> [--restore] · list --archived    keep history; include archived sessions",
  ].join("\n"),
  memory: [`usage: ${PROGRAM_NAME} ` + MEMORY_USAGE, "  list [--status saved|pending|archived]", '  add [--user] [--category C] "text"', '  search "query" [--limit N]'].join("\n"),
  loop: [
    `usage: ${PROGRAM_NAME} loop <command> [--dir D] [--json]`,
    "  list [--all]",
    '  create [--every 1h|--daily 09:00] [--now] [--goal [--check "cmd"]... [--no-audit]] [--runs N] [--name N] [--criteria C] "objective"',
    "  pause|resume|stop|run|delete <id>",
    '  fire <id> [--note "what happened"]             start an external loop now (from cron or CI); a fire during a run waits for it',
    LOOP_CONTROL_USAGE,
    "  events|artifacts|receipt|export <id> [--run N] [--limit 1..100] [--before SEQ] [--format json|markdown (export)]",
  ].join("\n"),
  workflow: [
    `usage: ${PROGRAM_NAME} workflow <command> [--dir D] [--json]`,
    "  list [--all]",
    "  status [--all]                              alias for list",
    "  save <file.json|name> [--definition-id ID] [--name NAME --description TEXT --source manual|saved|template|package|session-generated]",
    "  definitions [--limit N] · revision <revision-id>",
    "  preview <file.json|name>                      validate; print tasks, checks and the applied permission",
    "  start <file.json|name> [--permission ask|edits|full] [--yes] [--wait [--timeout S]]",
    "                                                without --yes only previews; --wait blocks until done, failed, blocked, stopped or waiting for input",
    "  preview|start --plan-file FILE | --definition-id ID | --revision-id ID",
    "  run <file.js|name> [key=value ... | --args JSON] [--permission P] [--yes] [--wait [--timeout S]]   start a script workflow (preview without --yes)",
    "  new <name> [--out FILE]                       write a commented starter script (default ./<name>.js)",
    "  convert <plan.json> [--out FILE]              turn a JSON plan into a script",
    "  budget <id> [--agents N] [--tokens N] [--usd N] [--minutes N]   raise the caps of a paused script run, then resume",
    "  update <id> <file.js>                         swap in an edited script (paused or failed run); resume re-runs only changed calls",
    "  show <id>                                     tasks, contract, last verification",
    "  pause|resume|stop|verify|delete <id>",
    "  retry <id> --task <taskId>                    run one task (and what depends on it) again",
    "  retry-task <id> --task-id <taskId> [--reason TEXT]",
    "  approve|reject <id> --task <taskId> [--reason TEXT]   answer a human task or approval gate that waits for you",
    '  accept <id> --reason "…"                      declare the workflow done despite the contract',
    "  events|artifacts|receipt|export <id> [--limit 1..100] [--before SEQ] [--format json|markdown (export)]",
  ].join("\n"),
  usage: `usage: ${PROGRAM_NAME} usage [--days N] [--tools N] [--models [N]] [--project [ID]] [--scope global|project|directory] [--json]   last N days (default 30)`,
  recipe: [`usage: ${PROGRAM_NAME} recipe <list|apply <name>> [--json]`, "  list            model recipes of every layer (built-in, packages, user, project); * marks the active one", "  apply <name>    set every model role from the recipe"].join("\n"),
  profile: [
    `usage: ${PROGRAM_NAME} profile <command> [--json]   (folder profiles: sessions under a profile's folders use its memory, roles and default permission)`,
    "  list                                          profiles, their folders, and the profile of this directory",
    "  add <name> <folder>... [--permission ask|edits|full]   add or replace; a folder covers everything under it",
    "  remove <name>                                 its user memories stay, tagged, but are no longer used",
  ].join("\n"),
  package: [
    `usage: ${PROGRAM_NAME} package <command> [--project] [--json]   (user scope unless --project: this directory's .mendcode/packages)`,
    "  list                                          installed packages, what each adds, on or off",
    "  install <folder|npm:name@x.y.z[#sha512-…]|github:owner/repo#ref|git:URL> [--replace]   npm and a full git commit are pinned",
    "  config [name]; config <name> enable|disable <skills|commands|agents|themes|tools|extensions>/<name>",
    "  refresh <source>                              download a remote (https) catalog index; add it with add-source <id> <url> --enable",
    "  new <name> [--dir PARENT]; check [folder]     scaffold a complete package; validate one (schema, compat, capabilities, forbidden keys, size)",
    "  remove <name> [--purge]                       to the Trash for 30 days; --purge deletes it for good",
    "  restore <name>                                bring the newest trashed copy back (off until enabled)",
    "  enable|disable <name> [--switch]              a package's look replaces the one in force only with --switch",
    "  status|list; use|install <name> [source]; install-source|use-source <source> [--replace]",
    "  deselect <name>; disable-all|deselect-all [--project]",
    "  search [query] [source]; show|preview <name> [source]; assets",
    "  sources; add-source <id> <folder> [--enable]; remove-source <id>",
    "  aliases: packages, marketplace, control-plane packages, [control-plane] runtime registry",
    "  create|update [--id id] [--title name] [--description text] [--version x.y.z]",
    "    [--include all|commands,skills,...] [--exclude models,...]   snapshot local project assets",
    "    [--kind kind] [--channel channel] [--source-type type] [--source-url url]",
    "    [--compat-mendcode range] [--compat-runtime-pack range]",
    "  delete-local                                  retire generated package; preserve original assets",
  ].join("\n"),
  storage: [
    `usage: ${PROGRAM_NAME} storage [--clean [--older-than 90d]] [--compact [--delta-idle 3d]] [--worktrees [--worktree-idle 14d]] [--dry-run] [--vacuum] [--json]`,
    "  (no flags)      where the disk goes: database, WAL, blobs, orphans, bytes per turn, snapshots, what compression saves, top sessions",
    "  --clean         remove sessions idle longer than --older-than (default: the retentionDays setting, else 90d),",
    "                  then orphan blobs; never touches a session with an active turn, a queued message or a live loop",
    "  --compact       move old data into the compact forms (compressed tool output, model history and shared snapshot content)",
    "                  and drop the streaming deltas of finished messages in sessions idle --delta-idle (default 3d); nothing is lost",
    "  --offline       with --compact --dir DATA: VACUUM INTO 16 KB pages, atomic swap and preserved backup; daemon must be stopped",
    "  --worktrees     alone: list the worktrees the daemon created (size, merged or not, why one is kept); with --clean or --compact:",
    "                  also remove the merged, clean, unused ones idle --worktree-idle (default 14d) and old trash. Local only",
    "  --dry-run       show what --clean or --compact would change and change nothing",
    "  --vacuum        also rewrite the database file (needs free disk equal to its size); alone, it removes no sessions",
  ].join("\n"),
  stats: `usage: ${PROGRAM_NAME} stats [--days N] [--tools N] [--models [N]] [--project [ID]] [--scope global|project|directory] [--waste] [--json]   all time by default; --days 0 selects today; --waste: where tokens were paid twice and what to change`,
  prompt: `usage: ${PROGRAM_NAME} [control-plane] prompt <sources|build|mode [minimal|focus|guide|full|custom]|cycle-mode> [--focus auto|codex|claude|gemini|kimi|deepseek|mistral|glm|minimax|grok|local] [--mode MODE --model ID --role ROLE --workflow WORKFLOW --show-full] [--dir D] [--json]`,
  ...CATALOG_USAGE,
  theme: THEME_USAGE,
  "config-bundle": CONFIG_BUNDLE_USAGE,
  agent: AGENT_USAGE,
  export: TRANSFER_EXPORT_USAGE,
  import: TRANSFER_IMPORT_USAGE,
  worktree: WORKTREE_USAGE,
  mflow: MFLOW_USAGE,
  uninstall: UNINSTALL_USAGE,
  cache: CACHE_USAGE,
  apply: APPLY_USAGE,
  "ai-config": AI_CONFIG_USAGE,
  daemon: DAEMON_USAGE.trimEnd(),
  tsm: TSM_USAGE,
  github: GITHUB_USAGE,
  pr: PR_USAGE,
  console: CONSOLE_USAGE,
  share: SHARE_USAGE,
}

export const HELP = [
  `${PROGRAM_NAME} — terminal coding harness`,
  "",
  `  ${PROGRAM_NAME}                       interactive UI`,
  `  ${PROGRAM_NAME} run [--json] [--approve] [--session ID] "prompt"   one headless turn`,
  "  " + TRANSFER_EXPORT_USAGE,
  "  " + TRANSFER_IMPORT_USAGE,
  `  ${PROGRAM_NAME} acp                   Agent Client Protocol agent on stdio, for editors (Zed and others)`,
  `  ${PROGRAM_NAME} app-server            JSON-RPC (Codex app-server style) on stdio, for third-party UIs`,
  "",
  USAGE.session,
  USAGE.memory,
  USAGE.loop,
  USAGE.workflow,
  USAGE.usage,
  USAGE.storage,
  USAGE.package,
  USAGE.recipe,
  USAGE.profile,
  USAGE["control-plane"],
  USAGE.context,
  USAGE.status,
  USAGE.doctor,
  USAGE.debug,
  USAGE.generate,
  USAGE.completion,
  USAGE.models,
  USAGE.providers,
  USAGE.mcp,
  "",
  "flags: --dir D (data directory)  --json | --format json (one JSON object per line, schema " + SCHEMA + ")  --help/-h  --version/-v  --print-logs  --log-level DEBUG|INFO|WARN|ERROR  --trace",
  "exit codes: 0 ok · 1 failure · 2 stopped/cancelled/interrupted · 3 timeout · 4 needs input · 5 approval denied without --approve and nothing ran after it (session send) · 64 usage",
  USAGE.stats,
  USAGE.prompt,
  USAGE.theme,
  USAGE["config-bundle"],
  USAGE.agent,
  PROJECT_USAGE,
  USAGE.tsm,
  USAGE.uninstall,
  USAGE.cache,
  USAGE.apply,
  USAGE.plugin,
  DAEMON_USAGE.trimEnd(),
  USAGE.db,
  GITHUB_USAGE,
  PR_USAGE,
  USAGE.console,
  USAGE.share,
].join("\n")

function tokenize(argv: string[]) {
  const flags = new Map<string, string | true>()
  const repeated = new Map<string, string[]>()
  const positionals: string[] = []
  const usageCommand = argv.includes("usage") || argv.includes("stats")
  const bad = (error: string) => ({ error, topic: positionals[0] })
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] === "-n" ? "--max-count" : argv[i] === "-g" ? "--global" : argv[i] === "-f" ? "--force" : argv[i]!
    if (token === "--") { positionals.push(...argv.slice(i + 1)); break }
    if (!token.startsWith("--")) {
      positionals.push(token)
      continue
    }
    const [rawName, inline] = token.slice(2).split(/=(.*)/s, 2)
    const name = rawName!
    const packageAuthoring = ["package", "packages", "marketplace"].includes(positionals[0] ?? "") && ["create", "update"].includes(positionals[1] ?? "") || positionals[0] === "control-plane" && ["packages", "marketplace"].includes(positionals[1] ?? "") && ["create", "update"].includes(positionals[2] ?? "")
    const packageVersion = name === "version" && positionals[0] === "control-plane" && positionals[1] === "project" && positionals[2] === "package-set"
    if (name === "version" && packageAuthoring) {
      const value = inline ?? argv[++i]
      if (!value || value.startsWith("--")) return bad("--version needs a value")
      flags.set(name, value)
    } else if (usageCommand && (name === "models" || name === "project")) {
      const next = argv[i + 1]
      const value = inline ?? (next !== undefined && !next.startsWith("--") ? argv[++i] : undefined)
      flags.set(name, value ?? (name === "models" ? true : ""))
    } else if (name === "tools" && (positionals[0] === "export" || positionals[0] === "session" && positionals[1] === "export")) flags.set(name, true)
    else if ((BOOLEAN_FLAGS.has(name) && !(name === "project" && positionals[0] === "session") && !packageVersion) || ["global", "force"].includes(name) || name === "check" && (positionals[0] === "tui" || positionals[0] === "control-plane")) flags.set(name, true)
    else if (VALUE_FLAGS.has(name) || name === "project" && positionals[0] === "session" || packageVersion) {
      const value = inline ?? argv[++i]
      if (value === undefined || value.startsWith("--")) return bad(`--${name} needs a value`)
      flags.set(name, value)
    } else if (REPEAT_FLAGS.has(name)) {
      const value = inline ?? argv[++i]
      if (value === undefined || value.startsWith("--")) return bad(`--${name} needs a value`)
      repeated.set(name, [...(repeated.get(name) ?? []), value])
      if (name === "glob") while (argv[i + 1] && !argv[i + 1]!.startsWith("-")) repeated.set(name, [...repeated.get(name)!, argv[++i]!])
    } else return bad(`unknown flag --${name}`)
  }
  return { flags, repeated, positionals }
}

function number(flags: Map<string, string | true>, name: string, options: { min?: number; integer?: boolean } = {}): number | undefined | { error: string } {
  const raw = flags.get(name)
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (typeof raw !== "string" || !Number.isFinite(value) || value < (options.min ?? 0) || (options.integer && !Number.isInteger(value))) return { error: `--${name} needs ${options.integer ? "a whole " : "a "}number${options.min ? ` ≥ ${options.min}` : ""}` }
  return value
}

const isError = (value: unknown): value is { error: string } => typeof value === "object" && value !== null && "error" in value

/** "30m" | "1h" | "2d" → ms. */
export function parseEvery(text: string) {
  const match = /^(\d+)(m|h|d)$/.exec(text)
  return match ? Number(match[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "m" | "h" | "d"] : undefined
}

/** Pure argument parsing. `none` = not an automation command (run, export, the UI). */
export function parseAutomation(argv: string[]): ParseResult {
  let offlineOption = false
  try {
    const globals = parseGlobalOptions(argv)
    offlineOption = globals.offline === true
    argv = globals.args
  } catch (error) { return { ok: false, message: String(error instanceof Error ? error.message : error) } }
  argv = jobAliases(loopAliases(argv))
  const loop = parseLoopAutomation(argv)
  if (loop) return loop
  const console = parseConsole(argv)
  if (console) return console
  const mflow = parseMflow(argv)
  if (mflow) return mflow
  const worktree = parseWorktree(argv)
  if (worktree) return worktree
  if (argv[0] === "control-plane" && ["workflow", "workflows"].includes(argv[1] ?? "")) argv = argv.slice(1)
  if (argv[0] === "workflows") argv = ["workflow", ...(argv.length === 1 ? ["list"] : argv.slice(1))]
  const cache = parseCache(argv)
  if (cache) return cache
  const apply = parseApply(argv)
  if (apply) return apply
  const aiConfig = parseAIConfig(argv)
  if (aiConfig) return aiConfig
  // Unapproved tool probes retain the agent RPC; inspection and --approve use donor debug.
  const legacyAgentDebug = parseAgent(argv)
  if (legacyAgentDebug?.ok === true && legacyAgentDebug.command.kind === "agent.debug" && legacyAgentDebug.command.tool) return legacyAgentDebug
  const debug = parseDebug(argv)
  if (debug) return debug
  const tsm = parseTsm(argv)
  if (tsm) return tsm
  const catalog = parseCatalog(argv)
  if (catalog) return catalog
  const theme = parseTheme(argv)
  if (theme) return theme
  const configBundle = parseConfigBundle(argv)
  if (configBundle) return configBundle
  const agent = parseAgent(argv)
  if (agent) return agent
  const github = parseGithub(argv)
  if (github) return github
  const tokens = tokenize(argv)
  if ("error" in tokens) {
    const first = tokens.topic ?? argv.find((token) => !token.startsWith("--"))
    return NAMES.includes(first as never) ? { ok: false, message: tokens.error, ...(first ? { topic: first } : {}) } : { ok: "none" }
  }
  const { flags, repeated, positionals } = tokens
  const [name, sub, ...rest] = positionals
  if (name === "workflows" || name === "control-plane" && sub === "workflows") {
    const normalized = [...argv]
    if (name === "control-plane") normalized.splice(normalized.indexOf("control-plane"), 1)
    normalized[normalized.indexOf("workflows")] = "workflow"
    return parseAutomation(normalized)
  }
  if (flags.get("version") === true && !(name === "control-plane" && sub === "project" && rest[0] === "package-set")) return { ok: true, command: { kind: "version", json: false } }
  if (name === "help" || (!name && flags.has("help"))) return { ok: true, command: { kind: "help", ...(sub ? { topic: sub } : {}), json: false } }
  if (!name || !NAMES.includes(name as never)) return { ok: "none" }
  if (flags.has("help")) return { ok: true, command: { kind: "help", topic: name === "control-plane" && (sub === "memory" || sub === "prompt" || sub === "project") ? sub : name, json: false } }

  const format = flags.get("format")
  if (format !== undefined && !["json", "table", "text", ...(name === "export" || name === "session" && sub === "export" ? ["markdown", "md", "html"] : []), ...(sub === "export" && (name === "workflow" || name === "loop") ? ["markdown"] : [])].includes(String(format))) return { ok: false, message: `--format must be json or table`, topic: name }
  const compat = flags.get("compat")
  if (compat !== undefined && compat !== COMPAT) return { ok: false, message: `--compat must be ${COMPAT}`, topic: name }
  const common: Common = { json: flags.has("json") || format === "json" || compat === COMPAT, ...(compat === COMPAT ? { compat } : {}), ...(typeof flags.get("dir") === "string" ? { dir: String(flags.get("dir")) } : {}) }
  if ((name === "workflow" || name === "loop") && ["events", "artifacts", "receipt", "export"].includes(sub ?? "")) {
    if (rest.length !== 1) return { ok: false, message: `${name} ${sub} needs one <id>`, topic: name }
    const query: { limit?: number; before?: number; run?: number } = {}
    for (const field of ["limit", "before", "run"] as const) {
      const value = number(flags, field, { min: field === "run" ? 0 : 1, integer: true })
      if (isError(value) || field === "limit" && value !== undefined && value > 100) return { ok: false, message: `--${field} needs ${field === "limit" ? "1..100" : field === "run" ? "a nonnegative integer" : "a positive integer"}`, topic: name }
      if (value !== undefined) query[field] = value
    }
    return { ok: true, command: { ...common, kind: "automation.ledger", scope: name, id: rest[0]!, operation: sub as "events" | "artifacts" | "receipt" | "export", ...query, exportFormat: format === "markdown" ? "markdown" : "json" } }
  }
  const bad = (message: string): ParseResult => ({ ok: false, message, topic: name })
  const ok = (command: DistributiveOmit<Automation, keyof Common>): ParseResult => ({ ok: true, command: { ...common, ...command } as Automation })
  const text = rest.join(" ").trim()
  const str = (flag: string) => (typeof flags.get(flag) === "string" ? String(flags.get(flag)) : undefined)
  if (name === "plugin" || name === "plug") return !sub || rest.length ? bad("plugin needs exactly one module") : ok({ kind: "plugin.install", spec: sub, global: flags.has("global"), force: flags.has("force") })
  if (name === "plugin-auth") return rest.length > 1 || rest[0] !== undefined && !/^\d+$/.test(rest[0]) ? bad("plugin-auth needs a provider and optional method index") : ok({ kind: "plugin.auth", ...(sub ? { provider: sub } : {}), method: Number(rest[0] ?? 0) })

  const registry = name === "runtime" && sub === "registry" || name === "control-plane" && sub === "runtime" && rest[0] === "registry"
  const packageArgs = registry ? positionals.slice(name === "runtime" ? 2 : 3) : name === "control-plane" && ["packages", "marketplace"].includes(sub ?? "") ? positionals.slice(2) : ["package", "packages", "marketplace"].includes(name) ? positionals.slice(1) : undefined
  if (packageArgs) {
    const parsed = packageArguments(packageArgs, flags, registry, repeated)
    if (parsed) return "error" in parsed ? bad(parsed.error) : ok(parsed)
  }

  if (name === "export") {
    if (compat !== undefined) return bad("export --compat requires the B36 session-format decision")
    const parsed = parseTransferExport(positionals.slice(1), flags, true)
    return "error" in parsed ? bad(parsed.error) : ok(parsed)
  }
  if (name === "import") {
    const parsed = parseTransferImport(positionals.slice(1), flags)
    return "error" in parsed ? bad(parsed.error) : ok(parsed)
  }
  if (name === "control-plane" && sub === "project") {
    const parsed = parseProjectAutomation(rest, flags)
    if (typeof flags.get("data-dir") === "string") common.dir = String(flags.get("data-dir"))
    return "error" in parsed ? bad(parsed.error) : ok(parsed)
  }

  if (name === "memory" || name === "control-plane" && sub === "memory") {
    const parsed = parseMemoryAutomation(name === "memory" ? positionals.slice(1) : positionals.slice(2), flags)
    if (parsed) return "error" in parsed ? bad(parsed.error) : ok(parsed)
    if (name === "control-plane") return parseAutomation(argv.filter((token) => token !== "control-plane"))
  }

  if (name === "control-plane" && (sub === "setup" || sub === "budget")) {
    const [operation = "status", ...extra] = rest
    if (extra.length || !(operation === "status" || operation === "doctor" || sub === "setup" && operation === "plan")) return bad(`Expected control-plane ${sub} ${sub === "setup" ? "status|plan|doctor" : "status|doctor"}`)
    return ok({ kind: "setup.control", target: sub, operation: operation as "status" | "plan" | "doctor" })
  }
  if (name === "prompt" || name === "control-plane" && sub === "prompt") {
    const parsed = parsePromptAutomation(name === "prompt" ? positionals.slice(1) : rest, flags)
    return "error" in parsed ? bad(parsed.error) : ok(parsed)
  }
  if (name === "control-plane" && sub === "permissions") {
    const [operation = "status", argument, ...extra] = rest
    if (extra.length) return bad("Too many permissions arguments")
    if (operation === "status") return argument ? bad("permissions status takes no argument") : ok({ kind: "permissions", operation })
    if (operation === "set-default") {
      if (!["approval", "smart", "full_access", "ask", "edits", "full"].includes(argument ?? "")) return bad("permissions set-default needs approval|smart|full_access|ask|edits|full")
      return ok({ kind: "permissions", operation, mode: argument as NonNullable<Extract<Automation, { kind: "permissions" }>["mode"]> })
    }
    if (operation === "set-reviewer-role") {
      if (!MODEL_ROLES.includes(argument as never)) return bad("permissions set-reviewer-role needs a model role: " + MODEL_ROLES.join(", "))
      return ok({ kind: "permissions", operation, role: argument as import("@mendcode/protocol").ModelRole })
    }
    return bad("Unknown permissions operation: " + operation)
  }

  if (name === "completion") {
    if (sub && !COMPLETION_SHELLS.includes(sub as CompletionShell) || rest.length) return bad("completion needs bash|zsh|fish|powershell")
    return ok({ kind: "completion", shell: (sub ?? "bash") as CompletionShell })
  }
  if (name === "backlog") {
    const origin = { ...(str("session") ? { sessionId: str("session") } : {}) }
    // `--file` may repeat for other commands; an item is born in one file, the last one named.
    const file = repeated.get("file")?.at(-1)
    const words = parseBacklogWords([...(sub ? [sub] : []), ...(sub === "add" ? [...(file ? ["--file", file] : []), ...(str("commit") ? ["--commit", str("commit")!] : [])] : []), ...rest], origin)
    if (words.kind === "error") return bad(`backlog: ${words.message}`)
    if (words.kind === "open") return bad("backlog open works in the terminal UI (/backlog open <id>)")
    return ok({ kind: "backlog", words })
  }
  if (name === "context") {
    const limit = number(flags, "limit", { min: 1, integer: true })
    if (!sub || rest.length) return bad("context needs <sessionID>")
    if (isError(limit) || (limit ?? 20) > 100) return bad("--limit needs an integer from 1 to 100")
    return ok({ kind: "context", id: sub, limit: limit ?? 20 })
  }
  if (name === "status" || name === "doctor") {
    if (sub) return bad(`${name} takes no arguments`)
    return ok({ kind: "system", operation: name })
  }
  if (name === "control-plane" && (sub === "ai" || sub === "system")) {
    const operation = rest[0] ?? "status"
    if (sub === "ai") {
      if (!(operation === "status" && rest.length <= 1 || operation === "env" && rest.length <= 2 && (!rest[1] || rest[1] === "status"))) return bad("Expected control-plane ai status|env [status]")
      return ok({ kind: "system", operation: operation === "env" ? "ai-env" : "ai-status" })
    }
    if (rest.length > 1 || !["status", "doctor", "check", "toolchain", "config-paths", "config-layers", "precedence", "adapter-status"].includes(operation)) return bad("Unknown system operation: " + operation)
    return ok({ kind: "system", operation: operation as Extract<Automation, { kind: "system" }>["operation"] })
  }
  if (name === "debug") {
    const operation = rest[0]
    if (sub !== "rg" || !["tree", "files", "search"].includes(operation ?? "")) return bad("Expected debug rg tree|files|search")
    const query = operation === "search" ? rest[1] : str("query")
    if (operation === "search" && !query || rest.length > (operation === "search" ? 2 : 1)) return bad("search needs one pattern")
    const limit = number(flags, "limit", { min: 1, integer: true })
    if (isError(limit) || (limit ?? 1) > 10000) return bad("--limit needs an integer from 1 to 10000")
    const glob = repeated.get("glob")
    if (glob && (glob.length > 20 || glob.some((value) => !value || value.length > 500))) return bad("--glob needs at most 20 patterns of 1–500 characters")
    if (query && query.length > 1000) return bad("query must be at most 1000 characters")
    return ok({ kind: "files", operation: operation as "tree" | "files" | "search", ...(query ? { query } : {}), ...(limit ? { limit } : {}), ...(glob ? { glob } : {}) })
  }
  if (name === "generate") {
    if (flags.has("hono")) return bad("unknown generate flag --hono; use --httpapi")
    if (sub) return bad("generate accepts no positional arguments")
    const backend = flags.has("httpapi") ? "httpapi" : "protocol"
    if ((flags.has("index") || flags.has("entry")) && backend !== "protocol") return bad("--index and --entry apply to the protocol schema only")
    if (flags.has("index") && flags.has("entry")) return bad("generate accepts --index or --entry, not both")
    if (flags.has("entry") && !str("entry")) return bad("--entry needs a name from generate --index, e.g. command:tui.query")
    return ok({ kind: "generate", backend, ...(flags.has("index") ? { index: true } : {}), ...(str("entry") ? { entry: str("entry")! } : {}) })
  }

  if (name === "control-plane" && !packageArgs || name === "tui") {
    if (name === "control-plane" && sub !== "tui") return bad("Expected control-plane tui or permissions")
    const operation = (name === "tui" ? sub : rest[0]) ?? "status"
    if (!TUI_OPERATIONS.includes(operation as never)) return bad("Unknown TUI operation: " + operation)
    if (operation === "propose" && !flags.has("dry-run")) return bad("TUI propose requires --dry-run")
    const state = str("state") ?? "home"
    if (state !== "home" && state !== "session") return bad("--state needs home|session")
    const argument = str("proposal") ?? str("backup") ?? str("preset") ?? (name === "tui" ? rest : rest.slice(1)).join(" ").trim()
    return ok({ kind: "tui", operation: operation as import("@mendcode/protocol/wire").TuiOperation, state, dryRun: flags.has("dry-run"), ...(flags.has("check") ? { check: true } : {}), ...(argument ? { argument } : {}), ...(str("session") ? { session: str("session")! } : {}) })
  }

  if (name === "usage" || name === "stats") {
    if (sub) return bad(`unexpected argument ${sub}`)
    const days = number(flags, "days", { min: 0, integer: true })
    if (isError(days)) return bad(days.error)
    const tools = number(flags, "tools", { min: 0, integer: true })
    if (isError(tools)) return bad(tools.error)
    if (tools !== undefined && tools > 10000) return bad("--tools must be ≤ 10000")
    const models = flags.get("models") === true ? true : number(flags, "models", { min: 0, integer: true })
    if (isError(models)) return bad(models.error)
    const scope = str("scope")
    if (scope !== undefined && !["global", "project", "directory"].includes(scope)) return bad("--scope needs global|project|directory")
    if (flags.has("project") && scope && scope !== "project") return bad("--project needs project scope")
    return ok({ kind: name, ...(days !== undefined ? { days } : name === "usage" ? { days: DEFAULT_USAGE_DAYS } : {}),
      ...(tools === undefined ? {} : { tools }), ...(models === undefined ? {} : { models }),
      ...(scope ? { scope: scope as "global" | "project" | "directory" } : {}), ...(flags.has("project") ? { project: str("project") ?? "" } : {}),
      ...(flags.has("waste") ? { waste: true as const } : {}),
    })
  }

  if (name === "storage") {
    const olderThan = str("older-than")
    const days = olderThan === undefined ? undefined : /^(\d+)d?$/.exec(olderThan)?.[1]
    if (olderThan !== undefined && days === undefined) return bad("--older-than needs a number of days like 90d")
    const clean = flags.has("clean")
    const compactData = flags.has("compact")
    const offline = offlineOption
    if (offline && (!compactData || clean || flags.has("worktrees") || flags.has("vacuum") || str("delta-idle") !== undefined || !str("dir"))) return bad("--offline requires --compact and --dir; cannot combine with cleanup options")
    const worktrees = flags.has("worktrees")
    const idle = (flag: string) => {
      const value = str(flag)
      const parsed = value === undefined ? undefined : /^(\d+)d?$/.exec(value)?.[1]
      return value !== undefined && parsed === undefined ? ({ error: `--${flag} needs a number of days like 14d` } as const) : ({ days: parsed === undefined ? undefined : Number(parsed) } as const)
    }
    const deltaIdle = idle("delta-idle")
    const worktreeIdle = idle("worktree-idle")
    if ("error" in deltaIdle) return bad(deltaIdle.error)
    if ("error" in worktreeIdle) return bad(worktreeIdle.error)
    if (!clean && olderThan !== undefined) return bad("--older-than and --dry-run need --clean")
    if (!clean && !compactData && flags.has("dry-run")) return bad("--older-than and --dry-run need --clean or --compact")
    if (!compactData && deltaIdle.days !== undefined) return bad("--delta-idle needs --compact")
    if (!worktrees && worktreeIdle.days !== undefined) return bad("--worktree-idle needs --worktrees")
    if (flags.has("dry-run") && flags.has("vacuum")) return bad("--dry-run cannot vacuum")
    return ok({
      kind: "storage",
      clean: clean || compactData || flags.has("vacuum"),
      ...(clean ? (days === undefined ? {} : { olderThanDays: Number(days) }) : { olderThanDays: 0 }),
      dryRun: flags.has("dry-run"),
      vacuum: flags.has("vacuum"),
      compact: compactData,
      ...(offline ? { offline: true } : {}),
      ...(deltaIdle.days === undefined ? {} : { deltaIdleDays: deltaIdle.days }),
      worktrees,
      ...(worktreeIdle.days === undefined ? {} : { worktreeIdleDays: worktreeIdle.days }),
    })
  }

  if (name === "profile") {
    const permission = str("permission")
    if (permission !== undefined && !["ask", "edits", "full"].includes(permission)) return bad("--permission needs ask, edits or full")
    switch (sub) {
      case undefined:
      case "list":
        return ok({ kind: "profile.list" })
      case "add":
        if (!rest[0] || !PROFILE_NAME.test(rest[0]) || rest[0] === DEFAULT_PROFILE) return bad(`profile add needs a name (lowercase letters, digits, -; not "${DEFAULT_PROFILE}")`)
        if (rest.length < 2) return bad("profile add needs at least one folder")
        return ok({ kind: "profile.add", name: rest[0], folders: rest.slice(1), ...(permission ? { permission: permission as "ask" | "edits" | "full" } : {}) })
      case "remove":
        return rest[0] ? ok({ kind: "profile.remove", name: rest[0] }) : bad("profile remove needs <name>")
      default:
        return bad(`unknown profile command "${sub}"`)
    }
  }

  if (name === "lsp") {
    if (sub !== "install") return bad(sub ? `unknown lsp command "${sub}"` : "lsp needs a command: install <typescript|python|go>")
    const server = rest[0]
    return server === "typescript" || server === "python" || server === "go" ? ok({ kind: "lsp.install", server }) : bad("lsp install needs typescript, python or go")
  }

  if (name === "recipe") {
    if (sub === "list") return ok({ kind: "recipe.list" })
    if (sub === "apply") return rest[0] ? ok({ kind: "recipe.apply", name: rest[0] }) : bad("recipe apply needs <name>")
    return bad(sub ? `unknown recipe command "${sub}"` : "recipe needs a command")
  }

  if (["package", "packages", "marketplace"].includes(name) || name === "control-plane" && ["packages", "marketplace"].includes(sub ?? "")) {
    const scope: PackageScope = flags.has("project") ? "project" : "user"
    const [action = "status", target] = packageArgs ?? []
    switch (action) {
      case "status":
      case "list":
        return ok({ kind: "package.list" })
      case "install":
        return target ? ok({ kind: "package.install", source: target, scope, replace: flags.has("replace") }) : bad("package install needs <folder|npm:name@x.y.z|github:owner/repo|git:URL>")
      case "capture":
        return target && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(target) ? ok({ kind: "package.capture", name: target, replace: flags.has("replace") }) : bad("package capture needs <name> (lowercase letters, digits, . _ -) [--replace]")
      case "remove":
        return target ? ok({ kind: "package.remove", name: target, scope, purge: flags.has("purge") }) : bad("package remove needs <name> [--purge]")
      case "restore":
        return target ? ok({ kind: "package.restore", name: target, scope }) : bad("package restore needs <name>")
      case "enable":
      case "disable":
      case "deselect":
        return target ? ok({ kind: "package.enable", name: target.replace(/^(user|project):/, ""), scope: target.startsWith("project:") ? "project" : target.startsWith("user:") ? "user" : scope, enabled: action === "enable", switch: flags.has("switch") }) : bad(`package ${action} needs <name>`)
      default:
        return bad(`unknown package command "${action}"`)
    }
  }

  if (name === "session") {
    const parsed = parseSession(sub, rest, flags, repeated)
    const { dir: _dir, ...sessionCommon } = common
    return "error" in parsed ? bad(parsed.error) : { ok: true, command: { ...sessionCommon, ...sessionDirectories(argv), ...parsed.command } }
  }

  if (name === "memory") {
    switch (sub) {
      case "list":
        return ok({ kind: "memory.list", ...(str("status") ? { status: str("status")! } : {}) })
      case "add":
        return text ? ok({ kind: "memory.add", text, user: flags.has("user"), ...(str("category") ? { category: str("category")! } : {}) }) : bad('memory add needs "text"')
      case "search": {
        const limit = number(flags, "limit", { min: 1, integer: true })
        if (isError(limit)) return bad(limit.error)
        return text ? ok({ kind: "memory.search", query: text, ...(limit ? { limit } : {}) }) : bad('memory search needs "query"')
      }
      default:
        return bad(sub ? `unknown memory command "${sub}"` : "memory needs a command")
    }
  }

  if (name === "workflow") {
    const id = rest[0]
    /** `run`/`start`/`preview` of a script: `<file.js|name>` then `--args JSON` or `key=value` words. Without --yes it only previews. */
    const scriptRun = (previewOnly: boolean): ParseResult => {
      if (!id) return bad("workflow run needs <file.js|name>")
      if (!isScriptFile(id) && !id.includes("/") && !WORKFLOW_NAME.test(id)) return bad(`"${id}" is neither a .js file nor a saved script name (a-z 0-9 . _ -)`)
      const extra = rest.slice(1).join(" ")
      const given = str("args")
      if (given !== undefined && extra) return bad("give arguments either as --args JSON or as key=value words")
      const parsed = parseRunArguments(given ?? extra)
      if (!parsed.ok) return bad(parsed.error)
      const script: ScriptRun = parsed.args ? { args: parsed.args } : {}
      if (previewOnly) return ok({ kind: "workflow.preview", target: id, script })
      const permission = str("permission")
      if (permission !== undefined && !WORKFLOW_PERMISSIONS.includes(permission as WorkflowPermission)) return bad("--permission must be ask, edits or full")
      if (flags.has("timeout") && !flags.has("wait")) return bad("--timeout needs --wait")
      const timeout = number(flags, "timeout", { min: 0.001 })
      if (isError(timeout)) return bad(timeout.error)
      return ok({ kind: "workflow.start", target: id, script, ...(permission ? { permission: permission as WorkflowPermission } : {}), yes: flags.has("yes"), wait: flags.has("wait"), ...(timeout ? { timeoutMs: timeout * 1000 } : {}) })
    }
    switch (sub) {
      case "run":
        return scriptRun(false)
      case "new": {
        if (!id || rest.length > 1 || !WORKFLOW_NAME.test(id)) return bad("workflow new needs one <name> (a-z 0-9 . _ -)")
        const out = str("out")
        return ok({ kind: "workflow.new", name: id, ...(out ? { out } : {}) })
      }
      case "convert": {
        if (!id || rest.length > 1 || !id.endsWith(".json")) return bad("workflow convert needs one <plan.json>")
        const out = str("out")
        return ok({ kind: "workflow.convert", target: id, ...(out ? { out } : {}) })
      }
      case "budget": {
        if (!id || rest.length > 1) return bad("workflow budget needs <id> and at least one of --agents --tokens --usd --minutes")
        const budget: { agents?: number; tokens?: number; usd?: number; minutes?: number } = {}
        for (const key of ["agents", "tokens", "usd", "minutes"] as const) {
          const value = number(flags, key, { min: 0.000001 })
          if (isError(value)) return bad(value.error)
          if (value !== undefined) budget[key] = value
        }
        return Object.keys(budget).length ? ok({ kind: "workflow.script", id, budget }) : bad("workflow budget needs at least one of --agents --tokens --usd --minutes")
      }
      case "update": {
        const file = rest[1]
        if (!id || !file || rest.length > 2 || !isScriptFile(file)) return bad("workflow update needs <id> <file.js>")
        return ok({ kind: "workflow.update", id, file })
      }
      case "list":
      case "status":
        return ok({ kind: "workflow.list", all: flags.has("all") })
      case "definitions": {
        const limit = number(flags, "limit", { min: 1, integer: true })
        if (isError(limit) || (limit ?? 50) > 100) return bad("--limit must be 1–100")
        return ok({ kind: "workflow.definitions", limit: limit ?? 50 })
      }
      case "revision":
        return id && /^wfr_[a-zA-Z0-9_-]{1,80}$/.test(id) ? ok({ kind: "workflow.revision", revisionId: id }) : bad("workflow revision needs a revision id")
      case "save": {
        const target = id ?? str("plan-file")
        if (!target || rest.length > 1 || id && flags.has("plan-file")) return bad("workflow save needs one <file.json|name> or --plan-file FILE")
        if (!isPlanFile(target) && !WORKFLOW_NAME.test(target)) return bad("save needs a .json file or saved plan name")
        const definitionId = str("definition-id")
        if (definitionId && !/^wfd_[a-zA-Z0-9_-]{1,80}$/.test(definitionId)) return bad("--definition-id needs a workflow definition id")
        const source = str("source")
        if (source && !["manual", "saved", "template", "package", "session-generated"].includes(source)) return bad("invalid workflow source")
        const name = str("name")
        const description = str("description")
        if (name !== undefined && (!name.trim() || name.length > 120) || (description?.length ?? 0) > 2_000) return bad("workflow name is 1–120 characters; description is at most 2000")
        return ok({ kind: "workflow.save", target, ...(definitionId ? { definitionId } : {}), ...(name ? { name } : {}), ...(description !== undefined ? { description } : {}), ...(source ? { source: source as import("@mendcode/protocol").WorkflowDefinition["source"] } : {}) })
      }
      case "preview":
      case "start": {
        if (id && isScriptFile(id)) return scriptRun(sub === "preview")
        const definitionId = str("definition-id")
        const revisionId = str("revision-id")
        if (!id && !str("plan-file") && !definitionId && !revisionId) return bad(`workflow ${sub} needs <file.json|name> or --definition-id/--revision-id`)
        if (definitionId && !/^wfd_[a-zA-Z0-9_-]{1,80}$/.test(definitionId) || revisionId && !/^wfr_[a-zA-Z0-9_-]{1,80}$/.test(revisionId)) return bad("invalid workflow definition/revision id")
        if ([id, str("plan-file"), definitionId, revisionId].filter((v) => v !== undefined).length !== 1) return bad(`workflow ${sub} needs one plan, definition or revision`)
        const target = id ?? str("plan-file") ?? (definitionId ? `definition:${definitionId}` : `revision:${revisionId}`)
        if (rest.length > 1) return bad(`workflow ${sub} takes one <file.json|name>`)
        if (!definitionId && !revisionId && !isPlanFile(target) && !WORKFLOW_NAME.test(target)) return bad(`"${target}" is neither a .json file nor a saved plan name (a-z 0-9 . _ -)`)
        if (sub === "preview") return ok({ kind: "workflow.preview", target })
        const permission = str("permission")
        if (permission !== undefined && !WORKFLOW_PERMISSIONS.includes(permission as WorkflowPermission)) return bad("--permission must be ask, edits or full")
        if (flags.has("timeout") && !flags.has("wait")) return bad("--timeout needs --wait")
        const timeout = number(flags, "timeout", { min: 0.001 })
        if (isError(timeout)) return bad(timeout.error)
        return ok({ kind: "workflow.start", target, ...(permission ? { permission: permission as WorkflowPermission } : {}), yes: flags.has("yes"), wait: flags.has("wait"), ...(timeout ? { timeoutMs: timeout * 1000 } : {}) })
      }
      case "show":
        return id ? ok({ kind: "workflow.show", id }) : bad("workflow show needs <id>")
      case "pause":
      case "resume":
      case "stop":
      case "verify":
      case "delete":
        return id ? ok({ kind: "workflow.control", id, action: sub }) : bad(`workflow ${sub} needs <id>`)
      case "retry":
      case "retry-task": {
        if (!id) return bad("workflow retry needs <id>")
        const task = str("task") ?? str("task-id")
        if (!task) return bad("workflow retry needs --task <taskId>")
        if (!WORKFLOW_SLUG.test(task)) return bad("--task needs a task id like build or test-1")
        const reason = str("reason")?.trim()
        if (reason && reason.length > MAX_REASON_CHARS) return bad("--reason is at most 500 characters")
        const timeout = number(flags, "timeout", { min: 0.001 })
        if (isError(timeout)) return bad(timeout.error)
        if (timeout && !flags.has("wait")) return bad("--timeout needs --wait")
        return ok({ kind: "workflow.control", id, action: "retry", taskId: task, ...(reason ? { reason } : {}), ...(flags.has("wait") ? { wait: true } : {}), ...(timeout ? { timeoutMs: timeout * 1000 } : {}) })
      }
      case "approve":
      case "reject": {
        if (!id) return bad(`workflow ${sub} needs <id>`)
        const task = str("task") ?? str("task-id")
        if (!task) return bad(`workflow ${sub} needs --task <taskId>`)
        if (!WORKFLOW_SLUG.test(task)) return bad("--task needs a task id like gate-1 or review")
        const reason = str("reason")?.trim()
        if (reason && reason.length > MAX_REASON_CHARS) return bad(`--reason is at most ${MAX_REASON_CHARS} characters`)
        return ok({ kind: "workflow.control", id, action: sub, taskId: task, ...(reason ? { reason } : {}) })
      }
      case "accept": {
        if (!id) return bad("workflow accept needs <id>")
        const reason = str("reason")?.trim()
        if (!reason) return bad('workflow accept needs --reason "…"')
        if (reason.length > MAX_REASON_CHARS) return bad(`--reason is at most ${MAX_REASON_CHARS} characters`)
        return ok({ kind: "workflow.control", id, action: "accept", reason })
      }
      default:
        return bad(sub ? `unknown workflow command "${sub}"` : "workflow needs a command")
    }
  }

  // loop
  switch (sub) {
    case "list":
      return ok({ kind: "loop.list", all: flags.has("all") })
    case "pause":
    case "resume":
    case "stop":
    case "run":
    case "delete":
      return rest[0] ? ok({ kind: "loop.control", id: rest[0], action: sub }) : bad(`loop ${sub} needs <id>`)
    case "fire": {
      if (!rest[0]) return bad("loop fire needs <id>")
      const note = str("note")?.trim()
      if (note !== undefined && (note.length < 1 || note.length > 500)) return bad("--note needs 1 to 500 characters")
      return ok({ kind: "loop.fire", id: rest[0], ...(note ? { note } : {}) })
    }
    case "create": {
      if (!text) return bad('loop create needs "objective"')
      const every = str("every")
      const daily = str("daily")
      if (every && daily) return bad("use --every or --daily, not both")
      const everyMs = every ? parseEvery(every) : undefined
      if (every && (everyMs === undefined || everyMs < 60_000)) return bad("--every needs 30m, 1h, 2d … (at least 1m)")
      if (daily && !/^([01]\d|2[0-3]):[0-5]\d$/.test(daily)) return bad("--daily needs HH:MM")
      const runs = number(flags, "runs", { min: 1, integer: true })
      if (isError(runs)) return bad(runs.error)
      const budget = flags.has("goal") ? { mode: "goal" as const, ...(runs ? { maxRuns: runs } : {}) } : runs ? { mode: "fixed" as const, maxRuns: runs } : { mode: "monitor" as const }
      const trigger = everyMs ? { kind: "interval" as const, everyMs } : daily ? { kind: "daily" as const, at: daily } : { kind: "manual" as const }
      if (trigger.kind === "manual" && !flags.has("now")) return bad("loop create needs --every, --daily or --now")
      const checks = (repeated.get("check") ?? []).map((command) => command.trim())
      if (checks.some((command) => !command || command.length > MAX_CHECK_CHARS)) return bad(`--check needs a command of 1 to ${MAX_CHECK_CHARS} characters`)
      if (checks.length > MAX_CHECKS) return bad(`at most ${MAX_CHECKS} --check`)
      if ((checks.length > 0 || flags.has("no-audit")) && !flags.has("goal")) return bad("--check and --no-audit need --goal")
      return ok({ kind: "loop.create", objective: text, name: str("name") ?? text.replace(/\s+/g, " ").slice(0, NAME_CHARS), trigger, budget, ...(str("criteria") ? { criteria: str("criteria")! } : {}), ...(checks.length ? { checks } : {}), ...(flags.has("no-audit") ? { audit: "none" as const } : {}), runNow: flags.has("now") })
    }
    default:
      return bad(sub ? `unknown loop command "${sub}"` : "loop needs a command")
  }
}

/** A plan argument ending in `.json` or containing a slash is a file; anything else is a saved plan name. */
export const isPlanFile = (target: string) => target.endsWith(".json") || target.includes("/")

export function helpText(topic?: string) {
  return `${topic === "project" ? PROJECT_USAGE : topic === "control-plane" ? USAGE[topic] + "\n" + PROJECT_USAGE + "\n" + MFLOW_USAGE : (topic && USAGE[topic]) || HELP}\n`
}

// ---------------------------------------------------------------------------------------------
// Execution

export type AutomationDeps = {
  client: Pick<Client, "send" | "subscribe">
  /** Routes pushed session events to `handler` (the client's `onEvent` is fixed at construction). */
  listen(handler: ((event: SessionEvent) => void) | undefined): void
  out: { write(text: string): unknown }
  err: { write(text: string): unknown }
  cwd: string
  /** Home directory, for `~` in profile folders. */
  home?: string
  now(): number
  /** Ctrl-C / SIGTERM: ends a `--follow` stream cleanly. */
  onInterrupt(callback: () => void): void
  setTimer?(ms: number, callback: () => void): { cancel(): void }
  /** Routes pushed global events (`workflow.changed`) to `handler`; the client's `onGlobal` is fixed at construction. Needed by `workflow start --wait`. */
  listenGlobal?(handler: ((event: GlobalEvent) => void) | undefined): void
  /** Builds the HTTP adapter's OpenAPI document for `generate --httpapi` (default: lazy daemon import, no listener). */
  httpApi?(): Promise<Record<string, unknown>>
  /** Reads a plan file as JSON (default: `Bun.file(path).json()`). */
  readJson?(file: string): Promise<unknown>
  /** Script workflow files: read as text and written (default: `Bun.file`/`Bun.write`). */
  readText?(file: string): Promise<string>
  writeText?(file: string, text: string): Promise<void>
  /** Whether a file exists, so `workflow new|convert` never overwrite one. */
  exists?(file: string): Promise<boolean>
  /** Injectable line source for the read-only SQL shell. */
  sqlLines?(): AsyncIterable<string>
  /** Paths are read by the local daemon; remote attachments stay disabled. */
  allowFiles?: boolean
  prompt?(request: import("./catalog-automation").CatalogPrompt): Promise<string | undefined>
  isTTY?: boolean
  terminalSize?: { width: number; height: number }
  drawLoopFrame?(rows: import("./ui/theme").Line[]): void
  env?: Record<string, string | undefined>
  openPr?(report: import("@mendcode/protocol").PrCheckoutReport): Promise<void>
}

const defaultReadJson = (file: string): Promise<unknown> => Bun.file(file).json()
const defaultExists = (file: string): Promise<boolean> => Bun.file(file).exists()
const defaultReadText =(file: string): Promise<string> => Bun.file(file).text()
const defaultWriteText = async (file: string, text: string): Promise<void> => void (await Bun.write(file, text))

const defaultTimer = (ms: number, callback: () => void) => {
  const handle = setTimeout(callback, ms)
  return { cancel: () => clearTimeout(handle) }
}

export function localDay(at: number) {
  const date = new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

/** What a session's persisted events say about it right now. */
export function foldSession(events: SessionEvent[]) {
  let foreground = "idle"
  let queued = 0
  let activeTurn: string | undefined
  for (const event of events) {
    if (event.type === "foreground.state") foreground = event.state
    else if (event.type === "queue.changed") queued = event.queue.length
    else if (event.type === "turn.started") activeTurn = event.turnId
    else if (event.type === "turn.completed" || event.type === "turn.cancelled" || event.type === "turn.interrupted" || event.type === "turn.failed") activeTurn = undefined
  }
  return { foreground, queued, activeTurn }
}

const ageOf = (now: number, then: number) => relativeTime(now, then)

export function sessionRows(sessions: SessionSummary[], now: number, showDirectory: boolean) {
  if (sessions.length === 0) return "no sessions\n"
  return sessions.map((s) => [s.sessionId, s.state.padEnd(16), ageOf(now, s.updatedAt).padStart(4), labelString(sessionLabel(s, { untitled: "untitled", marker: "draft" })), ...(s.archivedAt !== undefined ? ["[archived]"] : []), ...(showDirectory ? [`(${s.directory})`] : [])].join("  ")).join("\n") + "\n"
}

export function memoryRows(memories: MemoryEntry[]) {
  if (memories.length === 0) return "no memories\n"
  return memories.map((m) => `${m.memoryId}  ${m.scope.padEnd(7)}  ${m.status.padEnd(8)}  ${m.category ? `[${m.category}] ` : ""}${m.text.replace(/\s+/g, " ")}`).join("\n") + "\n"
}

function triggerText(loop: Loop) {
  const t = loop.trigger
  if (t.kind === "manual" || t.kind === "external") return t.kind
  if (t.kind === "daily") return `daily ${t.at}`
  const every = t.everyMs % 3_600_000 === 0 ? `${t.everyMs / 3_600_000}h` : `${Math.round(t.everyMs / 60_000)}m`
  return t.kind === "adaptive" ? `adaptive ~${every}` : `every ${every}`
}

export function profileRows(profiles: readonly Profile[], current: string) {
  const rows = [
    `${current === DEFAULT_PROFILE ? "*" : " "} ${DEFAULT_PROFILE.padEnd(16)} everything else`,
    ...profiles.map((profile) => `${profile.name === current ? "*" : " "} ${profile.name.padEnd(16)} ${profile.directories.join(", ")}${profile.defaultPermission ? `  · ${profile.defaultPermission}` : ""}${profile.models ? "  · own roles" : ""}`),
  ]
  return `${rows.join("\n")}\n`
}

export function recipeRows(report: RecipesReport) {
  if (report.recipes.length === 0) return "no recipes\n"
  return (
    report.recipes
      .map((recipe) => {
        const mark = recipe.name === report.active ? "*" : " "
        const detail = recipe.problem ? `problem: ${recipe.problem}` : `${recipe.description}${recipe.version ? `  v${recipe.version}` : ""}`
        return `${mark} ${recipe.name.padEnd(16)} ${recipe.source.padEnd(8)} ${detail}`
      })
      .join("\n") + "\n"
  )
}

export function loopRows(loops: Loop[]) {
  if (loops.length === 0) return "no loops\n"
  return loops.map((l) => `${l.loopId}  ${l.state.padEnd(11)}  ${triggerText(l).padEnd(11)}  runs ${l.runs}  ${l.name}`).join("\n") + "\n"
}

const TASK_MARK: Record<WorkflowRun["tasks"][number]["state"], string> = { pending: "[ ]", running: "[/]", needs_input: "[?]", done: "[x]", failed: "[!]", skipped: "[-]", stopped: "[-]" }
const PERMISSION_RANK: Record<WorkflowPermission, number> = { ask: 0, edits: 1, full: 2 }
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()

export function workflowRows(workflows: WorkflowSummary[]) {
  if (workflows.length === 0) return "no workflows\n"
  return workflows.map((w) => `${w.workflowId}  ${w.state.padEnd(11)}  ${w.tasks.filter((task) => task.state === "done").length}/${w.tasks.length} tasks  ${oneLine(w.name)}  working=${w.tasks.filter((task) => task.state === "running").length} blocked=${w.tasks.filter((task) => task.state === "failed" || task.state === "needs_input").length}`).join("\n") + "\n"
}

/** Tasks that wait on a request, with the session where the user can answer. */
export function waitingLines(workflow: Pick<WorkflowSummary, "tasks">) {
  return workflow.tasks.filter((task) => task.state === "needs_input").map((task) => `waiting: ${task.id}  session ${task.sessionId ?? "-"}\n`)
}

/** The full run: tasks, contract, last verification. */
export function workflowText(run: WorkflowRun) {
  const lines = [`${run.workflowId}  ${run.state}  ${run.permission}  ${run.name}`, `objective: ${oneLine(run.objective)}`]
  if (run.reason) lines.push(`reason: ${oneLine(run.reason)}`)
  if (run.revisionId) lines.push(`definition_id: ${run.definitionId}`, `revision_id: ${run.revisionId} (#${run.revision})`, `plan_hash: ${run.planHash}`)
  lines.push(`tasks ${run.tasks.filter((task) => task.state === "done").length}/${run.tasks.length}:`)
  for (const task of run.tasks) {
    const kind = task.kind === "check" ? "check" : `agent/${task.mode ?? "work"}`
    lines.push(`  ${TASK_MARK[task.state]} ${task.id}  ${task.state.padEnd(11)}  ${kind}  ${task.title}${task.attempt > 1 ? `  (attempt ${task.attempt})` : ""}${task.sessionId ? `  ${task.sessionId}` : ""}`)
    if (task.reason) lines.push(`      ${oneLine(task.reason)}`)
  }
  const contract = run.plan.contract
  if (contract === undefined) lines.push("contract: none (unverified)")
  else if (typeof contract === "string") lines.push(`contract: ${contract}`)
  else {
    lines.push(`contract: ${contract.criteria.length} criteria · audit ${contract.audit} · repairs ${run.repairs}/${contract.maxRepairs}`)
    for (const criterion of contract.criteria) lines.push(`  ${criterion.id}  ${criterion.required ? "required" : "advisory"}  ${oneLine(criterion.text)}`)
    for (const check of contract.checks) lines.push(`  check ${check.id}: ${check.command}`)
  }
  const last = run.verifications.at(-1)
  if (last) {
    lines.push(`verification round ${last.round}: ${last.accepted ? "accepted" : "not accepted"}`)
    for (const gate of last.gates) lines.push(`  ${gate.status === "pass" ? "pass" : "FAIL"}  ${gate.id}${gate.status === "fail" && gate.detail ? `  ${oneLine(gate.detail).slice(0, 120)}` : ""}`)
    for (const criterion of last.criteria) lines.push(`  ${criterion.status.padEnd(10)}  ${criterion.id}  by ${criterion.by}`)
    if (last.audit) lines.push(`  audit ${last.audit.verdict}${last.audit.workspaceChanged ? " (void: workspace changed)" : ""}: ${oneLine(last.audit.findings).slice(0, 200)}`)
  }
  if (run.override) lines.push(`accepted by user: ${oneLine(run.override.reason)}`)
  return `${lines.join("\n")}\n`
}

const record = (value: unknown): Record<string, unknown> | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined)
const word = (value: unknown) => (typeof value === "string" && value ? value : undefined)
const permissionOf = (value: unknown) => (WORKFLOW_PERMISSIONS as readonly unknown[]).includes(value) ? (value as WorkflowPermission) : undefined

/** What a plan will do: tasks with their modes, every check command verbatim, the permission it will run with. */
export function previewText({ target, plan, summary, granted }: { target: string; plan: unknown; summary: unknown; granted?: WorkflowPermission | undefined }) {
  const source = record(plan)
  const inline = source && Array.isArray(source.tasks) ? source : undefined
  const info = record(summary)
  const lines = [`plan: ${word(inline?.name) ?? word(info?.name) ?? target}`]
  const scriptInfo = record(info?.script)
  if (scriptInfo) {
    // A script has no static tasks: what matters before it runs is where it came from, its hash and what it may spend.
    const meta = record(scriptInfo.meta)
    const budget = record(meta?.budget)
    const phases = Array.isArray(meta?.phases) ? meta.phases.map((phase) => word(record(phase)?.title)).filter((title) => title !== undefined) : []
    lines.push(`script: ${word(scriptInfo.origin) ?? "file"} · sha256 ${word(scriptInfo.hash) ?? "?"}`)
    if (word(meta?.description)) lines.push(`  ${word(meta?.description)}`)
    if (phases.length) lines.push(`  phases: ${phases.join(" > ")}`)
    lines.push(`caps: ${budget && Object.keys(budget).length ? Object.entries(budget).map(([key, value]) => `${key} ${String(value)}`).join(", ") : "none declared (limited to 10 agent calls)"}`)
    if (scriptInfo.args !== undefined) lines.push(`arguments: ${JSON.stringify(scriptInfo.args)}`)
    const checkNames = Array.isArray(info?.checks) ? info.checks : []
    for (const command of checkNames) lines.push(`  check: ${String(command)}`)
    const applied = granted ?? permissionOf(info?.permission)
    lines.push(`permission: ${applied ?? "set by the daemon at start"}`)
    return `${lines.join("\n")}\n`
  }
  const taskList = (inline?.tasks ?? info?.tasks) as unknown
  const tasks = Array.isArray(taskList) ? taskList.map(record).filter((task) => task !== undefined) : []
  if (tasks.length) lines.push(`tasks ${tasks.length}:`)
  for (const task of tasks) {
    const kind = word(task.kind) === "check" ? "check" : `agent/${word(task.mode) ?? "work"}`
    lines.push(`  ${word(task.id) ?? "?"}  ${kind}  ${word(task.title) ?? ""}${word(task.command) ? `  $ ${word(task.command)}` : ""}`.trimEnd())
  }
  const contract = record(inline?.contract)
  const checkList = (contract?.checks ?? info?.checks) as unknown
  const checks = Array.isArray(checkList) ? checkList.map((check) => (typeof check === "string" ? { command: check } : record(check))).filter((check) => check !== undefined) : []
  if (typeof inline?.contract === "string") lines.push(`contract: ${inline.contract}`)
  else if (contract) lines.push(`contract: ${Array.isArray(contract.criteria) ? contract.criteria.length : 0} criteria · audit ${word(contract.audit) ?? "auto"}`)
  else if (inline) lines.push("contract: none (unverified)")
  for (const check of checks) lines.push(`  check${word(check.id) ? ` ${word(check.id)}` : ""}: ${word(check.command) ?? "?"}`)
  const caps = [granted ?? permissionOf(info?.permission), permissionOf(inline?.permission)].filter((permission) => permission !== undefined)
  const applied = caps.length ? caps.reduce((low, next) => (PERMISSION_RANK[next] < PERMISSION_RANK[low] ? next : low)) : undefined
  lines.push(applied ? `permission: ${applied}` : "permission: set by the daemon at start")
  return `${lines.join("\n")}\n`
}

export function usageText(report: UsageReport, days: number) {
  const sum = report.days.reduce((a, d) => ({ tokens: a.tokens + d.input + d.output, cached: a.cached + d.cacheRead + d.cacheWrite, reasoning: a.reasoning + d.reasoning, calls: a.calls + d.calls, cost: a.cost + d.costMicros, unknown: a.unknown + d.costUnknownCalls }), { tokens: 0, cached: 0, reasoning: 0, calls: 0, cost: 0, unknown: 0 })
  // The headline counts what the model rows count (input + output), so the rows add up to it; cached and reasoning tokens are named apart.
  const apart = [sum.cached ? `+${compact(sum.cached)} cached` : "", sum.reasoning ? `+${compact(sum.reasoning)} reasoning` : ""].filter(Boolean).join(", ")
  const cost = sum.cost > 0 ? `$${(sum.cost / 1e6).toFixed(2)}${sum.unknown ? ` (+${sum.unknown} unpriced)` : ""}` : sum.unknown ? "n/a" : "$0.00"
  const lines = [`last ${days} days: ${compact(sum.tokens)} tokens${apart ? ` (${apart})` : ""} · ${compact(sum.calls)} calls${report.sessions === undefined ? "" : ` · ${report.sessions} sessions`} · cost ${cost}`]
  for (const model of [...report.models].sort((a, b) => b.input + b.output - (a.input + a.output))) lines.push(`  ${`${model.provider}/${model.model}`.padEnd(36)} ${compact(model.input + model.output).padStart(8)} tokens  ${compact(model.calls).padStart(6)} calls`)
  return `${lines.join("\n")}\n`
}

export function storageText(report: StorageReport, now: number) {
  const total = report.dbBytes + report.walBytes + report.blobBytes
  const lines = [
    `disk: ${formatBytes(total)} (database ${formatBytes(report.dbBytes)} · wal ${formatBytes(report.walBytes)} · blobs ${formatBytes(report.blobBytes)} in ${compact(report.blobs)} files)`,
    `database: events ${formatBytes(report.eventBytes)} · engine history ${formatBytes(report.engineBytes)} · other ${formatBytes(report.otherBytes)} (${formatBytes(report.freeBytes)} free) · auto-vacuum ${report.autoVacuum}`,
    `orphaned blobs: ${compact(report.orphanBlobs)} (${formatBytes(report.orphanBytes)})`,
    `${compact(report.sessions)} sessions · ${compact(report.events)} events`,
  ]
  if (report.turns) lines.push(`per turn: ${formatBytes(Math.round(report.eventBytes / report.turns))} of events · ${compact(report.turns)} turns`)
  if (report.eventTypes?.length) lines.push(`events by size: ${report.eventTypes.slice(0, 4).map((entry) => `${entry.type} ${formatBytes(entry.bytes)} (${compact(entry.count)})`).join(" · ")}`)
  if (report.snapshotBytes !== undefined) lines.push(`undo snapshots: ${formatBytes(report.snapshotBytes)} · ${compact(report.snapshotObjects ?? 0)} shared objects for ${compact(report.snapshotRefs ?? 0)} references`)
  if (report.compressedRows !== undefined) lines.push(`compression: ${compact(report.compressedRows)} compact rows · saves ${formatBytes(report.savedBytes ?? 0)}${report.savedBytes === 0 ? " (run storage --compact to move older data)" : ""}`)
  if (report.forkRefs) lines.push(`forks: ${compact(report.forkRefs)} share ${compact(report.sharedMessages ?? 0)} model messages (${formatBytes(report.sharedBytes ?? 0)} read, stored once)${report.eventObjects ? ` · ${compact(report.eventObjects)} tool outputs shared by ${compact(report.eventObjectRefs ?? 0)} references` : ""}`)
  if (report.trashBytes) lines.push(`worktree trash: ${formatBytes(report.trashBytes)} (storage --clean --worktrees removes old copies)`)
  if (report.topSessions.length) {
    lines.push("top sessions:")
    for (const session of report.topSessions) lines.push(`  ${formatBytes(session.bytes).padStart(9)}  ${relativeTime(now, session.updatedAt).padStart(4)}  ${session.title.trim() || "untitled"}  (${session.directory})`)
  }
  return `${lines.join("\n")}\n`
}

function contentsText(contents: PackageInfo["contents"]) {
  const parts = [["tool", contents.tools], ["skill", contents.skills], ["command", contents.commands], ["theme", contents.themes]] as const
  const listed = parts.filter(([, count]) => count > 0).map(([label, count]) => `${count} ${label}${count === 1 ? "" : "s"}`)
  return [...listed, ...(contents.mcp ? ["mcp"] : [])].join(", ") || "empty"
}

export function packageRows(packages: PackageInfo[]) {
  if (packages.length === 0) return "no packages\n"
  return (
    packages
      .map((p) => {
        const version = p.manifest?.version ? `@${p.manifest.version}` : ""
        const state = p.problem ? "problem" : p.enabled ? "on" : "off"
        return `${p.key}${version}  ${state.padEnd(7)}  ${contentsText(p.contents)}${p.problem ? `  (${p.problem})` : p.manifest ? `  ${p.manifest.description}` : ""}`
      })
      .join("\n") + "\n"
  )
}

export function cleanText(result: StorageCleanResult) {
  const scope = result.olderThanDays > 0 ? `${result.sessionsRemoved} sessions older than ${result.olderThanDays} days (${compact(result.eventsRemoved)} events)` : "no sessions"
  const head = result.dryRun ? `would remove ${scope}, ${result.blobsRemoved} blobs · ≈${formatBytes(result.bytesReclaimed)}` : `removed ${scope}, ${result.blobsRemoved} blobs · freed ${formatBytes(result.bytesReclaimed)}${result.vacuumed ? " · vacuumed" : ""}`
  const extra = [
    ...(result.compactedRows !== undefined ? [`${result.dryRun ? "would move" : "moved"} ${compact(result.compactedRows)} rows to compact form${result.compactComplete === false ? " (more remain: run again)" : ""}`] : []),
    ...(result.deltaEventsRemoved ? [`${result.dryRun ? "would drop" : "dropped"} ${compact(result.deltaEventsRemoved)} streaming deltas`] : []),
    ...(result.worktreesRemoved !== undefined ? [`${result.dryRun ? "would remove" : "removed"} ${result.worktreesRemoved} worktrees/trash entries · ${formatBytes(result.worktreeBytes ?? 0)}`] : []),
  ]
  return `${head}${result.protectedSessions ? ` · kept ${result.protectedSessions} protected` : ""}\n${extra.map((line) => `${line}\n`).join("")}`
}

export function worktreeStorageText(report: StorageWorktreesReport) {
  if (report.worktrees.length === 0 && report.trashBytes === 0 && report.loopBytes === 0) return "no worktrees created by the daemon\n"
  const lines = [`worktrees: ${formatBytes(report.totalBytes)} in ${report.worktrees.length} · removable ${formatBytes(report.removableBytes)} · trash ${formatBytes(report.trashBytes)} · loop worktrees ${formatBytes(report.loopBytes)}`]
  for (const tree of report.worktrees) lines.push(`  ${formatBytes(tree.bytes).padStart(9)}  ${tree.removable ? "removable" : "kept     "}  ${tree.state.padEnd(8)} ${tree.branch ?? "(detached)"}  ${tree.directory}${tree.keep ? `  (${tree.keep})` : ""}`)
  return `${lines.join("\n")}\n`
}

function eventLine(event: SessionEvent) {
  const detail = "text" in event && typeof event.text === "string" ? ` ${event.text.replace(/\s+/g, " ").slice(0, 80)}` : "kind" in event ? ` ${String(event.kind)}` : ""
  return `#${event.seq} ${event.type}${detail}\n`
}

/** Runs one parsed command and resolves with the process exit code. Never throws for expected failures. */
export async function runAutomation(command: Automation, deps: AutomationDeps): Promise<number> {
  if (isLoopAutomation(command)) return runLoopAutomation(command, deps)
  if (command.kind === "github.install" || command.kind === "github.run" || command.kind === "pr") return (await import("./github-automation")).createGithubAutomation(deps)(command)
  const { client, out, err } = deps
  const setTimer = deps.setTimer ?? defaultTimer
  const dir = command.projectDir ? path.resolve(deps.cwd, command.projectDir) : deps.cwd
  const line = (value: Parameters<typeof compatEnvelope>[0]) => out.write(`${JSON.stringify(command.compat ? compatEnvelope(value, deps.now()) : { schema: SCHEMA, ...value })}\n`)
  const result = (data: Record<string, unknown>, human: string) => {
    if (command.json) line({ kind: "result", command: command.kind === "memory.control" ? `memory.${command.input.operation}` : command.kind === "dream.control" ? `memory.dream.${command.input.operation}` : command.kind, data })
    else out.write(human)
    return EXIT.ok
  }
  const fail = (message: string, code: number = EXIT.failed, errorCode = "failed") => {
    if (command.json) line({ kind: "error", command: command.kind, error: { code: errorCode, message } })
    else err.write(`error: ${message}\n`)
    return code
  }
  const daemon = async (request: Parameters<typeof client.send>[0]) => {
    const reply = await client.send(request)
    return reply.ok ? { ok: true as const, result: reply.result ?? {} } : { ok: false as const, code: reply.error.code, message: reply.error.message }
  }
  /** Subscribes from `after` and returns the events up to the session's last seq, then keeps `onLive` attached. */
  const history = async (id: string, after: number, onLive?: (event: SessionEvent) => void) => {
    const seen: SessionEvent[] = []
    let lastSeq: number | undefined
    deps.listen((event) => {
      if (lastSeq === undefined || event.seq <= lastSeq) seen.push(event)
      else onLive?.(event)
    })
    const reply = await client.subscribe(id as SessionId, after)
    if (!reply.ok) {
      deps.listen(undefined)
      return { error: reply.error.code === "unknown_session" ? `unknown session ${id}` : reply.error.message }
    }
    lastSeq = Number(reply.result?.lastSeq ?? 0)
    // Events that arrived in the same read as the ack, before lastSeq was known, may already be live ones.
    for (const event of seen.filter((entry) => entry.seq > lastSeq!)) onLive?.(event)
    return { events: seen.filter((event) => event.seq <= lastSeq!), lastSeq }
  }
  const timeoutIn = (ms: number | undefined, onTimeout: () => void) => (ms ? setTimer(ms, onTimeout) : undefined)
  /** An inline plan is read from disk (relative to the working directory); a name is left for the daemon to resolve. */
  const loadPlan = async (target: string, script?: ScriptRun): Promise<{ plan: unknown } | { error: string }> => {
    if (script) {
      // A `.js` file is read here and sent as source; a bare name is a saved script the daemon finds in its layers.
      const args = script.args ? { args: script.args } : {}
      if (!isScriptFile(target) && !target.includes("/")) return { plan: { scriptRef: target, ...args } }
      try {
        return { plan: { script: await (deps.readText ?? defaultReadText)(path.resolve(dir, target)), origin: "file", ...args } }
      } catch (error) {
        return { error: `cannot read script ${target}: ${(error as NodeJS.ErrnoException).code === "ENOENT" ? "no such file" : (error as Error).message}` }
      }
    }
    if (target.startsWith("definition:")) return { plan: { definitionId: target.slice(11) } }
    if (target.startsWith("revision:")) return { plan: { revisionId: target.slice(9) } }
    if (!isPlanFile(target)) return { plan: { ref: target } }
    try {
      return { plan: await (deps.readJson ?? defaultReadJson)(path.resolve(dir, target)) }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      return { error: `cannot read plan ${target}: ${code === "ENOENT" ? "no such file" : error instanceof SyntaxError ? "not valid JSON" : (error as Error).message}` }
    }
  }

  switch (command.kind) {
    case "apply": {
      const { createApplyAutomation } = await import("./apply-automation")
      return createApplyAutomation({ client, directory: dir, result, fail })(command)
    }
    case "cache": {
      const { createCacheAutomation } = await import("./cache-automation")
      return createCacheAutomation({ client, directory: dir, result, fail })(command)
    }
    case "debug":
    case "debug.wait":
    case "db": {
      const { createDebugAutomation } = await import("./debug-automation")
      return createDebugAutomation({ ...deps, directory: dir, result, fail })(command)
    }
    case "console": case "share": {
      const { createConsoleAutomation } = await import("./console-automation")
      return createConsoleAutomation({ ...deps, request: daemon, result, fail })(command)
    }
    case "memory.control":
    case "dream.control": {
      const reply = await daemon({ type: command.kind, directory: dir, input: command.input } as Parameters<typeof client.send>[0])
      if (!reply.ok) return fail(reply.message)
      const output = JSON.stringify(reply.result, null, 2) + "\n"
      result(reply.result, output)
      return (reply.result.run as { status?: string } | undefined)?.status === "failed" ? EXIT.failed : EXIT.ok
    }
    case "setup.control": {
      const directory = deps.cwd ?? process.cwd()
      const request = command.target === "budget" ? command.operation === "doctor" ? { type: "budget.doctor" as const, directory } : { type: "budget.status" as const, directory } : command.operation === "plan" ? { type: "setup.plan" as const, directory } : command.operation === "doctor" ? { type: "setup.doctor" as const, directory } : { type: "setup.status" as const, directory }
      const reply = await daemon(request)
      if (reply.ok) {
        if (command.json) line({ kind: "result", command: request.type, data: reply.result })
        else out.write(JSON.stringify(reply.result, null, 2) + "\n")
        return reply.result?.ok === false ? EXIT.failed : EXIT.ok
      }
      return fail(reply.message, EXIT.failed, reply.code)
    }
    case "prompt": {
      const directory = dir
      const { operation, mode, focusID, modelID, role, workflow, showFull } = command
      const reply = await daemon(operation === "sources" ? { type: "prompt.sources", directory, ...(modelID ? { modelID } : {}) } : operation === "build" ? { type: "prompt.build", directory, ...(mode ? { mode } : {}), ...(focusID ? { focusID } : {}), ...(modelID ? { modelID } : {}), ...(role ? { role } : {}), ...(workflow ? { workflow } : {}), ...(showFull ? { showFull } : {}) } : operation === "cycle-mode" ? { type: "prompt.cycle", directory } : mode || focusID ? { type: "prompt.set", directory, ...(mode ? { mode } : {}), ...(focusID ? { focusID } : {}) } : { type: "prompt.status", directory })
      // The plain-text output leads with what the mode costs on every call; the JSON carries the same numbers as `costs`.
      const shown = reply.ok ? reply.result as Partial<PromptStatus> | undefined : undefined
      const notice = shown?.costs && shown.mode ? [promptCostLine(promptCostOf(shown, shown.mode)), promptCostWarning(shown.mode)].filter(Boolean).join(" · ") : ""
      return reply.ok ? result(reply.result, (notice ? notice + "\n" : "") + JSON.stringify(reply.result, null, 2) + "\n") : fail(reply.message, EXIT.failed, reply.code)
    }
    case "permissions": {
      const reply = await daemon(command.operation === "status" ? { type: "permissions.status" } : command.operation === "set-default" ? { type: "permissions.set-default", mode: command.mode! } : { type: "permissions.set-reviewer-role", role: command.role! })
      if (!reply.ok) return fail(reply.message)
      return result(reply.result, JSON.stringify(reply.result, null, 2) + "\n")
    }
    case "catalog.models":
    case "catalog.models.control":
    case "catalog.providers":
    case "catalog.auth":
    case "catalog.mcp": {
      const { createCatalogAutomation } = await import("./catalog-automation")
      return createCatalogAutomation({ ...deps, directory: dir, request: daemon, result, fail })(command)
    }
    case "theme.validate":
    case "theme.install":
    case "theme.select": {
      const { createThemeAutomation } = await import("./theme-automation")
      return createThemeAutomation({ ...deps, directory: dir, request: daemon, result, fail })(command)
    }
    case "config-bundle.inventory":
    case "config-bundle.export":
    case "config-bundle.inspect":
    case "config-bundle.import":
    case "config-bundle.imports":
    case "config-bundle.rollback": {
      const { createConfigBundleAutomation } = await import("./config-bundle-automation")
      return createConfigBundleAutomation({ ...deps, directory: dir, version: packageJson.version, request: daemon, result, fail })(command)
    }
    case "agent.list":
    case "agent.create":
    case "agent.debug": {
      const { createAgentAutomation } = await import("./agent-automation")
      return createAgentAutomation({ ...deps, directory: dir, request: daemon, result, fail })(command)
    }
    case "version":
      out.write(`${packageJson.version}\n`)
      return EXIT.ok
    case "mflow": {
      const reply = await daemon({ ...command.request, directory: dir })
      if (!reply.ok) return fail(reply.message, EXIT.failed, reply.code)
      const report = reply.result as unknown as import("@mendcode/protocol").MflowReport
      result(reply.result, mflowText(report))
      return report.ok ? EXIT.ok : EXIT.failed
    }
    case "worktree": {
      const reply = await daemon({ ...command.request, directory: dir })
      if (!reply.ok) return fail(reply.message, EXIT.failed, reply.code)
      const report = reply.result as unknown as import("@mendcode/protocol").WorktreeReport
      result(reply.result, worktreeText(report))
      return report.ok ? EXIT.ok : EXIT.failed
    }
    case "tsm": {
      const reply = await daemon({ ...command.request, directory: dir })
      if (!reply.ok) return fail(reply.message, EXIT.failed, reply.code)
      const report = reply.result as unknown as import("@mendcode/protocol").TsmReport
      result(reply.result, tsmText(report))
      return report.ok ? EXIT.ok : EXIT.failed
    }
    case "completion":
      out.write(completionScript(command.shell))
      return EXIT.ok
    case "backlog": {
      const reply = await daemon(command.words.kind === "list" ? { type: "backlog.get", directory: dir } : { type: "backlog.change", directory: dir, change: command.words.change })
      if (!reply.ok) return fail(reply.message)
      const report = reply.result as unknown as BacklogReport & { added?: number }
      const lines = backlogLines(report.items)
      if (command.words.kind === "list") return result({ ...report }, report.items.length ? `${backlogCount(report.items)}\n${lines.join("\n")}\n` : "Nothing pending\n")
      return result({ ...report }, `${backlogChangeText(command.words.change, report)}\n`)
    }
    case "context": {
      const reply = await daemon({ type: "context.recent", sessionId: command.id as SessionId, limit: command.limit })
      if (!reply.ok) return fail(reply.message)
      return result(reply.result, contextText(reply.result as unknown as import("@mendcode/protocol").RecentContextReport))
    }
    case "system": {
      const reply = await daemon({ type: "system.query", operation: command.operation, directory: dir })
      if (!reply.ok) return fail(reply.message)
      const report = reply.result as unknown as import("@mendcode/protocol").SystemReport
      result(reply.result, systemText(report))
      return report.ok ? EXIT.ok : EXIT.failed
    }
    case "files": {
      const reply = await daemon({ type: "files.query", operation: command.operation, directory: dir, ...(command.query ? { query: command.query } : {}), ...(command.glob ? { glob: command.glob } : {}), ...(command.limit ? { limit: command.limit } : {}) })
      if (!reply.ok) return fail(reply.message)
      const lines = reply.result.lines as string[]
      return result(reply.result, `${lines.join("\n")}${lines.length ? "\n" : ""}${reply.result.truncated ? "[results truncated]\n" : ""}`)
    }
    case "generate": {
      if (command.backend === "httpapi") {
        const { loadHttpApi, renderHttpApi } = await import("./generate-httpapi")
        out.write(renderHttpApi({ spec: await (deps.httpApi ?? loadHttpApi)(), json: command.json, compat: command.compat, schema: SCHEMA, now: deps.now() }))
        return EXIT.ok
      }
      const schemaReport = async (page: { entry?: string; page?: number; index?: number }) => {
        const reply = await daemon({ type: "system.query", operation: "generate", directory: dir, ...page })
        if (!reply.ok) throw new Error(reply.message)
        const report = reply.result as unknown as import("@mendcode/protocol").SystemReport
        if (!report.ok) throw new Error(report.failures.join("; "))
        return report.facts.contract as Record<string, unknown>
      }
      try {
        if (command.entry) {
          const contract = await schemaReport({ entry: command.entry })
          return result(contract, `${JSON.stringify(contract.schema, null, 2)}\n`)
        }
        const head = await schemaReport({})
        const indexes = [head.index as SchemaIndex]
        for (let next = 1; next < indexes[0]!.indexPages; next++) indexes.push((await schemaReport({ index: next })).index as SchemaIndex)
        if (command.index) {
          const entries = indexes.flatMap((index) => index.entries)
          return result({ transport: head.transport, protocol: head.protocol, entries, pages: indexes[0]!.pages, bytes: indexes[0]!.bytes }, `${entries.map((entry) => `${entry.name}\t${entry.bytes}`).join("\n")}\n`)
        }
        const { assembleSchema } = await import("@mendcode/protocol/wire")
        const pages: SchemaPage[] = []
        for (let page = 0; page < indexes[0]!.pages; page++) pages.push((await schemaReport({ page })).page as SchemaPage)
        const contract = { transport: head.transport, protocol: head.protocol, schema: assembleSchema({ indexes, pages }) }
        return result(contract, `${JSON.stringify(contract, null, 2)}\n`)
      } catch (error) { return fail(error instanceof Error ? error.message : String(error)) }
    }
    case "tui": {
      const read = ["status", "schema", "profile"].includes(command.operation)
      const request = { operation: command.operation, ...(command.argument ? { argument: command.argument } : {}), state: command.state, dryRun: command.dryRun, ...(command.check ? { check: true } : {}) }
      const reply = await daemon(read ? { type: "tui.query", operation: command.operation as "status" | "schema" | "profile" } : { type: "tui.change", input: request })
      if (!reply.ok) return fail(reply.message)
      let data = reply.result
      if (["preview", "propose", "render", "project"].includes(command.operation)) {
        try {
          const { controlFrames } = await import("./ui/control-frames")
          const frames = await controlFrames(client, dir, data.profile as Record<string, unknown>, command.state, command.session)
          const evidence = await daemon({ type: "tui.change", input: { operation: "preview", profile: data.profile as Record<string, never>, state: command.state, frames } })
          if (!evidence.ok) return fail(evidence.message)
          data = { ...data, artifacts: [...(data.artifacts as string[] ?? []), ...(evidence.result.artifacts as string[] ?? [])] }
        } catch (error) { return fail(String(error)) }
      }
      if (data.valid === false) return fail((data.issues as string[]).join("; "))
      return result(data, JSON.stringify(data, null, 2) + "\n")
    }
    case "help":
      out.write(helpText(command.topic))
      return EXIT.ok

    case "session.list": {
      const reply = await daemon({ type: "session.list", limit: command.limit, roots: !command.all, ...(command.allProjects ? {} : { directory: dir }), ...(command.project ? { project: path.resolve(dir, command.project) } : {}), ...(command.state ? { state: command.state } : {}), ...(command.active !== undefined ? { active: command.active } : {}), ...(command.since !== undefined ? { since: command.since } : {}), ...(command.search !== undefined ? { search: command.search } : {}), ...(command.agent ? { agent: command.agent } : {}), ...(command.model ? { model: sessionModelPrefix(command.model) } : {}), ...(command.archived ? { archived: true } : {}) })
      if (!reply.ok) return fail(reply.message)
      const sessions = (reply.result.sessions ?? []) as SessionSummary[]
      return result({ sessions }, sessionRows(sessions, deps.now(), !!command.allProjects))
    }

    case "session.create": {
      const selected = await sessionSelection(client, command, { directory: dir })
      if (!selected.ok) return fail(selected.message)
      const reply = await daemon({ type: "session.create", directory: dir, title: command.title, ...(command.parent ? { parentId: command.parent as SessionId } : {}), ...(selected.agent ? { agent: selected.agent } : {}), ...(selected.model ? { choice: selected.model } : {}) })
      if (!reply.ok) return fail(reply.message)
      return result({ sessionId: reply.result.sessionId }, `${reply.result.sessionId}\n`)
    }

    case "session.send": {
      if (command.files?.length && deps.allowFiles === false) return fail("file attachments disabled while remote")
      const selected = await sessionSelection(client, command, { sessionId: command.id as SessionId })
      if (!selected.ok) return fail(selected.message)
      const attachments: import("@mendcode/protocol").BlobRef[] = []
      let fileText = ""
      for (const file of command.files ?? []) {
        const added = await daemon({ type: "attachment.paste", path: path.resolve(dir, file) })
        if (!added.ok) return fail(added.message)
        if (added.result.kind === "image") attachments.push(added.result.attachment as import("@mendcode/protocol").BlobRef)
        else fileText += `\n\n[${added.result.name}]\n${added.result.content}`
      }
      const text = command.text + fileText
      const selection = selected.agent || selected.model ? { selection: { ...(selected.agent ? { agent: selected.agent } : {}), ...(selected.model ? { model: selected.model } : {}) } } : {}
      const submission = command.command
        ? { type: "commands.execute" as const, sessionId: command.id as SessionId, name: command.command.replace(/^\//, ""), args: command.text, attachments, ...(fileText ? { contextText: fileText } : {}), ...selection }
        : { type: "user.submit" as const, sessionId: command.id as SessionId, text, attachments, ...selection, ...(command.mode ? { delivery: command.mode === "auto" ? "steer" as const : command.mode } : {}), ...(command.requestId ? { clientRequestId: command.requestId } : {}) }
      if (!command.wait) {
        const reply = await daemon(submission)
        if (!reply.ok) return fail(reply.code === "unknown_session" ? `unknown session ${command.id}` : reply.message)
        if (reply.result.handled) return result({ sessionId: command.id, handled: true }, reply.result.notice ? `${reply.result.notice}\n` : "")
        const task = reply.result.task as import("@mendcode/protocol").TaskRecord | undefined
        const steered = reply.result.steered === true
        return result({ sessionId: task?.taskId ?? command.id, queueId: reply.result.queueId, ...(command.mode ? { steered } : {}), ...(task ? { task } : {}) }, `${steered ? "steered" : "queued"} ${reply.result.queueId}${task ? ` · ${task.taskId}` : ""}\n`)
      }
      const jsonOut = { write: (text: string) => void text.split("\n").filter(Boolean).forEach((entry) => line({ kind: "event", event: JSON.parse(entry) })) }
      const run = createHeadlessRun({ client: client as Client, sessionId: command.id as SessionId, prompt: text, json: command.json, approve: command.approve, ...(command.skipPermissions ? { skipPermissions: true } : {}), out: command.json ? jsonOut : out, err, submit: () => client.send(submission) })
      let after = 0
      let observedSession = command.id as SessionId
      const consume = (event: SessionEvent) => {
        if (event.sessionId !== run.sessionId) return
        if (event.sessionId !== observedSession) { observedSession = event.sessionId; after = 0 }
        if (event.seq <= after) return
        after = event.seq
        run.onEvent(event)
      }
      deps.listen(consume)
      const subscribed = await client.subscribe(command.id as SessionId, 0)
      if (!subscribed.ok) {
        deps.listen(undefined)
        return fail(subscribed.error.code === "unknown_session" ? `unknown session ${command.id}` : subscribed.error.message)
      }
      let timer: { cancel(): void } | undefined
      let refresh: { cancel(): void } | undefined
      let stopped = false
      const reconcile = () => {
        if (!command.intervalMs || stopped) return
        refresh = setTimer(command.intervalMs, () => {
          void daemon({ type: "session.events", sessionId: run.sessionId, after, limit: 500 }).then((reply) => {
            if (stopped) return
            if (reply.ok) (reply.result.events as SessionEvent[]).forEach(consume)
            reconcile()
          })
        })
      }
      reconcile()
      const expired = new Promise<number>((resolve) => void (timer = timeoutIn(command.timeoutMs, () => resolve(EXIT.timeout))))
      const code = await Promise.race([run.start(), expired])
      stopped = true
      refresh?.cancel()
      timer?.cancel()
      deps.listen(undefined)
      if (command.json) line({ kind: "result", command: command.kind, data: { sessionId: command.id, exitCode: code, status: code === EXIT.ok ? "completed" : code === EXIT.stopped ? "stopped" : code === EXIT.timeout ? "timeout" : code === EXIT.denied ? "denied" : "failed", ...(code === EXIT.denied ? { approvalDenied: true } : {}) } })
      else if (code === EXIT.timeout) err.write("error: timed out waiting for the turn\n")
      return code
    }

    case "session.export": case "session.import": {
      const { createSessionTransferAutomation } = await import("./session-transfer-automation")
      return createSessionTransferAutomation({ ...deps, directory: dir, request: daemon, result, fail })(command)
    }

    case "session.get": case "session.inspect": case "session.status": {
      const reply = await daemon(command.kind === "session.get" ? { type: "session.get", sessionId: command.id as SessionId } : { type: "session.inspect", sessionId: command.id as SessionId, limit: command.kind === "session.inspect" ? command.limit : 20 })
      if (!reply.ok) return fail(reply.message)
      const session = reply.result.session as import("@mendcode/protocol").SessionDetail
      return result(reply.result, sessionHuman(session))
    }

    case "session.stats": {
      const reply = await daemon({ type: "session.stats", sessionId: command.id as SessionId })
      if (!reply.ok) return fail(reply.message)
      return result(reply.result.stats as Record<string, unknown>, String(reply.result.text))
    }

    case "session.pause": case "session.resume": case "session.stop": {
      const action = command.kind === "session.pause" ? "pause" : command.kind === "session.resume" ? "resume" : "stop"
      const reply = await daemon({ type: "session.control", sessionId: command.id as SessionId, action })
      if (!reply.ok) return fail(reply.message)
      const outcome = reply.result as { paused?: boolean; cancelledTurn?: boolean; cancelledChildren?: number }
      const children = outcome.cancelledChildren ?? 0
      return result({ sessionId: command.id, action, ...reply.result }, action === "pause" ? `Paused ${command.id}: the running turn finishes, then nothing starts until resume\n` : action === "resume" ? `Resumed ${command.id}\n` : `Stopped ${command.id}: ${outcome.cancelledTurn ? "turn cancelled" : "no running turn"}, ${children} sub-agent${children === 1 ? "" : "s"} cancelled\n`)
    }

    case "session.archive": {
      const reply = await daemon({ type: "session.archive", sessionId: command.id as SessionId, ...(command.restore ? { restore: true } : {}) })
      if (!reply.ok) return fail(reply.message)
      return result({ sessionId: command.id, ...reply.result }, `${command.restore ? "Restored" : "Archived"} ${command.id}\n`)
    }

    case "session.rename": case "session.fork": case "session.delete": {
      const reply = await daemon(command.kind === "session.rename" ? { type: "session.rename", sessionId: command.id as SessionId, title: command.title } : command.kind === "session.fork" ? { type: "session.fork", sessionId: command.id as SessionId, transcript: true, ...(command.messageId ? { beforeItemId: command.messageId as import("@mendcode/protocol").ItemId } : {}) } : { type: "session.delete", sessionId: command.id as SessionId })
      if (!reply.ok) return fail(reply.message)
      return result({ sessionId: command.id, ...reply.result }, command.kind === "session.rename" ? `Renamed ${command.id} to ${command.title}\n` : command.kind === "session.fork" ? `Forked session ${reply.result.sessionId} from ${command.id}\n` : `Session ${command.id} deleted\n`)
    }

    case "session.wait": {
      let settle!: (code: number) => void
      const done = new Promise<number>((resolve) => (settle = resolve))
      const state = { foreground: "idle", queued: 0 }
      let terminal: "completed" | "cancelled" | "interrupted" | "failed" | undefined
      const observe = (event: SessionEvent) => {
        if (event.type === "turn.started") terminal = undefined
        if (event.type === "turn.completed") terminal = "completed"
        if (event.type === "turn.cancelled") terminal = "cancelled"
        // The daemon lost the turn (restart, transport): the same exit code as a cancel, its own status word.
        if (event.type === "turn.interrupted") terminal = "interrupted"
        if (event.type === "turn.failed") terminal = "failed"
        if (event.type === "queue.changed") state.queued = event.queue.length
        if (event.type === "foreground.state") state.foreground = event.state
      }
      const evaluate = () => {
        if (state.queued !== 0) return
        if (state.foreground === "idle" && (command.idle || terminal)) settle(terminal === "failed" ? EXIT.failed : terminal === "cancelled" || terminal === "interrupted" ? EXIT.stopped : EXIT.ok)
        else if (state.foreground === "error") settle(EXIT.failed)
      }
      const loaded = await history(command.id, 0, (event) => {
        observe(event)
        evaluate()
      })
      if ("error" in loaded) return fail(loaded.error)
      for (const event of loaded.events) observe(event)
      evaluate()
      let refresh: { cancel(): void } | undefined
      let stopped = false
      const reconcile = () => {
        if (!command.intervalMs || stopped) return
        refresh = setTimer(command.intervalMs, () => {
          void daemon({ type: "session.inspect", sessionId: command.id as SessionId, limit: 1 }).then((reply) => {
            if (stopped) return
            if (!reply.ok) settle(EXIT.failed)
            else if (["completed", "failed", "cancelled", "interrupted"].includes(String(reply.result.state))) {
              terminal = reply.result.state as typeof terminal
              const session = reply.result.session as import("@mendcode/protocol").SessionDetail
              state.foreground = session.state
              state.queued = session.queued
              evaluate()
            }
            reconcile()
          })
        })
      }
      reconcile()
      const timer = timeoutIn(command.timeoutMs ?? 1_800_000, () => settle(EXIT.timeout))
      deps.onInterrupt(() => settle(EXIT.stopped))
      const code = await done
      stopped = true
      refresh?.cancel()
      timer?.cancel()
      deps.listen(undefined)
      const status = code === EXIT.timeout ? "timeout" : command.idle && code === EXIT.ok ? "idle" : terminal ?? (code === EXIT.stopped ? "cancelled" : "error")
      if (code === EXIT.ok) return result({ sessionId: command.id, status }, `${status}\n`)
      if (command.json) line({ kind: "result", command: command.kind, data: { sessionId: command.id, status } })
      else err.write(code === EXIT.timeout ? `error: timed out waiting for ${command.idle ? "idle" : "a terminal result"}\n` : code === EXIT.stopped ? `error: session ${terminal === "interrupted" ? "interrupted" : "cancelled"}\n` : "error: session is in error state\n")
      return code
    }

    case "session.events": {
      let settle!: () => void
      const done = new Promise<void>((resolve) => (settle = resolve))
      let count = 0
      const print = (event: SessionEvent, live = false) => {
        if (command.limit && count >= command.limit) return
        command.json ? line({ kind: "event", event }) : out.write(eventLine(event))
        count++
        if (command.limit && count >= command.limit || live && !command.keepOpen && event.type === "foreground.state" && event.state === "idle") settle()
      }
      const loaded = await history(command.id, command.after, command.follow ? (event) => print(event, true) : undefined)
      if ("error" in loaded) return fail(loaded.error)
      for (const event of loaded.events) print(event)
      if (!command.follow) {
        deps.listen(undefined)
        return EXIT.ok
      }
      deps.onInterrupt(settle)
      await done
      deps.listen(undefined)
      return EXIT.ok
    }

    case "session.cancel": {
      const loaded = await history(command.id, 0)
      if ("error" in loaded) return fail(loaded.error)
      deps.listen(undefined)
      const { activeTurn } = foldSession(loaded.events)
      if (!activeTurn) return result({ sessionId: command.id, cancelled: false }, "no active turn\n")
      const reply = await daemon({ type: "turn.cancel", sessionId: command.id as SessionId, turnId: activeTurn as never })
      if (!reply.ok) return fail(reply.message)
      return result({ sessionId: command.id, turnId: activeTurn, cancelled: true }, `cancelled ${activeTurn}\n`)
    }

    case "memory.list": {
      const reply = await daemon({ type: "memory.list", directory: dir, ...(command.status ? { status: command.status as never } : {}) })
      if (!reply.ok) return fail(reply.message)
      const memories = (reply.result.memories ?? []) as MemoryEntry[]
      return result({ memories }, memoryRows(memories))
    }

    case "memory.add": {
      const reply = await daemon({ type: "memory.add", scope: command.user ? "user" : "project", directory: dir, text: command.text, ...(command.category ? { category: command.category } : {}) })
      if (!reply.ok) return fail(reply.message)
      return result({ memoryId: reply.result.memoryId }, `saved ${reply.result.memoryId}\n`)
    }

    case "memory.search": {
      const reply = await daemon({ type: "memory.search", query: command.query, directory: dir, ...(command.limit ? { limit: command.limit } : {}) })
      if (!reply.ok) return fail(reply.message)
      const memories = (reply.result.memories ?? []) as MemoryEntry[]
      return result({ memories }, memoryRows(memories))
    }

    case "loop.list": {
      const reply = await daemon({ type: "loop.list", ...(command.all ? {} : { directory: dir }) })
      if (!reply.ok) return fail(reply.message)
      const loops = (reply.result.loops ?? []) as Loop[]
      return result({ loops }, loopRows(loops))
    }

    case "loop.create": {
      const reply = await daemon({ type: "loop.create", name: command.name, directory: dir, objective: command.objective, trigger: command.trigger, budget: command.budget, ...(command.criteria ? { criteria: command.criteria } : {}), ...(command.checks ? { checks: command.checks } : {}), ...(command.audit ? { audit: command.audit } : {}), ...(command.runNow ? { runNow: true } : {}) })
      if (!reply.ok) return fail(reply.message)
      const loop = reply.result.loop as Loop
      return result({ loop }, `${loop.loopId}  ${loop.state}\n`)
    }

    case "workflow.list": {
      const reply = await daemon({ type: "workflow.list", ...(command.all ? {} : { directory: dir }) })
      if (!reply.ok) return fail(reply.message, EXIT.failed, reply.code)
      const workflows = (reply.result.workflows ?? []) as WorkflowSummary[]
      return result({ workflows }, workflowRows(workflows))
    }
    case "automation.ledger": {
      const query = { ...(command.limit !== undefined ? { limit: command.limit } : {}), ...(command.before ? { before: command.before } : {}), ...(command.run !== undefined ? { run: command.run } : {}) }
      const body = command.scope === "workflow" ? { type: `workflow.${command.operation}`, workflowId: command.id, ...query } : { type: `loop.${command.operation}`, loopId: command.id, ...query }
      const reply = await daemon({ ...body, ...(command.operation === "export" ? { format: command.exportFormat } : {}) } as never)
      if (!reply.ok) return fail(reply.message, EXIT.failed, reply.code)
      if (command.operation === "export") {
        const exported = reply.result.export as import("@mendcode/protocol").LedgerExport
        return result({ export: exported }, `${exported.text}\n`)
      }
      const ledger = reply.result.ledger as import("@mendcode/protocol").LedgerPage
      const text = ledger.entries.length ? ledger.entries.map((entry) => JSON.stringify(entry)).join("\n") : `No ${command.scope} ${command.operation}.`
      return result({ ledger }, `${text}\n${ledger.nextBefore ? `Next cursor: --before ${ledger.nextBefore}\n` : ""}${ledger.truncated ? "Retention truncated older evidence.\n" : ""}${!ledger.historical ? "Historical snapshot; earlier events unavailable.\n" : ""}`)
    }

    case "workflow.save": {
      const loaded = await loadPlan(command.target)
      if ("error" in loaded) return fail(loaded.error)
      const reply = await daemon({ type: "workflow.save", directory: dir, plan: loaded.plan as never, ...(command.definitionId ? { definitionId: command.definitionId } : {}), ...(command.name ? { name: command.name } : {}), ...(command.description !== undefined ? { description: command.description } : {}), ...(command.source ? { source: command.source } : {}) })
      if (!reply.ok) return fail(reply.message, EXIT.failed, reply.code)
      const receipt = reply.result.receipt as import("@mendcode/protocol").WorkflowRevisionReceipt
      return result({ receipt }, `Saved workflow ${receipt.definitionId} revision ${receipt.revisionId} (#${receipt.revision})\nplan_hash: ${receipt.planHash}\n`)
    }
    case "workflow.definitions": {
      const reply = await daemon({ type: "workflow.definitions", directory: dir, limit: command.limit })
      if (!reply.ok) return fail(reply.message, EXIT.failed, reply.code)
      const definitions = (reply.result.definitions ?? []) as import("@mendcode/protocol").WorkflowDefinition[]
      return result({ definitions }, definitions.length ? definitions.map((d) => `${d.definitionId}  #${d.currentRevision}  ${d.currentRevisionId}  ${d.saved ? "saved" : "session"}  ${oneLine(d.name)}\n`).join("") : "No workflow definitions\n")
    }
    case "workflow.revision": {
      const reply = await daemon({ type: "workflow.revision.get", directory: dir, revisionId: command.revisionId })
      if (!reply.ok) return fail(reply.message, EXIT.failed, reply.code)
      const r = reply.result.receipt as import("@mendcode/protocol").WorkflowRevisionReceipt
      return result({ receipt: r }, `definition_id: ${r.definitionId}\nrevision_id: ${r.revisionId} (#${r.revision})\nplan_hash: ${r.planHash}\n${JSON.stringify(r.plan, null, 2)}\n`)
    }

    case "workflow.new": {
      const { workflowStarter } = await import("./view/workflow-script")
      const file = path.resolve(dir, command.out ?? `${command.name}.js`)
      if (await (deps.exists ?? defaultExists)(file)) return fail(`${file} already exists`)
      await (deps.writeText ?? defaultWriteText)(file, workflowStarter(command.name))
      return result({ file }, `Wrote ${file}\nPreview it with: workflow run ${path.relative(dir, file) || file}\n`)
    }
    case "workflow.convert": {
      const loaded = await loadPlan(command.target)
      if ("error" in loaded) return fail(loaded.error)
      const { planToScript } = await import("./view/workflow-convert")
      const converted = planToScript(loaded.plan, command.target)
      if (!converted.ok) return fail(`cannot convert ${command.target}:\n${converted.problems.map((problem) => `  - ${problem}`).join("\n")}`)
      const file = path.resolve(dir, command.out ?? command.target.replace(/\.json$/, ".js"))
      if (await (deps.exists ?? defaultExists)(file)) return fail(`${file} already exists`)
      await (deps.writeText ?? defaultWriteText)(file, converted.script)
      return result({ file, notes: converted.notes }, `Wrote ${file}\n${converted.notes.map((note) => `note: ${note}\n`).join("")}`)
    }
    case "workflow.script": {
      const reply = await daemon({ type: "workflow.script", workflowId: command.id as never, action: "budget", budget: command.budget })
      if (!reply.ok) return fail(reply.message, EXIT.failed, reply.code)
      const workflow = reply.result.workflow as WorkflowSummary
      return result({ workflow }, `${workflow.workflowId}  caps ${Object.entries(workflow.script?.budget ?? {}).map(([key, value]) => `${key} ${value}`).join(", ")}\nResume with: workflow resume ${workflow.workflowId}\n`)
    }
    case "workflow.update": {
      let script: string
      try {
        script = await (deps.readText ?? defaultReadText)(path.resolve(dir, command.file))
      } catch (error) {
        return fail(`cannot read script ${command.file}: ${(error as NodeJS.ErrnoException).code === "ENOENT" ? "no such file" : (error as Error).message}`)
      }
      const reply = await daemon({ type: "workflow.script", workflowId: command.id as never, action: "update", script })
      if (!reply.ok) return fail(reply.message, EXIT.failed, reply.code)
      const workflow = reply.result.workflow as WorkflowSummary
      return result({ workflow }, `${workflow.workflowId}  script updated (sha256 ${workflow.script?.hash ?? "?"})\nResume with: workflow resume ${workflow.workflowId} (only changed or new calls run again)\n`)
    }
    case "workflow.preview":
    case "workflow.start": {
      const start = command.kind === "workflow.start" ? command : undefined
      if (start?.wait && !deps.listenGlobal) return fail("this client cannot receive workflow events; start without --wait", EXIT.failed, "unsupported")
      const loaded = await loadPlan(command.target, command.script)
      if ("error" in loaded) return fail(loaded.error)
      const previewed = await daemon({ type: "workflow.preview", directory: dir, plan: loaded.plan as never })
      if (!previewed.ok) return fail(previewed.message, EXIT.failed, previewed.code)
      const problems = ((previewed.result.problems ?? []) as unknown[]).map(String)
      if (problems.length) {
        const message = `plan has ${problems.length} problem${problems.length === 1 ? "" : "s"}`
        if (command.json) line({ kind: "error", command: command.kind, error: { code: "invalid_plan", message, problems } })
        else err.write(`error: ${message}:\n${problems.map((problem) => `  - ${problem}`).join("\n")}\n`)
        return EXIT.failed
      }
      const summary = previewed.result.summary
      const preview = previewText({ target: command.target, plan: loaded.plan, summary, granted: start?.permission })
      if (!start) return result({ problems, ...(summary === undefined ? {} : { summary }) }, preview)
      if (!start.yes) return result({ started: false, problems, ...(summary === undefined ? {} : { summary }) }, `${preview}re-run with --yes to start\n`)
      if (!command.json) out.write(preview)

      const latest = new Map<string, WorkflowSummary>()
      const deleted = new Set<string>()
      let onChange = () => {}
      if (start.wait)
        deps.listenGlobal?.((event) => {
          if (event.type !== "workflow.changed") return
          latest.set(event.workflow.workflowId, event.workflow)
          if (event.deleted) deleted.add(event.workflow.workflowId)
          onChange()
        })
      const started = await daemon({ type: "workflow.start", directory: dir, plan: loaded.plan as never, ...(start.permission ? { permission: start.permission } : {}) })
      if (!started.ok) {
        deps.listenGlobal?.(undefined)
        return fail(started.message, EXIT.failed, started.code)
      }
      const workflow = started.result.workflow as WorkflowSummary
      if (!start.wait) return result({ workflow }, `${workflow.workflowId}  ${workflow.state}  ${workflow.name}\n`)

      let current = workflow
      let settle!: (code: number) => void
      const done = new Promise<number>((resolve) => (settle = resolve))
      onChange = () => {
        const pushed = latest.get(workflow.workflowId)
        if (pushed && pushed.updatedAt >= current.updatedAt) current = pushed
        if (deleted.has(workflow.workflowId)) settle(EXIT.failed)
        else if (current.state === "completed") settle(EXIT.ok)
        else if (current.state === "failed" || current.state === "blocked") settle(EXIT.failed)
        else if (current.state === "stopped") settle(EXIT.stopped)
        else if (current.state === "needs_input") settle(EXIT.needsInput)
        // A script run paused at one of its caps waits for the user to raise it (workflow budget) and resume.
        else if (current.state === "paused" && current.script) settle(EXIT.needsInput)
      }
      onChange()
      const timer = timeoutIn(start.timeoutMs, () => settle(EXIT.timeout))
      const code = await done
      timer?.cancel()
      deps.listenGlobal?.(undefined)
      const status = code === EXIT.timeout ? "timeout" : deleted.has(workflow.workflowId) ? "deleted" : current.state
      if (command.json) {
        line({ kind: "result", command: command.kind, data: { workflow: current, exitCode: code, status, ...(code === EXIT.needsInput ? { waiting: current.tasks.filter((task) => task.state === "needs_input").map((task) => ({ taskId: task.id, sessionId: task.sessionId })) } : {}) } })
        return code
      }
      out.write(`${current.workflowId}  ${status}  ${current.name}\n`)
      for (const waiting of waitingLines(current)) out.write(waiting)
      if (code === EXIT.timeout) err.write("error: timed out waiting for the workflow\n")
      else if (code !== EXIT.ok && code !== EXIT.needsInput && current.reason) err.write(`error: ${oneLine(current.reason)}\n`)
      return code
    }

    case "workflow.show": {
      const reply = await daemon({ type: "workflow.get", workflowId: command.id as never })
      if (!reply.ok) return fail(reply.message, EXIT.failed, reply.code)
      const workflow = reply.result.workflow as WorkflowRun
      return result({ workflow }, workflowText(workflow))
    }

    case "workflow.control": {
      if (command.wait && !deps.listenGlobal) return fail("this client cannot receive workflow events; retry without --wait", EXIT.failed, "unsupported")
      let pushed: WorkflowSummary | undefined
      let deleted = false
      let change = () => {}
      if (command.wait) deps.listenGlobal?.((event) => {
        if (event.type !== "workflow.changed" || event.workflow.workflowId !== command.id) return
        if (!pushed || event.workflow.updatedAt >= pushed.updatedAt) pushed = event.workflow
        deleted ||= event.deleted ?? false
        change()
      })
      const reply = await daemon({ type: "workflow.control", workflowId: command.id as never, action: command.action, ...(command.taskId ? { taskId: command.taskId } : {}), ...(command.reason ? { reason: command.reason } : {}) })
      if (!reply.ok) {
        if (command.wait) deps.listenGlobal?.(undefined)
        return fail(reply.message, EXIT.failed, reply.code)
      }
      const workflow = reply.result.workflow as WorkflowSummary | undefined
      if (command.wait && workflow) {
        let current = workflow
        let settle!: (code: number) => void
        const done = new Promise<number>((resolve) => (settle = resolve))
        change = () => {
          if (pushed && pushed.updatedAt >= current.updatedAt) current = pushed
          if (deleted) settle(EXIT.failed)
          else if (current.state === "completed") settle(EXIT.ok)
          else if (current.state === "failed" || current.state === "blocked") settle(EXIT.failed)
          else if (current.state === "stopped") settle(EXIT.stopped)
          else if (current.state === "needs_input") settle(EXIT.needsInput)
        }
        change()
        const timer = timeoutIn(command.timeoutMs, () => settle(EXIT.timeout))
        const code = await done
        timer?.cancel()
        deps.listenGlobal?.(undefined)
        const status = code === EXIT.timeout ? "timeout" : deleted ? "deleted" : current.state
        if (command.json) line({ kind: "result", command: command.kind, data: { workflow: current, exitCode: code, status } })
        else {
          out.write(`${current.workflowId}  ${status}  ${current.name}\n`)
          for (const waiting of waitingLines(current)) out.write(waiting)
          if (code === EXIT.timeout) err.write("error: timed out waiting for the workflow\n")
          else if (code !== EXIT.ok && code !== EXIT.needsInput && current.reason) err.write(`error: ${oneLine(current.reason)}\n`)
        }
        return code
      }
      if (command.wait) deps.listenGlobal?.(undefined)
      return result({ workflowId: command.id, action: command.action, ...(workflow ? { workflow } : {}) }, `${command.action} ${command.id}${command.taskId ? ` ${command.taskId}` : ""}${workflow ? `  ${workflow.state}` : ""}\n`)
    }

    case "loop.control": {
      const reply = await daemon({ type: "loop.control", loopId: command.id as never, action: command.action })
      if (!reply.ok) return fail(reply.message)
      const loop = reply.result.loop as Loop | undefined
      return result({ loopId: command.id, action: command.action, ...(loop ? { loop } : {}) }, `${command.action} ${command.id}${loop ? `  ${loop.state}` : ""}\n`)
    }

    case "loop.fire": {
      const reply = await daemon({ type: "loop.fire", loopId: command.id as never, ...(command.note ? { note: command.note } : {}) })
      if (!reply.ok) return fail(reply.message)
      const loop = reply.result.loop as Loop | undefined
      const queued = reply.result.queued === true
      return result({ loopId: command.id, fired: true, queued, ...(loop ? { loop } : {}) }, `fire ${command.id}${queued ? "  queued (a run is in progress)" : "  started"}${loop ? `  ${loop.state}` : ""}\n`)
    }

    case "storage": {
      if (!command.clean) {
        if (command.worktrees) {
          const reply = await daemon({ type: "storage.worktrees", ...(command.worktreeIdleDays === undefined ? {} : { idleDays: command.worktreeIdleDays }) })
          if (!reply.ok) return fail(reply.message, EXIT.failed, reply.code)
          return result(reply.result, worktreeStorageText(reply.result as unknown as StorageWorktreesReport))
        }
        const reply = await daemon({ type: "storage.report" })
        if (!reply.ok) return fail(reply.message)
        return result(reply.result, storageText(reply.result as unknown as StorageReport, deps.now()))
      }
      const reply = await daemon({
        type: "storage.clean",
        ...(command.olderThanDays === undefined ? {} : { olderThanDays: command.olderThanDays }),
        ...(command.dryRun ? { dryRun: true } : {}),
        ...(command.vacuum ? { vacuum: true } : {}),
        ...(command.compact ? { compact: true } : {}),
        ...(command.deltaIdleDays === undefined ? {} : { deltaIdleDays: command.deltaIdleDays }),
        ...(command.worktrees ? { worktrees: true } : {}),
        ...(command.worktreeIdleDays === undefined ? {} : { worktreeIdleDays: command.worktreeIdleDays }),
      })
      if (!reply.ok) return fail(reply.message)
      return result(reply.result, cleanText(reply.result as unknown as StorageCleanResult))
    }

    case "plugin.install": {
      const reply = await daemon({ type: "plugins.install", directory: dir, spec: command.spec, global: command.global, force: command.force })
      return reply.ok ? result(reply.result, `${String(reply.result.mode)} ${command.spec} · ${String(reply.result.scope)}\n${String(reply.result.file)}\n`) : fail(reply.message, EXIT.failed, reply.code)
    }
    case "plugin.auth": {
      const { pluginLogin } = await import("./plugin-auth")
      try {
        const data = await pluginLogin(client, dir, command.provider, command.method, deps.prompt, (text) => err.write(text))
        return result(data, command.provider ? `Authenticated ${command.provider}\n` : `${(data.providers as Array<{ provider: string; methods: Array<{ label: string }> }> | undefined ?? []).map((entry) => `${entry.provider}: ${entry.methods.map((method, index) => `${index} ${method.label}`).join(" · ")}`).join("\n")}\n`)
      } catch (error) { return fail(error instanceof Error ? error.message : "plugin login failed", EXIT.failed) }
    }
    case "package.catalog": {
      const reply = await daemon({ ...command.request, directory: dir })
      if (!reply.ok) return fail(reply.message, EXIT.failed, reply.code)
      const config = command.request.type === "packages.config" || command.request.type === "packages.resource"
      return result(reply.result, Array.isArray(reply.result.packages) && !config ? packageRows(reply.result.packages as PackageInfo[]) : packageCatalogText(reply.result))
    }
    case "lsp.install": {
      err.write(`installing the ${command.server} language server (pnpm or go downloads it; up to 3 minutes)...\n`)
      const reply = await daemon({ type: "lsp.install", directory: dir, server: command.server })
      if (!reply.ok) return fail(reply.message)
      const installed = reply.result as { command?: string[]; already?: boolean }
      return result(installed, `${installed.already ? "already installed" : "installed"}: ${(installed.command ?? []).join(" ")}\n`)
    }
    case "package.capture": {
      const reply = await daemon({ type: "packages.capture", directory: dir, name: command.name, ...(command.replace ? { replace: true } : {}) })
      if (!reply.ok) return fail(reply.message)
      const packages = (reply.result.packages ?? []) as PackageInfo[]
      const skipped = (reply.result.skipped ?? []) as string[]
      return result({ packages, skipped }, `captured user:${command.name} from your terminal profile${skipped.length ? ` (left out, not a package's to set: ${skipped.join(", ")})` : ""}\n${packageRows(packages.filter((p) => p.key === `user:${command.name}`))}`)
    }
    case "package.list":
    case "package.install":
    case "package.remove":
    case "package.restore":
    case "package.enable": {
      const reply =
        command.kind === "package.list"
          ? await daemon({ type: "packages.list", directory: dir })
          : command.kind === "package.install"
            ? await daemon({ type: "packages.install", directory: dir, source: command.source, scope: command.scope, ...(command.replace ? { replace: true } : {}) })
            : command.kind === "package.remove"
              ? await daemon({ type: "packages.remove", directory: dir, name: command.name, scope: command.scope, ...(command.purge ? { purge: true } : {}) })
              : command.kind === "package.restore"
                ? await daemon({ type: "packages.restore", directory: dir, name: command.name, scope: command.scope })
                : await daemon({ type: "packages.enable", directory: dir, key: `${command.scope}:${command.name}`, enabled: command.enabled, ...(command.switch ? { switch: true } : {}) })
      if (!reply.ok) return fail(reply.message)
      const packages = (reply.result.packages ?? []) as PackageInfo[]
      if (command.kind === "package.list") return result({ packages }, packageRows(packages))
      const key = command.kind === "package.install" ? undefined : `${command.scope}:${command.name}`
      const done = command.kind === "package.install" ? "installed" : command.kind === "package.remove" ? (command.purge ? "removed for good" : "removed (in the Trash for 30 days: package restore)") : command.kind === "package.restore" ? "restored (off until enabled)" : command.enabled ? "enabled" : "disabled"
      return result({ packages }, `${done}${key ? ` ${key}` : ""}\n${command.kind === "package.remove" ? "" : packageRows(key ? packages.filter((p) => p.key === key) : packages)}`)
    }

    case "profile.list":
    case "profile.add":
    case "profile.remove": {
      const current = await daemon({ type: "settings.get" })
      if (!current.ok) return fail(current.message)
      const profiles = ((current.result.settings as Settings | undefined)?.profiles ?? []) as Profile[]
      let next = profiles
      if (command.kind === "profile.add") {
        // Relative folders are taken from here; `~` stays so the profile follows the home directory.
        const folders = command.folders.map((folder) => (folder.startsWith("~") ? folder : path.resolve(dir, folder)))
        const entry: Profile = { name: command.name, directories: folders, ...(command.permission ? { defaultPermission: command.permission } : {}) }
        const existing = profiles.find((profile) => profile.name === command.name)
        next = existing ? profiles.map((profile) => (profile.name === command.name ? { ...existing, ...entry } : profile)) : [...profiles, entry]
      } else if (command.kind === "profile.remove") {
        if (!profiles.some((profile) => profile.name === command.name)) return fail(`no profile named ${command.name}`)
        next = profiles.filter((profile) => profile.name !== command.name)
      }
      if (next !== profiles) {
        const set = await daemon({ type: "settings.set", patch: { profiles: next.length ? next : null } })
        if (!set.ok) return fail(set.message)
      }
      const here = profileFor(dir, next, deps.home)
      return result({ profiles: next, current: here }, profileRows(next, here))
    }

    case "recipe.list":
    case "recipe.apply": {
      const reply = await daemon(command.kind === "recipe.list" ? { type: "recipes.list", directory: dir } : { type: "recipes.apply", directory: dir, name: command.name })
      if (!reply.ok) return fail(reply.message)
      const report = reply.result as unknown as RecipesReport
      return result(report, `${command.kind === "recipe.apply" ? `applied ${command.name}\n` : ""}${recipeRows(report)}`)
    }

    case "usage":
    case "stats": {
      const now = deps.now()
      const from = command.days === undefined ? "0000-01-01" : localDay(now - Math.max(0, command.days - 1) * 86_400_000)
      const scope = command.scope ?? (command.project !== undefined ? "project" : "global")
      if (command.waste) {
        // The 30 days a waste report reads by default: all time mixes configurations that no longer apply.
        const wasteFrom = command.days === undefined ? localDay(now - 29 * 86_400_000) : from
        const reply = await daemon({ type: "usage.waste", from: wasteFrom, to: localDay(now), scope, directory: dir, ...(command.project ? { project: command.project } : {}) })
        if (!reply.ok) return fail(reply.message)
        const { wasteText } = await import("./view/usage-waste-text")
        return result(reply.result, wasteText(reply.result as unknown as UsageWasteReport))
      }
      const reply = await daemon({ type: "usage.query", from, to: localDay(now), scope, directory: dir,
        ...(command.project ? { project: command.project } : {}), ...(command.tools !== undefined || command.kind === "stats" ? { toolLimit: 0 } : {}),
      })
      if (!reply.ok) return fail(reply.message)
      const report = reply.result as unknown as UsageReport
      const extended = command.kind === "stats" || command.tools !== undefined || command.models !== undefined || scope !== "global"
      return result(reply.result, extended ? statsText(report, command) : usageText(report, command.days ?? DEFAULT_USAGE_DAYS))
    }
    case "project": {
      const reply = await daemon({ type: "project.control", directory: dir, input: command.input })
      return reply.ok ? result(reply.result, projectOutput(command.input, reply.result)) : fail(reply.message, EXIT.failed, reply.code)
    }
    case "ai.config": {
      const { createAIConfigAutomation } = await import("./ai-config-automation")
      return createAIConfigAutomation({ ...deps, directory: dir, request: daemon, result, fail })(command)
    }
  }
}
