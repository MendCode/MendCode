import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { REASONING_EFFORTS, type ModelInfo, type ReasoningEffort } from "@mendcode/protocol"
import { z } from "zod"

export const ACP_AGENTS_FILE = "acp-agents.json"
/** The models each agent offered in its `model` config option, as last seen: `{ "<agent>": [{ "value", "name" }] }`. */
export const ACP_MODELS_FILE = "acp-models.json"
/** Model ids of ACP agents are `acp:<name>` (the agent's own default) or `acp:<name>/<model>` (a model the agent offers). */
export const ACP_MODEL_PREFIX = "acp:"
const MAX_MODEL_ID = 100
const MAX_AGENT_MODELS = 200

/** One model an agent offered; `efforts`, once the agent showed its effort select for that model, the levels it listed there. */
export type AcpModelOption = { value: string; name: string; efforts?: ReasoningEffort[] }

const isEffort = (value: string): value is ReasoningEffort => (REASONING_EFFORTS as readonly string[]).includes(value)

/** The engine key of an ACP model id: `acp:<name>`, whichever of the agent's models it names. */
export function acpAgentKey(modelId: string): string {
  const slash = modelId.indexOf("/", ACP_MODEL_PREFIX.length)
  return slash === -1 ? modelId : modelId.slice(0, slash)
}

function acpParts(modelId: string | undefined): { name: string; model?: string } | undefined {
  if (!modelId?.startsWith(ACP_MODEL_PREFIX)) return undefined
  const key = acpAgentKey(modelId)
  const name = key.slice(ACP_MODEL_PREFIX.length)
  const model = modelId.slice(key.length + 1)
  return model ? { name, model } : { name }
}

const nameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "use letters, digits, dot, dash and underscore")

export const agentConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
})
export type AcpAgentConfig = z.infer<typeof agentConfigSchema>

export type LoadedAcpAgents = { agents: Record<string, AcpAgentConfig>; issues: string[] }

/** Parses the text of `acp-agents.json`: `{ "<name>": { "command": "…", "args": […], "env": {…} } }`. Bad entries are reported and skipped. */
export function parseAcpAgents(text: string): LoadedAcpAgents {
  const agents: Record<string, AcpAgentConfig> = {}
  const issues: string[] = []
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    return { agents, issues: [`${ACP_AGENTS_FILE}: invalid JSON: ${(error as Error).message}`] }
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return { agents, issues: [`${ACP_AGENTS_FILE}: expected { "<name>": { "command": "…" } }`] }
  for (const [name, raw] of Object.entries(json)) {
    const named = nameSchema.safeParse(name)
    if (!named.success) {
      issues.push(`${ACP_AGENTS_FILE}: agent name "${name}": ${named.error.issues[0]?.message ?? "invalid"}`)
      continue
    }
    const parsed = agentConfigSchema.safeParse(raw)
    if (!parsed.success) {
      issues.push(`${ACP_AGENTS_FILE}: agent "${name}": ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}`)
      continue
    }
    agents[name] = parsed.data
  }
  return { agents, issues }
}

export interface AcpAgents {
  /** The configured agents, re-read when the file changes. */
  load(): LoadedAcpAgents
  get(name: string): AcpAgentConfig | undefined
  /** Catalog entries: `acp:<name>` per agent, then `acp:<name>/<model>` for each model the agent last offered. */
  models(): ModelInfo[]
  /** The agent a model id names, when it is an `acp:` id of a configured agent. */
  agentOf(modelId: string | undefined): string | undefined
  /** The agent's own model value an `acp:<name>/<model>` id names; undefined for `acp:<name>` (the agent's default). */
  modelOf(modelId: string | undefined): string | undefined
  /** Keeps the models an agent offered, so the catalog lists them before its next session starts. */
  learn(agent: string, models: AcpModelOption[]): void
  /** Keeps the effort levels an agent's effort select listed for one of its models, so `/model` offers them for `acp:<name>/<model>`. */
  learnEfforts(agent: string, model: string, efforts: string[]): void
}

/** `<dataDir>/acp-agents.json`, cached by modification time so editing it applies to the next turn without a restart. */
export function createAcpAgents({ dir, catalogEfforts, displayName }: { dir: string; /** The agent's own name ("OpenCode" for `opencode`), from the ACP registry; the id otherwise. */ displayName?(agent: string): string | undefined; /** The levels a catalog names for one of an agent's models (OpenCode's `provider/model` ids are models.dev's), until the agent showed its own. */ catalogEfforts?(model: string): ReasoningEffort[] | undefined }): AcpAgents {
  const file = join(dir, ACP_AGENTS_FILE)
  const modelsFile = join(dir, ACP_MODELS_FILE)
  let cached: { stamp: string; loaded: LoadedAcpAgents } | undefined
  let offeredCache: { stamp: string; models: Record<string, AcpModelOption[]> } | undefined

  function learned(): Record<string, AcpModelOption[]> {
    let stamp: string
    try {
      const info = statSync(modelsFile)
      stamp = `${info.mtimeMs}:${info.size}`
    } catch {
      return {}
    }
    if (offeredCache?.stamp === stamp) return offeredCache.models
    const parsed = z.record(z.string(), z.array(z.object({ value: z.string().min(1), name: z.string(), efforts: z.array(z.enum(REASONING_EFFORTS)).max(REASONING_EFFORTS.length).optional() }))).safeParse((() => {
      try { return JSON.parse(readFileSync(modelsFile, "utf8")) } catch { return undefined }
    })())
    const models: Record<string, AcpModelOption[]> = parsed.success ? Object.fromEntries(Object.entries(parsed.data).map(([agent, list]) => [agent, list.map(({ efforts, ...model }) => (efforts ? { ...model, efforts } : model))])) : {}
    offeredCache = { stamp, models }
    return models
  }

  function load(): LoadedAcpAgents {
    let stamp: string
    try {
      const info = statSync(file)
      stamp = `${info.mtimeMs}:${info.size}`
    } catch {
      cached = undefined
      return { agents: {}, issues: [] }
    }
    if (cached?.stamp === stamp) return cached.loaded
    let loaded: LoadedAcpAgents
    try {
      loaded = parseAcpAgents(readFileSync(file, "utf8"))
    } catch (error) {
      loaded = { agents: {}, issues: [`${ACP_AGENTS_FILE}: cannot read file: ${(error as Error).message}`] }
    }
    cached = { stamp, loaded }
    return loaded
  }

  return {
    load,
    get(name) {
      const config = load().agents[name]
      if (!config?.env) return config
      const env = Object.fromEntries(Object.entries(config.env).map(([key, value]) => {
        const reference = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)
        return [key, reference ? process.env[reference[1]!] ?? "" : value]
      }))
      return { ...config, env }
    },
    models: () => {
      const offered = learned()
      // Named for the harness that runs them, apart from the same models on a native provider (MendCode's harness).
      return Object.keys(load().agents).flatMap((name): ModelInfo[] => {
        const harness = `${displayName?.(name) ?? name} harness`
        return [
          { id: `${ACP_MODEL_PREFIX}${name}`, name: harness, efforts: [] },
          ...(offered[name] ?? []).map((model): ModelInfo => ({ id: `${ACP_MODEL_PREFIX}${name}/${model.value}`, name: `${model.name} · ${harness}`, efforts: [...(model.efforts ?? catalogEfforts?.(model.value) ?? [])] })),
        ]
      })
    },
    agentOf(modelId) {
      const parts = acpParts(modelId)
      return parts && load().agents[parts.name] ? parts.name : undefined
    },
    modelOf(modelId) {
      const parts = acpParts(modelId)
      return parts && load().agents[parts.name] ? parts.model : undefined
    },
    learn(agent, models) {
      const all = learned()
      // A model's learned levels survive a new listing: the model select never carries them.
      const known = new Map((all[agent] ?? []).map((model) => [model.value, model.efforts]))
      const fitting = models.filter((model) => `${ACP_MODEL_PREFIX}${agent}/${model.value}`.length <= MAX_MODEL_ID).slice(0, MAX_AGENT_MODELS).map((model) => {
        const efforts = model.efforts ?? known.get(model.value)
        return { value: model.value, name: model.name, ...(efforts ? { efforts } : {}) }
      })
      if (JSON.stringify(all[agent] ?? []) === JSON.stringify(fitting)) return
      save({ ...all, [agent]: fitting })
    },
    learnEfforts(agent, model, efforts) {
      const all = learned()
      const levels = [...new Set(efforts.filter(isEffort))]
      const list = all[agent] ?? []
      const at = list.findIndex((entry) => entry.value === model)
      if (at === -1 || JSON.stringify(list[at]!.efforts ?? []) === JSON.stringify(levels) && list[at]!.efforts) return
      save({ ...all, [agent]: list.map((entry, index) => (index === at ? { ...entry, efforts: levels } : entry)) })
    },
  }

  function save(models: Record<string, AcpModelOption[]>) {
    try {
      writeFileSync(`${modelsFile}.tmp`, `${JSON.stringify(models, null, 2)}\n`)
      renameSync(`${modelsFile}.tmp`, modelsFile)
    } catch {
      // A convenience only: without the file the agent's own default still runs, and its models are offered again next session.
    }
  }
}
