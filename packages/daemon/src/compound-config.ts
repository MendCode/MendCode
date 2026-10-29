import { createHash } from "node:crypto"
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { CompoundConfig, type CompoundReport, type ModelChoice, type ModelRoles, type ResolvedCompoundProfile } from "@mendcode/protocol"
import { invalidChoice, usableEffort, type ModelCatalog } from "./models"

const EMPTY: CompoundConfig = { version: 1, orchestration: { enabled: false, profiles: {} } }
export const compoundHash = (config: CompoundConfig) => createHash("sha256").update(JSON.stringify(config)).digest("hex")

export function readCompoundConfig(dir: string): { config: CompoundConfig; issues: string[] } {
  const file = path.join(dir, "ai.json")
  if (!existsSync(file)) return { config: structuredClone(EMPTY), issues: [] }
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error("ai.json must be a regular file under 64 KB")
    return { config: CompoundConfig.parse(JSON.parse(readFileSync(file, "utf8"))), issues: [] }
  } catch (error) {
    return { config: structuredClone(EMPTY), issues: [error instanceof Error ? error.message : String(error)] }
  }
}

export function writeCompoundConfig(dir: string, config: CompoundConfig, expectedHash: string) {
  const current = readCompoundConfig(dir)
  if (current.issues.length) throw new Error(current.issues.join("; "))
  if (compoundHash(current.config) !== expectedHash) throw new Error("Compound configuration changed; reload before applying")
  const parsed = CompoundConfig.parse(config)
  const target = path.join(dir, "ai.json")
  const temp = path.join(dir, `ai-${crypto.randomUUID()}.tmp`)
  writeFileSync(temp, `${JSON.stringify(parsed, null, 2)}\n`, { flag: "wx", mode: 0o600 })
  renameSync(temp, target)
}

export function resolveCompoundProfiles(config: CompoundConfig, catalog: ModelCatalog, roles: ModelRoles): Pick<CompoundReport, "profiles" | "issues"> {
  const profiles: ResolvedCompoundProfile[] = []
  const issues: string[] = []
  const configHash = compoundHash(config)
  for (const [name, profile] of Object.entries(config.orchestration.profiles)) {
    try {
      const resolve = (ref: typeof profile.primary): ModelChoice => {
        let choice: ModelChoice
        if ("role" in ref) {
          if (ref.role !== "main" && !roles[ref.role]) throw new Error(`role ${ref.role} is not configured`)
          choice = roles[ref.role] ?? catalog.defaults
        } else {
          const bare = catalog.list().find((model) => model.id === ref.modelID && !model.provider)
          choice = { model: bare && ["codex", "openai", "chatgpt"].includes(ref.providerID) ? bare.id : `${ref.providerID}:${ref.modelID}`, ...(ref.variant ? { variant: ref.variant } : {}) }
        }
        const problem = invalidChoice(choice, catalog)
        if (problem) throw new Error(problem)
        if (catalog.list().find((model) => model.id === choice.model)?.engine || choice.model.startsWith("acp:")) throw new Error("Compound execution requires a native provider")
        const variant = choice.variant ? catalog.list().find((model) => model.id === choice.model)?.variants?.[choice.variant] : undefined
        return usableEffort({ ...choice, ...(variant?.effort ? { effort: variant.effort } : {}), ...(variant?.parameters ? { parameters: variant.parameters } : {}) }, catalog)
      }
      const primary = resolve(profile.primary)
      const escalation = profile.escalation ? resolve(profile.escalation) : undefined
      const critic = profile.critic ? resolve(profile.critic) : undefined
      if (critic?.model === primary.model && critic.variant === primary.variant) throw new Error("critic must use a distinct model or variant")
      const pricing = Object.fromEntries(catalog.list().filter((model) => model.compoundPricing && Object.values(model.compoundPricing).some((value) => typeof value === "number" && value > 0)).map((model) => [model.id, model.compoundPricing!]))
      profiles.push({ name, strategy: profile.strategy, primary, ...(escalation ? { escalation } : {}), ...(critic ? { critic } : {}), limits: structuredClone(profile.limits), configHash, pricing })
    } catch (error) { issues.push(`${name}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  return { profiles, issues }
}
