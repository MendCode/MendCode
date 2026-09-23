import path from "node:path"
import { Flock } from "@mendcode/core/util/flock"
import { evolutionPaths, readEvolutionPolicy, type EvolutionPolicy } from "./config"

export type EvolutionAction = "capture" | "provider" | "propose" | "promote" | "auto-apply" | "legacy-learning"

export function authorizeEvolutionAction(policy: EvolutionPolicy, action: EvolutionAction, revision?: string) {
  const blocked = (reason: string) => ({ allowed: false as const, reason })
  if (policy.reason) return blocked(policy.reason)
  if (revision !== undefined && revision !== policy.revision) return blocked("Evolution policy changed; stale work discarded")
  if (action === "legacy-learning") return policy.adopted ? blocked("Legacy learning replaced by Evolution") : { allowed: true as const, reason: null }
  if (!policy.adopted || policy.config.mode === "off") return blocked("Evolution is off")
  if (action === "capture") return { allowed: true as const, reason: null }
  if (policy.config.mode === "observe") return blocked("Observe does not call models or create proposals")
  if (action === "provider" && !policy.config.remoteProcessing) return blocked("Provider processing has not been authorized")
  if (action === "auto-apply" && policy.config.mode !== "auto-safe") return blocked("Proposal requires approval")
  return { allowed: true as const, reason: null }
}

export async function withEvolutionAction<T>(root: string, action: EvolutionAction, revision: string, effect: () => Promise<T>, dataDir?: string) {
  const paths = evolutionPaths(root, dataDir)
  return Flock.withLock(`evolution-policy:${paths.consent}`, async () => {
    const decision = authorizeEvolutionAction(await readEvolutionPolicy(root, dataDir), action, revision)
    if (!decision.allowed) throw new Error(decision.reason)
    return effect()
  }, { dir: path.join(paths.projectDir, ".locks"), timeoutMs: 5_000 })
}

export const resolveEvolutionPolicy = readEvolutionPolicy

export async function assertLegacyLearning(root: string) {
  const decision = authorizeEvolutionAction(await readEvolutionPolicy(root), "legacy-learning")
  if (!decision.allowed) throw new Error(decision.reason)
}
