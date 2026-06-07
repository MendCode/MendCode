import { spawnSync } from "child_process"
import { existsSync, readFileSync, readdirSync, statSync } from "fs"
import { mkdir, writeFile } from "fs/promises"
import path from "path"
import { Global } from "@mendcode/core/global"
import { generatedInternalAgentModelConfig, modelRoleProjection, modelsConfigToYaml, readGlobalModelsConfig, resolveModelRoles } from "./models"
import { readMendMcpConfig } from "./mcp"
import { mendPaths } from "./paths"
import { defaultTuiProfile } from "../profile"

const BASELINE_OPENCODE_COMMIT = "aa3c99a3c0a609ea4dd485355627e3161251584a"
const OPENCODE_WATCH_REMOTE = "https://mendcode.ai"

export const defaultMendConfig = {
  version: 0,
  engine: {
    name: "opencode",
    runtimeCommit: BASELINE_OPENCODE_COMMIT,
    watchRemote: OPENCODE_WATCH_REMOTE,
    configMode: "overlay",
  },
  focus: { default: "codex", allowSessionOverride: true },
  budgets: { warnUsd: 1, stopUsd: 3, expensiveModelRequiresConfirm: true },
  memory: {
    enabled: false,
    use: false,
    generate: false,
    scopes: ["global", "project"],
    maxPromptTokens: 10_000,
    maxEntries: 50,
    extractorRole: "memoryExtractor",
    consolidatorRole: "none",
    requireApprovalForGenerated: true,
  },
  package: {
    kind: "bundle",
    channel: "local",
  },
  tui: { profile: "default", rollbackOnError: true },
  worktree: { mode: "off" },
}

export const focusProfiles: Record<string, any> = {
  codex: {
    id: "codex",
    publicName: "Codex optimized",
    agent: "build",
    model: null,
    reasoning: { default: "medium", escalation: ["architecture", "security", "concurrency", "migration", "crypto"] },
    tools: { defaultPermission: "project", riskyTools: ["shell", "write", "edit"] },
    promptPolicy: { contextFiles: ["AGENTS.md", ".agents/context.md", ".agents/global/context.md", ".mendcode/context/project.md"], editStyle: "patch-first", verification: "executable-feedback" },
    budgetPolicy: defaultMendConfig.budgets,
    sessionPolicy: { persistFocus: true },
    worktreePolicy: { mode: "awareness-only" },
  },
  claude: {
    id: "claude",
    publicName: "Claude-like planning discipline",
    agent: "build",
    model: null,
    reasoning: { default: "medium", escalation: ["large-refactor", "architecture", "security"] },
    tools: { defaultPermission: "project", riskyTools: ["shell", "write", "edit"] },
    promptPolicy: { contextFiles: ["CLAUDE.md", "AGENTS.md", ".mendcode/context/project.md"], editStyle: "read-before-write", verification: "tests-first-when-risky" },
    budgetPolicy: defaultMendConfig.budgets,
    sessionPolicy: { persistFocus: true },
    worktreePolicy: { mode: "awareness-only" },
  },
  gemini: {
    id: "gemini",
    publicName: "Gemini context and checkpoint style",
    agent: "build",
    model: null,
    reasoning: { default: "medium", escalation: ["large-context", "research", "multimodal"] },
    tools: { defaultPermission: "project", riskyTools: ["shell", "write", "edit"] },
    promptPolicy: { contextFiles: ["GEMINI.md", "AGENTS.md", ".mendcode/context/project.md"], editStyle: "checkpoint-aware", verification: "eval-or-command-backed" },
    budgetPolicy: defaultMendConfig.budgets,
    sessionPolicy: { persistFocus: true },
    worktreePolicy: { mode: "awareness-only" },
  },
  kimi: {
    id: "kimi",
    publicName: "Kimi shell-workflow style",
    agent: "build",
    model: null,
    reasoning: { default: "medium", escalation: ["shell-workflow", "agentic-search"] },
    tools: { defaultPermission: "project", riskyTools: ["shell", "write", "edit"] },
    promptPolicy: { contextFiles: ["AGENTS.md", ".agents/skills", ".mendcode/context/project.md"], editStyle: "shell-aware", verification: "command-output-backed" },
    budgetPolicy: defaultMendConfig.budgets,
    sessionPolicy: { persistFocus: true },
    worktreePolicy: { mode: "lock-only" },
  },
  deepseek: {
    id: "deepseek",
    publicName: "DeepSeek optimized",
    agent: "build",
    model: null,
    reasoning: { default: "medium", escalation: ["debugging", "architecture", "security", "batch-analysis", "long-context"] },
    tools: { defaultPermission: "project", riskyTools: ["shell", "write", "edit"] },
    promptPolicy: { contextFiles: ["AGENTS.md", ".agents/context.md", ".mendcode/context/project.md"], editStyle: "parallel-first-verified", verification: "evidence-before-claim", orchestration: "subagents-and-rlm-for-independent-work" },
    budgetPolicy: { ...defaultMendConfig.budgets, trackCache: true },
    sessionPolicy: { persistFocus: true, compactBeforeContextRisk: true },
    worktreePolicy: { mode: "awareness-only" },
  },
  mistral: {
    id: "mistral",
    publicName: "Mistral optimized",
    agent: "build",
    model: null,
    reasoning: { default: "medium", escalation: ["tool-orchestration", "agent-config", "budget-risk", "long-context"] },
    tools: { defaultPermission: "project", riskyTools: ["shell", "write", "edit"] },
    promptPolicy: { contextFiles: ["AGENTS.md", ".vibe/AGENTS.md", ".mendcode/context/project.md"], editStyle: "agent-config-and-tool-policy-first", verification: "max-turn-max-price-and-output-backed", systemPromptMode: "prompt-id-or-agents-layering", toolPolicy: "exact-glob-regex-enable-disable" },
    budgetPolicy: { ...defaultMendConfig.budgets, maxTurnsDefault: 5 },
    sessionPolicy: { persistFocus: true, programmaticOutput: ["text", "json", "streaming"] },
    worktreePolicy: { mode: "awareness-only" },
  },
}

const commands: Record<string, { description: string; template: string }> = {
  focus: { description: "MendCode focus profile status and switching guidance", template: "MendCode focus mode command. Read .mendcode/mendcode.json and .mendcode/focus/*.yaml. Explain the active focus, model/agent policy, budget posture, and exact safe next command. Do not edit high-blast-radius donor runtime paths without ADR/runtime evidence." },
  budget: { description: "MendCode budget guard status", template: "MendCode budget command. Read .mendcode/mendcode.json budgets and summarize current warn/stop thresholds. If spend data is unavailable, say it is unavailable and do not invent numbers." },
  tui: { description: "MendCode TUI identity/profile preview plan", template: "MendCode TUI command. Read .mendcode/tui/profile.json and report identity/sidebar/profile values that can be projected safely. Use runtime-plan/probe for plugin-seam evidence. Do not edit protected donor TUI hot paths or claim rendered sidebar integration without terminal render evidence." },
  context: { description: "MendCode deterministic context refresh level 1", template: "MendCode context refresh. Read AGENTS.md, .agents/global/context.md, .mendcode/context/project.md, and .mendcode/context/refresh.json. Produce a concise evidence-grounded context summary." },
  recipe: { description: "MendCode recipe runner placeholder", template: "MendCode recipe command. List available .mendcode/commands and describe the exact recipe inputs needed. Do not implement product features unless explicitly asked." },
  worktree: { description: "MendCode worktree policy status and dry-run safety checks", template: "MendCode worktree command. Read .mendcode/worktree/policy.yaml and report current mode, planned flows, locks, and dry-run safety checks. Do not create git worktrees without an approved safety review." },
  mflow: { description: "MendCode Mflow safety status and dry-run planning", template: "MendCode Mflow command. Report Mflow mode and safety gates from .mendcode/worktree/policy.yaml. Plan optional mflow-sdk integration only as dry-run unless explicit user approval enables live sync." },
  tsm: { description: "MendCode TSM worktree/session orchestration plan", template: "MendCode TSM command. Treat github.com/adibhanna/tsm as an external terminal-session/worktree orchestration candidate. Inspect and plan only; do not install tsm, run tsm wt add/rm/prune, or create git worktrees without explicit approval." },
  ai: { description: "MendCode AI runtime readiness", template: "MendCode AI command. Report if a real AI run is possible from MendCode-owned configuration. If provider/model credentials are not configured, say blocked and show the minimal setup path. Do not call donor runtime or provider APIs by default." },
}

function readJsonSync<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T
  } catch {
    return fallback
  }
}

function readTextIfExists(file: string) {
  if (!existsSync(file)) return null
  return readFileSync(file, "utf8")
}

function listFiles(root: string, dir: string, { maxDepth = 1, ignore = new Set<string>() } = {}) {
  const out: string[] = []
  function walk(current: string, depth: number) {
    if (!existsSync(current) || depth > maxDepth) return
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (ignore.has(entry.name)) continue
      const full = path.join(current, entry.name)
      const rel = path.relative(root, full)
      if (entry.isDirectory()) walk(full, depth + 1)
      else out.push(rel)
    }
  }
  walk(dir, 0)
  return out.sort()
}

function commandPackFiles(root: string) {
  return listFiles(root, path.join(root, ".mendcode", "commands"), { maxDepth: 0 }).filter((file) => file.endsWith(".md"))
}

async function writeJson(file: string, data: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`)
}

async function writeIfMissing(file: string, data: string) {
  if (existsSync(file)) return
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, data)
}

function toYaml(value: any, indent = 0): string {
  const pad = " ".repeat(indent)
  if (Array.isArray(value)) return value.map((item) => `${pad}- ${typeof item === "object" ? `\n${toYaml(item, indent + 2)}` : item}`).join("\n")
  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([key, item]) => {
        if (item === null) return `${pad}${key}: null`
        if (Array.isArray(item)) return `${pad}${key}: [${item.map((x) => JSON.stringify(x)).join(", ")}]`
        if (typeof item === "object") return `${pad}${key}:\n${toYaml(item, indent + 2)}`
        return `${pad}${key}: ${JSON.stringify(item)}`
      })
      .join("\n")
  }
  return `${pad}${String(value)}`
}

export function readMendConfig(root?: string) {
  return readJsonSync<Record<string, any>>(mendPaths(root).mendConfig, defaultMendConfig)
}

export function readGlobalMendConfig() {
  return readJsonSync<Record<string, any>>(path.join(Global.Path.config, "mendcode.json"), defaultMendConfig)
}

function globalMendConfigPath() {
  return path.join(Global.Path.config, "mendcode.json")
}

function configuredRuntimeModel(role: any) {
  return role?.configured && role?.runtimeModel ? role.runtimeModel : null
}

function runtimeModelForAgent(agentName: string, resolved: Awaited<ReturnType<typeof resolveModelRoles>>) {
  const roles = resolved.roles as Record<string, any>
  const aliases = agentName === "planner"
    ? ["planner", "plan"]
    : agentName === "plan"
      ? ["plan", "planner"]
      : agentName === "build"
        ? ["build", "code"]
        : [agentName]
  for (const key of aliases) {
    const model = configuredRuntimeModel(roles[key])
    if (model) return model
  }
  return resolved.defaultModel || null
}

export async function syncGlobalPrimaryAgentModels(root?: string) {
  const resolved = await resolveModelRoles(root)
  const cfg = readGlobalMendConfig()
  const next: Record<string, any> = {
    ...cfg,
    agent: { ...(cfg.agent || {}) },
  }

  if (resolved.enabled && resolved.defaultModel) next.model = resolved.defaultModel
  else if (resolved.enabled) delete next.model
  const subagentModel = configuredRuntimeModel((resolved.roles as Record<string, any>).subagent)
  if (resolved.enabled && subagentModel) next.subagent_model = subagentModel
  else if (resolved.enabled) delete next.subagent_model

  for (const [name, agent] of Object.entries(next.agent)) {
    if (!agent || typeof agent !== "object") continue
    if ((agent as any).mode === "subagent") continue
    const model = runtimeModelForAgent(name, resolved)
    if (!model) continue
    ;(next.agent as Record<string, any>)[name] = {
      ...(agent as Record<string, any>),
      model,
    }
  }

  await writeJson(globalMendConfigPath(), next)
  return {
    path: globalMendConfigPath(),
    defaultModel: resolved.defaultModel,
    rolesEnabled: resolved.enabled,
  }
}

export function packageMetadata(root?: string) {
  const cfg = readMendConfig(root)
  const pkg = readJsonSync<Record<string, any>>(path.join(mendPaths(root).root, "package.json"), {})
  const configured = cfg.package || {}
  return {
    id: typeof configured.id === "string" && configured.id.trim() ? configured.id : null,
    title: typeof configured.title === "string" && configured.title.trim() ? configured.title : typeof pkg.name === "string" ? pkg.name : null,
    description: typeof configured.description === "string" && configured.description.trim()
      ? configured.description
      : typeof pkg.description === "string"
        ? pkg.description
        : null,
    kind: typeof configured.kind === "string" && configured.kind.trim() ? configured.kind : "bundle",
    channel: typeof configured.channel === "string" && configured.channel.trim() ? configured.channel : "local",
    source: configured.source && typeof configured.source === "object" ? configured.source : {},
    compatibility: configured.compatibility && typeof configured.compatibility === "object" ? configured.compatibility : {},
  }
}

export async function packageMetadataSet(input: {
  id?: string | null
  title?: string | null
  description?: string | null
  kind?: string | null
  channel?: string | null
  sourceType?: string | null
  sourceURL?: string | null
  compatMendcode?: string | null
  compatRuntimePack?: string | null
}, root?: string) {
  const paths = mendPaths(root)
  const cfg = readMendConfig(paths.root)
  const next = { ...(cfg.package || {}) }
  if (input.id !== undefined) next.id = input.id || undefined
  if (input.title !== undefined) next.title = input.title || undefined
  if (input.description !== undefined) next.description = input.description || undefined
  if (input.kind !== undefined) next.kind = input.kind || undefined
  if (input.channel !== undefined) next.channel = input.channel || undefined

  const currentSource = next.source && typeof next.source === "object" ? next.source : {}
  if (input.sourceType !== undefined || input.sourceURL !== undefined) {
    next.source = {
      ...currentSource,
      ...(input.sourceType !== undefined ? { type: input.sourceType || undefined } : {}),
      ...(input.sourceURL !== undefined ? { url: input.sourceURL ?? undefined } : {}),
    }
  }

  const currentCompatibility = next.compatibility && typeof next.compatibility === "object" ? next.compatibility : {}
  if (input.compatMendcode !== undefined || input.compatRuntimePack !== undefined) {
    next.compatibility = {
      ...currentCompatibility,
      ...(input.compatMendcode !== undefined ? { mendcode: input.compatMendcode || undefined } : {}),
      ...(input.compatRuntimePack !== undefined ? { runtimePack: input.compatRuntimePack || undefined } : {}),
    }
  }

  cfg.package = Object.fromEntries(Object.entries(next).filter(([, value]) => {
    if (value === undefined || value === null) return false
    if (typeof value === "object" && !Array.isArray(value)) return Object.keys(value).length > 0
    return true
  }))
  await writeJson(paths.mendConfig, cfg)
  return packageMetadata(paths.root)
}

function activeFocusID(root?: string) {
  return readMendConfig(root).focus?.default || "codex"
}

function activeProfile(root?: string) {
  const id = activeFocusID(root)
  const profile = focusProfiles[id]
  if (!profile) throw new Error(`Unknown focus profile: ${id}`)
  return profile
}

export function activeFocus(root?: string) {
  return activeFocusID(root)
}

export function focusStatus(root?: string) {
  const cfg = readMendConfig(root)
  const profile = activeProfile(root)
  return { active: profile.id, allowSessionOverride: cfg.focus?.allowSessionOverride !== false, profile }
}

export function focusList() {
  return Object.values(focusProfiles).map((profile: any) => ({ id: profile.id, publicName: profile.publicName }))
}

export function focusShow(id: string | undefined, root?: string) {
  const focusID = id || activeFocusID(root)
  const profile = focusProfiles[focusID]
  if (!profile) throw new Error(`Unknown focus profile: ${focusID}`)
  return profile
}

export async function focusUse(id: string | undefined, root?: string) {
  if (!id || !focusProfiles[id]) throw new Error(`Usage: mend focus use <${Object.keys(focusProfiles).join("|")}>`)
  const paths = mendPaths(root)
  const cfg = readMendConfig(paths.root)
  cfg.focus = { ...(cfg.focus || {}), default: id }
  await writeJson(paths.mendConfig, cfg)
  await syncProject(paths.root)
  return { active: id }
}

function upstreamState(root?: string) {
  const paths = mendPaths(root)
  const cfg = readMendConfig(paths.root)
  return readJsonSync(path.join(paths.mendDir, "upstream.json"), {
    version: 0,
    watchRemote: cfg.engine?.watchRemote || cfg.engine?.upstreamRemote || OPENCODE_WATCH_REMOTE,
    runtimeCommit: cfg.engine?.runtimeCommit || cfg.engine?.upstreamCommit || BASELINE_OPENCODE_COMMIT,
    lastReviewedCommit: cfg.engine?.runtimeCommit || cfg.engine?.upstreamCommit || BASELINE_OPENCODE_COMMIT,
    license: "MIT",
    integrationMode: "manual-donor-source-adoption",
    lastCheckedAt: null,
    lastInspectedAt: null,
  })
}

async function generatedConfigFor(root?: string) {
  const profile = activeProfile(root)
  const [resolved, mcp] = await Promise.all([
    resolveModelRoles(root, profile.id),
    readMendMcpConfig(root),
  ])
  if (mcp.failures.length) throw new Error(`Invalid .mendcode/mcp config:\n${mcp.failures.join("\n")}`)
  const command = Object.fromEntries(Object.entries(commands).map(([name, info]) => [name, { description: info.description, agent: profile.agent, template: info.template }]))
  const config: Record<string, any> = { "$schema": "https://mendcode.ai/config.json", default_agent: profile.agent, command }
  if (resolved.defaultModel) config.model = resolved.defaultModel
  if (resolved.smallModel) config.small_model = resolved.smallModel
  const subagentModel = configuredRuntimeModel((resolved.roles as Record<string, any>).subagent)
  if (subagentModel) config.subagent_model = subagentModel
  const agent = generatedInternalAgentModelConfig(resolved.roles as any)
  if (Object.keys(agent).length) config.agent = agent
  if (Object.keys(mcp.servers).length) config.mcp = mcp.servers
  return { config, profile, resolved }
}

export async function syncProject(root?: string) {
  const paths = mendPaths(root)
  const upstream = upstreamState(paths.root)
  const { config, profile, resolved } = await generatedConfigFor(paths.root)
  await writeJson(paths.generatedOpencodeConfig, config)
  await writeJson(path.join(paths.mendDir, "cache", "source-map.json"), {
    version: 0,
    engineRoot: path.join(paths.root, ".agents", "vendor", "opencode"),
    runtimeCommit: upstream.runtimeCommit,
    watchRemote: upstream.watchRemote,
    lastReviewedCommit: upstream.lastReviewedCommit,
    models: resolved,
    protectedHotPaths: [
      "packages/opencode/src/cli/cmd/tui/routes/session/index.tsx",
      "packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx",
      "packages/opencode/src/cli/cmd/tui/context/sync.tsx",
      "packages/opencode/src/cli/cmd/tui/context/sync-v2.tsx",
      "packages/opencode/src/cli/cmd/tui/worker.ts",
      "packages/opencode/src/cli/cmd/tui/thread.ts",
      "packages/opencode/src/cli/cmd/tui/attach.ts",
      "packages/opencode/src/session/prompt.ts",
    ],
    generatedAt: new Date().toISOString(),
  })
  await writeJson(paths.modelRoleProjectionState, await modelRoleProjection(paths.root, profile.id))
  return { generatedConfig: path.relative(paths.root, paths.generatedOpencodeConfig), focus: profile.id, model: resolved.defaultModel || "runtime-default" }
}

export function collectLocalContext(root?: string) {
  const paths = mendPaths(root)
  const refreshState = path.join(paths.mendDir, "context", "refresh.json")
  const previous = readJsonSync<any>(refreshState, { files: [] })
  const previousByPath = new Map((previous.files || []).map((file: any) => [file.path, file]))
  const inputs = [
    "AGENTS.md",
    ".agents/context.md",
    ".agents/global/context.md",
    ".agents/specs/mendcode-opencode-phase0-spike/phase1-status.md",
    ".mendcode/context/project.md",
    ".mendcode/mendcode.json",
    ".mendcode/models.yaml",
    ".mendcode/budget/spend-state.json",
    ".mendcode/tui/profile.json",
    ".mendcode/runtime-adoption.json",
    ".mendcode/worktree/policy.yaml",
    "package.json",
    "src/mendcode/package.json",
  ]
  const files = inputs.map((rel) => {
    const full = path.join(paths.root, rel)
    const text = readTextIfExists(full)
    const prior: any = previousByPath.get(rel)
    const bytes = text ? Buffer.byteLength(text) : 0
    const mtimeMs = text ? statSync(full).mtimeMs : null
    return {
      path: rel,
      exists: text !== null,
      bytes,
      mtimeMs,
      changed: Boolean(prior && (prior.exists !== (text !== null) || prior.bytes !== bytes || prior.mtimeMs !== mtimeMs)),
    }
  })
  const docs = listFiles(paths.root, path.join(paths.root, "docs"), { maxDepth: 1 }).filter((file) => file.endsWith(".md"))
  const pkg = readJsonSync<any>(path.join(paths.root, "package.json"), {})
  const git = spawnSync("git", ["status", "--short"], { cwd: paths.root, encoding: "utf8" })
  const gitChangedPaths = git.status === 0
    ? String(git.stdout || "")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3))
      .filter((file) => !file.startsWith(".mendcode/runs/") && !file.startsWith(".mendcode/cache/") && !file.startsWith(".env"))
      .slice(0, 50)
    : []
  const changed = files.filter((file) => file.changed).map((file) => file.path)
  return {
    version: 0,
    level: 2,
    previousGeneratedAt: previous.generatedAt || null,
    files,
    docs,
    commands: commandPackFiles(paths.root),
    packageScripts: Object.keys(pkg.scripts || {}).sort(),
    packageDependencies: Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }).sort(),
    gitChangedPaths,
    changed,
    generatedAt: new Date().toISOString(),
  }
}

export function renderContextSummary(snapshot: any) {
  const present = snapshot.files.filter((file: any) => file.exists).map((file: any) => `- \`${file.path}\` (${file.bytes} bytes)`)
  const missing = snapshot.files.filter((file: any) => !file.exists).map((file: any) => `- \`${file.path}\``)
  return `# MendCode Context Summary

Generated: ${snapshot.generatedAt}
Refresh level: ${snapshot.level} deterministic/local only

## Product boundary

MendCode is an owned vendorized runtime with OpenCode as donor/reference source. CLI/plugin seams are probes and transition tools only; product changes belong in MendCode-controlled runtime source. High-blast-radius runtime internals require ADR, tests, runtime evidence, and rollback before edits.

## Local evidence inputs

${present.join("\n") || "- none"}

## Missing optional inputs

${missing.join("\n") || "- none"}

## Changed since previous refresh

${snapshot.changed.map((file: string) => `- \`${file}\``).join("\n") || "- none"}

## Docs

${snapshot.docs.map((file: string) => `- \`${file}\``).join("\n") || "- none"}

## Command pack

${snapshot.commands.map((file: string) => `- \`${file}\``).join("\n") || "- none"}

## Local dependency/script inventory

- package scripts: ${snapshot.packageScripts?.join(", ") || "none"}
- package dependencies: ${snapshot.packageDependencies?.join(", ") || "none"}

## Local git freshness

${snapshot.gitChangedPaths?.map((file: string) => `- \`${file}\``).join("\n") || "- none"}

## Safety notes

- Level 2 refresh is file metadata, package script/dependency inventory, and redacted local git freshness only.
- No AI rewrite, no remote fetch, no donor runtime mutation.
- \`.env*\`, \`.git\`, \`.mendcode/runs\`, and \`.mendcode/cache\` stay out of export/sync by default.
`
}

export function contextStatus(root?: string) {
  const paths = mendPaths(root)
  const refreshState = path.join(paths.mendDir, "context", "refresh.json")
  const summary = path.join(paths.mendDir, "context", "summary.md")
  return { ...readJsonSync(refreshState, { version: 0, level: 1, files: [], generatedAt: null }), summary: existsSync(summary) ? path.relative(paths.root, summary) : null }
}

export async function contextRefresh(root?: string) {
  const paths = mendPaths(root)
  const refreshState = path.join(paths.mendDir, "context", "refresh.json")
  const summary = path.join(paths.mendDir, "context", "summary.md")
  const snapshot = collectLocalContext(paths.root)
  await writeJson(refreshState, snapshot)
  await writeFile(summary, renderContextSummary(snapshot))
  return { summary: path.relative(paths.root, summary), present: snapshot.files.filter((file: any) => file.exists).length, total: snapshot.files.length }
}

export async function contextShow(root?: string) {
  const paths = mendPaths(root)
  const summary = path.join(paths.mendDir, "context", "summary.md")
  if (!existsSync(summary)) await contextRefresh(paths.root)
  return readFileSync(summary, "utf8")
}

export async function initProject(root?: string) {
  const paths = mendPaths(root)
  const seedModelsConfig = await readGlobalModelsConfig()
  for (const dir of ["focus", "commands", "context", "memory", "tui/previews", "tui/proposals", "tui/backups", "worktree", "budget", "setup", "runs", "cache", "generated"]) {
    await mkdir(path.join(paths.mendDir, dir), { recursive: true })
  }
  await writeIfMissing(paths.mendConfig, `${JSON.stringify(defaultMendConfig, null, 2)}\n`)
  await writeIfMissing(paths.modelsConfig, `${modelsConfigToYaml(seedModelsConfig)}\n`)
  await writeIfMissing(path.join(paths.mendDir, "upstream.json"), `${JSON.stringify(upstreamState(paths.root), null, 2)}\n`)
  await writeIfMissing(path.join(paths.root, ".agents", "patches", "patch-log.md"), `# MendCode Patch Log\n\nMendCode currently has no runtime patches beyond tracked adoption work.\n\nThis log records manual adaptation/import decisions. It is not an automatic upstream merge log.\n\n| Date | Observed upstream commit | Decision | MendCode files | Reason | Status |\n|---|---|---|---|---|---|\n| 2026-05-06 | ${BASELINE_OPENCODE_COMMIT} | observe only | none | Phase 1 CLI harness; OpenCode remains donor/reference source, not public product identity | active |\n`)
  for (const [id, profile] of Object.entries(focusProfiles)) await writeIfMissing(path.join(paths.mendDir, "focus", `${id}.yaml`), `${toYaml(profile)}\n`)
  for (const [name, info] of Object.entries(commands)) await writeIfMissing(path.join(paths.mendDir, "commands", `${name}.md`), `---\ndescription: ${JSON.stringify(info.description)}\n---\n\n${info.template}\n`)
  await writeIfMissing(path.join(paths.mendDir, "context", "project.md"), "# MendCode Project Context\n\nMendCode is an owned vendorized runtime/product. OpenCode is a donor/reference source; CLI/plugin seams are probes and transition tools only. High-blast-radius runtime paths require ADR, tests, runtime evidence, and rollback before edits.\n")
  await writeIfMissing(paths.memorySummary, "# MendCode Project Memory\n\nNo project memories recorded yet.\n")
  await writeIfMissing(paths.memoryEntries, "")
  await writeJson(path.join(paths.mendDir, "context", "refresh.json"), { version: 0, level: 1, inputs: ["AGENTS.md", ".agents/global/context.md", ".mendcode/context/project.md"], generatedAt: new Date().toISOString() })
  await writeIfMissing(paths.tuiProfile, `${JSON.stringify(defaultTuiProfile(), null, 2)}\n`)
  await writeIfMissing(paths.budgetSpendState, `${JSON.stringify({ version: 0, telemetry: { available: false, source: null, currentUsd: null, updatedAt: null }, notes: ["Spend telemetry is intentionally unknown until a local source is configured."] }, null, 2)}\n`)
  await writeIfMissing(path.join(paths.mendDir, "worktree", "policy.yaml"), `version: 0\nmode: off\nliveSync: false\nneverSync: [".git", ".mflow", ".env*", "node_modules", "dist", "build", ".mendcode/runs", ".mendcode/cache"]\n`)
  await writeIfMissing(path.join(paths.mendDir, "worktree", "locks.json"), "{}\n")
  await writeIfMissing(path.join(paths.mendDir, "setup", "plan.json"), `${JSON.stringify({ version: 0, generatedAt: null, status: "not-generated", installActions: [], shellChanges: [], secretsRead: false }, null, 2)}\n`)
  await syncProject(paths.root)
  return { initialized: path.relative(paths.root, paths.mendDir) }
}

function mustRun(cmd: string, args: string[], root: string) {
  const result = spawnSync(cmd, args, { cwd: root, encoding: "utf8" })
  if (result.status !== 0) throw new Error(`Command failed: ${cmd} ${args.join(" ")}\n${result.stderr || result.stdout}`)
  return String(result.stdout || "").trim()
}

export async function baselineUpstream(commit: string | undefined, root?: string) {
  if (!commit) throw new Error("Usage: mend upstream baseline <commit>")
  const paths = mendPaths(root)
  const engineRoot = path.join(paths.root, ".agents", "vendor", "opencode")
  const status = spawnSync("git", ["-C", engineRoot, "status", "--short"], { cwd: paths.root, encoding: "utf8" })
  if (status.status !== 0) throw new Error(`Unable to read donor git status:\n${status.stderr || status.stdout}`)
  if (String(status.stdout || "").trim()) throw new Error(`Refusing to record baseline while OpenCode checkout is dirty:\n${status.stdout}`)
  const target = mustRun("git", ["-C", engineRoot, "rev-parse", commit], paths.root)
  await writeJson(path.join(paths.mendDir, "upstream.json"), { ...upstreamState(paths.root), lastReviewedCommit: target, lastReviewedAt: new Date().toISOString(), lastCheckedAt: null })
  await syncProject(paths.root)
  return { target }
}
