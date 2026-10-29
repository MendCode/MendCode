import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import path from "node:path"
import { claudeFormat, defaultLayers, emptyDiagnostics, frontmatterBoolean, frontmatterHint, frontmatterList, frontmatterText, layerAllows, layerLabel, layerReads, oneLine, parseFrontmatter, resolvePrecedence, type Candidate, type ExtensionLayer, type ResourceDiagnostics } from "@mendcode/packages"
import { CommandDefinition, type CommandSummary } from "@mendcode/protocol"
import { skillFolderLine } from "@mendcode/engine-native"
import { builtinCommands } from "./command-templates"
import type { McpServerPrompt } from "@mendcode/mcp"

export type CustomCommand = CommandSummary & { body: string; mcp?: { server: string; name: string; arguments: Array<{ name: string; required?: boolean }> } }

/** Markdown and config commands kept after precedence; built-ins, MCP prompts and extension commands are not counted. */
const MAX_COMMANDS = 200
/** One folder is read this far before precedence, so a full lower layer cannot hide a project command. */
const MAX_SCANNED = 1_000
const MAX_BODY_CHARS = 32_000
const SLASH_NAME = /^[a-z0-9][a-z0-9:_-]*$/

/** Fields a command file reads; anything else is listed as ignored. */
const COMMAND_FIELDS = new Set(["description", "argument-hint", "agent", "model", "subtask", "allowed-tools"])

type Origin = { layer: string; report: ResourceDiagnostics }

function noteFor(origin: Origin, name: string, note: string) {
  origin.report.notes.push({ kind: "command", name, layer: origin.layer, note })
}

/**
 * `foreign` files (`.claude/commands`) follow another tool's rules: a file that does not fit is reported and skipped, never fatal;
 * long descriptions are cut, and `model`/`agent` are kept but applied only when they exist here (`sonnet`, `Explore` name other tools' models and agents).
 * A native file that does not fit is reported the same way, so one broken command never hides the others.
 */
async function scan(dir: string, source: CustomCommand["source"], pkg: string | undefined, origin: Origin, foreign = false): Promise<Array<Candidate<CustomCommand>>> {
  if (!existsSync(dir)) return []
  const files: string[] = []
  for await (const file of new Bun.Glob("**/*.md").scan({ cwd: dir, onlyFiles: true })) {
    files.push(file)
    if (files.length >= MAX_SCANNED) break
  }
  const out: Array<Candidate<CustomCommand>> = []
  for (const file of files.sort()) {
    const name = file.replace(/\.md$/, "").split(path.sep).join(":").toLowerCase()
    const fullPath = path.join(dir, file)
    if (!SLASH_NAME.test(name)) {
      origin.report.problems.push({ file: fullPath, message: "command names use letters, digits, _ - and : (folders become name:space); skipped" })
      continue
    }
    try {
      if (statSync(fullPath).size > 64_000) throw new Error("command file too large (64 KB)")
      const front = parseFrontmatter(await Bun.file(fullPath).text())
      if (front.problem) throw new Error(front.problem)
      const { data } = front
      const subtask = frontmatterBoolean(data.subtask)
      if (data.subtask !== undefined && subtask === undefined) throw new Error("invalid subtask: use true or false")
      const description = frontmatterText(data.description)
      const hint = frontmatterHint(data["argument-hint"])
      const agent = frontmatterText(data.agent)
      const model = frontmatterText(data.model)
      const flatDescription = description === undefined ? undefined : oneLine(description, foreign ? 120 : Number.MAX_SAFE_INTEGER)
      const keepModel = model !== undefined && model.length <= 200
      const keepAgent = agent !== undefined && agent.length <= 100
      const definition = CommandDefinition.parse({
        template: front.body.trim(),
        ...(flatDescription ? { description: flatDescription } : {}),
        ...(hint ? { "argument-hint": foreign ? oneLine(hint, 60) : hint } : {}),
        ...(keepAgent ? { agent } : {}),
        ...(keepModel ? { model } : {}),
        ...(subtask !== undefined ? { subtask } : {}),
      })
      const allowedTools = frontmatterList(data["allowed-tools"])
      const command: CustomCommand = { ...fromDefinition(name, definition, source, pkg), ...(allowedTools?.length ? { allowedTools } : {}), ...(foreign ? { foreign: true } : {}) }
      if (allowedTools?.length) noteFor(origin, name, `allowed-tools (${allowedTools.join(", ")}) is not applied: a command file neither grants nor restricts tools here, so the normal permissions stay in force`)
      if (foreign && command.model) noteFor(origin, name, `model "${command.model}" applies only if the model exists here; otherwise the session model stays`)
      if (foreign && command.agent) noteFor(origin, name, `agent "${command.agent}" applies only if a trusted agent of that name exists here; otherwise the current agent stays`)
      if (hint && /\b[A-Z][A-Z0-9_]*=/.test(hint)) noteFor(origin, name, "named placeholders ($FILE, $PR_TITLE) are not substituted; use $1…$9 or $ARGUMENTS")
      if (front.lenient) noteFor(origin, name, "frontmatter is not valid YAML; read line by line")
      const ignored = front.keys.filter((key) => !COMMAND_FIELDS.has(key.toLowerCase()))
      if (ignored.length) origin.report.ignored.push({ kind: "command", name, layer: origin.layer, fields: ignored })
      out.push({ name, layer: origin.layer, value: command })
    } catch (error) {
      origin.report.problems.push({ file: fullPath, message: problemText(error) })
    }
  }
  return out
}

function fromDefinition(name: string, definition: CommandDefinition, source: CustomCommand["source"], pkg?: string): CustomCommand {
  const { template, description, "argument-hint": hint, agent, model, subtask } = definition
  const positions = [...new Set(template.match(/\$\d+/g) ?? [])].sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)))
  return { name, body: template, description: description ?? (template.trim().split("\n")[0] ?? "").slice(0, 120), argumentHint: hint ?? [...positions, ...(template.includes("$ARGUMENTS") ? ["$ARGUMENTS"] : [])].join(" ").slice(0, 60), source, ...(agent ? { agent } : {}), ...(model ? { model } : {}), ...(subtask !== undefined ? { subtask } : {}), ...(pkg ? { pkg } : {}) }
}

function problemText(error: unknown) {
  const issues = (error as { issues?: Array<{ path: PropertyKey[]; message: string }> } | undefined)?.issues
  if (Array.isArray(issues)) return `invalid command: ${issues.map((issue) => `${issue.path.map(String).join(".") || "body"} ${issue.message}`).join("; ").slice(0, 300)}`
  return error instanceof Error ? error.message : String(error)
}

const MAX_TEMPLATE_FILE_BYTES = 256 * 1024

/**
 * A template's `{file:path}` references (v1's and opencode's spelling) replaced by the file's text. The path is relative to the
 * config file and must stay inside `root` (the project, the user's folder or the package): a command is prompt data, it cannot
 * pull in files from elsewhere on the machine.
 */
function inlineFiles(template: string, base: string, root: string): string {
  return template.replace(/\{file:([^}]+)\}/g, (_, reference: string) => {
    const target = path.resolve(base, reference)
    const real = (() => { try { return realpathSync(target) } catch { throw new Error(`{file:${reference}}: no such file`) } })()
    const inside = path.relative(realpathSync(root), real)
    if (inside.startsWith("..") || path.isAbsolute(inside)) throw new Error(`{file:${reference}}: outside ${root}`)
    if (statSync(real).size > MAX_TEMPLATE_FILE_BYTES) throw new Error(`{file:${reference}}: larger than ${MAX_TEMPLATE_FILE_BYTES / 1024} KB`)
    return readFileSync(real, "utf8")
  })
}

/** The folder a layer's `{file:}` references must stay in: the project for its `.mendcode`, else the layer's own folder. */
const configRoot = (layer: ExtensionLayer) => !layer.pkg && layer.source === "project" && path.basename(layer.dir) === ".mendcode" ? path.dirname(layer.dir) : layer.dir

/** `mendcode.json` `command` map: every entry is checked on its own, so one bad entry (or a broken file) never hides the others. */
async function readConfig(file: string, source: CustomCommand["source"], pkg: string | undefined, origin: Origin, root: string): Promise<Array<Candidate<CustomCommand>>> {
  if (!existsSync(file)) return []
  try {
    if (statSync(file).size > 1_000_000) throw new Error("command config too large (1 MB)")
    // `mendcode.jsonc` may carry comments and trailing commas (as v1 and opencode read it).
    const text = await Bun.file(file).text()
    const config = (file.endsWith(".jsonc") ? Bun.JSONC.parse(text) : JSON.parse(text)) as { command?: unknown }
    if (config.command === undefined) return []
    if (!config.command || typeof config.command !== "object" || Array.isArray(config.command)) throw new Error("invalid command map")
    const entries = Object.entries(config.command)
    if (entries.length > MAX_SCANNED) throw new Error(`more than ${MAX_SCANNED} commands`)
    const out: Array<Candidate<CustomCommand>> = []
    for (const [name, value] of entries) {
      try {
        if (!/^[a-z0-9][a-z0-9:_-]*$/i.test(name)) throw new Error(`invalid command name: ${name}`)
        const definition = CommandDefinition.parse(value)
        out.push({ name: name.toLowerCase(), layer: origin.layer, value: fromDefinition(name.toLowerCase(), { ...definition, template: inlineFiles(definition.template, path.dirname(file), root) }, source, pkg) })
      } catch (error) {
        origin.report.problems.push({ file: `${file}#command.${name}`, message: problemText(error) })
      }
    }
    return out
  } catch (error) {
    origin.report.problems.push({ file, message: problemText(error) })
    return []
  }
}

/**
 * What `/skill-name args` sends: the skill's folder and body with `$ARGUMENTS` filled (or the arguments appended when the
 * body has no placeholder). Only `$ARGUMENTS` is replaced: a skill body is documentation and may hold `$1` or `$HOME`
 * in examples. The text goes to the command executor as an argument, so `!` shell markers in it are never run.
 */
export function skillCommandText(skill: { dir: string; body: string }, args: string) {
  const body = skill.body.trim().slice(0, 30_000)
  const filled = body.includes("$ARGUMENTS") ? body.replaceAll("$ARGUMENTS", () => args.trim()) : args.trim() ? `${body}\n\nARGUMENTS: ${args.trim()}` : body
  return `${skillFolderLine(skill.dir)}\n\n${filled}`
}

/** A skill that can run as `/name`: what the daemon passes from the skill loader. The body is read when the command runs. */
export type SkillCommandSource = { name: string; description: string; source: "user" | "project"; layer: string; userInvocable: boolean; pkg?: string | undefined; argumentHint?: string | undefined; model?: string | undefined; allowedTools?: string[] | undefined }

/**
 * Each extension layer's `commands/`; a later layer wins on the same name (project `.mendcode/commands` last), and the
 * cap on markdown commands applies after that, dropping the lowest-priority layers first.
 * `extra` are commands of extension code (run by the daemon when submitted, so their `body` is empty); they win over markdown ones.
 * `skills` become `/name` when nothing else owns the name: built-in, custom and extension commands win, and the clash is reported.
 * Findings (overrides, drops, ignored fields, notes, files that failed) go to `report`; a failing file never stops the rest.
 */
export async function loadCustomCommands(options: { directory: string; userDir: string; layers?: ExtensionLayer[]; extra?: CustomCommand[]; prompts?: CustomCommand[]; skills?: readonly SkillCommandSource[]; report?: ResourceDiagnostics }) {
  const report = options.report ?? emptyDiagnostics()
  const layers = options.layers ?? defaultLayers({ userDir: options.userDir, directory: options.directory })
  const builtins = builtinCommands(options.directory)
  const builtinNames = new Set(builtins.map((command) => command.name))
  const scanned = await Promise.all(layers.map(async (layer): Promise<Array<Candidate<CustomCommand>>> => {
    const origin: Origin = { layer: layerLabel(layer), report }
    const found = layer.foreign
      ? layerReads(layer, "commands") ? await scan(path.join(layer.dir, "commands"), layer.source, undefined, origin, claudeFormat(layer)) : []
      : [
        ...await readConfig(path.join(layer.dir, "mendcode.json"), layer.source, layer.pkg, origin, configRoot(layer)),
        ...await readConfig(path.join(layer.dir, "mendcode.jsonc"), layer.source, layer.pkg, origin, configRoot(layer)),
        ...await scan(path.join(layer.dir, "command"), layer.source, layer.pkg, origin),
        ...await scan(path.join(layer.dir, "commands"), layer.source, layer.pkg, origin),
      ]
    return found.filter((command) => layerAllows(layer, "commands", command.name)).filter((command) => {
      if (!layer.foreign || !builtinNames.has(command.name)) return true
      report.overridden.push({ kind: "command", name: command.name, layer: command.layer, by: "built-in command" })
      return false
    })
  }))
  const projectConfig = [
    ...await readConfig(path.join(options.directory, "mendcode.json"), "project", undefined, { layer: "project", report }, options.directory),
    ...await readConfig(path.join(options.directory, "mendcode.jsonc"), "project", undefined, { layer: "project", report }, options.directory),
  ]
  const projectIndex = layers.findLastIndex((layer) => layer.source === "project")
  const ordered = scanned.flatMap((commands, index) => index === projectIndex ? [...projectConfig, ...commands] : commands)
  const kept = resolvePrecedence("command", [...ordered, ...(projectIndex < 0 ? projectConfig : [])], MAX_COMMANDS, report)
  const byName = new Map<string, CustomCommand>()
  const layerOf = new Map<string, string>()
  for (const command of [...builtins, ...(options.prompts ?? [])]) byName.set(command.name, command)
  for (const entry of kept) {
    if (builtinNames.has(entry.name)) report.overridden.push({ kind: "command", name: entry.name, layer: "built-in", by: entry.layer })
    byName.set(entry.name, entry.value)
    layerOf.set(entry.name, entry.layer)
  }
  for (const command of options.extra ?? []) {
    const previous = layerOf.get(command.name)
    if (previous) report.overridden.push({ kind: "command", name: command.name, layer: previous, by: "extension" })
    byName.set(command.name, command)
  }
  for (const skill of options.skills ?? []) {
    if (!skill.userInvocable) continue
    if (!SLASH_NAME.test(skill.name)) {
      report.notes.push({ kind: "skill", name: skill.name, layer: skill.layer, note: "cannot run as a slash command: the name has characters other than letters, digits, _ - and :; the skill tool still loads it" })
      continue
    }
    const owner = byName.get(skill.name)
    if (owner) {
      report.overridden.push({ kind: "skill", name: skill.name, layer: skill.layer, by: owner.source === "builtin" ? "built-in command" : `${owner.source} command` })
      continue
    }
    byName.set(skill.name, { name: skill.name, body: "", description: skill.description.slice(0, 120), argumentHint: (skill.argumentHint ?? "").slice(0, 60), source: skill.source, skill: true, foreign: true, ...(skill.model ? { model: skill.model } : {}), ...(skill.allowedTools?.length ? { allowedTools: skill.allowedTools } : {}), ...(skill.pkg ? { pkg: skill.pkg } : {}) })
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** `$ARGUMENTS` is the whole argument string; `$1`…`$9` are whitespace-separated positions. */
export function expandCommand(body: string, args: string, append = true, maximum?: number) {
  const positional = commandArguments(args)
  const last = maximum ?? Math.max(0, ...[...body.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])))
  const expanded = body.replace(/\$ARGUMENTS|\$(\d+)/g, (placeholder, value: string | undefined) => {
    if (placeholder === "$ARGUMENTS") return args
    const position = Number(value)
    return position === last ? positional.slice(position - 1).join(" ") : positional[position - 1] ?? ""
  })
  return !append || body.includes("$ARGUMENTS") || /\$\d+/.test(body) || !args.trim() ? expanded.trim() : `${expanded.trim()}\n\n${args.trim()}`
}

export function commandArguments(args: string) {
  return (args.match(/(?:"[^"\\]*(?:\\.[^"\\]*)*"|'[^']*'|\S)+/g) ?? []).map((value) => value.replace(/^("|')([\s\S]*)\1$/, "$2"))
}

/** One POSIX shell word; plain-looking values stay readable, everything else is single-quoted so it is never parsed as shell syntax. */
export function shellQuote(value: string) {
  if (/^[A-Za-z0-9_./:@%+,-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Whether the character at `index` of a shell fragment sits inside single or double quotes, or right after a backslash. */
function inQuotes(fragment: string, index: number) {
  let quote: "'" | '"' | undefined
  for (let position = 0; position < index; position++) {
    const char = fragment[position]!
    if (quote === "'") { if (char === "'") quote = undefined; continue }
    if (char === "\\") { if (++position >= index) return true; continue }
    if (quote === '"') { if (char === '"') quote = undefined; continue }
    if (char === "'" || char === '"') quote = char
  }
  return quote !== undefined
}

/**
 * The shell text of an inline `!`…`` fragment with its placeholders bound: `$1`…`$9` and `$ARGUMENTS` become single-quoted words
 * (the highest placeholder and `$ARGUMENTS` take every remaining word, each quoted), so an argument is never re-parsed as shell
 * syntax. A placeholder that would put a value inside quotes or after a backslash cannot be quoted safely and is rejected
 * (an empty value inserts nothing, so it is fine anywhere).
 */
export function expandShellFragment({ fragment, args, last, platform = process.platform }: { fragment: string; args: string; last: number; platform?: NodeJS.Platform }) {
  const positional = commandArguments(args)
  const words = (list: string[]) => list.map(shellQuote).join(" ")
  return fragment.replace(/\$ARGUMENTS|\$(\d+)/g, (placeholder: string, value: string | undefined, offset: number) => {
    const position = Number(value)
    const bound = placeholder === "$ARGUMENTS" ? words(positional) : words(position === last ? positional.slice(position - 1) : positional.slice(position - 1, position))
    if (bound === "") return ""
    const shown = fragment.length > 60 ? `${fragment.slice(0, 57)}...` : fragment
    if (platform === "win32") throw new Error(`${placeholder} in the inline shell !\`${shown}\` cannot be quoted safely on Windows; pass the value another way`)
    if (inQuotes(fragment, offset)) throw new Error(`${placeholder} sits inside quotes in the inline shell !\`${shown}\`; write it without quotes, it is quoted for you`)
    return bound
  })
}

export async function expandCommandTemplate(body: string, args: string, shell: (command: string) => Promise<string> | string) {
  if (body.includes("\u0000") || args.includes("\u0000")) throw new Error("command contains a null byte")
  const matches = [...body.matchAll(/!`([^`]+)`/g)]
  if (matches.length > 20) throw new Error("too many inline shell commands")
  const outputs: string[] = []
  const last = Math.max(0, ...[...body.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])))
  for (const match of matches) outputs.push(await shell(expandShellFragment({ fragment: match[1]!, args, last })))
  let index = 0
  const protectedBody = body.replace(/!`([^`]+)`/g, () => `\u0000command-shell-${index++}\u0000`)
  let expanded = expandCommand(protectedBody, args, !body.includes("$ARGUMENTS") && !/\$\d+/.test(body), last)
  for (const [position, output] of outputs.entries()) expanded = expanded.replace(`\u0000command-shell-${position}\u0000`, () => output)
  if (expanded.length > MAX_BODY_CHARS) throw new Error("expanded command exceeds 32000 characters")
  return expanded
}

export function mcpCommands(prompts: McpServerPrompt[]): CustomCommand[] {
  return prompts.map(({ server, prompt }) => ({
    name: `${server}:${prompt.name}`.toLowerCase().replace(/[^a-z0-9:_-]/g, "_"),
    description: prompt.description ?? "MCP prompt",
    argumentHint: (prompt.arguments ?? []).map((argument) => argument.required ? `<${argument.name}>` : `[${argument.name}]`).join(" "),
    source: "mcp" as const, body: "", mcp: { server, name: prompt.name, arguments: prompt.arguments ?? [] },
  }))
}

export function mcpCatalogCommands(prompts: import("@mendcode/protocol").McpCatalogReport["prompts"]): CustomCommand[] {
  return prompts.map((prompt) => ({
    name: prompt.id.toLowerCase(), description: prompt.description ?? "MCP prompt",
    argumentHint: (prompt.arguments ?? []).map((argument) => argument.required ? `<${argument.name}>` : `[${argument.name}]`).join(" "),
    source: "mcp" as const, body: "", mcp: { server: prompt.server, name: prompt.name, arguments: (prompt.arguments ?? []).map((argument) => ({ name: argument.name, ...(argument.required !== undefined ? { required: argument.required } : {}) })) },
  }))
}
