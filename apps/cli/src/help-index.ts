import { PROGRAM_NAME } from "@mendcode/program"

/**
 * The index `mendcode --help` prints: every command once, grouped by what you want to do, one line each (arguments, then a few words).
 * `command` is the word that starts the line; `mendcode <command> --help` prints the details. `test/cli-help.test.ts` checks that each
 * word resolves to a real command and that every registered command is listed here (or is an alias named in HELP_ALIASES).
 */
export type HelpEntry = { command: string; usage: string; text: string }
export type HelpGroup = { title: string; entries: readonly HelpEntry[] }

const e = (command: string, usage: string, text: string): HelpEntry => ({ command, usage, text })

export const HELP_GROUPS: readonly HelpGroup[] = [
  { title: "Work", entries: [
    e("run", "run MESSAGE...", "one headless turn (--bg: in the background)"),
    e("attach", "attach ID", "open the terminal UI on a session"),
    e("ps", "ps", "background sessions that are running"),
    e("logs", "logs ID [-f]", "events of a session (-f follows)"),
    e("kill", "kill ID", "cancel the running turn of a session"),
    e("session", "session <command>", "list, send to, watch and control sessions"),
    e("export", "export [ID]", "write a session as json, markdown or html"),
    e("import", "import FILE|URL", "bring in a session (also from Claude Code, Codex)"),
    e("apply", "apply [ID] [--to DIR]", "apply a session's file changes to a checkout"),
    e("context", "context ID", "what fills the context of a session"),
    e("worktree", "worktree <command>", "git worktrees for sessions"),
  ] },
  { title: "Remember and automate", entries: [
    e("memory", "memory <command>", "saved and proposed memories"),
    e("backlog", "backlog <command>", "this project's to-do list"),
    e("loop", "loop <command>", "scheduled and goal loops"),
    e("workflow", "workflow <command>", "multi-step workflows and scripts"),
    e("mflow", "mflow <command>", "MendCode flow rooms"),
  ] },
  { title: "Models, tools and look", entries: [
    e("models", "models [provider]", "list models"),
    e("providers", "providers list|logout", "signed-in providers"),
    e("mcp", "mcp <command>", "MCP servers: list, add, auth, debug"),
    e("agent", "agent list|create", "agents"),
    e("recipe", "recipe list|apply NAME", "model recipes"),
    e("prompt", "prompt <command>", "how the system prompt is built"),
    e("cache", "cache <command>", "prompt cache on or off"),
    e("theme", "theme <command>", "themes"),
    e("package", "package <command>", "packages: install, enable, create"),
    e("plugin", "plugin MODULE", "install an extension"),
    e("plugin-auth", "plugin-auth [provider]", "sign in through an extension"),
    e("profile", "profile <command>", "folder profiles (memory, roles, permission)"),
    e("config-bundle", "config-bundle <command>", "export and import settings"),
    e("ai-config", "ai-config <command>", "inspect and apply AI config files"),
    e("tsm", "tsm <command>", "terminal multiplexer setup"),
  ] },
  { title: "Usage and health", entries: [
    e("usage", "usage [--days N]", "tokens and cost per day"),
    e("stats", "stats [--days N]", "usage over all time, --waste for savings"),
    e("storage", "storage [--clean]", "where disk goes; clean and compact"),
    e("status", "status", "daemon, models and project at a glance"),
    e("doctor", "doctor", "check this installation"),
    e("debug", "debug <command>", "diagnostics: config, paths, files, lsp"),
    e("db", "db [SQL]", "read-only SQL shell on the database"),
  ] },
  { title: "Setup and services", entries: [
    e("control-plane", "control-plane <area>", "settings by area: ai, system, tui, project"),
    e("daemon", "daemon <command>", "start, stop, status, logs, service"),
    e("console", "console <command>", "MendCode console: setup, login, orgs"),
    e("share", "share <command>", "share a session: link, local file, gist"),
    e("github", "github install|run", "GitHub workflow and action"),
    e("pr", "pr NUMBER | pr setup", "work on a pull request"),
    e("acp", "acp", "Agent Client Protocol on stdio (editors)"),
    e("app-server", "app-server", "JSON-RPC on stdio for other UIs"),
    e("pet", "pet new TEXT", "create a pet from a description"),
    e("completion", "completion SHELL", "shell completion script"),
    e("generate", "generate [--httpapi]", "protocol schema or HTTP API contract"),
    e("docs", "docs [TOPIC]", "reference cards of this version"),
    e("uninstall", "uninstall", "remove MendCode"),
    e("help", "help [COMMAND]", "this text, or the help of one command"),
  ] },
]

/** Words that run a command listed under another word: the help of the first is the help of the second. */
export const HELP_ALIASES: Readonly<Record<string, string>> = {
  tui: "mendcode", workflows: "workflow", loops: "loop", packages: "package", marketplace: "package", runtime: "package", plug: "plugin",
  login: "console", logout: "console", switch: "console", orgs: "console", open: "console", project: "control-plane", thread: "attach",
}

const COLUMN = 30

export function indexText(schema: string): string {
  const lines = [
    `${PROGRAM_NAME} - terminal coding harness`,
    "",
    `usage: ${PROGRAM_NAME} [PROJECT]                 open the terminal UI`,
    `       ${PROGRAM_NAME} <command> [options]`,
    `       ${PROGRAM_NAME} <command> --help         details of one command`,
    `UI and run options: ${PROGRAM_NAME} run --help`,
  ]
  for (const group of HELP_GROUPS) {
    lines.push("", `${group.title}:`)
    for (const entry of group.entries) lines.push(`  ${entry.usage.padEnd(COLUMN - 2)}${entry.text}`)
  }
  lines.push(
    "",
    "Options (any command):",
    "  --dir D               data directory (--data-dir)",
    "  --json                JSON lines, schema " + schema + " (--format json)",
    "  -h, --help            help        -v, --version   version",
    "  --print-logs          logs on stderr; --log-level LEVEL; --trace",
    "",
    "Exit codes: 0 ok, 1 failure, 2 stopped, 3 timeout, 4 needs input,",
    "  5 approval denied (session send), 64 usage. run has its own: run --help.",
    "",
  )
  return lines.join("\n")
}

export const HELP_WIDTH = 80

/** Breaks one long line at a space, preferably before an option or a bracket, and indents the rest under the line's own text. */
function wrapLine(line: string, indent: number, hang: number): string[] {
  const out: string[] = []
  let rest = line
  let pad = ""
  while (rest.length + pad.length > HELP_WIDTH) {
    const room = HELP_WIDTH - pad.length
    let cut = -1
    for (let i = room; i > Math.max(indent, room - 28); i--) {
      if (rest[i] === " " && /^[\[(<-]/.test(rest.slice(i + 1, i + 2))) { cut = i; break }
    }
    // A space inside `<a|b c|d>` is not a place to break: the bars are.
    const inside = (at: number) => { const whole = line.length - rest.length + at; return line.lastIndexOf("<", whole) > line.lastIndexOf(">", whole) }
    if (cut < 0) { cut = rest.lastIndexOf(" ", room); while (cut > indent && inside(cut)) cut = rest.lastIndexOf(" ", cut - 1) }
    let skip = 1
    // A word longer than the line (`<a|b|c|...>`) breaks after a bar.
    if (cut <= indent) {
      const bar = rest.lastIndexOf("|", room - 1)
      if (bar > indent) { cut = bar + 1; skip = 0 } else cut = rest.indexOf(" ", room)
    }
    if (cut <= 0) break
    out.push(pad + rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut + skip)
    pad = " ".repeat(hang)
  }
  out.push(pad + rest)
  return out
}

/** One `usage:` line per help (later ones continue under it) and no line past 80 columns. */
export function tidyHelp(text: string): string {
  let seen = false
  return text.split("\n").flatMap((raw) => {
    let line = raw
    if (line.startsWith("usage: ")) {
      if (seen) line = `       ${line.slice("usage: ".length)}`
      seen = true
    }
    if (line.length <= HELP_WIDTH) return [line]
    // A description column far to the right gives way when its line does not fit.
    const deep = /^ {35,}/.exec(line)
    if (deep) line = " ".repeat(30) + line.trimStart()
    if (line.length <= HELP_WIDTH) return [line]
    const lead = /^ */.exec(line)![0].length
    if (line.startsWith("usage: ")) return wrapLine(line, 4, 7)
    // A description column far to the right moves in so that it has room.
    const wide = /^( *\S.*?) {2,}(\S.*)$/.exec(line)
    if (wide && wide[1]!.length <= 28 && !wide[1]!.startsWith("usage")) {
      line = `${wide[1]!.padEnd(30)}${wide[2]}`
      if (line.length <= HELP_WIDTH) return [line]
    }
    // An entry with a description column continues under that column.
    const gap = /^ *\S.*? {2,}(?=\S)/.exec(line)
    const column = gap && gap[0].length < 44 ? gap[0].length : lead >= 24 ? lead : lead + 4
    return wrapLine(line, lead, column)
  }).join("\n")
}
