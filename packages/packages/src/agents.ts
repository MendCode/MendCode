import { z } from "zod"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { claudeFormat, layerAllows, layerReads, type ExtensionLayer, type ExtensionSource } from "./layers"
import { layerLabel, type ResourceDiagnostics } from "./resource-report"

/**
 * Custom agents: `agents/<name>.md` in every extension layer (packages, the user's folder, the project's `.mendcode`).
 * The frontmatter configures the agent, the body is added to the system prompt of every model call the agent makes.
 * A later layer wins on the same name. This module only reads and validates files; trust, selection and running an agent
 * belong to the daemon and the engine.
 */

export const AGENT_MODE_VALUES = ["primary", "subagent", "all"] as const
export type AgentModeValue = (typeof AGENT_MODE_VALUES)[number]
export const AGENT_PERMISSIONS = ["plan", "ask", "smart", "edits", "full"] as const
export type AgentPermissionValue = (typeof AGENT_PERMISSIONS)[number]
/** The protocol's REASONING_EFFORTS (this package does not depend on the protocol). A Claude Code agent file's `max` still reads as `xhigh` below. */
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "none"] as const
type EffortValue = (typeof EFFORTS)[number]

/** Names the engine owns: `build` (the default behaviour) and `plan` (plan mode). */
export const RESERVED_AGENTS: readonly string[] = ["build", "plan"]
export const AGENT_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/
const TOOL_PATTERN = /^[A-Za-z0-9_:.*-]{1,100}$/
export const MAX_AGENT_FILES = 100
/** Files read across all layers before precedence picks the winners that `MAX_AGENT_FILES` then caps. */
const MAX_AGENT_SCANNED = 400
const MAX_AGENT_BYTES = 32 * 1024
const MAX_PROMPT_CHARS = 16_000
const MAX_TOOL_LIST = 100
/** Generation and presentation fields shared with the donor's agent files. */
const ADVANCED_KEYS = ["temperature", "top_p", "color", "steps", "maxsteps", "variant", "options", "disable", "prompt"]
const KNOWN_KEYS = new Set(["name", "description", "model", "effort", "tools", "deny", "permission", "permissionrules", "mode", "hidden", ...ADVANCED_KEYS])

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export type AgentDefinition = {
  name: string
  description: string
  mode: AgentModeValue
  hidden?: boolean | undefined
  disable?: boolean | undefined
  temperature?: number | undefined
  top_p?: number | undefined
  color?: string | undefined
  steps?: number | undefined
  variant?: string | undefined
  options?: Record<string, Json> | undefined
  /** A model id of the catalog (`gpt-5.4`, `<provider>:<model>`); the session's own model when absent. */
  model?: string
  effort?: EffortValue
  /** Allow list; a trailing `*` matches a name prefix (`mcp__github__*`). Absent = every tool. */
  tools?: string[]
  /** Removed after the allow list. */
  deny?: string[]
  /** The most permissive permission mode the agent may run in. */
  permission?: AgentPermissionValue
  permissionRules?: Array<{ permission: string; pattern: string; action: "ask" | "allow" | "deny" }>
  /** The markdown body: added to the system prompt. */
  prompt: string
  file: string
  source: ExtensionSource
  pkg?: string
}

export type AgentIssue = { file: string; message: string }

type Frontmatter = { data: Record<string, unknown>; body: string }

/** Bun's bounded YAML frontmatter parser also preserves nested provider options and permission mappings. */
export function parseAgentFrontmatter(text: string): Frontmatter | { problem: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!match) return { data: {}, body: text }
  try {
    const raw = Bun.YAML.parse(match[1]!)
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { problem: "expected a mapping" }
    const data = Object.fromEntries(Object.entries(raw).map(([key, value]) => [KNOWN_KEYS.has(key.toLowerCase()) ? key.toLowerCase() : key, value]))
    return { data, body: text.slice(match[0].length) }
  } catch { return { problem: "invalid YAML mapping" } }
}

const unquote = (value: string) => {
  const text = value.trim()
  if (text.startsWith('"') && text.endsWith('"')) {
    try { const parsed = JSON.parse(text); if (typeof parsed === "string") return parsed } catch {}
  }
  return text.replace(/^(['"])(.*)\1$/, "$2")
}
const splitList = (value: string) => value.split(",").map(unquote).filter(Boolean)
const asText = (value: unknown): string | undefined => value === undefined ? undefined : typeof value === "object" && !Array.isArray(value) ? JSON.stringify(value) : Array.isArray(value) ? value.join(", ") : String(value)
const asList = (value: unknown): string[] | undefined => Array.isArray(value) ? value.map(String) : value === undefined ? undefined : splitList(String(value))

function toolList(key: string, value: unknown): { list?: string[] } | { problem: string } {
  const list = asList(value)
  if (list === undefined) return {}
  if (list.length > MAX_TOOL_LIST) return { problem: `${key} lists more than ${MAX_TOOL_LIST} tools` }
  const bad = list.find((tool) => !TOOL_PATTERN.test(tool))
  if (bad !== undefined) return { problem: `${key}: "${bad.slice(0, 40)}" is not a tool name (letters, digits, _ : . - and a trailing *)` }
  return { list: [...new Set(list)] }
}

/** Claude Code tool names and the v2 tools they stand for; a name not listed here and not already a v2 name is dropped (with a warning). */
const CLAUDE_TOOLS: Record<string, string[]> = {
  read: ["read"], grep: ["grep"], glob: ["glob"], ls: ["ls"], bash: ["shell"], edit: ["edit"], multiedit: ["edit"], write: ["write"],
  notebookedit: ["notebook_edit"], webfetch: ["webfetch"], websearch: ["websearch"], task: ["task"], todowrite: ["todo"], skill: ["skill"],
}
/** Claude `permissionMode` values and the most permissive mode they allow here. `default` adds no cap; anything else is never granted. */
const CLAUDE_PERMISSION_MODES: Record<string, AgentPermissionValue | undefined> = { plan: "plan", acceptedits: "edits", default: undefined }
/** Claude fields that carry the file's meaning into the conversion; `color` is presentation only and needs no warning. */
const CLAUDE_CONVERTED_KEYS = new Set(["name", "description", "tools", "disallowedtools", "model", "effort", "permissionmode", "color"])

type ForeignAgent = { data: Record<string, unknown>; warnings: string[] }

const specified = (value: unknown) => value !== undefined && value !== null && !(typeof value === "string" && value.trim() === "")

/**
 * The fields of a `.claude/agents/*.md` file that mean the same here, and a warning for each thing that could not be honoured.
 * Conversion never widens what the file asks for:
 * - `tools` is an allow list: names that are not tools here are dropped, and a list left with none grants none (`tools: []`),
 *   never "every tool". An entry with a qualifier (`Bash(git status:*)`) grants nothing, because the bare tool would be wider.
 * - `disallowedTools` entries with a qualifier deny the whole tool, the stricter reading.
 * - `permissionMode: plan` and `acceptEdits` cap the agent (`plan`, `edits`); `bypassPermissions` and unknown modes are never granted by a file.
 * - `model` and `effort` apply only when the model is in the catalog (`modelExists`); aliases such as `sonnet` fall back to the session's model.
 */
function foreignAgentData(data: Record<string, unknown>, modelExists: ((id: string) => boolean) | undefined): ForeignAgent {
  const out: Record<string, unknown> = {}
  const warnings: string[] = []
  const name = asText(data.name)?.trim().toLowerCase()
  if (name) out.name = name
  const description = asText(data.description)?.replace(/\s+/g, " ").trim()
  if (description) out.description = description.length > 300 ? `${description.slice(0, 299)}…` : description
  const entries = (value: unknown) => (asList(value) ?? []).map((tool) => tool.trim()).filter(Boolean)
  const parts = (entry: string) => {
    const match = /^([^()]*?)\s*(?:\((.*)\))?$/.exec(entry)
    return { base: (match?.[1] ?? entry).trim(), qualified: match?.[2] !== undefined }
  }
  const named = (base: string): string[] | undefined => CLAUDE_TOOLS[base.toLowerCase()] ?? (TOOL_PATTERN.test(base) && base === base.toLowerCase() ? [base] : undefined)
  if (specified(data.tools)) {
    const granted: string[] = []
    const unknown: string[] = []
    const qualified: string[] = []
    for (const entry of entries(data.tools)) {
      const { base, qualified: hasQualifier } = parts(entry)
      const tools = named(base)
      if (!tools) unknown.push(entry)
      else if (hasQualifier) qualified.push(entry)
      else granted.push(...tools)
    }
    out.tools = [...new Set(granted)]
    if (unknown.length) warnings.push(`tools: ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not a MendCode tool and ${unknown.length === 1 ? "was" : "were"} dropped`)
    if (qualified.length) warnings.push(`tools: ${qualified.join(", ")} cannot be limited to what the qualifier says here, so ${qualified.length === 1 ? "it grants" : "they grant"} nothing`)
    if ((out.tools as string[]).length === 0) warnings.push("tools: none of the listed tools is available here, so the agent gets no tools")
  }
  const denied = data.disallowedtools ?? data.disallowedTools
  if (specified(denied)) {
    const deny: string[] = []
    const unknown: string[] = []
    const qualified: string[] = []
    for (const entry of entries(denied)) {
      const { base, qualified: hasQualifier } = parts(entry)
      const tools = named(base)
      if (!tools) unknown.push(entry)
      else {
        deny.push(...tools)
        if (hasQualifier) qualified.push(entry)
      }
    }
    if (deny.length) out.deny = [...new Set(deny)]
    if (unknown.length) warnings.push(`disallowedTools: ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not a MendCode tool and ${unknown.length === 1 ? "was" : "were"} dropped`)
    if (qualified.length) warnings.push(`disallowedTools: ${qualified.join(", ")} ${qualified.length === 1 ? "denies" : "deny"} the whole tool here, because the qualifier cannot be honoured`)
  }
  const mode = asText(data.permissionmode)?.trim()
  if (mode) {
    const key = mode.toLowerCase()
    if (key in CLAUDE_PERMISSION_MODES) {
      const cap = CLAUDE_PERMISSION_MODES[key]
      if (cap) out.permission = cap
    } else if (key === "bypasspermissions") warnings.push("permissionMode: bypassPermissions is never granted by an agent file; the session's permission mode applies")
    else warnings.push(`permissionMode: "${mode.slice(0, 30)}" has no equivalent here and was ignored; the session's permission mode applies`)
  }
  const model = asText(data.model)?.trim()
  const effort = asText(data.effort)?.trim().toLowerCase()
  const asEffort = effort === "max" ? "xhigh" : effort
  if (model && model.toLowerCase() !== "inherit") {
    if (modelExists?.(model)) {
      out.model = model
      if (asEffort && (EFFORTS as readonly string[]).includes(asEffort)) out.effort = asEffort
      else if (asEffort) warnings.push(`effort: "${asEffort.slice(0, 20)}" is not one of ${EFFORTS.join(", ")} and was ignored`)
    } else warnings.push(`model: "${model.slice(0, 60)}" is not in the model catalog, so the session's model is used${asEffort ? " (and effort is not applied)" : ""}`)
  } else if (asEffort) warnings.push("effort: needs a model of the catalog and was ignored")
  const ignored = Object.keys(data).filter((key) => !CLAUDE_CONVERTED_KEYS.has(key))
  if (ignored.length) warnings.push(`fields with no equivalent here were ignored: ${ignored.slice(0, 10).join(", ")}`)
  return { data: out, warnings }
}

/** One agent file as an agent, or why not. `stem` is the file name without `.md`; `foreign` reads another tool's agent file (`.claude/agents`). */
export function parseAgentFile(input: { text: string; stem: string; file: string; source: ExtensionSource; pkg?: string | undefined; foreign?: boolean | undefined; /** Foreign files only: whether a model id is in the catalog (the file's `model` applies only then). */ modelExists?: ((id: string) => boolean) | undefined }): { agent: AgentDefinition; warnings?: string[] } | { problem: string } {
  const parsed = parseAgentFrontmatter(input.text)
  if ("problem" in parsed) return { problem: `frontmatter: ${parsed.problem}` }
  const converted = input.foreign ? foreignAgentData(Object.fromEntries(Object.entries(parsed.data).map(([key, value]) => [key.toLowerCase(), value])), input.modelExists) : undefined
  const data = converted ? converted.data : parsed.data
  if (input.foreign && RESERVED_AGENTS.includes(String(data.name ?? input.stem).toLowerCase())) return { problem: "name is reserved by MendCode" }
  const name = (asText(data.name) ?? input.stem).trim()
  if (!AGENT_NAME.test(name)) return { problem: `agent names use lowercase letters, digits, _ and - (max 64): "${name.slice(0, 40)}"` }
  const description = asText(data.description)?.trim() ?? (RESERVED_AGENTS.includes(name) ? `${name} agent` : data.disable === true ? `${name} (disabled)` : undefined)
  if (!description) return { problem: "description is required: it is what the model reads to choose the agent, and what the picker shows" }
  if (description.length > 300) return { problem: "description is longer than 300 characters" }
  const mode = asText(data.mode)?.trim() ?? (RESERVED_AGENTS.includes(name) ? "primary" : "all")
  if (!(AGENT_MODE_VALUES as readonly string[]).includes(mode)) return { problem: `mode must be ${AGENT_MODE_VALUES.join(", ")}: "${mode.slice(0, 20)}"` }
  const permission = asText(data.permission)?.trim()
  let permissionRules: AgentDefinition["permissionRules"]
  const modePermission = permission !== undefined && (AGENT_PERMISSIONS as readonly string[]).includes(permission) ? permission as AgentPermissionValue : undefined
  if (permission !== undefined && !modePermission) {
    const action = z.enum(["ask", "allow", "deny"])
    const config = z.union([action, z.record(z.string().min(1).max(200), z.union([action, z.record(z.string().min(1).max(4096), action)]))])
    let value: unknown = permission
    try { if (permission.startsWith("{")) value = JSON.parse(permission) } catch { return { problem: "permission: invalid JSON mapping" } }
    const valid = config.safeParse(value)
    if (!valid.success) return { problem: "permission must be plan, ask, smart, edits, full, allow/deny, or a tool/pattern mapping of ask/allow/deny" }
    permissionRules = typeof valid.data === "string" ? [{ permission: "*", pattern: "*", action: valid.data }] : Object.entries(valid.data).flatMap(([permission, value]) => typeof value === "string" ? [{ permission, pattern: "*", action: value }] : Object.entries(value).map(([pattern, action]) => ({ permission, pattern, action })))
  }
  if (data.permissionrules !== undefined) {
    try {
      permissionRules = z.array(z.strictObject({ permission: z.string().min(1).max(200), pattern: z.string().min(1).max(4096), action: z.enum(["ask", "allow", "deny"]) })).max(500).parse(Array.isArray(data.permissionrules) ? data.permissionrules : JSON.parse(asText(data.permissionrules)!))
    } catch { return { problem: "permissionRules: invalid rule list" } }
  }
  if (permissionRules && permissionRules.length > 500) return { problem: "permission lists more than 500 rules" }
  const effort = asText(data.effort)?.trim()
  if (effort !== undefined && !(EFFORTS as readonly string[]).includes(effort)) return { problem: `effort must be ${EFFORTS.join(", ")}: "${effort.slice(0, 20)}"` }
  const model = asText(data.model)?.trim()
  if (model !== undefined && (model.length === 0 || model.length > 100 || /\s/.test(model))) return { problem: "model must be one model id without spaces (max 100)" }
  const mappedTools = data.tools && typeof data.tools === "object" && !Array.isArray(data.tools) ? data.tools as Record<string, unknown> : undefined
  if (mappedTools && Object.values(mappedTools).some((value) => typeof value !== "boolean")) return { problem: "tools: expected boolean values" }
  const tools = toolList("tools", mappedTools ? undefined : data.tools)
  if ("problem" in tools) return tools
  const deny = toolList("deny", data.deny)
  if ("problem" in deny) return deny
  if (mappedTools) permissionRules = [...Object.entries(mappedTools).map(([permission, enabled]) => ({ permission: ["write", "edit", "patch"].includes(permission) ? "edit" : permission, pattern: "*", action: enabled ? "allow" as const : "deny" as const })), ...(permissionRules ?? [])]
  const options = { ...(typeof data.options === "object" && data.options && !Array.isArray(data.options) ? data.options : {}) } as Record<string, unknown>
  for (const [key, value] of Object.entries(data)) if (!KNOWN_KEYS.has(key)) options[key] = value
  if (data.options !== undefined && (!data.options || typeof data.options !== "object" || Array.isArray(data.options))) return { problem: "options must be a mapping" }
  if (data.maxsteps !== undefined && (typeof data.maxsteps !== "number" || !Number.isInteger(data.maxsteps) || data.maxsteps <= 0)) return { problem: "maxSteps must be a positive integer" }
  const advanced = z.strictObject({
    temperature: z.number().finite().optional(), top_p: z.number().finite().optional(),
    color: z.string().regex(/^(#[0-9a-fA-F]{6}|primary|secondary|accent|success|warning|error|info)$/).optional(),
    steps: z.number().int().positive().optional(), variant: z.string().min(1).max(100).optional(),
    hidden: z.boolean().optional(), disable: z.boolean().optional(),
    options: z.record(z.string(), z.json()).refine((value) => Object.keys(value).length <= 32 && JSON.stringify(value).length <= 8000 && !Object.keys(value).some((key) => ["model", "messages", "input", "instructions", "system", "tools", "tool_choice", "stream", "store", "headers", "url", "apiKey", "authorization", "prompt_cache_key"].includes(key))).optional(),
  }).safeParse({ ...Object.fromEntries(["temperature", "top_p", "color", "variant", "hidden", "disable"].filter((key) => data[key] !== undefined).map((key) => [key, data[key]])), ...(data.steps !== undefined || data.maxsteps !== undefined ? { steps: data.steps ?? data.maxsteps } : {}), ...(Object.keys(options).length ? { options } : {}) })
  if (!advanced.success) return { problem: `invalid agent configuration: ${advanced.error.issues.map((issue) => issue.path.join(".") + " " + issue.message).join("; ").slice(0, 300)}` }
  const prompt = (asText(data.prompt) ?? parsed.body).trim()
  if (prompt.length > MAX_PROMPT_CHARS) return { problem: `the prompt is longer than ${MAX_PROMPT_CHARS} characters` }
  return {
    agent: {
      name,
      description,
      mode: mode as AgentModeValue,
      ...advanced.data,
      ...(model ? { model } : {}),
      ...(effort ? { effort: effort as EffortValue } : {}),
      ...(tools.list ? { tools: tools.list } : {}),
      ...(deny.list ? { deny: deny.list } : {}),
      ...(modePermission ? { permission: modePermission } : {}),
      ...(permissionRules ? { permissionRules } : {}),
      prompt,
      file: input.file,
      source: input.source,
      ...(input.pkg ? { pkg: input.pkg } : {}),
    },
    ...(converted?.warnings.length ? { warnings: converted.warnings } : {}),
  }
}

/** An agent found in a layer, and whether it may be used: project layers count only in a trusted directory. */
export type FoundAgent = AgentDefinition & { trusted: boolean }

/**
 * Every layer's `agents/*.md`, lowest precedence first; a later layer's agent replaces an earlier one of the same name.
 * `projectTrusted` decides the project layers: an untrusted project agent is still returned (flagged, so the user can see
 * what trusting would enable) but never replaces a trusted agent and is never applied.
 */
export function readLayerAgents(layers: readonly ExtensionLayer[], options: { projectTrusted: boolean; /** Whether a model id is in the catalog, for the `model` of foreign (Claude) agent files. */ modelExists?: ((id: string) => boolean) | undefined }): { agents: FoundAgent[]; problems: AgentIssue[]; overridden: ResourceDiagnostics["overridden"] } {
  const effective = new Map<string, FoundAgent>()
  const untrusted: FoundAgent[] = []
  const problems: AgentIssue[] = []
  const overridden: ResourceDiagnostics["overridden"] = []
  const labels = new Map<FoundAgent, string>()
  let seen = 0
  for (const layer of layers) {
    if (!layerReads(layer, "agents")) continue
    const dir = path.join(layer.dir, "agents")
    let entries: string[]
    try {
      entries = readdirSync(dir).filter((entry) => entry.endsWith(".md") && !entry.startsWith(".") && layerAllows(layer, "agents", entry.slice(0, -".md".length))).sort()
    } catch {
      continue
    }
    const trusted = layer.source === "user" || options.projectTrusted
    for (const entry of entries) {
      const file = path.join(dir, entry)
      // Files are read before precedence so a full lower layer cannot hide a higher one; the cap below applies to the winners.
      if (++seen > MAX_AGENT_SCANNED) {
        problems.push({ file, message: `more than ${MAX_AGENT_SCANNED} agent files; the rest are ignored` })
        break
      }
      const stat = statSync(file, { throwIfNoEntry: false })
      if (!stat?.isFile()) continue
      if (stat.size > MAX_AGENT_BYTES) {
        problems.push({ file, message: `larger than ${MAX_AGENT_BYTES / 1024} KB` })
        continue
      }
      let text: string
      try {
        text = readFileSync(file, "utf8")
      } catch (error) {
        problems.push({ file, message: `not readable: ${(error as Error).message}` })
        continue
      }
      const parsed = parseAgentFile({ text, stem: entry.slice(0, -".md".length), file, source: layer.source, pkg: layer.pkg, foreign: claudeFormat(layer), modelExists: options.modelExists })
      if ("problem" in parsed) {
        if (!claudeFormat(layer)) problems.push({ file, message: parsed.problem })
        continue
      }
      // What a converted (Claude) file asked for and this agent cannot do is listed, not lost.
      for (const warning of "warnings" in parsed ? parsed.warnings ?? [] : []) problems.push({ file, message: `warning: ${warning}` })
      const found: FoundAgent = { ...parsed.agent, trusted }
      labels.set(found, layerLabel(layer))
      if (trusted) {
        const previous = effective.get(found.name)
        if (previous) {
          overridden.push({ kind: "agent", name: found.name, layer: labels.get(previous) ?? previous.source, by: layerLabel(layer) })
          effective.delete(found.name)
        }
        effective.set(found.name, found)
      } else untrusted.push(found)
    }
  }
  // Insertion order is priority order (a winner is re-inserted last), so the lowest-priority winners drop first.
  const winners = [...effective.values()]
  for (const dropped of winners.slice(0, Math.max(0, winners.length - MAX_AGENT_FILES))) {
    effective.delete(dropped.name)
    problems.push({ file: dropped.file, message: `agent ${dropped.name} (${labels.get(dropped) ?? dropped.source}) was left out: more than ${MAX_AGENT_FILES} agents; lowest-priority layers drop first` })
  }
  return { agents: [...effective.values(), ...untrusted].sort((a, b) => a.name.localeCompare(b.name) || Number(b.trusted) - Number(a.trusted)), problems, overridden }
}

/** Whether `tool` is named by `patterns`: an exact name, or a prefix when the pattern ends in `*`. */
export function toolMatches(tool: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => (pattern.endsWith("*") ? tool.startsWith(pattern.slice(0, -1)) : tool === pattern))
}
