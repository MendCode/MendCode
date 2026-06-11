import { mkdir, readFile, writeFile } from "fs/promises"
import { existsSync } from "fs"
import { homedir } from "os"
import path from "path"
import { Global } from "@mendcode/core/global"
import { mendPaths } from "./paths"
import { activeMendPackageProjection } from "../runtime/packages"

export type ModelRole = {
  providerID: string | null
  modelID: string | null
  authMode?: string | null
  variant?: string | null
  reason?: string
}
export type ModelsConfig = { version: 0; enabled: boolean; roles: Record<string, ModelRole> }

export const modelPresets = {
  "openai-codex-subscription-gpt-5.2": {
    providerID: "openai",
    modelID: "gpt-5.2",
    authMode: "chatgpt-subscription-oauth",
    env: [],
    pricingPer1MTokens: null,
    source: ".agents/vendor/opencode/packages/opencode/src/plugin/codex.ts",
    note: "Uses ChatGPT Plus/Pro OAuth through the donor Codex auth plugin; not OpenAI API billing.",
  },
  "openai-codex-subscription-gpt-5.2-codex": {
    providerID: "openai",
    modelID: "gpt-5.2-codex",
    authMode: "chatgpt-subscription-oauth",
    env: [],
    pricingPer1MTokens: null,
    source: ".agents/vendor/opencode/packages/opencode/src/plugin/codex.ts",
    note: "Uses ChatGPT Plus/Pro OAuth through the donor Codex auth plugin; not OpenAI API billing.",
  },
  "openai-api-gpt-5.2": {
    providerID: "openai",
    modelID: "gpt-5.2",
    authMode: "api-key",
    env: ["OPENAI_API_KEY"],
    pricingPer1MTokens: { inputUsd: 1.75, cachedInputUsd: 0.175, outputUsd: 14 },
    source: "https://platform.openai.com/docs/pricing/",
    note: "OpenAI API billing; not ChatGPT subscription.",
  },
  "openai-api-gpt-5.2-codex": {
    providerID: "openai",
    modelID: "gpt-5.2-codex",
    authMode: "api-key",
    env: ["OPENAI_API_KEY"],
    pricingPer1MTokens: { inputUsd: 1.75, cachedInputUsd: 0.175, outputUsd: 14 },
    source: "https://platform.openai.com/docs/models/gpt-5.2-codex",
    note: "OpenAI API billing; same text-token price as GPT-5.2.",
  },
  "openai-api-gpt-5-mini": {
    providerID: "openai",
    modelID: "gpt-5-mini",
    authMode: "api-key",
    env: ["OPENAI_API_KEY"],
    pricingPer1MTokens: { inputUsd: 0.25, cachedInputUsd: 0.025, outputUsd: 2 },
    source: "https://platform.openai.com/docs/pricing/",
    note: "OpenAI API cheaper test default for well-defined tasks.",
  },
  "openai-api-gpt-5-nano": {
    providerID: "openai",
    modelID: "gpt-5-nano",
    authMode: "api-key",
    env: ["OPENAI_API_KEY"],
    pricingPer1MTokens: { inputUsd: 0.05, cachedInputUsd: 0.005, outputUsd: 0.4 },
    source: "https://platform.openai.com/docs/pricing/",
    note: "OpenAI API cheapest smoke-test preset; lower capability.",
  },
} as const

export const defaultModelsConfig: ModelsConfig = {
  version: 0,
  enabled: false,
  roles: {
    default: {
      providerID: null,
      modelID: null,
      reason: "No default model is configured; MendCode should use its runtime default.",
    },
    small: { providerID: null, modelID: null, reason: "Runtime small-model fallback for lightweight internal tasks." },
    plan: { providerID: null, modelID: null, reason: "No plan-role model is configured yet." },
    build: { providerID: null, modelID: null, reason: "No build-role model is configured yet." },
    code: { providerID: null, modelID: null, reason: "No code-role model is configured yet." },
    review: { providerID: null, modelID: null, reason: "No review-role model is configured yet." },
    subagent: { providerID: null, modelID: null, reason: "Default model for subagent task tool sessions." },
    title: { providerID: null, modelID: null, reason: "Hidden runtime title-generation agent model." },
    compaction: { providerID: null, modelID: null, reason: "Hidden runtime context-compaction agent model." },
    summary: { providerID: null, modelID: null, reason: "Hidden runtime summary agent model." },
    memoryExtractor: {
      providerID: null,
      modelID: null,
      reason: "Hidden memory extractor model for approval-gated memory proposals.",
    },
    permissionReviewer: {
      providerID: null,
      modelID: null,
      reason: "Hidden permission reviewer model for Smart Approval decisions on risky shell prompts.",
    },
  },
}

function xdgConfigHome() {
  return process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config")
}

function globalModelsConfigCandidates() {
  const base = xdgConfigHome()
  return [path.join(base, "mendcode", "models.yaml"), path.join(base, "opencode", "models.yaml")]
}

export function resolveGlobalModelsConfigPath() {
  for (const candidate of globalModelsConfigCandidates()) {
    if (existsSync(candidate)) return candidate
  }
  return globalModelsConfigCandidates()[0]
}

export async function readGlobalModelsConfig(): Promise<ModelsConfig> {
  const file = resolveGlobalModelsConfigPath()
  if (!existsSync(file)) return JSON.parse(JSON.stringify(defaultModelsConfig)) as ModelsConfig
  return parseModelsYaml(await readFile(file, "utf8"))
}

export async function writeGlobalModelsConfig(config: ModelsConfig) {
  const file = resolveGlobalModelsConfigPath()
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${modelsConfigToYaml(config)}\n`)
}

function parseScalar(raw: string) {
  const value = raw.trim()
  if (value === "null" || value === "~") return null
  if (value === "true") return true
  if (value === "false") return false
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  return value.replace(/^"|"$/g, "")
}

export function parseModelsYaml(text: string): ModelsConfig {
  const config = JSON.parse(JSON.stringify(defaultModelsConfig)) as ModelsConfig
  let currentRole: string | null = null
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\s+#.*$/, "")
    if (!line.trim()) continue
    const top = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (top) {
      currentRole = null
      const [, key, rawValue] = top
      if (key === "version" || key === "enabled") {
        ;(config as any)[key] = parseScalar(rawValue)
      }
      continue
    }
    const role = line.match(/^  ([A-Za-z0-9_-]+):\s*$/)
    if (role) {
      currentRole = role[1]
      if (!Object.hasOwn(config.roles, currentRole)) {
        config.roles = { ...config.roles, [currentRole]: { providerID: null, modelID: null } }
      }
      continue
    }
    const field = line.match(/^    ([A-Za-z0-9_-]+):\s*(.*)$/)
    if (field && currentRole) {
      const [, key, rawValue] = field
      ;(config.roles[currentRole] as any)[key] = parseScalar(rawValue)
    }
  }
  return config
}

function yamlScalar(value: unknown) {
  if (value === null || value === undefined) return "null"
  if (typeof value === "boolean" || typeof value === "number") return String(value)
  return JSON.stringify(String(value))
}

export function modelsConfigToYaml(config: ModelsConfig) {
  const lines = [`version: ${config.version}`, `enabled: ${config.enabled}`, "roles:"]
  for (const [name, role] of Object.entries(config.roles)) {
    lines.push(`  ${name}:`)
    for (const [key, value] of Object.entries(role)) lines.push(`    ${key}: ${yamlScalar(value)}`)
  }
  return lines.join("\n")
}

function parseRuntimeModel(input: unknown) {
  if (typeof input !== "string") return null
  const [providerID, ...rest] = input.split("/")
  const modelID = rest.join("/")
  if (!providerID || !modelID) return null
  return { providerID, modelID }
}

async function applyGlobalConfigOverrides(config: ModelsConfig) {
  const file = path.join(Global.Path.config, "mendcode.json")
  if (!existsSync(file)) return config
  const data = JSON.parse(await readFile(file, "utf8")) as Record<string, any>
  const next: ModelsConfig = {
    ...config,
    roles: { ...config.roles },
  }

  const defaultModel = parseRuntimeModel(data.model)
  if (defaultModel && (!next.roles.default?.providerID || !next.roles.default.modelID)) {
    next.enabled = true
    next.roles.default = {
      ...(next.roles.default || { providerID: null, modelID: null }),
      providerID: defaultModel.providerID,
      modelID: defaultModel.modelID,
    }
  }

  const subagentModel = parseRuntimeModel(data.subagent_model)
  if (subagentModel && (!next.roles.subagent?.providerID || !next.roles.subagent.modelID)) {
    next.enabled = true
    next.roles.subagent = {
      ...(next.roles.subagent || { providerID: null, modelID: null }),
      providerID: subagentModel.providerID,
      modelID: subagentModel.modelID,
    }
  }

  for (const [name, agent] of Object.entries((data.agent || {}) as Record<string, any>)) {
    const parsed = parseRuntimeModel(agent?.model)
    if (!parsed) continue
    if (next.roles[name]?.providerID && next.roles[name]?.modelID) continue
    next.enabled = true
    next.roles[name] = {
      ...(next.roles[name] || { providerID: null, modelID: null }),
      providerID: parsed.providerID,
      modelID: parsed.modelID,
    }
  }

  if (next.roles.build?.providerID && next.roles.build?.modelID) {
    next.roles.code = { ...next.roles.build }
  }

  return next
}

export async function readModelsConfig(root?: string): Promise<ModelsConfig> {
  const globalFile = resolveGlobalModelsConfigPath()
  const paths = mendPaths(root)
  const base = existsSync(globalFile)
    ? await applyGlobalConfigOverrides(await readGlobalModelsConfig())
    : existsSync(paths.modelsConfig)
      ? await applyGlobalConfigOverrides(parseModelsYaml(await readFile(paths.modelsConfig, "utf8")))
      : await applyGlobalConfigOverrides(JSON.parse(JSON.stringify(defaultModelsConfig)) as ModelsConfig)
  const projected = await activeMendPackageProjection(paths.root).catch(() => undefined)
  for (const pack of projected?.runtimePacks || []) {
    if (!pack.models || (!pack.models.default.providerID && !Object.keys(pack.models.roles || {}).length)) continue
    base.enabled = true
    base.roles = {
      ...base.roles,
      ...pack.models.roles,
      ...(pack.models.default.providerID || pack.models.default.modelID
        ? { default: { ...base.roles.default, ...pack.models.default } }
        : {}),
    }
  }
  return base
}

export async function writeModelsConfig(config: ModelsConfig, root?: string) {
  const file = mendPaths(root).modelsConfig
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${modelsConfigToYaml(config)}\n`)
}

async function readJsonIfExists<T>(file: string, fallback: T): Promise<T> {
  if (!existsSync(file)) return fallback
  return JSON.parse(await readFile(file, "utf8")) as T
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

function modelIDFor(role?: ModelRole) {
  if (!role?.providerID || !role?.modelID) return null
  return `${role.providerID}/${role.modelID}`
}

const generatedAgentRoleNames = ["title", "compaction", "summary"] as const

function generatedAgentConfig(role?: ModelRole) {
  const model = modelIDFor(role)
  if (!model) return undefined
  return {
    model,
    ...(role?.variant ? { variant: role.variant } : {}),
  }
}

export function generatedInternalAgentModelConfig(roles: Record<string, ModelRole | undefined>) {
  const agent: Record<string, { model: string; variant?: string }> = {}
  for (const name of generatedAgentRoleNames) {
    const next = generatedAgentConfig(roles[name])
    if (next) agent[name] = next
  }
  return agent
}

export async function resolveModelRoles(root?: string, focus = "codex") {
  const paths = mendPaths(root)
  const models = await readModelsConfig(root)
  const roles = Object.fromEntries(
    Object.entries(models.roles || {}).map(([name, role]) => [
      name,
      { ...role, runtimeModel: modelIDFor(role), configured: Boolean(modelIDFor(role)) },
    ]),
  )
  if (!(roles as any).build?.configured && (roles as any).code?.configured) {
    ;(roles as any).build = { ...(roles as any).code, reason: "Using legacy code role as build role." }
  }
  const enabled = models.enabled === true
  const defaultModel = enabled ? (roles.default as any)?.runtimeModel || null : null
  const smallModel = enabled ? (roles.small as any)?.runtimeModel || null : null
  const warnings: string[] = []
  if (!enabled)
    warnings.push("models.yaml enabled=false; generated runtime compatibility config will not set model/small_model")
  if (enabled && !defaultModel)
    warnings.push(
      "models.yaml enabled=true but roles.default is not configured; generated runtime compatibility config will not set model",
    )
  return {
    path: path.relative(paths.root, paths.modelsConfig),
    enabled,
    focus,
    defaultModel,
    smallModel,
    roles,
    warnings,
  }
}

export async function modelRoleProjection(root?: string, focus = "codex") {
  const paths = mendPaths(root)
  const resolved = await resolveModelRoles(root, focus)
  const roles = resolved.roles as Record<string, any>
  const candidateModels = {
    plan: roles.plan?.runtimeModel || resolved.defaultModel,
    build: roles.build?.runtimeModel || roles.code?.runtimeModel || resolved.defaultModel,
    code: roles.build?.runtimeModel || roles.code?.runtimeModel || resolved.defaultModel,
    review: roles.review?.runtimeModel || resolved.defaultModel,
    subagent: roles.subagent?.runtimeModel || null,
    small: roles.small?.runtimeModel || null,
    title: roles.title?.runtimeModel || roles.small?.runtimeModel || resolved.defaultModel,
    compaction: roles.compaction?.runtimeModel || resolved.defaultModel,
    summary: roles.summary?.runtimeModel || roles.small?.runtimeModel || resolved.defaultModel,
    memoryExtractor: roles.memoryExtractor?.runtimeModel || null,
    permissionReviewer: roles.permissionReviewer?.runtimeModel || roles.small?.runtimeModel || null,
  }
  const projected = Object.fromEntries(
    Object.entries(candidateModels).map(([role, model]) => [
      role,
      { model: resolved.enabled ? model || null : null, configured: resolved.enabled && Boolean(model) },
    ]),
  )
  const failures: string[] = []
  if (resolved.enabled) {
    for (const [role, info] of Object.entries(projected)) {
      if (role === "small" || role === "subagent" || role === "memoryExtractor" || role === "permissionReviewer")
        continue
      if (!(info as any).configured) failures.push(`models.yaml enabled=true but ${role} role cannot be projected`)
    }
  }
  return {
    enabled: resolved.enabled,
    focus,
    projectionTarget: path.relative(paths.root, path.join(paths.mendDir, "generated", "model-role-projection.json")),
    writesProviderCredentials: false,
    generatedConfigOnlyWhenEnabled: true,
    projected,
    warnings: resolved.enabled
      ? resolved.warnings
      : ["models.yaml enabled=false; plan/code/review roles are documented but not projected into runtime metadata"],
    failures,
  }
}

export async function refreshGeneratedRuntimeModelConfig(root?: string) {
  const paths = mendPaths(root)
  const resolved = await resolveModelRoles(paths.root)
  const generated = await readJsonIfExists<Record<string, any>>(paths.generatedOpencodeConfig, {
    $schema: "https://mendcode.ai/config.json",
  })
  if (resolved.defaultModel) generated.model = resolved.defaultModel
  else delete generated.model
  if (resolved.smallModel) generated.small_model = resolved.smallModel
  else delete generated.small_model
  const subagentModel = (resolved.roles as Record<string, ModelRole & { runtimeModel?: string | null }>).subagent
    ?.runtimeModel
  if (subagentModel) generated.subagent_model = subagentModel
  else delete generated.subagent_model
  const subagentVariant = (resolved.roles as Record<string, ModelRole & { runtimeModel?: string | null }>).subagent
    ?.variant
  if (subagentModel && subagentVariant) generated.subagent_variant = subagentVariant
  else delete generated.subagent_variant
  const generatedAgent = { ...(generated.agent || {}) }
  const roles = resolved.roles as Record<string, ModelRole & { runtimeModel?: string | null; configured?: boolean }>
  const internalAgentConfig = generatedInternalAgentModelConfig(roles)
  for (const name of generatedAgentRoleNames) {
    if (internalAgentConfig[name]) generatedAgent[name] = internalAgentConfig[name]
    else delete generatedAgent[name]
  }
  if (Object.keys(generatedAgent).length) generated.agent = generatedAgent
  else delete generated.agent
  await writeJson(paths.generatedOpencodeConfig, generated)
  const projection = await modelRoleProjection(paths.root)
  await writeJson(paths.modelRoleProjectionState, projection)
  return {
    generatedConfig: path.relative(paths.root, paths.generatedOpencodeConfig),
    modelRoleProjection: path.relative(paths.root, paths.modelRoleProjectionState),
    defaultModel: resolved.defaultModel,
    smallModel: resolved.smallModel,
    warnings: resolved.warnings,
  }
}

export function validateProviderModelID(providerID?: string, modelID?: string) {
  const failures: string[] = []
  if (!providerID || !/^[a-zA-Z0-9_.-]+$/.test(providerID)) failures.push("providerID must match /^[a-zA-Z0-9_.-]+$/")
  if (!modelID || !/^[a-zA-Z0-9_.:/@-]+$/.test(modelID)) failures.push("modelID must match /^[a-zA-Z0-9_.:/@-]+$/")
  return failures
}
