import type { RecentContextReport, SystemReport } from "@mendcode/protocol"
import { PROGRAM_NAME } from "@mendcode/program"
import { compactEstimateText, describePrecedence, resolvePrecedence, type PrecedenceFacts } from "@mendcode/protocol/wire"

const count = (tokens: number) => tokens.toLocaleString("en-US")

/** Three lines: the model and its window, where the history is packed and what sets that, how full the context is. Each number names its source. */
export function contextLimitsLines(limits: NonNullable<RecentContextReport["limits"]>): string[] {
  const windowSource = { session: "this session's /context-window", "model-setting": "the modelContext setting for this model", engine: "reported by the engine", catalog: "model list", unknown: "" }[limits.contextWindowSource]
  const max = limits.maxContextWindow ? ` · max ${count(limits.maxContextWindow)}` : ""
  const window = limits.contextWindow ? `context window ${count(limits.contextWindow)} tokens (${windowSource})${max}` : `context window not stated by the model list${max}`
  const basis = limits.inputLimit ? "input limit" : "window"
  const thresholdBy = { default: "default; compactAtTokens not set", "compaction.threshold": "compaction.threshold", "provider-override": "the provider's compaction.threshold", "model-override": "the model's compaction.threshold" }[limits.thresholdSource ?? "default"]
  const why = {
    threshold: `${limits.thresholdPercent ?? 90}% of the ${basis} (${thresholdBy})`,
    compactAtTokens: "the compactAtTokens setting",
    environment: "MENDCODE_COMPACT_AT_TOKENS of the daemon",
    "model-setting": "compactAt of the modelContext setting for this model",
    "compaction.token_limit": "the compaction.token_limit setting",
    "provider-override": "the provider's compaction.token_limit",
    "model-override": "the model's compaction.token_limit",
    "no-window-default": "the default when no window is known",
    engine: "the engine's own figure",
    "last-call": "as the engine said at the last call",
    "engine-managed": "",
  }[limits.compactAtSource]
  const compacts = limits.compactAtTokens ? `compacts at ${count(limits.compactAtTokens)} tokens: ${why}${limits.capped ? `, lowered to the ${basis}` : ""}` : "compaction: this engine packs its own context"
  const against = limits.compactAtTokens ? [limits.compactAtTokens, "the compaction point"] as const : limits.contextWindow ? [limits.contextWindow, "the window"] as const : undefined
  const measured = limits.contextTokensSource === "estimate" ? "estimate of the current history" : "provider's count after the last call"
  return [
    `model ${limits.model} · ${window}${limits.inputLimit ? ` · input limit ${count(limits.inputLimit)}` : ""}`,
    `${compacts}${limits.autoCompact || !limits.compactAtTokens ? "" : " · automatic compaction is off (compaction.auto false): only /compact packs"}`,
    limits.contextTokens === undefined ? "context now: no model call recorded" : `context now ${count(limits.contextTokens)} tokens${against ? `, ${Math.round(limits.contextTokens / against[0] * 100)}% of ${against[1]}` : ""} (${measured})`,
    ...(limits.forecast ? [forecastLine(limits.forecast)] : []),
    ...(limits.idleCompaction ? [idleCompactionLine(limits.idleCompaction)] : []),
  ]
}

/** One line: how far the compaction is, as the terminal's notice says it, and the share at which the terminal says it. */
export function forecastLine(forecast: NonNullable<NonNullable<RecentContextReport["limits"]>["forecast"]>): string {
  const notice = forecast.noticePercent === undefined ? "notice off" : `notice at ${forecast.noticePercent}%${forecast.noticeDue ? " (reached)" : ""}`
  return `${compactEstimateText(forecast, count)} · ${notice}`
}

const clock = (at: number) => { const date = new Date(at); return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":") }

/** One line: when the compaction while idle starts and which cache lifetime sets that, or why none is scheduled. */
export function idleCompactionLine(idle: NonNullable<NonNullable<RecentContextReport["limits"]>["idleCompaction"]>): string {
  const lifetime = idle.lifetimeMinutes === undefined ? "" : `${idle.provider ?? "provider"} keeps the prompt cache ${idle.lifetimeMinutes}m after a call (${idle.lifetimeSource === "setting" ? "cacheLifetimeMinutes" : idle.lifetimeSource})`
  if (idle.scheduled && idle.at !== undefined) return `idle compaction at ${clock(idle.at)}: ${lifetime}`
  const why = {
    "feature-off": "off (/tier idle_compact on)",
    "auto-off": "off: automatic compaction is off (compaction.auto false)",
    "native-strategy": "off: compaction.strategy is native",
    "engine-managed": "off: this engine packs its own context",
    "child-session": "off: a sub-agent's session",
    "no-call": "not scheduled: no model call since the daemon started",
    "below-threshold": `not scheduled: context below ${count(idle.atTokens)} tokens`,
    "unknown-lifetime": `off: nobody states how long ${idle.provider ?? "the provider"} keeps the prompt cache (cacheLifetimeMinutes)`,
    "already-compacted": "not scheduled: already compacted since the last call",
    busy: "not scheduled: the session is busy",
    "cache-expired": "not scheduled: the prompt cache has expired",
  }[idle.reason ?? "no-call"]
  return `idle compaction ${why}`
}

export function contextText(report: RecentContextReport) {
  const lines = [...(report.limits ? [...contextLimitsLines(report.limits), ""] : []), "Context and cache — recent requests"]
  if (!report.requests.length) lines.push("No recorded requests")
  for (const request of report.requests) {
    lines.push("", `#${request.seq} ${request.provider}/${request.model}`)
    if (request.profile) {
      const p = request.profile, t = p.estimatedTokens
      lines.push(`Estimated tokens: instructions ${t.instructions}, memory ${t.memory}, history ${t.history}, tool results ${t.toolResults}, schemas ${t.toolSchemas}, media ${t.media}; total ${t.total}`)
      lines.push(`First token: ${p.firstTokenMs === null ? "unavailable" : `${p.firstTokenMs} ms`}; request: ${p.durationMs} ms; tools: ${p.toolCount}; images: ${p.imageCount}`)
    } else lines.push("Request estimates and timing: unavailable")
    lines.push(`Provider input: ${request.inputTokens}; cache read: ${request.cachedTokens}; cache write: ${request.cacheWriteTokens}; hit rate: ${request.cacheHitRate === null ? "unavailable" : `${(request.cacheHitRate * 100).toFixed(1)}%`}`)
  }
  if (report.truncated) lines.push("", `Showing the most recent ${report.requests.length} requests`)
  return `${lines.join("\n")}\n`
}

export function systemText(report: SystemReport) {
  if (report.operation === "doctor" || report.operation === "check") return `${report.checks.map((check) => `${check.ok ? "ok" : "fail"}\t${check.name}\t${check.detail}`).join("\n")}\n`
  if (report.operation === "config-layers") {
    const { layers = [], warnings = [] } = report.facts as { layers?: Array<{ label: string; source: string; present: boolean; entries: string[]; note?: string }>; warnings?: string[] }
    const lines = ["Config layers, lowest to highest precedence (secret values are never shown)"]
    for (const layer of layers) lines.push("", `${layer.label} · ${layer.present ? "present" : "not set"}`, `  ${layer.source}${layer.note ? ` · ${layer.note}` : ""}`, ...layer.entries.map((entry) => `  - ${entry}`))
    if (warnings.length) lines.push("", "Warnings", ...warnings.map((warning) => `  - ${warning}`))
    return `${lines.join("\n")}\n`
  }
  if (report.operation === "precedence") {
    const facts = report.facts as unknown as PrecedenceFacts
    const sections = describePrecedence(resolvePrecedence(facts.claims))
    const lines = [`Precedence of files, lowest layer first: ${facts.layers.join(" > ")} (the last listed is in force; profile keys, keys and views of the terminal are in /packages p)`]
    for (const section of sections) lines.push("", section.heading, ...section.lines)
    if (facts.truncated) lines.push("", "more than 2000 entries; the list is cut")
    return `${lines.join("\n")}\n`
  }
  return `${JSON.stringify(report.facts, null, 2)}\n`
}

const COMMANDS = ["backlog", "run", "export", "acp", "app-server", "session", "memory", "loop", "workflow", "usage", "storage", "package", "recipe", "profile", "control-plane", "tui", "help", "context", "status", "doctor", "debug", "generate", "completion", "agent", "import", "uninstall", "cache", "daemon", "loops", "db", "tsm", "github", "pr", "ps", "logs", "kill", "attach", "claude"]
const SUBCOMMANDS: Record<string, string> = {
  "control-plane": "ai system tui tsm", ai: "env status", env: "status",
  system: "status doctor check toolchain config-paths config-layers precedence adapter-status", debug: "rg config info paths scrap skill startup agent file lsp snapshot wait", rg: "tree files search",
  session: "list create get status inspect export rename fork delete send wait events cancel",
  backlog: "list add done reopen remove clear",
  memory: "list add search", loop: "list create pause resume stop run delete fire",
  workflow: "list preview start show pause resume stop verify delete retry accept",
  package: "list install remove enable disable", recipe: "list apply", profile: "list add remove",
  agent: "create list",
  cache: "status enable on disable off",
  daemon: "start run status logs stop service", service: "plan install start stop restart status logs uninstall", loops: "daemon service", dream: "status tick run consolidate daemon service",
  db: "path", file: "search read status list tree", lsp: "diagnostics symbols document-symbols", snapshot: "track patch diff",
  tsm: "status plan install setup activate deactivate remove doctor open create",
  github: "install run", claude: "login status",
}
const FLAGS = "--dir --data-dir --json --format --help --version --print-logs --log-level --limit --query --glob --httpapi --index --entry --keep-config --keep-data --dry-run --force --trace --no-trace --approve --no-approve --offline --output-schema --output-last-message --ephemeral --max-turns --tools --exclude-tools --no-tools --system-prompt --append-system-prompt --config --add-dir --process"

/** Static scripts need neither a daemon nor a provider and work for source and compiled entrypoints. */
export type CompletionShell = "bash" | "zsh" | "fish" | "powershell"
export const COMPLETION_SHELLS: readonly CompletionShell[] = ["bash", "zsh", "fish", "powershell"]
/** Completion is registered for the released name and for the one this process was started under. */
const COMPLETED_NAMES = [...new Set([PROGRAM_NAME, "mendcode"])]

export function completionScript(shell: CompletionShell) {
  const cases = Object.entries(SUBCOMMANDS).map(([name, words]) => `    ${name}) words='${words}' ;;`).join("\n")
  if (shell === "fish") {
    const subcommands = Object.entries(SUBCOMMANDS).map(([name, words]) => `    complete -c $command -n '__fish_seen_subcommand_from ${name}' -a '${words}'`).join("\n")
    const flags = FLAGS.split(" ").map((flag) => `    complete -c $command -l ${flag.slice(2)}${flag === "--dir" || flag === "--data-dir" ? " -r -F" : ""}`).join("\n")
    return `# MendCode completion (fish)\nfor command in ${COMPLETED_NAMES.join(" ")}\n    complete -c $command -f\n    complete -c $command -n '__fish_use_subcommand' -a '${COMMANDS.join(" ")}'\n${subcommands}\n    complete -c $command -l log-level -x -a 'DEBUG INFO WARN ERROR'\n${flags}\nend\n`
  }
  if (shell === "powershell") {
    const table = Object.entries(SUBCOMMANDS).map(([name, words]) => `    '${name}' = '${words}'`).join("\n")
    return `# MendCode completion (PowerShell)\nRegister-ArgumentCompleter -Native -CommandName ${COMPLETED_NAMES.join(", ")} -ScriptBlock {\n  param($wordToComplete, $commandAst, $cursorPosition)\n  $words = @($commandAst.CommandElements | ForEach-Object { $_.ToString() })\n  $previous = if ($wordToComplete -eq '' -and $words.Count -gt 0) { $words[-1] } elseif ($words.Count -gt 1) { $words[-2] } else { '' }\n  $subcommands = @{\n${table}\n    '--log-level' = 'DEBUG INFO WARN ERROR'\n  }\n  $candidates = if ($wordToComplete -like '-*') { '${FLAGS}' } elseif ($subcommands.ContainsKey($previous)) { $subcommands[$previous] } else { '${COMMANDS.join(" ")}' }\n  $candidates -split ' ' | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }\n}\n`
  }
  if (shell === "bash") return `# MendCode completion (bash)\n_mendcode() {\n  local current="\${COMP_WORDS[COMP_CWORD]}" previous="\${COMP_WORDS[COMP_CWORD-1]}" words='${COMMANDS.join(" ")}'\n  case "$previous" in\n${cases}\n    --log-level) words='DEBUG INFO WARN ERROR' ;;\n    --dir|--data-dir) COMPREPLY=( $(compgen -d -- "$current") ); return ;;\n  esac\n  [[ "$current" == -* ]] && words='${FLAGS}'\n  COMPREPLY=( $(compgen -W "$words" -- "$current") )\n}\ncomplete -F _mendcode ${COMPLETED_NAMES.join(" ")}\n`
  return `#compdef ${COMPLETED_NAMES.join(" ")}\n_mendcode() {\n  local previous="\${words[CURRENT-1]}" words_list='${COMMANDS.join(" ")}'\n  case "$previous" in\n${cases.replaceAll("words=", "words_list=")}\n    --log-level) words_list='DEBUG INFO WARN ERROR' ;;\n    --dir|--data-dir) _files -/; return ;;\n  esac\n  [[ "\${words[CURRENT]}" == -* ]] && words_list='${FLAGS}'\n  compadd -- \${=words_list}\n}\ncompdef _mendcode ${COMPLETED_NAMES.join(" ")}\n`
}
