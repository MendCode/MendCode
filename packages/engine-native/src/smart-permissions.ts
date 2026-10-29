import { existsSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { commandSubstitutions, MAX_SHELL_DEPTH, programName, withoutTransparentWrappers, wrappedScript, xargsCommand } from "./shell-script"

/**
 * `smart` permission mode: what runs without asking and what asks (docs/permissions.md). Pure: the same call and
 * project always give the same answer. A decision is `allow` (low risk) or `ask`, with the rule that decided it, so the
 * approval prompt can say why and tests can pin every rule.
 */
export type SmartRule =
  | "terminal-ui"
  | "read"
  | "edit-in-project"
  | "allow-listed-command"
  | "destructive"
  | "secrets-file"
  | "git-internals"
  | "agent-config"
  | "runs-program"
  | "outside-project"
  | "network"
  | "autonomy"
  | "shell-expansion"
  | "unlisted-command"
  | "unclear-target"
  | "unknown-tool"
  | "forbidden"
  | "sandboxed"

/**
 * low: runs. uncertain: nothing flagged it, but nothing vouches for it either (an unlisted command, an unknown tool): asks,
 * and is the only kind a permission reviewer may approve. high: a rule flagged it; always asks (a reviewer can only deny).
 */
export type SmartRisk = "low" | "uncertain" | "high"

/** `deny` is only for what no one should approve by reflex (`rm -rf ~`, `mkfs`, a fork bomb): it never reaches the reviewer or a prompt. */
export type SmartDecision = { decision: "allow" | "ask" | "deny"; risk: SmartRisk; rule: SmartRule; reason: string }

const allow = (rule: SmartRule, reason: string): SmartDecision => ({ decision: "allow", risk: "low", rule, reason })
const ask = (risk: "uncertain" | "high", rule: SmartRule, reason: string): SmartDecision => ({ decision: "ask", risk, rule, reason })
const forbid = (reason: string): SmartDecision => ({ decision: "deny", risk: "high", rule: "forbidden", reason })
const SEVERITY: Record<SmartRisk, number> = { low: 0, uncertain: 1, high: 2 }
const severity = (decision: SmartDecision) => (decision.decision === "deny" ? 3 : SEVERITY[decision.risk])
const worst = (a: SmartDecision, b: SmartDecision) => (severity(b) > severity(a) ? b : a)

/** Tools that edit files by path (`edit`, `write`) or by patch (`apply_patch`). */
const EDIT_TOOLS = new Set(["edit", "write", "apply_patch", "notebook_edit"])

/**
 * Starting an interactive session (`shell_session`, action start) is a shell command: it is judged, matched against rules
 * and bound to its executable exactly like `shell` does. Every other action of that tool is judged as itself.
 */
export function asShellCall(tool: string, args: unknown): { tool: string; args: unknown } {
  if (tool !== "shell_session") return { tool, args }
  const record = (args ?? {}) as Record<string, unknown>
  if (record.action !== "start" || typeof record.command !== "string") return { tool, args }
  return { tool: "shell", args: { command: record.command, ...(typeof record.workdir === "string" ? { workdir: record.workdir } : {}) } }
}
/** Tools that start autonomous work or message another session: never low risk. */
const AUTONOMY_TOOLS = new Set(["loop", "workflow_start", "workflow_script", "tell", "workflow_control", "worktree"])

export type SmartInput = {
  tool: { name: string; permission: "read" | "write" | "execute" }
  args: unknown
  /** Absolute project root: "inside the project" means inside this directory. */
  cwd: string
  /** Declared extra workspace directories (`additionalDirectories`, `--add-dir`): they count as inside the project, with the same secrets and .git checks. */
  extraRoots?: readonly string[]
  /** Extra allow-listed command prefixes (`permissionAllow` setting), e.g. "bun test" or "git commit". */
  allowCommands?: readonly string[]
  /**
   * The command runs inside an OS sandbox that confines its writes and has no network (`smartSandboxTrust` setting, off by
   * default). A command that nothing flagged but nothing vouched for then runs: the sandbox, not a prompt, is the safety net.
   * Rules that flag a risk (delete, network, outside the project, secrets) still ask.
   */
  sandboxed?: boolean
}

export function classifySmart(input: SmartInput): SmartDecision {
  const { tool } = input
  if (tool.permission === "read") return allow("read", "reads never change anything")
  const shellCall = asShellCall(tool.name, input.args)
  const root = projectRoot(input.cwd, input.extraRoots)
  if (shellCall.tool === "shell") {
    const verdict = classifyShell((shellCall.args ?? {}) as Record<string, unknown>, root, input.allowCommands ?? [])
    const contained = input.sandboxed && verdict.decision === "ask" && verdict.risk === "uncertain" && (verdict.rule === "unlisted-command" || verdict.rule === "shell-expansion")
    return contained ? allow("sandboxed", `${verdict.reason}; it runs inside the OS sandbox (no network, writes confined)`) : verdict
  }
  if (tool.name === "sidebar") return allow("terminal-ui", "validated sidebar widgets only change terminal UI")
  if (AUTONOMY_TOOLS.has(tool.name)) return ask("high", "autonomy", `${tool.name} starts autonomous work or contacts another session`)
  if (EDIT_TOOLS.has(tool.name)) return classifyEdit(tool.name, input.args, root)
  if (tool.name === "shell") return classifyShell((input.args ?? {}) as Record<string, unknown>, root, input.allowCommands ?? [])
  return ask("uncertain", "unknown-tool", `${tool.name} is not one of the tools smart mode knows`)
}

// ---- paths ---------------------------------------------------------------------------------------------------

/** The project root; `extra` are declared extra workspace directories that count as part of the project. */
type Root = { logical: string; real: string; extra?: Root[] }

export function projectRoot(cwd: string, extra: readonly string[] = []): Root {
  const logical = path.resolve(cwd)
  return { logical, real: realOf(logical), ...(extra.length ? { extra: extra.map((directory) => projectRoot(directory)) } : {}) }
}

/** The real path of the nearest existing ancestor plus the rest, so a symlink inside the project cannot lead out of it. */
export function realOf(target: string): string {
  let existing = target
  const rest: string[] = []
  while (!existsSync(existing)) {
    const parent = path.dirname(existing)
    if (parent === existing) return target
    rest.unshift(path.basename(existing))
    existing = parent
  }
  try {
    return path.join(realpathSync(existing), ...rest)
  } catch {
    return target
  }
}

const within = (parent: string, child: string) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`)

/** The root (the project or a declared extra directory) that holds the target, symlinks resolved, or undefined. */
function containingRoot(target: string, root: Root): Root | undefined {
  const resolved = path.resolve(root.logical, target)
  const real = realOf(resolved)
  return [root, ...(root.extra ?? [])].find((candidate) => within(candidate.logical, resolved) && within(candidate.real, real))
}

export function insideProject(target: string, root: Root): boolean {
  return containingRoot(target, root) !== undefined
}

function expandHome(target: string): string {
  if (target === "~") return homedir()
  if (target.startsWith("~/")) return path.join(homedir(), target.slice(2))
  if (target === "$HOME" || target === "${HOME}") return homedir()
  if (target.startsWith("$HOME/")) return path.join(homedir(), target.slice(6))
  if (target.startsWith("${HOME}/")) return path.join(homedir(), target.slice(8))
  return target
}

const HARMLESS_ABSOLUTE = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"])

const EXAMPLE_ENV = /^\.env\.(example|sample|template|dist|defaults?)$/i
const SECRET_SEGMENT = [
  /^\.env(\..+)?$/i,
  /^\.(ssh|aws|gnupg|kube|docker|npmrc|netrc|pypirc|git-credentials|pgpass|secrets?)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|ppk|kdbx)$/i,
  /^credentials(\..+)?$/i,
  /^secrets?\.(json|ya?ml|toml|env|txt)$/i,
  /^service-account.*\.json$/i,
  /^kubeconfig$/i,
]

/** True when a path names a file that normally holds credentials. */
export function isSecretPath(target: string): boolean {
  const segments = target.split(/[\\/]/).filter(Boolean)
  return segments.some((segment) => !EXAMPLE_ENV.test(segment) && SECRET_SEGMENT.some((pattern) => pattern.test(segment)))
}

/** True when a path is inside a `.git` directory (hooks and config run or leak code outside the edit tools' view). */
function isGitInternal(target: string): boolean {
  const segments = target.split(/[\\/]/)
  const at = segments.indexOf(".git")
  return at !== -1 && at < segments.length - 1
}

/** True when a path (relative to its project root) is inside `.mendcode/`: hooks, tools and extensions there are run later by the daemon, unsandboxed. */
function isAgentConfig(relative: string): boolean {
  return relative.split(/[\\/]/).filter((segment) => segment !== "" && segment !== ".")[0] === ".mendcode"
}

/** Judges one path an action touches; undefined when it is an ordinary file inside the project. */
function judgePath(target: string, root: Root, verb: string): SmartDecision | undefined {
  const expanded = expandHome(target)
  if (HARMLESS_ABSOLUTE.has(expanded)) return undefined
  const home = containingRoot(expanded, root)
  const inside = home !== undefined
  // Inside the project only the part below its root counts (a project that lives under a folder named like a secret is fine).
  const relative = home ? path.relative(home.logical, path.resolve(root.logical, expanded)) : expanded
  if (isSecretPath(relative)) return ask("high", "secrets-file", `${verb} ${target}, which looks like a secrets file`)
  if (!inside) return ask("high", "outside-project", `${verb} ${target}, outside the project`)
  if (isGitInternal(relative)) return ask("high", "git-internals", `${verb} ${target}, inside .git`)
  if (isAgentConfig(relative)) return ask("high", "agent-config", `${verb} ${target}, inside .mendcode (hooks, tools and extensions the daemon runs outside any sandbox)`)
  return undefined
}

// ---- file edits ----------------------------------------------------------------------------------------------

function editTargets(tool: string, args: unknown): string[] {
  const record = (args ?? {}) as Record<string, unknown>
  if (tool !== "apply_patch") return typeof record.path === "string" ? [record.path] : []
  if (typeof record.patch !== "string") return []
  return [...new Set([...record.patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map((match) => match[1]!.trim()))]
}

function classifyEdit(tool: string, args: unknown, root: Root): SmartDecision {
  const targets = editTargets(tool, args)
  if (targets.length === 0) return ask("uncertain", "unclear-target", `cannot tell which file ${tool} changes`)
  let verdict = allow("edit-in-project", `${targets.length === 1 ? targets[0] : `${targets.length} files`} inside the project`)
  for (const target of targets) {
    const problem = judgePath(target, root, "edits")
    if (problem) verdict = worst(verdict, problem)
  }
  return verdict
}

// ---- shell ---------------------------------------------------------------------------------------------------

type Word = { text: string; redirectTarget: boolean }
type Segment = { words: Word[]; expansion: boolean }

/**
 * Splits a command line into simple commands at unquoted `&&`, `||`, `;`, `|`, `&` and newlines, and each into words
 * (quotes removed). A word right after `>`, `>>` or `<` is marked as a redirection target. `expansion` is set when an
 * unquoted or double-quoted `$` or backtick appears: what such a command runs cannot be read from its text.
 */
export function splitCommand(command: string): Segment[] {
  const segments: Segment[] = []
  let words: Word[] = []
  let expansion = false
  let current: string | undefined
  let quote: "'" | '"' | undefined
  let afterRedirect = false
  const endWord = () => {
    if (current === undefined) return
    words.push({ text: current, redirectTarget: afterRedirect })
    afterRedirect = false
    current = undefined
  }
  const endSegment = () => {
    endWord()
    if (words.length > 0 || expansion) segments.push({ words, expansion })
    words = []
    expansion = false
    afterRedirect = false
  }
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!
    if (quote === "'") {
      if (char === "'") quote = undefined
      else current += char
      continue
    }
    if (char === "\\" && i + 1 < command.length) {
      current = (current ?? "") + command[++i]!
      continue
    }
    if (quote === '"') {
      if (char === '"') quote = undefined
      else {
        if (char === "$" || char === "`") expansion = true
        current += char
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      current ??= ""
      continue
    }
    if (char === "$" || char === "`") {
      expansion = true
      current = (current ?? "") + char
      continue
    }
    if (char === " " || char === "\t") {
      endWord()
      continue
    }
    if (char === "\n" || char === ";") {
      endSegment()
      continue
    }
    if (char === "&" || char === "|") {
      // `2>&1` and `&>` are redirections, not command separators.
      if (char === "&" && (command[i - 1] === ">" || command[i + 1] === ">")) continue
      if (command[i + 1] === char) i++
      endSegment()
      continue
    }
    if (char === ">" || char === "<") {
      // `2>file`: the file descriptor digit is part of the operator, not a word.
      if (current !== undefined && /^\d+$/.test(current)) current = undefined
      else endWord()
      while (command[i + 1] === char) i++
      // `<(cmd)` and `>(cmd)` run a command: what runs cannot be read from the text, like `$(cmd)`.
      if (command[i + 1] === "(") expansion = true
      if (command[i + 1] === "&") {
        // `>&2` duplicates a descriptor: no target.
        i++
        while (/\d|-/.test(command[i + 1] ?? "")) i++
        continue
      }
      afterRedirect = true
      continue
    }
    current = (current ?? "") + char
  }
  endSegment()
  return segments
}

/** Commands that only read (or, inside the project, make ordinary local files) and have no dangerous options of their own. */
const READ_ONLY_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "wc", "pwd", "echo", "printf", "true", "false", "test", "[", "basename", "dirname", "realpath", "readlink", "stat", "file", "du", "df",
  "which", "type", "date", "uname", "whoami", "id", "hostname", "tree", "sort", "uniq", "cut", "tr", "diff", "cmp", "comm", "grep", "egrep", "fgrep", "rg", "jq",
  "column", "nl", "tac", "rev", "seq", "sleep", "expr", "md5sum", "sha256sum", "shasum", "cksum", "od", "hexdump", "xxd", "strings", "cd",
])
/** Ordinary local file work: fine inside the project, like the edit tools. */
const LOCAL_FILE_COMMANDS = new Set(["mkdir", "touch", "cp", "mv"])

const GIT_READ_ONLY = new Set(["status", "diff", "log", "show", "rev-parse", "rev-list", "ls-files", "ls-tree", "cat-file", "blame", "describe", "shortlog", "diff-tree", "show-ref", "merge-base", "grep", "name-rev", "count-objects", "whatchanged"])
const GIT_SAFE_GLOBAL_FLAGS = new Set(["--no-pager", "-P", "--no-optional-locks"])

/** The program's own reference cards (`mendcode docs`, `mendcode docs <topic>`) read the installed program's text and settings and write nothing. */
const PROGRAM_COMMAND = /^mendcode(?:-[a-z]+)?$/
const DOCS_TOPIC = /^[a-z][a-z0-9-]{0,39}$/

/** The most plain words `mendcode docs` takes after `docs` (DOCS_MAX_WORDS of apps/cli/src/docs-args.ts): a longer call is a usage error there, so it is not waved through here. */
const DOCS_MAX_WORDS = 8

/**
 * Exactly `mendcode docs` or `mendcode docs [--search] <topic> [<topic>...]` (up to eight words, `docs commands <name>` included): the bare
 * program name, no assignment or wrapper in front, no redirection, no option, only plain lowercase words (nothing that could be a flag
 * or a path), and nothing else on the line (a pipe, `&&` or `;` makes it an ordinary unlisted command: the line is judged as a whole).
 */
function isDocsCommand(segment: Segment, alone: boolean): boolean {
  const texts = segment.words.map((word) => word.text)
  if (!alone || segment.expansion || segment.words.some((word) => word.redirectTarget)) return false
  if (texts.length < 2 || !PROGRAM_COMMAND.test(texts[0]!) || texts[1] !== "docs") return false
  // `docs --search WORDS` is the one option: it must come first, and the words after it are plain words like topics (it searches the same cards).
  const searching = texts[2] === "--search"
  const words = texts.slice(searching ? 3 : 2)
  if (words.length > DOCS_MAX_WORDS || (searching && words.length === 0)) return false
  return words.every((word) => DOCS_TOPIC.test(word))
}

/** Built-in dev commands (prefix match on the words): run the project's own tests, checks and builds. */
const DEFAULT_ALLOW: readonly string[] = [
  "bun test", "bun run test", "bun run typecheck", "bun run lint", "bun run build", "bun run check", "bun run format", "bun --version",
  "npm test", "npm run test", "npm run lint", "npm run build", "npm run typecheck", "npm run check",
  "pnpm test", "pnpm run test", "pnpm lint", "pnpm typecheck", "pnpm build", "pnpm run lint", "pnpm run build", "pnpm run typecheck",
  "yarn test", "yarn lint", "yarn build", "yarn typecheck",
  "tsc", "eslint", "prettier --check", "biome check", "vitest", "jest", "pytest", "python -m pytest",
  "cargo test", "cargo check", "cargo build", "cargo clippy", "go test", "go vet", "go build", "node --version",
]

const DESTRUCTIVE: Array<[RegExp, string]> = [
  [/^(sudo|doas|su)$/, "runs with elevated privileges"],
  [/^(rm|rmdir|unlink|shred|truncate)$/, "deletes files"],
  [/^(dd|mkfs|mkfs\.\w+|fdisk|parted|mount|umount|diskutil)$/, "works on disks"],
  [/^(chmod|chown|chgrp)$/, "changes permissions or ownership"],
  [/^(kill|pkill|killall)$/, "kills processes"],
  [/^(shutdown|reboot|halt|poweroff|launchctl|systemctl)$/, "controls the machine or its services"],
  [/^(crontab)$/, "changes scheduled jobs"],
]
const DESTRUCTIVE_ANYWHERE: Array<[RegExp, string]> = [
  [/\bgit\s+(?:-\S+\s+)*(?:(?:reset\s+--hard|clean|restore|stash\s+(?:drop|clear)|branch\s+-D|rebase|filter-branch|reflog\s+(?:expire|delete)|gc\s+--prune|update-ref\s+-d|worktree\s+remove)\b|checkout\s+(?:--|\.)(?:\s|$))/, "discards git state"],
  [/\bfind\b.*\s-(delete|exec|execdir|ok|okdir|fprint|fls)\b/, "find that deletes or runs commands"],
  [/\bdrop\s+(table|database|schema)\b/i, "drops data"],
  [/\bdocker\s+(rm|rmi|system\s+prune|volume\s+rm|container\s+prune)\b/, "removes containers or images"],
  [/:\(\)\s*\{/, "fork bomb"],
]
const NETWORK_COMMANDS = new Set(["curl", "wget", "ssh", "scp", "sftp", "rsync", "nc", "ncat", "netcat", "telnet", "ftp", "ping", "nslookup", "dig", "traceroute", "http", "https", "gh", "aws", "gcloud", "az", "kubectl", "terraform", "vercel", "netlify", "fly", "flyctl", "heroku", "npx", "bunx", "deno"])
const NETWORK_SUBCOMMANDS: Array<[RegExp, string]> = [
  [/^git\s+(?:-\S+\s+)*(push|pull|fetch|clone|ls-remote|remote\s+(add|set-url)|submodule\s+update)\b/, "git contacts a remote"],
  [/^(npm|pnpm|yarn|bun)\s+(install|i|add|ci|update|upgrade|publish|dlx|x|create|audit|view|info|login|outdated|remove|rm|uninstall)\b/, "package manager contacts the registry or changes dependencies"],
  [/^(pip3?|uv|poetry)\s+(install|download|add|sync|update|publish)\b/, "package manager contacts the index"],
  [/^cargo\s+(install|fetch|publish|add|update|login)\b/, "cargo contacts the registry"],
  [/^go\s+(get|install|mod\s+download)\b/, "go contacts the module proxy"],
  [/^(brew|apt|apt-get|dnf|yum|pacman|apk|gem|composer)\s+/, "system package manager"],
  [/^docker\s+(pull|push|login|run|build|compose)\b/, "docker contacts registries or runs containers"],
]

function isAssignment(word: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)
}

/** The command words of a segment without leading `VAR=x` assignments and transparent wrappers (`env`, `time`, `timeout 30`, `nice -n 5`…). */
const commandWords = withoutTransparentWrappers

/** Variables that change which program, library or config a command loads: `PATH=./bin ls` runs the project's own `ls`. */
const DANGEROUS_VARIABLE = /^(?:PATH|IFS|ENV|BASH_ENV|BASHOPTS|SHELLOPTS|SHELL|HOME|TMPDIR|PS4|PROMPT_COMMAND|CDPATH|GLOBIGNORE|LD_\w+|DYLD_\w+|GIT_\w+|NODE_(?:OPTIONS|PATH|EXTRA_CA_CERTS|TLS_REJECT_UNAUTHORIZED|PRESERVE_SYMLINKS)|npm_config_\w+|NPM_CONFIG_\w+|BUN_\w+|DENO_\w+|PYTHON\w*|RUBY\w*|PERL\w*|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|CLASSPATH|RUSTC\w*|RUSTFLAGS|CARGO_\w+|GO\w+|CC|CXX|LD|AR|EDITOR|VISUAL|PAGER|MANPAGER|LESSOPEN|LESSCLOSE|XDG_\w+|\w*_PROXY|\w*_proxy)$/i

/** The first leading `NAME=value` assignment (before the command, also after `env`) that changes how programs load; undefined when none does. */
function dangerousAssignment(wrapperWords: readonly string[]): string | undefined {
  for (const word of wrapperWords) {
    if (!isAssignment(word)) continue
    const name = word.slice(0, word.indexOf("="))
    if (DANGEROUS_VARIABLE.test(name)) return name
  }
  return undefined
}

/** Flags that make an otherwise read-only command run another program; the reason, or undefined. */
function programFlag(name: string, words: readonly string[]): string | undefined {
  const flag = (pattern: RegExp) => words.slice(1).find((word) => pattern.test(word))
  if (name === "rg") return flag(/^--(?:pre|pre-glob|hostname-bin)(?:=|$)/) && "rg --pre and --hostname-bin run a program"
  if (name === "sort") return flag(/^--compress-program(?:=|$)/) && "sort --compress-program runs a program"
  if (name === "git" && words.includes("grep")) return flag(/^(?:-O|--open-files-in-pager)/) && "git grep -O opens matches in a program"
  return undefined
}

/**
 * Whether every command of a `sed` script only selects, prints, deletes or substitutes (flags g p i I m M and digits):
 * the `e` and `w`/`W` commands and flags run programs or write files, and `-f` reads a script that cannot be seen.
 */
function sedReadOnly(words: readonly string[]): boolean {
  const scripts: string[] = []
  let at = 1
  for (; at < words.length; at++) {
    const word = words[at]!
    if (word === "-e" || word === "--expression") {
      const script = words[++at]
      if (script === undefined) return false
      scripts.push(script)
    } else if (word.startsWith("--expression=")) scripts.push(word.slice("--expression=".length))
    else if (/^-[nEruszb]+$/.test(word) || /^--(?:quiet|silent|regexp-extended|null-data|separate|unbuffered|posix|sandbox)$/.test(word)) continue
    else if (word.startsWith("-") && word !== "-") return false
    else break
  }
  if (!scripts.length) {
    const script = words[at++]
    if (script === undefined) return false
    scripts.push(script)
  }
  // GNU sed accepts options after the files too (`sed p file -f x`).
  if (words.slice(at).some((word) => word.startsWith("-") && word !== "-")) return false
  return scripts.every(sedScriptReadOnly)
}

function sedScriptReadOnly(script: string): boolean {
  let i = 0
  const skipBlank = () => { while (i < script.length && /[\s;{}]/.test(script[i]!)) i++ }
  /** Skips `d…d` (the delimiter already at `i`) and returns false when it never closes. */
  const skipDelimited = (): boolean => {
    const delimiter = script[i++]
    while (i < script.length) {
      const char = script[i++]
      if (char === "\\") i++
      else if (char === delimiter) return true
    }
    return false
  }
  skipBlank()
  while (i < script.length) {
    // address: line number, `$`, `/re/` or `\cREc`, optionally a second one after `,`, and `!`
    for (let part = 0; part < 2; part++) {
      if (script[i] === "/" || script[i] === "\\") {
        if (script[i] === "\\") i++
        if (!skipDelimited()) return false
        while (script[i] === "I" || script[i] === "M") i++
      } else {
        const number = /^(?:\d+(?:~\d+)?|\$)/.exec(script.slice(i))
        if (!number) break
        i += number[0].length
      }
      if (script[i] !== ",") break
      i++
    }
    while (script[i] === "!" || script[i] === " ") i++
    const command = script[i++]
    if (command === undefined) return false
    if ("pPdDnNgGhHxlz=".includes(command)) { /* no argument */ } else if (command === "q" || command === "Q") while (/\d/.test(script[i] ?? "")) i++
    else if (command === "s") {
      const delimiter = script[i]
      if (delimiter === undefined || /[\s\\]/.test(delimiter) || !skipDelimited()) return false
      i--
      if (!skipDelimited()) return false
      while (i < script.length && !/[\s;}]/.test(script[i]!)) {
        if (!/[gpiImM\d]/.test(script[i]!)) return false
        i++
      }
    } else if (command === "y") {
      const delimiter = script[i]
      if (delimiter === undefined || /[\s\\]/.test(delimiter) || !skipDelimited()) return false
      i--
      if (!skipDelimited()) return false
    } else return false
    skipBlank()
  }
  return true
}

function startsWithWords(words: readonly string[], prefix: string): boolean {
  const wanted = prefix.trim().split(/\s+/)
  return wanted.length <= words.length && wanted.every((word, index) => words[index] === word)
}

function gitSubcommandAllowed(words: readonly string[]): boolean {
  let at = 1
  while (at < words.length && words[at]!.startsWith("-")) {
    if (!GIT_SAFE_GLOBAL_FLAGS.has(words[at]!)) return false
    at++
  }
  const sub = words[at]
  if (!sub) return false
  const rest = words.slice(at + 1)
  if (GIT_READ_ONLY.has(sub)) return true
  const onlyFlags = rest.every((word) => word.startsWith("-"))
  if (sub === "branch") return onlyFlags && !rest.some((word) => /^(-d|-D|-m|-M|-c|-C|-u|--delete|--move|--copy|--set-upstream-to|--unset-upstream|--edit-description|-f|--force)$/.test(word))
  if (sub === "tag") return rest.every((word) => word === "-l" || word === "--list" || word.startsWith("--sort") || word.startsWith("--format") || word === "-n")
  if (sub === "remote") return rest.length === 0 || (rest.length === 1 && rest[0] === "-v")
  if (sub === "config") return rest.length > 0 && (rest[0] === "--get" || rest[0] === "--list" || rest[0] === "-l" || rest[0] === "--get-all")
  if (sub === "stash") return rest[0] === "list" || rest[0] === "show"
  if (sub === "worktree") return rest[0] === "list"
  if (sub === "reflog") return rest.length === 0 || rest[0] === "show"
  return false
}

function findAllowed(words: readonly string[]): boolean {
  return !words.some((word) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fls|fprintf)$/.test(word))
}

function looksLikePath(word: string) {
  return word.includes("/") || word === ".." || word === "." || word.startsWith("~") || isSecretPath(word)
}

function classifySegment(segment: Segment, root: Root, allowCommands: readonly string[], depth = 0, alone = false): SmartDecision {
  const texts = segment.words.map((word) => word.text)
  const words = commandWords(texts)
  const name = words[0]
  let verdict: SmartDecision = allow("allow-listed-command", "")
  const note = (decision: SmartDecision) => {
    verdict = worst(verdict, decision)
  }

  // Risk rules first: whatever the command is, these make it ask.
  if (name) {
    for (const [pattern, why] of DESTRUCTIVE) if (pattern.test(path.basename(name))) note(ask("high", "destructive", `${name} ${why}`))
  }
  const line = words.join(" ")
  for (const [pattern, why] of DESTRUCTIVE_ANYWHERE) if (pattern.test(line)) note(ask("high", "destructive", why))
  if (name && NETWORK_COMMANDS.has(path.basename(name))) note(ask("high", "network", `${name} reaches the network`))
  for (const [pattern, why] of NETWORK_SUBCOMMANDS) if (pattern.test(line)) note(ask("high", "network", why))
  if (texts.some((text) => /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /\b(?:https?|ftp|ssh|git):\/\//i.test(text))) note(ask("high", "network", "the command mentions a URL"))
  if (name === "printenv" || (name === undefined && texts[0] === "env")) note(ask("high", "secrets-file", "prints the environment, which holds secrets"))
  if (words[0] === "export" && words[1] === "-p") note(ask("high", "secrets-file", "prints the environment, which holds secrets"))
  const variable = dangerousAssignment(texts.slice(0, texts.length - words.length))
  if (variable) note(ask("high", "runs-program", `sets ${variable}, which changes which program or library runs`))
  const catastrophe = catastrophicCommand(words, segment.words)
  if (catastrophe) note(forbid(catastrophe))
  // `bash -lc '…'`, `eval '…'`, `trap '…'`: the script is judged like a command line of its own (a bad nesting depth is high risk).
  const script = wrappedScript(words)
  const scriptWord = script === undefined ? undefined : segment.words.find((word) => word.text === script)
  const inner = script === undefined ? undefined : classifyScript(script, root, allowCommands, depth + 1)
  if (inner && inner.risk === "high") note(inner)
  // `xargs rm`: what xargs runs is judged too, though its arguments only exist at run time.
  const xargsInner = name && programName(name) === "xargs" ? xargsCommand(words) : []
  if (xargsInner.length) {
    const result = classifySegment({ words: xargsInner.map((text) => ({ text, redirectTarget: false })), expansion: false }, root, allowCommands, depth + 1)
    if (result.risk === "high") note(result)
  }
  const running = name ? programFlag(path.basename(name), words) : undefined
  if (running) note(ask("high", "runs-program", running))
  if (name === "jq" && words.slice(1).some((word) => /(?:^|[^\w$])(?:\$ENV|env)\b/.test(word))) note(ask("high", "secrets-file", "prints the environment, which holds secrets"))

  // Every path the command names (arguments, flag values, redirection targets).
  for (const word of segment.words) {
    if (word === scriptWord) continue
    // `--out=/x` and `-o/x`: the value of a flag is a path too.
    const glued = /^-[A-Za-z](?=.*\/)/.test(word.text) ? word.text.slice(word.text.indexOf("/")) : undefined
    const candidates = glued ? [glued] : word.text.startsWith("-") && word.text.includes("=") ? [word.text.slice(word.text.indexOf("=") + 1)] : [word.text]
    for (const candidate of candidates) {
      if (!word.redirectTarget && !looksLikePath(candidate)) continue
      if (!candidate || candidate.startsWith("-")) continue
      const problem = judgePath(candidate, root, word.redirectTarget ? "writes to" : "touches")
      if (problem) note(problem)
    }
  }
  if (verdict.decision !== "allow") return verdict

  if (segment.expansion) return ask("uncertain", "shell-expansion", "uses $ or backticks, so what runs cannot be read from the text")
  if (!name) return allow("allow-listed-command", "only assignments or redirections")

  const base = path.basename(name)
  const userListed = [...DEFAULT_ALLOW, ...allowCommands].some((prefix) => startsWithWords(words, prefix))
  if (inner) return inner.decision === "allow" || userListed ? allow("allow-listed-command", `${name} runs a script whose every command is on the allow list`) : inner
  const listed =
    (READ_ONLY_COMMANDS.has(name) && name === base) ||
    (LOCAL_FILE_COMMANDS.has(name) && name === base) ||
    (name === "find" && findAllowed(words)) ||
    (name === "sed" && !words.some((word) => /^-[a-zA-Z]*i/.test(word) || word === "--in-place") && sedReadOnly(words)) ||
    (name === "git" && gitSubcommandAllowed(words)) ||
    isDocsCommand(segment, alone) ||
    userListed
  return listed ? allow("allow-listed-command", `${name} is on the allow list`) : ask("uncertain", "unlisted-command", `${name} is not on the allow list`)
}

/**
 * A command line judged on its own: every simple command, plus the command lines run by `$(…)`, backticks and `<(…)` in
 * it. Only a substitution that is itself risky counts here; one that is merely unknown already makes its command
 * `shell-expansion` (uncertain).
 */
function classifyScript(command: string, root: Root, allowCommands: readonly string[], depth: number, workdir?: string): SmartDecision {
  if (depth > MAX_SHELL_DEPTH) return ask("high", "runs-program", `shell commands nested more than ${MAX_SHELL_DEPTH} levels deep`)
  const segments = splitCommand(command)
  if (segments.length === 0) return ask("uncertain", "unlisted-command", "an empty command")
  const decisions = segments.map((segment) => classifySegment(segment, root, allowCommands, depth, segments.length === 1))
  for (const substituted of commandSubstitutions(command)) {
    const result = classifyScript(substituted, root, allowCommands, depth + 1)
    if (result.risk === "high") decisions.push(result)
  }
  const directory = workdir === undefined ? undefined : judgePath(workdir, root, "runs in")
  if (directory) decisions.unshift(directory)
  // The most severe decision wins; among equals the first (so the prompt names the first thing that was wrong).
  const verdict = decisions.reduce(worst)
  return verdict.decision === "allow" && decisions.length > 1 ? allow("allow-listed-command", "every command in the line is on the allow list") : verdict
}

function classifyShell(args: Record<string, unknown>, root: Root, allowCommands: readonly string[]): SmartDecision {
  return classifyScript(typeof args.command === "string" ? args.command : "", root, allowCommands, 0, typeof args.workdir === "string" ? args.workdir : undefined)
}

// ---- commands that must never run on a reflex ------------------------------------------------------------------

/** Directories whose recursive removal or permission change wrecks the machine, not the project. */
const SYSTEM_DIRECTORIES = new Set(["/", "/bin", "/sbin", "/usr", "/etc", "/var", "/lib", "/lib64", "/opt", "/boot", "/dev", "/proc", "/sys", "/home", "/root", "/srv", "/mnt", "/media", "/Users", "/System", "/Library", "/Applications", "/Volumes", "/private"])
const BLOCK_DEVICE = /^\/dev\/(?:sd|hd|vd|xvd|nvme|mmcblk|disk|rdisk)/
const SUDO_FLAGS_WITH_VALUE = new Set(["-u", "-g", "-h", "-p", "-r", "-t", "-C", "-D", "-U", "-R", "--user", "--group", "--host", "--prompt", "--role", "--type", "--chdir"])

/** True when a path names the root, a system directory or the home directory itself (`/`, `/*`, `~`, `$HOME`, `~/*`). */
function isSystemOrHome(target: string): boolean {
  const stripped = expandHome(target).replace(/\/\*+$/, "")
  if (stripped === "") return true
  if (!path.isAbsolute(stripped)) return false
  const normalized = path.resolve(stripped)
  return SYSTEM_DIRECTORIES.has(normalized) || normalized === homedir() || normalized === path.dirname(homedir())
}

/** The command a `sudo`/`doas` invocation runs. */
function afterSudo(words: readonly string[]): string[] {
  let at = 1
  while (at < words.length && words[at]!.startsWith("-") && words[at] !== "--") at += SUDO_FLAGS_WITH_VALUE.has(words[at]!) ? 2 : 1
  if (words[at] === "--") at++
  return words.slice(at)
}

/**
 * Why a command may never run in smart mode (it asks nothing and refuses): wiping `/` or the home directory, formatting or
 * overwriting a disk, a fork bomb. Judged on the program after `sudo`; a prompt would be one reflexive click from a wiped
 * machine, and none of these has a use inside a coding session.
 */
function catastrophicCommand(words: readonly string[], segmentWords: readonly Word[]): string | undefined {
  const name = words[0] === undefined ? undefined : programName(words[0])
  if (name === "sudo" || name === "doas") return catastrophicCommand(afterSudo(words), segmentWords)
  const args = words.slice(1)
  const operands = args.filter((arg) => !arg.startsWith("-"))
  const recursive = args.some((arg) => /^-[A-Za-z]*[rR]/.test(arg) || arg === "--recursive")
  if (name === "rm") {
    if (args.includes("--no-preserve-root")) return "rm --no-preserve-root removes the filesystem root"
    const target = recursive ? operands.find(isSystemOrHome) : undefined
    if (target !== undefined) return `rm -r ${target} removes a system or home directory`
  }
  if ((name === "chmod" || name === "chown" || name === "chgrp") && recursive) {
    const target = operands.find(isSystemOrHome)
    if (target !== undefined) return `${name} -R ${target} changes a system or home directory`
  }
  if (name === "dd" && args.some((arg) => arg.startsWith("of=") && BLOCK_DEVICE.test(arg.slice(3)))) return "dd writes to a disk device"
  if (name !== undefined && /^mkfs(?:\.\w+)?$/.test(name)) return `${name} formats a disk`
  if (name === "diskutil" && /^(?:erase\w*|zeroDisk|secureErase|partitionDisk|reformat)$/i.test(args[0] ?? "")) return `diskutil ${args[0]} erases a disk`
  if (segmentWords.some((word) => word.redirectTarget && BLOCK_DEVICE.test(word.text))) return "redirects output onto a disk device"
  if (/:\(\)\s*\{/.test(words.join(" "))) return "a fork bomb"
  return undefined
}
