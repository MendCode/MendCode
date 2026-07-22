import type { PermissionRequest } from "@mendcode/sdk/v2"
import { ShellID } from "@/tool/shell/id"
import { resolveModelRoles } from "@/mend/config/models"
import { readPermissionsConfig } from "@/mend/config/permissions"
import { runProviderAdapter } from "@/mend/runtime/provider-adapters"
import { errorMessage } from "@/util/error"

export type SmartPermissionDecision = {
  triggered: boolean
  decision: "allow" | "reject" | "ask"
  reason: string
}

const DANGEROUS_COMMAND_NAME_RE =
  /^(?:rm|unlink|rmdir|del|erase|remove-item|rd|chmod|chown|sudo|su|curl|wget|bash|sh|zsh|fish|cmd|powershell|pwsh|python|python3|node|bun|deno|npm|pnpm|yarn|npx|ruby|perl|php|java|go|cargo|make|docker|kubectl|ssh|scp|sftp|nc|netcat|osascript|launchctl|systemctl|service|crontab|kill|pkill|killall|dd|mkfs|fdisk|parted|diskutil|mount|umount|format|source|eval|exec)$/i
const SCRIPT_RE =
  /(^|[\s"'=])(?:\.\.?[\\/]|\/[\w~.-]|~[\\/])?[^\s;&|<>]+\.(sh|bash|zsh|py|js|ts|mjs|cjs|rb|pl|ps1)(?=$|[\s"';&|<>])/i
const DESTRUCTIVE_FLAG_RE =
  /(?:^|\s)(-rf|-fr|--force|--recursive|-recurse|--hard|--delete|--no-preserve-root|--exec(?:=|\s))/i
const SMART_APPROVAL_TIMEOUT_MS = 20_000

const SAFE_COMMANDS = new Set([
  "[",
  "[[",
  "]",
  "basename",
  "cat",
  "cd",
  "chdir",
  "clear",
  "date",
  "df",
  "dir",
  "dirname",
  "du",
  "echo",
  "false",
  "file",
  "find",
  "get-alias",
  "get-childitem",
  "get-command",
  "get-content",
  "get-filehash",
  "get-item",
  "get-itemproperty",
  "get-location",
  "get-module",
  "get-variable",
  "grep",
  "egrep",
  "fgrep",
  "head",
  "history",
  "hostname",
  "ls",
  "measure-object",
  "more",
  "out-host",
  "printenv",
  "printf",
  "pwd",
  "readlink",
  "realpath",
  "resolve-path",
  "rg",
  "ripgrep",
  "select-object",
  "select-string",
  "set-location",
  "sort",
  "stat",
  "test-path",
  "tail",
  "tree",
  "true",
  "type",
  "uniq",
  "uname",
  "ver",
  "wc",
  "where",
  "whereis",
  "which",
  "whoami",
  "write-host",
  "write-output",
])

const SAFE_GIT_COMMANDS = new Set([
  "branch",
  "describe",
  "diff",
  "log",
  "ls-files",
  "ls-tree",
  "remote",
  "rev-parse",
  "show",
  "status",
  "tag",
])

const UNSAFE_GIT_ARGUMENT_RE =
  /^(?:-c|--config(?:=|$)|--config-env(?:=|$)|--exec(?:=|$)|--ext-diff$|--textconv$|--upload-pack(?:=|$)|--receive-pack(?:=|$)|--output(?:=|$)|--hard$|--force(?:=|$)|--delete$|-d$|-D$|-m$|-M$|-c$)/i
const UNSAFE_FIND_ARGUMENT_RE = /^-(?:delete|exec(?:dir)?|ok(?:dir)?|fls|fprint(?:0)?|fprintf)$/i
const UNSAFE_FIND_COMMAND_RE = /(?:^|\s)-(?:delete|exec(?:dir)?|ok(?:dir)?|fls|fprint(?:0)?|fprintf)(?=$|\s)/i
const UNSAFE_RG_ARGUMENT_RE = /^--pre(?:=|$)/i
const UNSAFE_RG_COMMAND_RE = /(?:^|\s)--pre(?:=|\s|$)/i
const UNSAFE_EXECUTION_ARGUMENT_RE =
  /^--?(?:command|cmd|compress-program|editor|exec(?:dir)?|ext-diff|ok(?:dir)?|pager|pre|program|receive-pack|textconv|upload-pack|use-compress-program)(?:=|$)/i
const UNSAFE_SPECIAL_PATH_RE = /(?:^|[\\/])dev\/(?:fd|tcp|udp)(?:[\\/]|$)/i
const CLEARLY_DESTRUCTIVE_COMMANDS = new Set([
  "rm",
  "unlink",
  "rmdir",
  "del",
  "erase",
  "remove-item",
  "rd",
  "chmod",
  "chown",
  "sudo",
  "su",
  "kill",
  "pkill",
  "killall",
  "dd",
  "mkfs",
  "fdisk",
  "parted",
  "diskutil",
  "mount",
  "umount",
  "format",
  "systemctl",
  "service",
  "crontab",
  "reboot",
  "shutdown",
  "launchctl",
])
const SCRIPT_INTERPRETERS = new Set([
  "bash",
  "sh",
  "zsh",
  "fish",
  "pwsh",
  "powershell",
  "python",
  "python3",
  "node",
  "bun",
  "deno",
  "ruby",
  "perl",
  "php",
  "java",
])
const CLEARLY_DESTRUCTIVE_OPERATION_RE =
  /\b(?:rm|unlink|rmdir|del|erase|remove-item|chmod|chown|sudo|su|kill|pkill|killall|dd|mkfs|fdisk|parted|diskutil|mount|umount|format|systemctl|service|crontab|reboot|shutdown)\b|(?:-rf|-fr|--force|--recursive|--delete|--hard|--no-preserve-root)/i
const DOWNLOAD_TO_INTERPRETER_RE =
  /\b(?:curl|wget)\b[^;&\n]*\|\s*(?:bash|sh|zsh|fish|pwsh|powershell|python|python3|node|bun|deno|ruby|perl|php)\b/i
const CLEARLY_MALICIOUS_REASON_RE =
  /\b(?:malicious|malware|phishing|credential(?:s)?(?: theft| exfiltration)?|exfiltrat(?:e|ion)|exploit|command injection)\b/i

function reasonIndicatesClearMaliciousness(reason: string) {
  if (/\b(?:not|no|cannot\s+confirm)\s+(?:clearly\s+)?malicious\b/i.test(reason)) return false
  return CLEARLY_MALICIOUS_REASON_RE.test(reason)
}

type Token = string

function splitCommand(command: string) {
  const segments: string[] = []
  let current = ""
  let quote: "'" | '"' | undefined
  let escaped = false

  for (let index = 0; index < command.length; index++) {
    const char = command[index]
    const next = command[index + 1]

    if (escaped) {
      current += char
      escaped = false
      continue
    }

    if (quote) {
      current += char
      if (char === quote) quote = undefined
      if (char === "\\" && quote === '"') escaped = true
      continue
    }

    if (char === "\\") {
      current += char
      escaped = true
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      current += char
      continue
    }
    if (char === "`" || (char === "$" && (next === "(" || next === "{"))) return
    if (char === "<" || char === ">" || char === "(" || char === ")" || char === "{" || char === "}") return

    if (char === "&") {
      if (next !== "&") return
      segments.push(current)
      current = ""
      index++
      continue
    }
    if (char === "|") {
      segments.push(current)
      current = ""
      if (next === "|") index++
      continue
    }
    if (char === ";" || char === "\n" || char === "\r") {
      segments.push(current)
      current = ""
      continue
    }

    current += char
  }

  if (quote || escaped) return
  segments.push(current)
  return segments.map((segment) => segment.trim())
}

function tokenize(segment: string) {
  const tokens: Token[] = []
  let current = ""
  let quote: "'" | '"' | undefined
  let escaped = false

  const push = () => {
    if (!current) return
    tokens.push(current)
    current = ""
  }

  for (let index = 0; index < segment.length; index++) {
    const char = segment[index]
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (quote) {
      if (char === quote) {
        quote = undefined
        continue
      }
      if (char === "\\" && quote === '"') {
        escaped = true
        continue
      }
      current += char
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      push()
      continue
    }
    current += char
  }

  if (quote || escaped) return
  push()
  return tokens
}

function commandName(token: string) {
  const normalized = token.toLowerCase()
  if (normalized.endsWith(".exe")) return normalized.slice(0, -4)
  return normalized
}

function isSafeGit(tokens: string[]) {
  const subcommand = commandName(tokens[1] || "")
  if (!SAFE_GIT_COMMANDS.has(subcommand)) return false
  const args = tokens.slice(2)
  if (args.some((arg) => UNSAFE_GIT_ARGUMENT_RE.test(arg))) return false

  if (subcommand === "branch") return args.every((arg) => arg.startsWith("-"))
  if (subcommand === "tag") return args.every((arg) => arg.startsWith("-"))
  if (subcommand === "remote") {
    const operation = commandName(args[0] || "")
    return !operation || operation === "-v" || operation === "get-url"
  }
  return true
}

function isSafeSegment(tokens: string[]) {
  const first = tokens[0]
  if (!first || first.includes("/") || first.includes("\\") || first.startsWith(".") || first.startsWith("~"))
    return false
  if (tokens.some((token) => token.includes("$") || token.includes("`"))) return false
  if (tokens.slice(1).some((token) => UNSAFE_EXECUTION_ARGUMENT_RE.test(token))) return false
  if (tokens.slice(1).some((token) => UNSAFE_SPECIAL_PATH_RE.test(token))) return false

  const name = commandName(first)
  if (name === "git") return isSafeGit(tokens)
  if (!SAFE_COMMANDS.has(name)) return false
  if (name === "find" && tokens.slice(1).some((arg) => UNSAFE_FIND_ARGUMENT_RE.test(arg))) return false
  if ((name === "rg" || name === "ripgrep") && tokens.slice(1).some((arg) => UNSAFE_RG_ARGUMENT_RE.test(arg)))
    return false
  return true
}

function isSafeShellCommand(command: string) {
  const segments = splitCommand(command)
  // Auto-approval is intentionally limited to one simple command. A pipeline
  // or chain can hide a second command whose safety is not captured by the
  // first command's allowlist entry.
  if (!segments || segments.length !== 1) return false
  const tokens = tokenize(segments[0] || "")
  return Boolean(tokens && tokens.length > 0 && isSafeSegment(tokens))
}

function isKnownRiskyCommand(command: string) {
  if (SCRIPT_RE.test(command) || DESTRUCTIVE_FLAG_RE.test(command)) return true
  const segments = splitCommand(command)
  if (!segments) {
    const first = command.trim().split(/\s+/, 1)[0] || ""
    return (
      DANGEROUS_COMMAND_NAME_RE.test(commandName(first)) ||
      UNSAFE_FIND_COMMAND_RE.test(command) ||
      UNSAFE_RG_COMMAND_RE.test(command)
    )
  }
  return segments.some((segment) => {
    const tokens = tokenize(segment)
    if (!tokens?.length) return false
    const name = commandName(tokens[0] || "")
    if (DANGEROUS_COMMAND_NAME_RE.test(name)) return true
    if (name === "git") return !isSafeGit(tokens)
    if (name === "find") return tokens.slice(1).some((arg) => UNSAFE_FIND_ARGUMENT_RE.test(arg))
    if (name === "rg" || name === "ripgrep") return tokens.slice(1).some((arg) => UNSAFE_RG_ARGUMENT_RE.test(arg))
    return false
  })
}

function requestCommands(request: PermissionRequest) {
  const commands = new Set<string>()
  const metadataCommand = request.metadata?.command
  if (typeof metadataCommand === "string" && metadataCommand.trim()) commands.add(metadataCommand.trim())
  for (const pattern of request.patterns) {
    if (pattern.trim()) commands.add(pattern.trim())
  }
  return Array.from(commands)
}

function commandFromRequest(request: PermissionRequest) {
  return requestCommands(request).join("\n")
}

function isClearlyDestructiveCommand(command: string) {
  if (DOWNLOAD_TO_INTERPRETER_RE.test(command)) return true
  const segments = splitCommand(command)
  if (!segments) return false

  return segments.some((segment) => {
    const tokens = tokenize(segment)
    if (!tokens?.length) return false
    const name = commandName(tokens[0] || "")
    if (CLEARLY_DESTRUCTIVE_COMMANDS.has(name)) return true
    if (name === "git") return tokens.slice(1).some((arg) => UNSAFE_GIT_ARGUMENT_RE.test(arg))
    if (name === "find") return tokens.slice(1).some((arg) => UNSAFE_FIND_ARGUMENT_RE.test(arg))
    if (name === "rg" || name === "ripgrep") return tokens.slice(1).some((arg) => UNSAFE_RG_ARGUMENT_RE.test(arg))
    if (!SCRIPT_INTERPRETERS.has(name)) return false
    return tokens.slice(1).some((arg) => /^(?:-c|--command|-e|--eval|--execute)$/i.test(arg)) &&
      CLEARLY_DESTRUCTIVE_OPERATION_RE.test(segment)
  })
}

export function normalizeSmartPermissionDecision(
  request: PermissionRequest,
  decision: SmartPermissionDecision,
): SmartPermissionDecision {
  if (request.permission !== ShellID.ToolID && request.permission !== "bash")
    return decision

  const commands = requestCommands(request)
  if (commands.length === 0) return decision
  if (commands.some(isClearlyDestructiveCommand)) {
    if (decision.decision === "reject") return decision
    return {
      ...decision,
      decision: "reject",
      reason: "The command is clearly destructive and cannot be auto-approved.",
    }
  }
  if (decision.decision !== "reject" || reasonIndicatesClearMaliciousness(decision.reason)) return decision

  return {
    ...decision,
    decision: "ask",
    reason: "This command is not clearly destructive; manual approval is required.",
  }
}

function isSafeShellRequest(request: PermissionRequest) {
  const commands = requestCommands(request)
  return commands.length > 0 && commands.every(isSafeShellCommand)
}

export function shouldTriggerSmartApproval(request: PermissionRequest) {
  if (request.permission !== ShellID.ToolID && request.permission !== "bash") return false
  const command = commandFromRequest(request)
  if (!command) return false
  return isKnownRiskyCommand(command)
}

export function isSafeSmartPermissionRequest(request: PermissionRequest) {
  if (request.permission === ShellID.ToolID || request.permission === "bash") {
    return isSafeShellRequest(request)
  }

  if (request.permission !== "external_directory") return false
  if (request.metadata?.source !== "shell") return false
  const command = request.metadata?.command
  return typeof command === "string" && isSafeShellCommand(command.trim())
}

function parseDecision(text: string): SmartPermissionDecision {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
  try {
    const parsed = JSON.parse(cleaned)
    const decision = parsed?.decision === "allow" || parsed?.decision === "reject" ? parsed.decision : "ask"
    const reason =
      typeof parsed?.reason === "string" && parsed.reason.trim()
        ? parsed.reason.trim().slice(0, 180)
        : "No usable reason returned."
    return { triggered: true, decision, reason }
  } catch {
    return { triggered: true, decision: "ask", reason: "Reviewer model did not return strict JSON." }
  }
}

export async function reviewPermissionRequestWithModel(
  request: PermissionRequest,
  root: string,
): Promise<SmartPermissionDecision> {
  if (!shouldTriggerSmartApproval(request))
    return { triggered: false, decision: "ask", reason: "Not a risky shell permission." }

  const config = await readPermissionsConfig()
  const resolved = await resolveModelRoles(root)
  const role = (
    resolved.roles as Record<
      string,
      {
        configured?: boolean
        providerID?: string | null
        modelID?: string | null
        authMode?: string | null
      }
    >
  )[config.reviewerRole]
  if (!resolved.enabled || !role?.configured || !role.providerID || !role.modelID) {
    return {
      triggered: true,
      decision: "ask",
      reason: `Permission reviewer role is not configured: ${config.reviewerRole}.`,
    }
  }

  const command = commandFromRequest(request)
  const result = await Promise.race([
    runProviderAdapter(root, {
      providerID: role.providerID,
      modelID: role.modelID,
      authMode: role.authMode || "api-key",
      instructions: [
        "You are a security gate for one local terminal permission request, not a general assistant.",
        'Return only JSON: {"decision":"allow|reject|ask","reason":"short reason"}.',
        "Allow only a command you can prove is read-only, bounded, and free of shell execution or side effects.",
        "Never auto-allow scripts or script interpreters, even when the path looks trusted or the script name sounds harmless.",
        "Never auto-allow network access, package installation, containers, services, process control, disk operations, or remote code.",
        "A plain curl or wget request is not inherently prohibited: return ask so the user can approve it manually.",
        "Reject only clearly destructive or malicious commands, such as deletion, overwrite, privilege escalation, or downloading content into an interpreter.",
        "Treat shell operators, aliases, substitutions, quoted text, flags, and every chained command as part of the security decision.",
        "Use ask for scripts, runtimes, benign or unknown network targets, and whenever safety cannot be proven from the complete command.",
        "The patterns and always fields are scope hints, not approval to broaden access.",
      ].join("\n"),
      messages: [
        {
          role: "user",
          content: [
            `permission=${request.permission}`,
            `patterns=${request.patterns.join(" | ")}`,
            `command=${command}`,
            `metadata=${JSON.stringify(request.metadata || {})}`,
          ].join("\n"),
        },
      ],
    }),
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`Smart Approval timed out after ${SMART_APPROVAL_TIMEOUT_MS / 1000}s.`)),
        SMART_APPROVAL_TIMEOUT_MS,
      )
    }),
  ]).catch((error): { ok: false; errorPreview: string } => ({
    ok: false,
    errorPreview: errorMessage(error),
  }))

  if (!result.ok)
    return { triggered: true, decision: "ask", reason: result.errorPreview || "Permission reviewer model failed." }
  const decision = normalizeSmartPermissionDecision(request, parseDecision(result.outputText || ""))
  if (decision.decision === "allow" && !isSafeShellRequest(request)) {
    return {
      triggered: true,
      decision: "ask",
      reason: "Smart Approval will not auto-allow a command that is not provably read-only.",
    }
  }
  return decision
}
