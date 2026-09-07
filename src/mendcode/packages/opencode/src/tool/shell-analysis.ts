import { createHash, createHmac, randomBytes } from "node:crypto"
import path from "node:path"
import type { Node } from "web-tree-sitter"

export const ACTION_FACTS_VERSION = 1 as const
export const MAX_ACTION_COMMAND_BYTES = 32 * 1024
export const MAX_ACTION_AST_NODES = 256

export type ActionEffect = "read" | "write" | "network" | "execute" | "delete" | "external"

export type ActionFactsV1 = {
  version: typeof ACTION_FACTS_VERSION
  kind: "shell" | "native_file"
  fingerprint: string
  fullCommand?: string
  dialect?: "bash" | "powershell" | "cmd"
  cwd: string
  argvSegments: readonly (readonly string[])[]
  astNodes: number
  readTargets: readonly string[]
  writeTargets: readonly string[]
  destinations: readonly string[]
  executableIdentities: readonly string[]
  scriptIdentities: readonly string[]
  environmentDigest: string
  effects: readonly ActionEffect[]
  analysisComplete: boolean
  unknownReasons: readonly string[]
  nativeOperation?: "read" | "create" | "update" | "move" | "delete"
  beforeDigest?: string
  afterDigest?: string
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

const environmentKey = randomBytes(32)

function environmentDigest(environment: NodeJS.ProcessEnv) {
  // The reviewer needs to know whether the execution environment changed, but
  // audit records must never contain environment values or their secrets.
  return createHmac("sha256", environmentKey)
    .update(JSON.stringify(Object.keys(environment).sort().map((key) => [key, environment[key] ?? null])))
    .digest("hex")
}

function astSegments(root: Node | undefined) {
  const unknownReasons: string[] = []
  const argvSegments: string[][] = []
  let astNodes = 0
  if (!root) return { argvSegments, astNodes, unknownReasons: ["shell_ast_missing"] }
  const stack = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (++astNodes > MAX_ACTION_AST_NODES || astNodes + stack.length + node.childCount > MAX_ACTION_AST_NODES) {
      unknownReasons.push("ast_budget_exceeded")
      break
    }
    if (node.isError || node.isMissing) unknownReasons.push("shell_ast_incomplete")
    if (node.type === "command") {
      const args: string[] = []
      for (const child of node.namedChildren) {
        if (!child) {
          unknownReasons.push("shell_ast_incomplete")
          continue
        }
        const value = literalArgument(child)
        if (value === undefined) unknownReasons.push("unsupported_shell_argument")
        else args.push(value)
      }
      argvSegments.push(args)
    }
    // This is deliberately a small grammar, not a second shell parser.
    // Expansions, assignments, redirects, background jobs and control flow
    // must not inherit the classification of a nested read command.
    if (![
      "program", "list", "pipeline", "command", "command_name",
      "word", "raw_string", "string", "string_content",
      "&&", "||", "|", ";", "'", '"',
    ].includes(node.type)) unknownReasons.push("unsupported_shell_grammar:" + node.type)
    for (let index = node.childCount - 1; index >= 0; index--) {
      const child = node.child(index)
      if (child) stack.push(child)
    }
  }
  return { argvSegments, astNodes, unknownReasons }
}

function literalArgument(node: Node): string | undefined {
  if (node.type === "command_name" && node.namedChildCount === 1) return literalArgument(node.namedChild(0)!)
  if (node.type === "raw_string") return node.text.slice(1, -1)
  if (node.type === "string" && node.namedChildren.every((child) => child?.type === "string_content")) {
    // Escapes require dialect-specific interpretation; retain manual review.
    if (node.text.includes("\\")) return
    return node.text.slice(1, -1)
  }
  if (node.type === "word" && ![...node.text].some((char) => "\\$`*?[]{}~".includes(char))) return node.text
}

function commandName(value: string) {
  const normalized = value.toLowerCase().replace(/\.exe$/, "")
  return path.basename(normalized)
}

const knownReadCommands = new Set([
  "[",
  "basename",
  "cat",
  "command",
  "date",
  "df",
  "dirname",
  "file",
  "find",
  "grep",
  "head",
  "hostname",
  "ls",
  "printf",
  "pwd",
  "readlink",
  "realpath",
  "rg",
  "sed",
  "sort",
  "stat",
  "tail",
  "tree",
  "uname",
  "uniq",
  "wc",
  "which",
  "where",
])

const knownVersionCommands = new Set(["node", "npm", "opencode", "bun", "git", "python", "python3"])
const pathLike = /^(?:\.|\.\.|~|\/|[A-Za-z]:[\\/])/

function pathTarget(value: string, cwd: string) {
  if (!value || value.startsWith("-")) return
  if (value.includes("$") || value.includes("`") || value.includes("*")) return
  return path.resolve(cwd, value)
}

function isFileRedirection(value: string) {
  return /^(?:\d+)?(?:>>?|<<?|&>)/u.test(value) && !/^(?:\d+)?[<>]&\d+$/u.test(value)
}

function actionFingerprint(input: Omit<ActionFactsV1, "fingerprint">) {
  return digest(JSON.stringify(input))
}

export function analyzeShellCommand(input: {
  command: string
  cwd: string
  dialect?: "bash" | "powershell" | "cmd"
  environment?: NodeJS.ProcessEnv
  root?: Node
}): ActionFactsV1 {
  const environment = input.environment ?? process.env
  const unknownReasons: string[] = []
  const readTargets: string[] = []
  const writeTargets: string[] = []
  const executableIdentities: string[] = []
  const commandBytes = Buffer.byteLength(input.command, "utf8")
  const { argvSegments, astNodes, unknownReasons: grammarReasons } = astSegments(
    commandBytes <= MAX_ACTION_COMMAND_BYTES ? input.root : undefined,
  )
  unknownReasons.push(...grammarReasons)
  // Parsing is not an executable identity proof. Until the semantic adapter
  // verifies the binary, startup files and command-specific configuration,
  // shell commands require review even when their names look read-only.
  unknownReasons.push("shell_execution_identity_unverified")
  if (commandBytes > MAX_ACTION_COMMAND_BYTES) unknownReasons.push("command_too_large")
  if (astNodes > MAX_ACTION_AST_NODES) unknownReasons.push("ast_budget_exceeded")
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u.test(input.command)) unknownReasons.push("invisible_or_non_ascii_control")
  if (/\$\(|\$\{|`|\b(?:eval|exec)\b/i.test(input.command)) unknownReasons.push("dynamic_shell_evaluation")
  if (/\b(?:rm|del|erase|remove-item|move-item|mv|cp|copy-item|curl|wget|nc|ssh)\b/i.test(input.command)) {
    unknownReasons.push("write_or_network_capability")
  }

  for (const segment of argvSegments ?? []) {
    const name = commandName(segment[0] ?? "")
    if (!name) {
      unknownReasons.push("empty_command_segment")
      continue
    }
    executableIdentities.push(name)
    const versionProbe =
      (knownVersionCommands.has(name) && segment.slice(1).every((arg) => arg === "--version" || arg === "-v")) ||
      (name === "command" && segment[1] === "-v" && Boolean(segment[2]))
    const knownRead = knownReadCommands.has(name) || versionProbe
    if (!knownRead) unknownReasons.push(`unknown_executable:${name}`)
    if (versionProbe && segment[1] === "-v") executableIdentities.push(`resolved:${segment[2]}`)
    const redirectionTargets = new Set<number>()
    for (let index = 1; index < segment.length; index++) {
      const value = segment[index]
      if (isFileRedirection(value)) {
        unknownReasons.push("redirection_requires_review")
        redirectionTargets.add(index)
        const target = segment[index + 1]
        if (target && !isFileRedirection(target)) {
          redirectionTargets.add(index + 1)
          const resolved = pathTarget(target, input.cwd)
          if (resolved) writeTargets.push(resolved)
        }
        continue
      }
      if (/^(?:\d+)?[<>]&\d+$/u.test(value) || redirectionTargets.has(index)) continue
      const target = pathTarget(value, input.cwd)
      if (target) {
        readTargets.push(target)
        if (!pathLike.test(value) && value.includes("/")) unknownReasons.push("unresolved_path")
      }
      if (value.includes("..") || value.startsWith("~") || path.isAbsolute(value))
        unknownReasons.push("path_boundary_requires_check")
    }
  }

  const effects = new Set<ActionEffect>(["execute"])
  if (readTargets.length > 0 || executableIdentities.length > 0) effects.add("read")
  if (writeTargets.length > 0) effects.add("write")
  const complete = argvSegments.length > 0 && unknownReasons.length === 0
  const base: Omit<ActionFactsV1, "fingerprint"> = {
    version: ACTION_FACTS_VERSION,
    kind: "shell",
    fullCommand: input.command,
    dialect: input.dialect ?? "bash",
    cwd: path.resolve(input.cwd),
    argvSegments,
    astNodes,
    readTargets: [...new Set(readTargets)].sort(),
    writeTargets: [...new Set(writeTargets)].sort(),
    destinations: [],
    executableIdentities: [...new Set(executableIdentities)].sort(),
    scriptIdentities: [],
    environmentDigest: environmentDigest(environment),
    effects: [...effects].sort(),
    analysisComplete: complete,
    unknownReasons: [...new Set(unknownReasons)].sort(),
  }
  return { ...base, fingerprint: actionFingerprint(base) }
}

export function createNativeFileActionFacts(input: {
  operation: NonNullable<ActionFactsV1["nativeOperation"]>
  cwd: string
  sourcePaths: readonly string[]
  destinationPaths?: readonly string[]
  before?: readonly string[]
  after?: readonly string[]
  formatterUnknown?: boolean
}): ActionFactsV1 {
  const destinations = (input.destinationPaths ?? []).map((item) => path.resolve(input.cwd, item)).sort()
  const readTargets = input.sourcePaths.map((item) => path.resolve(input.cwd, item)).sort()
  const effects = new Set<ActionEffect>(["execute"])
  if (input.operation !== "create") effects.add("read")
  if (input.operation === "delete") effects.add("delete")
  if (input.operation === "create" || input.operation === "update" || input.operation === "move") effects.add("write")
  const unknownReasons = input.formatterUnknown ? ["formatter_effect_unknown"] : []
  const base: Omit<ActionFactsV1, "fingerprint"> = {
    version: ACTION_FACTS_VERSION,
    kind: "native_file",
    cwd: path.resolve(input.cwd),
    argvSegments: [],
    astNodes: 0,
    readTargets,
    writeTargets: input.operation === "read" ? [] : readTargets,
    destinations,
    executableIdentities: [`builtin:${input.operation}`],
    scriptIdentities: [],
    environmentDigest: environmentDigest(process.env),
    effects: [...effects].sort(),
    analysisComplete: unknownReasons.length === 0 && input.operation !== "delete",
    unknownReasons,
    nativeOperation: input.operation,
    beforeDigest: input.before ? digest(input.before.join("\u0000")) : undefined,
    afterDigest: input.after ? digest(input.after.join("\u0000")) : undefined,
  }
  return { ...base, fingerprint: actionFingerprint(base) }
}

export function isBoundedShellInspection(facts: ActionFactsV1) {
  return (
    facts.kind === "shell" &&
    facts.analysisComplete &&
    facts.effects.every((effect) => effect === "read" || effect === "execute")
  )
}
