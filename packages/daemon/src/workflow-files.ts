import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import type { ExtensionLayer, ExtensionSource } from "@mendcode/packages"
import { WorkflowContract, WorkflowPlan } from "@mendcode/protocol"
import { validateContract, validatePlan } from "@mendcode/workflows"

/**
 * Saved workflow contracts (`contracts/<name>.json`, a `WorkflowContract`) and plans (`workflows/<name>.json`, a
 * `WorkflowPlan`) in any extension layer, read like recipes: a later layer's file replaces one of the same name,
 * an invalid file is listed with a `problem` instead of failing the loader, and nothing here throws.
 */
const FILE_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/
const MAX_CONTRACT_BYTES = 16 * 1024
const MAX_PLAN_BYTES = 64 * 1024
const MAX_SCRIPT_BYTES = 48 * 1024
const MAX_FILES = 100

type LayerFile = { name: string; file: string; source: ExtensionSource; pkg?: string }
type Parsed<T> = { value: T } | { problem: string }

export type ContractInfo = LayerFile & { contract?: WorkflowContract; problem?: string }
export type WorkflowPlanInfo = LayerFile & { plan?: WorkflowPlan; problem?: string }

export function readContracts(layers: readonly ExtensionLayer[]): ContractInfo[] {
  return readLayerFiles(layers, { folder: "contracts", maxBytes: MAX_CONTRACT_BYTES, parse: parseContract }).map(({ base, parsed }) => ({
    ...base,
    ...("value" in parsed ? { contract: parsed.value } : { problem: parsed.problem }),
  }))
}

export function readWorkflowPlans(layers: readonly ExtensionLayer[]): WorkflowPlanInfo[] {
  return readLayerFiles(layers, { folder: "workflows", maxBytes: MAX_PLAN_BYTES, parse: parsePlan }).map(({ base, parsed }) => ({
    ...base,
    ...("value" in parsed ? { plan: parsed.value } : { problem: parsed.problem }),
  }))
}

export type WorkflowScriptFile = LayerFile & { text?: string; problem?: string }

/** Saved script workflows: `workflows/<name>.js` in any layer (a later layer replaces one of the same name). The source is read, never run. */
export function readWorkflowScripts(layers: readonly ExtensionLayer[]): WorkflowScriptFile[] {
  const byName = new Map<string, WorkflowScriptFile>()
  for (const layer of layers) {
    const dir = path.join(layer.dir, "workflows")
    let entries: string[]
    try {
      entries = readdirSync(dir).filter((entry) => entry.endsWith(".js")).sort()
    } catch {
      continue
    }
    for (const entry of entries) {
      const name = entry.slice(0, -".js".length)
      if (!byName.has(name) && byName.size >= MAX_FILES) continue
      const file = path.join(dir, entry)
      const base = { name, file, source: layer.source, ...(layer.pkg ? { pkg: layer.pkg } : {}) }
      byName.delete(name)
      byName.set(name, { ...base, ...readScriptFile(file, name) })
    }
  }
  return [...byName.values()]
}

function readScriptFile(file: string, name: string): { text: string } | { problem: string } {
  if (!FILE_NAME.test(name)) return { problem: "names use lowercase letters, digits, . _ - (max 40)" }
  try {
    const size = statSync(file).size
    if (size > MAX_SCRIPT_BYTES) return { problem: `larger than ${MAX_SCRIPT_BYTES / 1024} KB` }
    return { text: readFileSync(file, "utf8") }
  } catch {
    return { problem: "not readable" }
  }
}

function readLayerFiles<T>(layers: readonly ExtensionLayer[], kind: { folder: string; maxBytes: number; parse: (json: unknown) => Parsed<T> }) {
  const byName = new Map<string, { base: LayerFile; parsed: Parsed<T> }>()
  for (const layer of layers) {
    const dir = path.join(layer.dir, kind.folder)
    let entries: string[]
    try {
      entries = readdirSync(dir).filter((entry) => entry.endsWith(".json")).sort()
    } catch {
      continue
    }
    for (const entry of entries) {
      const name = entry.slice(0, -".json".length)
      if (!byName.has(name) && byName.size >= MAX_FILES) continue
      const file = path.join(dir, entry)
      const base = { name, file, source: layer.source, ...(layer.pkg ? { pkg: layer.pkg } : {}) }
      byName.delete(name)
      byName.set(name, { base, parsed: readOne(file, name, kind) })
    }
  }
  return [...byName.values()]
}

function readOne<T>(file: string, name: string, kind: { folder: string; maxBytes: number; parse: (json: unknown) => Parsed<T> }): Parsed<T> {
  if (!FILE_NAME.test(name)) return { problem: "names use lowercase letters, digits, . _ - (max 40)" }
  let text: string
  try {
    const size = statSync(file).size
    if (size > kind.maxBytes) return { problem: `larger than ${kind.maxBytes / 1024} KB` }
    text = readFileSync(file, "utf8")
  } catch {
    return { problem: "not readable" }
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    return { problem: `invalid JSON: ${(error as Error).message}` }
  }
  return kind.parse(json)
}

function parseContract(json: unknown): Parsed<WorkflowContract> {
  const parsed = WorkflowContract.safeParse(json)
  if (!parsed.success) return { problem: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ") }
  const problems = validateContract(parsed.data)
  return problems.length ? { problem: problems.join("; ") } : { value: parsed.data }
}

function parsePlan(json: unknown): Parsed<WorkflowPlan> {
  const result = validatePlan(json)
  return result.ok ? { value: result.plan } : { problem: result.problems.join("; ") }
}
