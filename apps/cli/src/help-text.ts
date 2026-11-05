import { PROGRAM_NAME as P } from "@mendcode/program"

/**
 * The help of the commands whose usage is more than a line, written in one format: `usage:` first, the commands in a column, their
 * options under `options:`. At most 80 columns. `test/cli-help.test.ts` checks that every command listed here is accepted.
 */
const text = (lines: string[]) => lines.join("\n")

export const DEBUG_HELP = text([
  `usage: ${P} debug <command> [--dir DATA] [--json]`,
  "",
  "  config                  settings, agents and paths in force",
  "  info                    runtime, engine, build, OS and terminal",
  "  paths                   data and config paths",
  "  scrap                   projects with sessions: sessions and last update",
  "  skill                   skills and whether each is enabled",
  "  startup                 milliseconds the daemon has been up",
  "  agent NAME              run an agent's tool: --tool ID --params JSON --approve",
  "  file search QUERY       also: file read PATH | status | list PATH | tree [DIR]",
  "  lsp diagnostics FILE    also: lsp symbols QUERY | document-symbols URI",
  "  snapshot track          also: snapshot patch HASH | diff HASH",
  "  rg tree|files|search PATTERN",
  "                          --query TEXT --glob PATTERN (repeatable) --limit N",
  "  wait                    hold until interrupted (--timeout-ms MS)",
])

export const DATABASE_HELP = text([
  `usage: ${P} db [path|SQL] [--format json|tsv] [--dir DATA]`,
  "",
  "  path",
  "  SQL                     run one read-only statement",
  "  (nothing)               read-only SQL shell: .tables  .schema [TABLE]  .quit",
])

export const THEME_HELP = text([
  `usage: ${P} theme <command> [--dir D] [--json]`,
  "",
  "  validate <file>         check a theme file",
  "  install <file>          --name NAME --scope project|user|global",
  "  select <name>           --scope project|user|global",
])

export const WORKTREE_HELP = text([
  `usage: ${P} [control-plane] worktree <command> [target] [--json]`,
  "",
  "  status",
  "  plan NAME               --branch B --base REF --path PATH --focus F",
  "  create NAME             same options as plan",
  "  open|adopt|remove|reset <target>",
  "  doctor",
  "",
  "create, open, remove and reset only preview; adopt and plan save registry data.",
  "--dir DATA selects daemon storage; --project PATH selects the project.",
])

export const DAEMON_HELP = text([
  `usage: ${P} daemon <command> [--dir D] [--json]`,
  "",
  "  start|run|stop|restart  --force: interrupt active work",
  "  status",
  "  logs                    --lines N (1-1000)",
  "  service <action>        plan, install, start, stop, restart, status, logs,",
  "                          uninstall (macOS and Linux)",
  "                          --service-dir D --cwd PROJECT --engine ENGINE",
  "",
  "Also: [control-plane] loops daemon [--once [--execute]] | service <action>",
  "      [control-plane] memory dream daemon [--once [--execute]] | service",
])

export const GITHUB_HELP = text([
  `usage: ${P} github <command> [--dir DATA] [--project PATH] [--json]`,
  "",
  "  install                 --model PROVIDER/MODEL --write",
  "  install --hosted        --model PROVIDER/MODEL --release TAG --sha256 HEX",
  "                          --write",
  "  run                     --event JSON --token TOKEN --model PROVIDER/MODEL",
  "                          --variant NAME --effort LEVEL --prompt TEXT",
  "                          --mentions /mc,/mendcode --publish --approve",
  "                          --thinking --attachments --review",
  "",
  "Defaults: workflow preview, local response, no publishing or tool approval.",
  "In Actions: GITHUB_EVENT_PATH/NAME, GITHUB_REPOSITORY/ACTOR, GH_TOKEN or",
  "GITHUB_TOKEN, MODEL, VARIANT, EFFORT, PROMPT, MENTIONS.",
])

export const PR_HELP = text([
  `usage: ${P} pr <command> [--json] [--dir DATA]`,
  "",
  "  setup [all|requested]   --session ID --yes",
  "  NUMBER                  open MendCode on pr/NUMBER: --token TOKEN --no-tui",
  "                          --project PATH",
  "",
  "Setup uses the session's checkout and model; --yes consents to watching, model",
  "calls and GitHub publishing. NUMBER needs a clean checkout; donor session links",
  "are skipped.",
])

export const CONSOLE_HELP = text([
  `usage: ${P} console <command> [--dir DATA] [--json]`,
  "",
  "  setup [URL]             --token-file FILE",
  "  login [URL]",
  "  logout [email]",
  "  switch [orgID]",
  "  orgs",
  "  open",
  "  status",
  "  off",
])

export const SHARE_HELP = text([
  `usage: ${P} share <command> [--dir DATA] [--json]`,
  "",
  "  status|create|sync|remove SESSION_ID",
  "  policy disabled|manual|auto",
  "  local SESSION_ID        --remove",
  "  gist SESSION_ID         --yes | --remove",
])

export const MFLOW_HELP = text([
  `usage: ${P} [control-plane] mflow <command> [--json]`,
  "",
  "  status|legacy-status",
  "  activate|setup          --room ROOM --url embedded|http://127.0.0.1:PORT",
  "                          --token-file PRIVATE_FILE --priority 0-9",
  "  deactivate|remove|scan|relay-guide|plan|doctor|start|stop",
  "",
  "Opt-in coordination: setup configures only, start is explicit, file sync is off.",
  "--dir DATA selects daemon storage; --project PATH selects the project.",
])

export const TSM_HELP = text([
  `usage: ${P} [control-plane] tsm <command> [--json]`,
  "",
  "  --mux cmux|kitty|ghostty|wezterm|auto",
  "",
  "  status|doctor",
  "  plan|install|setup      save a dry-run plan",
  "  activate|deactivate",
  "  remove                  recycles only MendCode scaffold",
  "  open TARGET",
  "  create NAME             --branch B --base REF --path PATH --focus F",
  "                          (preview only)",
  "",
  "--dir DATA selects daemon storage; --project PATH selects the project.",
])

export const UNINSTALL_HELP = text([
  `usage: ${P} uninstall [options]`,
  "",
  "  --keep-config, -c       keep settings, providers, extensions, terminal config",
  "  --keep-data, -d         keep sessions, snapshots, attachments, encryption key",
  "  --dry-run               review targets; change nothing, start no daemon",
  "  --force, -f             skip confirmation; ownership and daemon checks apply",
  "  --dir D  --json",
  "",
  "Removed files go to Trash; unowned installations are left alone.",
])

export const CACHE_HELP = text([
  `usage: ${P} cache <command> [options]`,
  "",
  "  status",
  "  enable|on",
  "  disable|off",
  "",
  "options:",
  "  --global                every project",
  "  --provider ID           one provider (--model EXACT: one model)",
  "  --session ID            one session",
  "  --project-path PATH     one project",
  "  --scope session|project",
  "  --format text|json  --json  --dir DATA",
])

export const APPLY_HELP = text([
  `usage: ${P} apply [SESSION_ID | --session ID] [options]`,
  "",
  "  --to DIR  --check  --json  --dir DATA",
  "",
  "Applies the files a session changed (default: the project's latest session) onto",
  "another checkout. All or nothing; never overwrites a file that differs from the",
  "diff.",
])

export const AI_CONFIG_HELP = text([
  `usage: ${P} ai-config <command> [options]`,
  "",
  "  inspect|plan|validate|apply",
  "",
  "options:",
  "  --input JSON | --file FILE   the configuration",
  "  --scope project|global  --target PATH  --expected-hash HASH",
  "  --yes  --dir DIR  --json",
])

export const EXPORT_HELP = text([
  `usage: ${P} export [sessionID] [options]`,
  "",
  "  --format json|markdown|html",
  "  --sanitize  --no-reasoning  --no-tools  --metadata  --timestamps",
])

export const IMPORT_HELP = text([
  `usage: ${P} import <file.json|file.jsonl|URL> [options]`,
  `       ${P} import --latest [--from claude-code|codex]`,
  "",
  "  --from auto|mendcode|claude-code|codex",
  "  --dir DATA  --json",
])

export const PROMPT_HELP = text([
  `usage: ${P} [control-plane] prompt <command> [options]`,
  "",
  "  sources                 where the prompt comes from",
  "  build                   build it: --mode MODE --model ID --role ROLE",
  "                          --workflow WORKFLOW --show-full",
  "  mode [MODE]             minimal, focus, guide, full or custom",
  "  cycle-mode",
  "",
  "options:",
  "  --focus auto|codex|claude|gemini|kimi|deepseek|mistral|glm|minimax|grok|local",
  "  --dir D  --json",
])

export const USAGE_HELP = text([
  `usage: ${P} usage [options]`,
  "",
  "Tokens and cost, last N days (default 30).",
  "  --days N  --tools N  --models [N]  --project [ID]  --json",
  "  --scope global|project|directory",
])

export const STATS_HELP = text([
  `usage: ${P} stats [options]`,
  "",
  "Usage over all time by default; --days 0 selects today.",
  "  --days N  --tools N  --models [N]  --project [ID]  --json",
  "  --scope global|project|directory",
  "  --waste                 where tokens were paid twice and what to change",
])

export const GENERATE_HELP = text([
  `usage: ${P} generate [--httpapi] [--dir D]`,
  "",
  "  (nothing)               generate the socket protocol schema",
  "  --httpapi               print the OpenAPI 3.1 contract of the opt-in HTTP",
  "                          adapter (offline, no daemon)",
])

export const PLUGIN_HELP = text([
  `usage: ${P} plugin <module|file://path> [options]`,
  "",
  "  --global, -g  --force, -f  --dir D  --json",
  "",
  "Offline pnpm cache only; project code requires trust; --pure skips external",
  "extensions.",
])

export const RECIPE_HELP = text([
  `usage: ${P} recipe <command> [--json]`,
  "",
  "  list                    recipes of every layer (built-in, packages, user,",
  "                          project); * marks the active one",
  "  apply <name>            set every model role from the recipe",
])

export const BACKLOG_HELP = text([
  `usage: ${P} backlog <command> [--json] [--dir D]`,
  "",
  "  list                    this project's items, open ones first",
  '  add "text"              --file PATH --commit SHA --session ID',
  "  done|reopen|remove <id>",
  "  clear                   remove the finished items",
  "",
  "The project is the directory the command runs in. A session's own shell may",
  "list; only you change the list.",
])

export const CONTEXT_HELP = text([
  `usage: ${P} context <sessionID> [--limit N] [--json] [--dir D]`,
  "",
  "  --limit N               1-100, default 20",
])

export const MODELS_HELP = text([
  `usage: ${P} models [provider] [--verbose] [--refresh] [--json]`,
  "",
  "  control-plane models status|show|plan|presets",
  "  control-plane models set-default <provider> <model>",
  "                          --auth-mode api-key|chatgpt-subscription-oauth",
  "                          --enable --dry-run",
  "  control-plane models use-preset <name> [--enable] [--dry-run]",
])

export const PROVIDERS_HELP = text([
  `usage: ${P} providers <command> [--provider ID]`,
  "",
  "  list",
  "  logout",
  "  login [url]             --provider ID --method LABEL --api-key-env VAR",
  "                          --provider-type TYPE --base-url URL",
  "  login --provider azure  --azure-resource NAME | --base-url URL",
  "                          --deployments IDS --entra-token-env VAR",
  "                          --api-version VERSION --use-completion-urls",
  "                          --use-deployment-based-urls",
  "  login --provider amazon-bedrock",
  "                          --method aws-chain|api-key --aws-region REGION",
  "                          --aws-profile PROFILE --models IDS --aws-metadata",
  "                          --aws-credential-process",
  "  login --provider google-vertex",
  "                          --gcp-project ID --vertex-location LOCATION",
  "                          --models IDS --google-token-env VAR",
  "                          --vertex-quota-project ID --google-metadata",
  "",
  "Under control-plane:",
  "  providers auth|status|adapters",
  "  providers smoke         --provider ID --model ID --execute",
  "  auth status [provider]",
  "  auth login-plan|login <provider>   --method browser|headless|api-key --execute",
  "  auth refresh|logout chatgpt        --execute",
])

export const MCP_HELP = text([
  `usage: ${P} mcp <command>`,
  "",
  "  list",
  "  auth [name]             also: auth list",
  "  logout [name]",
  "  debug <name>",
  "  add [name]              --scope user|project --replace --dry-run",
  "                          --url URL [--no-oauth] [--client-id ID]",
  "                          [--client-secret-env VAR] [--callback-port PORT]",
  "                          [--redirect-uri URI]",
  "                          or: -- COMMAND ARG...",
  "",
  "Under control-plane: mcp status|preview|add-local <name> <command> [args...]",
])

export const CONTROL_PLANE_HELP = text([
  `usage: ${P} control-plane <area> <command> [--dir D] [--json]`,
  "",
  "  permissions status      also: set-default MODE | set-reviewer-role ROLE",
  "                          MODE: approval, smart, full_access, ask, edits, full",
  "  tui status              also: schema | profile | apply ID | preview |",
  "                          apply-preset PRESET | rollback ID | propose TEXT |",
  "                          project | render",
  "                          --state home|session --session ID --dry-run",
  "  ai status               also: env [status]",
  "  system status           also: doctor | check | toolchain | config-paths |",
  "                          config-layers | precedence | adapter-status",
  "  setup status|plan|doctor",
  "  budget status|doctor",
  "",
  "Other areas have their own help: project, worktree, mflow, tsm, models,",
  "providers, auth, mcp, memory, prompt, loops, workflows, packages.",
])

export const PROJECT_HELP = text([
  `usage: ${P} control-plane project <command> [--dir DATA] [--json]`,
  "",
  "  init",
  "  config-show",
  "  context-status|context-refresh|context-show",
  "  focus-status|focus-list|focus-show [ID]|focus-use ID",
  "  package-show|package-set",
])

export const DOCS_HELP = text([
  `usage: ${P} docs [topic...] [--dir D]`,
  "",
  "  (nothing)               list the topics, one line each",
  "  --search WORDS          the cards that answer plain words (up to 5)",
  "  TOPIC [TOPIC...]        print each reference card of this version: the exact",
  "                          command, file or slash command, and live facts",
  "  commands NAME           one built-in slash command in detail",
  "",
  "Works offline. --dir D (--data-dir D): the data directory the live lines read",
  "(default MENDCODE_V2_DIR or ~/.mendcode-v2). Exit codes: 0 a card printed,",
  "2 none printed (the topic list follows), 64 usage.",
])

export const CONFIG_BUNDLE_HELP = text([
  `usage: ${P} config-bundle <command> [--dir D] [--json]`,
  "",
  "  inventory               what this data directory holds (read-only)",
  "  export <file>           one verifiable file; --allow-flagged PATH (repeatable)",
  "                          --overwrite",
  "  inspect <file>          check the hashes and list what it carries (read-only)",
  "  import <file>           preview only; prints the plan id:",
  "                          --on-conflict keep|replace --resolve ITEM=keep|replace",
  "                          --rewrite-home",
  "  import <file> --apply --plan ID   apply the previewed plan, with backups",
  "  imports                 earlier imports of this data directory",
  "  rollback <import-id>    undo one import (--force: also items changed since)",
])

export const PROFILE_HELP = text([
  `usage: ${P} profile <command> [--json]`,
  "",
  "Folder profiles: sessions under a profile's folders use its memory, roles and",
  "default permission.",
  "",
  "  list                    profiles, their folders, this directory's profile",
  "  add <name> <folder>...  add or replace; --permission ask|edits|full",
  "  remove <name>           its user memories stay, tagged, but are not used",
])

export const AGENT_HELP = text([
  `usage: ${P} agent <command> [--dir D] [--json]`,
  "",
  "  list",
  "  create                  --path DIR --description TEXT",
  "                          --mode all|primary|subagent --name NAME",
  "                          --model provider/model (-m)",
  "                          --permissions bash,read,edit,glob,grep,webfetch,task,",
  "                          todowrite,websearch,lsp,skill",
  "                          --generate: the model writes name, when-to-use",
  "                          text and prompt (falls back to the plain template)",
  "",
  "Also: debug agent <name> [--tool ID] [--params JSON]",
])

export const STORAGE_HELP = text([
  `usage: ${P} storage [options] [--json]`,
  "",
  "  (no options)            where the disk goes: database, WAL, blobs, orphans,",
  "                          bytes per turn, snapshots, what compression saves,",
  "                          top sessions",
  "  --clean                 remove sessions idle longer than --older-than",
  "                          (default: the retentionDays setting, else 90d), then",
  "                          orphan blobs; never touches a session with an active",
  "                          turn, a queued message or a live loop",
  "  --compact               move old data into the compact forms (compressed tool",
  "                          output, model history, shared snapshot content) and",
  "                          drop the streaming deltas of finished messages in",
  "                          sessions idle --delta-idle (default 3d); no loss",
  "  --offline               with --compact --dir DATA: VACUUM INTO 16 KB pages,",
  "                          atomic swap, backup kept; the daemon must be stopped",
  "  --worktrees             alone: list the worktrees the daemon created (size,",
  "                          merged or not, why one is kept); with --clean or",
  "                          --compact: also remove the merged, clean, unused ones",
  "                          idle --worktree-idle (default 14d) and old trash.",
  "                          Local only",
  "  --dry-run               show what --clean or --compact would change; change",
  "                          nothing",
  "  --vacuum                also rewrite the database file (needs free disk equal",
  "                          to its size); alone, it removes no sessions",
  "",
  "  --older-than 90d  --delta-idle 3d  --worktree-idle 14d",
])
