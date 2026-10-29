import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { AGENT_SHELL_ENV, AGENT_SHELL_FILE_BLOCKS, agentRefusal } from "@mendcode/protocol/wire"

/**
 * The shell side of the agent-origin guard (docs/permissions.md): every command a session starts is marked, tracked and,
 * when it calls this program to change the owner's configuration, refused before it runs. Recognising a command line is
 * pattern matching and can be evaded; the daemon's own check of who is connected is what holds.
 */

// ---- the mark ------------------------------------------------------------------------------------------------

const MARKED_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"])
const shellName = (shell: string) => (shell.split(/[\\/]/).pop() ?? shell).toLowerCase().replace(/\.exe$/, "")

/** The data directory a session's own `mendcode` reads: the daemon's (the engine exports it), else the default one. */
export function agentDataDir(environment: Readonly<NodeJS.ProcessEnv> | undefined) {
  return path.resolve(environment?.MENDCODE_V2_DIR || path.join(homedir(), ".mendcode-v2"))
}

/** The environment of a command a session starts: the caller's plus the variable that names the daemon it runs under. */
export function agentShellEnvironment(environment: Readonly<NodeJS.ProcessEnv> | undefined): NodeJS.ProcessEnv {
  const base = environment ?? process.env
  return { ...base, [AGENT_SHELL_ENV]: agentDataDir(base) }
}

/**
 * Text run before a session's command in the shells that have `ulimit`: lowers the hard file-size limit to a value no file
 * reaches. Soft first, because a hard limit below the soft one is refused; quiet when a lower limit is already in force.
 */
export function agentLimitPrefix(shell: string) {
  return MARKED_SHELLS.has(shellName(shell)) ? `ulimit -S -f ${AGENT_SHELL_FILE_BLOCKS} 2>/dev/null; ulimit -H -f ${AGENT_SHELL_FILE_BLOCKS} 2>/dev/null` : undefined
}

/** How a session's command starts: the mark in front of the user's own prefix, and the marked environment. */
export function agentShellLaunch({ shell, policy, environment }: { shell: string; policy?: import("./shell-policy").ShellPolicy | undefined; environment?: Readonly<NodeJS.ProcessEnv> | undefined }) {
  const limit = agentLimitPrefix(shell)
  return {
    policy: limit ? { ...policy, prefix: policy?.prefix ? `${limit}\n${policy.prefix}` : limit } : policy,
    environment: agentShellEnvironment(environment),
  }
}

// ---- the processes a session started ---------------------------------------------------------------------------

type Tracked = { sessionId?: string | undefined; exited: boolean }
const MAX_EXITED = 4096

function createProcessTable() {
  const agents = new Map<number, Tracked>()
  const users = new Map<number, Tracked>()
  const add = (table: Map<number, Tracked>, pid: number | undefined, sessionId?: string) => {
    const entry: Tracked = { ...(sessionId ? { sessionId } : {}), exited: false }
    if (typeof pid === "number" && pid > 1) table.set(pid, entry)
    return {
      /** The process ended. The entry stays: what it left running still belongs to its session (see `find`). */
      exited() {
        entry.exited = true
        let over = [...table.values()].filter((item) => item.exited).length - MAX_EXITED
        for (const [key, item] of table) {
          if (over <= 0) break
          if (item.exited) { table.delete(key); over-- }
        }
      },
    }
  }
  /**
   * The entry of `pid`. For an ended process the number can only belong to someone else once nothing of its session is
   * left (a pid that still names a session or group is never handed out), so a live process under that number means the
   * entry is stale.
   */
  const find = (table: Map<number, Tracked>, pid: number, alive: (pid: number) => boolean) => {
    const entry = table.get(pid)
    if (!entry || !entry.exited) return entry
    if (!alive(pid)) return entry
    table.delete(pid)
    return undefined
  }
  return {
    /** A command a session started (`shell`, a background task, `shell_session`). */
    agent: (pid: number | undefined, sessionId?: string) => add(agents, pid, sessionId),
    /** A process the user drives through the daemon (a terminal they opened, a hook they wrote): what it starts is theirs. */
    user: (pid: number | undefined) => add(users, pid),
    findAgent: (pid: number, alive: (pid: number) => boolean) => find(agents, pid, alive),
    findUser: (pid: number, alive: (pid: number) => boolean) => find(users, pid, alive),
    clear() { agents.clear(); users.clear() },
  }
}

/** One table per process: the tools record what they start, the daemon asks it who is on the other end of a connection. */
export const agentProcesses = createProcessTable()

// ---- recognising a command line -----------------------------------------------------------------------------

const PROGRAM = /^(?:mend|mendcode(?:-[a-z]+)?)(?:\.exe)?$/i
const SOURCE_ENTRY = /(?:^|[\\/])apps[\\/]cli[\\/]src[\\/](?:main|entry)\.ts$/
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"])
const RUNTIMES = new Set(["bun", "node", "bunx", "npx", "tsx"])
const PRIVILEGE = new Set(["sudo", "doas"])
const PRIVILEGE_VALUES = new Set(["-u", "-g", "-h", "-p", "-U", "-C", "-D", "-R", "-T", "-r", "-t"])
const WRAPPERS = new Set(["command", "exec", "builtin", "nohup", "time", "nice", "ionice", "stdbuf", "timeout", "gtimeout", "setsid", "caffeinate", "xargs", "watch", "unbuffer", "arch", "chrt", "taskset", "noglob", "nocorrect", "then", "do", "else", "if", "while", "!"])
/** `--dir` after these names a project, not a data directory. */
const PROJECT_DIR_HEADS = new Set(["session", "sessions", "ps", "logs", "kill", "attach"])

type Rule = { subs?: readonly string[]; except?: readonly string[]; flags?: readonly string[]; what: string; ask?: string }
const lifecycle = "stops, starts or reinstalls the daemon every session runs under"
/** By first word (after an optional `control-plane`): what a session may not ask this program to do from its shell. */
const RULES: Record<string, Rule> = {
  permissions: { subs: ["set-default", "set-reviewer-role"], what: "changes the permission defaults of every new session", ask: "/permissions" },
  models: { subs: ["set-default", "use-preset"], what: "changes the default model", ask: "/models" },
  recipe: { subs: ["apply"], what: "sets every model role", ask: "/models" },
  recipes: { subs: ["apply"], what: "sets every model role", ask: "/models" },
  profile: { subs: ["add", "remove"], what: "changes a folder profile and its default permission" },
  profiles: { subs: ["add", "remove"], what: "changes a folder profile and its default permission" },
  cache: { subs: ["enable", "on", "disable", "off"], what: "changes the prompt cache setting" },
  console: { subs: ["setup", "off", "login", "logout", "switch", "open", "policy"], what: "changes the console account or its policy" },
  share: { subs: ["create", "sync", "remove", "policy", "local", "gist"], what: "publishes a session or changes the sharing policy" },
  providers: { subs: ["login", "logout", "smoke"], what: "changes provider credentials", ask: "/connect" },
  auth: { subs: ["login", "refresh", "logout"], what: "changes provider credentials", ask: "/connect" },
  mcp: { subs: ["add", "add-local", "auth", "logout"], except: ["auth:list"], what: "changes the MCP servers this machine runs", ask: "/mcp" },
  package: { subs: ["install", "use", "install-source", "use-source", "remove", "restore", "enable", "disable", "deselect", "disable-all", "deselect-all", "add-source", "remove-source", "refresh", "create", "update", "delete-local"], what: "installs, removes or switches packages", ask: "/packages" },
  plugin: { what: "installs an extension" },
  theme: { subs: ["install", "select"], what: "installs or selects a theme", ask: "/theme" },
  agent: { subs: ["create", "debug"], what: "creates an agent or runs one of its tools with approval off" },
  debug: { subs: ["agent"], what: "runs a tool with approval off" },
  prompt: { subs: ["mode", "cycle-mode"], except: ["mode:"], what: "changes the prompt mode" },
  tui: { subs: ["apply", "apply-preset", "rollback", "propose"], what: "changes the terminal profile" },
  project: { subs: ["init", "context-refresh", "focus-use", "package-set"], what: "changes the project's configuration" },
  tsm: { subs: ["install", "setup", "activate", "deactivate", "remove", "open", "create"], what: "changes the terminal session manager setup" },
  memory: { subs: ["add", "edit", "delete", "apply", "reject", "import-codex", "import-v1", "config", "dream"], except: ["dream:status"], what: "writes memory without the user's approval", ask: "/memory (a session proposes with its memory tool; the user approves)" },
  loop: { subs: ["create", "pause", "resume", "stop", "run", "delete", "fire", "tick", "activate", "daemon", "service"], what: "schedules or controls unattended work", ask: "/loops (a session creates a loop with its loop tool; the user approves)" },
  workflow: { subs: ["start", "run", "save", "budget", "update", "pause", "resume", "stop", "verify", "delete", "retry", "retry-task", "approve", "reject", "accept"], what: "starts or controls unattended work", ask: "/workflows (a session starts one with its workflow tool; the user approves)" },
  daemon: { subs: ["start", "run", "stop", "restart", "service"], except: ["service:plan", "service:status", "service:logs"], what: lifecycle },
  serve: { what: "opens an HTTP server on the data directory" },
  web: { what: "opens an HTTP server on the data directory" },
  uninstall: { what: "removes this installation" },
  upgrade: { what: "replaces the installed program" },
  update: { what: "replaces the installed program" },
  "migrate-v1": { what: "imports history into the data directory" },
  token: { subs: ["create", "revoke"], what: "creates or revokes remote access" },
  github: { subs: ["install", "run"], what: "installs or runs the GitHub integration" },
  pet: { subs: ["new"], what: "makes a paid call" },
  view: { flags: ["--force"], what: "replaces an extension view the user has" },
  import: { what: "imports sessions into the data directory" },
  storage: { flags: ["--clean", "--compact", "--vacuum", "--offline"], what: "deletes or rewrites stored sessions" },
}
RULES.loops = RULES.loop!
RULES.workflows = RULES.workflow!
RULES.packages = RULES.package!
RULES.marketplace = RULES.package!
/** First words that only read or work inside the session's own authority; the first known first word decides. */
const SAFE_HEADS = new Set(["run", "session", "sessions", "ps", "logs", "kill", "attach", "docs", "status", "doctor", "context", "usage", "stats", "export", "db", "generate", "completion", "help", "apply", "pr", "acp", "app-server", "ai", "system", "setup", "budget", "remote"])
const APPROVAL_FLAGS = ["--approve", "--dangerously-skip-permissions"]

/** Words of one command line, split into simple commands; quotes are resolved, substitutions are returned to be read on their own. */
function splitCommands(text: string): { commands: string[][]; nested: string[] } {
  const commands: string[][] = []
  const nested: string[] = []
  let words: string[] = []
  let word = ""
  let open = false
  const endWord = () => { if (open) words.push(word); word = ""; open = false }
  const endCommand = () => { endWord(); if (words.length) commands.push(words); words = [] }
  /** `$( … )` or a backtick span starting at `at`: its text goes to `nested`, its last word stands in for it. */
  const substitution = (at: number, close: string) => {
    let depth = 1
    let end = at
    for (; end < text.length; end++) {
      if (close === ")" && text[end] === "(") depth++
      else if (text[end] === close && --depth === 0) break
    }
    const inner = text.slice(at, end)
    nested.push(inner)
    word += inner.trim().split(/\s+/).pop() ?? ""
    open = true
    return end
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (char === "\\" && i + 1 < text.length) { if (text[i + 1] !== "\n") { word += text[i + 1]; open = true } i++ }
    else if (char === "'") {
      const end = text.indexOf("'", i + 1)
      word += text.slice(i + 1, end < 0 ? text.length : end)
      open = true
      i = end < 0 ? text.length : end
    } else if (char === '"') {
      open = true
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === "\\" && i + 1 < text.length) word += text[++i]
        else if (text[i] === "$" && text[i + 1] === "(") i = substitution(i + 2, ")")
        else if (text[i] === "`") i = substitution(i + 1, "`")
        else word += text[i]
      }
    } else if (char === "$" && text[i + 1] === "(") i = substitution(i + 2, ")")
    else if (char === "`") i = substitution(i + 1, "`")
    else if (char === " " || char === "\t") endWord()
    else if (char === ";" || char === "&" || char === "|" || char === "\n" || char === "(" || char === ")" || char === "{" || char === "}") endCommand()
    else { word += char; open = true }
  }
  endCommand()
  return { commands, nested }
}

type Lookup = { cwd: string; environment: Readonly<NodeJS.ProcessEnv>; own: string; variables: Map<string, string> }

const real = (target: string) => { try { return realpathSync(target) } catch { return path.resolve(target) } }
const baseName = (word: string) => (word.split(/[\\/]/).pop() ?? word)
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s

function expand(word: string, variables: Map<string, string>) {
  return word.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, braced: string | undefined, plain: string | undefined) => variables.get(braced ?? plain ?? "") ?? whole)
}

/** Whether `word` runs this program: by name, or as a path or link that resolves to it. */
function isProgram(word: string, lookup: Lookup) {
  if (PROGRAM.test(baseName(word))) return true
  if (!word || word.length > 1024 || /[\s$*?]/.test(word)) return false
  try {
    const file = /[\\/]/.test(word) ? path.resolve(lookup.cwd, word) : Bun.which(word, { PATH: lookup.environment.PATH ?? "", cwd: lookup.cwd })
    if (!file) return false
    const target = realpathSync(file)
    return PROGRAM.test(baseName(target)) || PROGRAM.test(baseName(process.execPath)) && target === real(process.execPath)
  } catch { return false }
}

function refusalFor(shown: string, rule: Rule | undefined, reason?: string) {
  const what = reason ?? rule?.what ?? "changes the owner's configuration"
  return agentRefusal({ what: `\`${shown}\` ${what}`, ask: `run it from their own terminal${rule?.ask ? `, or to use ${rule.ask} in the TUI` : ""}` })
}

/** The arguments of one invocation of this program: the reason to refuse it, or nothing. */
function checkInvocation(program: string, args: string[], directory: string | undefined, lookup: Lookup): string | undefined {
  const shown = [baseName(program), ...args].join(" ").slice(0, 300)
  const positionals = args.filter((word) => !word.startsWith("-"))
  const head = positionals.find((word) => word !== "control-plane" && (word in RULES || SAFE_HEADS.has(word)))
  let chosen = directory
  for (let i = 0; i < args.length; i++) {
    const [name, inline] = args[i]!.split(/=(.*)/s, 2)
    if (name === "--data-dir" || name === "--dir" && !(head && PROJECT_DIR_HEADS.has(head) && args.indexOf(head) < i)) chosen = inline ?? args[i + 1] ?? chosen
  }
  // Another daemon's data directory (a throwaway one, a test) is not the owner's configuration.
  if (chosen && real(path.resolve(lookup.cwd, chosen)) !== lookup.own) return undefined
  if (args.includes("--dry-run")) return undefined
  const approval = APPROVAL_FLAGS.find((flag) => args.includes(flag))
  if (approval) return refusalFor(shown, undefined, `starts or drives a session with approvals off (${approval})`)
  if (args.includes("--restart-daemon")) return refusalFor(shown, RULES.daemon)
  const rule = head ? RULES[head] : undefined
  if (!rule) return undefined
  const rest = positionals.slice(positionals.indexOf(head!) + 1)
  if (rule.flags) return rule.flags.some((flag) => args.includes(flag)) ? refusalFor(shown, rule) : undefined
  if (!rule.subs) return refusalFor(shown, rule)
  const sub = rest[0]
  if (!sub || !rule.subs.includes(sub)) {
    // `package config <name> enable|disable …` switches a resource; plain `config` only shows.
    return (head === "package" || head === "packages") && sub === "config" && rest.some((word) => word === "enable" || word === "disable") ? refusalFor(shown, rule) : undefined
  }
  if (rule.except?.includes(`${sub}:${rest[1] ?? ""}`)) return undefined
  return refusalFor(shown, rule)
}

function checkCommand(words: string[], lookup: Lookup, depth: number): string | undefined {
  let directory: string | undefined
  const assign = (word: string) => {
    const match = ASSIGNMENT.exec(word)
    if (!match) return false
    lookup.variables.set(match[1]!, expand(match[2]!, lookup.variables))
    if (match[1] === "MENDCODE_V2_DIR") directory = lookup.variables.get(match[1])
    return true
  }
  for (let i = 0; i < words.length; i++) {
    const word = expand(words[i]!, lookup.variables)
    if (assign(words[i]!)) continue
    const name = baseName(word).toLowerCase()
    if (name === "export" || name === "local" || name === "declare" || name === "typeset" || name === "readonly") { for (const next of words.slice(i + 1)) assign(next); return undefined }
    if (name === "env") {
      for (i++; i < words.length; i++) {
        const next = words[i]!
        if (next === "-u" || next === "-C" || next === "--unset" || next === "--chdir") i++
        else if (next === "-S" || next === "--split-string") return checkText(words.slice(i + 1).join(" "), lookup, depth + 1)
        else if (!next.startsWith("-") && !assign(next)) break
      }
      i--
      continue
    }
    if (PRIVILEGE.has(name)) {
      for (i++; i < words.length && words[i]!.startsWith("-"); i++) if (PRIVILEGE_VALUES.has(words[i]!)) i++
      i--
      continue
    }
    if (WRAPPERS.has(name)) {
      while (i + 1 < words.length && (words[i + 1]!.startsWith("-") || /^\d+(?:\.\d+)?[smhd]?$/.test(words[i + 1]!))) i++
      continue
    }
    if (name === "eval") return checkText(words.slice(i + 1).join(" "), lookup, depth + 1)
    if (SHELLS.has(name)) {
      const at = words.findIndex((next, index) => index > i && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(next))
      return at > 0 && words[at + 1] !== undefined ? checkText(words[at + 1]!, lookup, depth + 1) : undefined
    }
    if (RUNTIMES.has(name)) {
      const at = words.findIndex((next, index) => index > i && SOURCE_ENTRY.test(next))
      return at > 0 ? checkInvocation("mendcode", words.slice(at + 1).map((next) => expand(next, lookup.variables)), directory, lookup) : undefined
    }
    return isProgram(word, lookup) ? checkInvocation(word, words.slice(i + 1).map((next) => expand(next, lookup.variables)), directory, lookup) : undefined
  }
  return undefined
}

function checkText(text: string, lookup: Lookup, depth: number): string | undefined {
  if (depth > 4) return undefined
  const { commands, nested } = splitCommands(text)
  for (const words of commands) {
    const refusal = checkCommand(words, lookup, depth)
    if (refusal) return refusal
  }
  for (const inner of nested) {
    const refusal = checkText(inner, lookup, depth + 1)
    if (refusal) return refusal
  }
  return undefined
}

/**
 * Why a session's command is not run: it calls this program (by name, by path, through `env`, `command`, `exec`, `sudo`,
 * `xargs`, `sh -c`, a variable or a link) to change the owner's configuration, to stop the daemon, or to drive a session with
 * approvals off. Undefined for everything else, and for an invocation that names another data directory.
 */
export function ownerCommandRefusal({ command, cwd, environment }: { command: string; cwd: string; environment?: Readonly<NodeJS.ProcessEnv> | undefined }): string | undefined {
  if (command.length > 200_000) return undefined
  const base = environment ?? process.env
  return checkText(command, { cwd, environment: base, own: real(agentDataDir(base)), variables: new Map() }, 0)
}
