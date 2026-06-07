import { existsSync } from "fs"
import { cp, mkdir, readFile, rm, writeFile } from "fs/promises"
import path from "path"
import { ConfigParse } from "@/config/parse"
import { defaultModelsConfig, modelsConfigToYaml, type ModelsConfig } from "../../config/models"
import { normalizedCacheDir, writeJson } from "./state"
import type { RuntimeRegistryEntry } from "./types"

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function splitRuntimeModel(value: unknown) {
  if (typeof value !== "string") return null
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1) return null
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) }
}

export async function inspectOpencodeSettings(stageDir: string) {
  const candidates = [
    path.join(stageDir, ".opencode"),
    path.join(stageDir, "opencode"),
    path.join(stageDir, ".config", "opencode"),
    stageDir,
  ]
  const settingsRoot = candidates.find((candidate) => existsSync(candidate)) || stageDir
  const configFiles = ["opencode.json", "opencode.jsonc", "config.json", "config.jsonc"]
    .map((name) => path.join(settingsRoot, name))
    .filter((file) => existsSync(file))
  let config: Record<string, any> = {}
  if (configFiles[0]) {
    config = ConfigParse.jsonc(await readFile(configFiles[0], "utf8"), configFiles[0])
    if (!isRecord(config)) throw new Error(`OpenCode settings config must be an object: ${configFiles[0]}`)
  }
  const supported = new Set(["$schema", "model", "small_model", "subagent_model", "agent", "mcp"])
  return {
    settingsRoot,
    config,
    preview: {
      root: path.relative(stageDir, settingsRoot) || ".",
      configFiles: configFiles.map((file) => path.relative(stageDir, file)),
      commandDirs: ["command", "commands"].filter((name) => existsSync(path.join(settingsRoot, name))),
      agentDirs: ["agent", "agents"].filter((name) => existsSync(path.join(settingsRoot, name))),
      skillDirs: ["skill", "skills"].filter((name) => existsSync(path.join(settingsRoot, name))),
      supportedKeys: Object.keys(config).filter((key) => supported.has(key)).sort(),
      unsupportedKeys: Object.keys(config).filter((key) => !supported.has(key)).sort(),
    },
  }
}

export async function opencodeSettingsPreview(stageDir: string) {
  const settings = await inspectOpencodeSettings(stageDir)
  return {
    ...settings.preview,
    unsupportedKeysReport: "normalization supports model, small_model, subagent_model, selected agent model roles, mcp, and command/agent/skill directories; other keys are reported but not applied",
  }
}

async function copyDirIfExists(source: string, target: string) {
  if (!existsSync(source)) return false
  await mkdir(path.dirname(target), { recursive: true })
  await cp(source, target, { recursive: true })
  return true
}

export async function normalizeOpencodeSettingsToMendcode(entry: RuntimeRegistryEntry, fetchedStageDir: string, root: string) {
  const target = normalizedCacheDir(root, entry.id)
  await rm(target, { recursive: true, force: true })
  await mkdir(path.join(target, ".mendcode"), { recursive: true })
  const inspected = await inspectOpencodeSettings(fetchedStageDir)
  const writes: string[] = []

  const mendConfig = {
    version: 0,
    focus: { default: "codex" },
    budgets: { expensiveModelRequiresConfirm: true },
    worktree: { mode: "off" },
  }
  if (typeof inspected.config.subagent_model === "string") {
    ;(mendConfig as Record<string, any>).subagent_model = inspected.config.subagent_model
  }
  await writeJson(path.join(target, ".mendcode", "mendcode.json"), mendConfig)
  writes.push(".mendcode/mendcode.json")

  const models: ModelsConfig = JSON.parse(JSON.stringify(defaultModelsConfig))
  const defaultModel = splitRuntimeModel(inspected.config.model)
  const smallModel = splitRuntimeModel(inspected.config.small_model)
  if (defaultModel) {
    models.enabled = true
    models.roles.default = { ...models.roles.default, ...defaultModel, reason: "Imported from OpenCode settings model." }
  }
  if (smallModel) {
    models.enabled = true
    models.roles.small = { ...models.roles.small, ...smallModel, reason: "Imported from OpenCode settings small_model." }
  }
  if (isRecord(inspected.config.agent)) {
    for (const role of ["plan", "build", "review", "title", "summary", "compaction"]) {
      const mapped = splitRuntimeModel(inspected.config.agent[role]?.model)
      if (!mapped) continue
      models.enabled = true
      models.roles[role] = { ...(models.roles[role] || { providerID: null, modelID: null }), ...mapped, reason: `Imported from OpenCode settings agent.${role}.model.` }
    }
  }
  await writeFile(path.join(target, ".mendcode", "models.yaml"), `${modelsConfigToYaml(models)}\n`)
  writes.push(".mendcode/models.yaml")

  if (isRecord(inspected.config.mcp)) {
    await writeJson(path.join(target, ".mendcode", "mcp", "imported.json"), inspected.config.mcp)
    writes.push(".mendcode/mcp/imported.json")
  }

  for (const name of ["command", "commands"]) {
    if (await copyDirIfExists(path.join(inspected.settingsRoot, name), path.join(target, ".mendcode", "commands"))) writes.push(".mendcode/commands")
  }
  for (const name of ["agent", "agents"]) {
    if (await copyDirIfExists(path.join(inspected.settingsRoot, name), path.join(target, ".mendcode", "agents"))) writes.push(".mendcode/agents")
  }
  for (const name of ["skill", "skills"]) {
    if (await copyDirIfExists(path.join(inspected.settingsRoot, name), path.join(target, ".mendcode", "skills"))) writes.push(".mendcode/skills")
  }

  await writeJson(path.join(target, ".mendcode", "imports", "opencode-settings.json"), {
    version: 0,
    source: entry.id,
    importedAt: new Date().toISOString(),
    preview: inspected.preview,
    writes,
    secretsIncluded: false,
  })
  writes.push(".mendcode/imports/opencode-settings.json")
  return { stageDir: target, preview: inspected.preview, writes }
}
