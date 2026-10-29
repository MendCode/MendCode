import { createHash, randomUUID } from "node:crypto"
import { linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { EvolutionSuggestion, findSecrets, parseEvolutionWorkflow, type EvolutionReceipt } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"
import { validatePlan } from "@mendcode/workflows"

const hash = (body: string) => createHash("sha256").update(body).digest("hex")
const sensitive = (body: string) => findSecrets(body).length > 0 || /-----BEGIN|\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|credential|authorization)\b|\bBearer\s+\S+/i.test(body)

function stat(file: string) {
  try { return lstatSync(file) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    return undefined
  }
}

/** Walk plain folders; never follow repository-controlled symlinks when publishing or retiring an artifact. */
function folders(root: string, parts: string[], create: boolean) {
  let current = path.resolve(root)
  const base = stat(current)
  if (!base?.isDirectory() || base.isSymbolicLink()) throw new Error("Project folder must be a plain directory")
  current = realpathSync(current)
  for (const part of parts) {
    current = path.join(current, part)
    if (!stat(current) && create) mkdirSync(current, { mode: 0o700 })
    const found = stat(current)
    if (!found?.isDirectory() || found.isSymbolicLink()) throw new Error("Promotion destination contains a missing folder or symlink")
  }
  return current
}

function destination(suggestion: EvolutionSuggestion, create: boolean) {
  const name = suggestion.kind === "workflow" ? `evo-${suggestion.name.slice(0, 16)}-${suggestion.suggestionId}` : suggestion.name
  const parts = suggestion.kind === "workflow" ? [".mendcode", "workflows"] : [".mendcode", "skills", name]
  return path.join(folders(suggestion.directory, parts, create), suggestion.kind === "workflow" ? `${name}.json` : "SKILL.md")
}

function bodyOf(suggestion: EvolutionSuggestion) {
  EvolutionSuggestion.parse(suggestion)
  if (sensitive(`${suggestion.name}\n${suggestion.description}\n${suggestion.content}`)) throw new Error("Candidate may contain a secret or credential")
  if (suggestion.kind === "workflow") {
    const plan = parseEvolutionWorkflow(suggestion.content)
    const valid = validatePlan(plan)
    if (!valid.ok) throw new Error(valid.problems.join("; "))
    return `${JSON.stringify(valid.plan, null, 2)}\n`
  }
  if (suggestion.kind !== "skill") throw new Error("Only skills and read-only workflows can be promoted")
  if (/^---\s*$/m.test(suggestion.content)) throw new Error("Skill content must not carry frontmatter")
  const description = suggestion.description.replace(/\s+/g, " ").trim()
  return `---\nname: ${suggestion.name}\ndescription: ${/^[a-zA-Z0-9 ._-]+$/.test(description) ? description : JSON.stringify(description)}\n---\n\n${suggestion.content.trim()}\n`
}

export function createEvolutionPromotions(input: { store: Store; dir: string; now(): number }) {
  const { store } = input
  function reviewed(suggestionId: number, expectedHash: string) {
    const suggestion = store.evolution.suggestion(suggestionId)
    if (!suggestion || suggestion.hash !== expectedHash) throw new Error("Candidate changed; review again")
    return suggestion
  }

  function promote(suggestionId: number, expectedHash: string, policyRevision: string) {
    const suggestion = reviewed(suggestionId, expectedHash)
    if (suggestion.status !== "pending") throw new Error("Candidate is no longer pending")
    const settings = store.settings.get()
    if (!settings.evolution || settings.evolution === "off" || settings.evolution === "observe") throw new Error("Promotion requires suggest or auto-safe mode")
    if (policyRevision !== store.evolution.policyRevision() || suggestion.policyRevision && suggestion.policyRevision !== policyRevision) throw new Error("Evolution policy changed; review a new candidate")
    if (suggestion.kind === "workflow" && !settings.evolutionWorkflows) throw new Error("Workflow candidates are disabled")
    return publish(suggestion)
  }

  function publish(suggestion: EvolutionSuggestion) {
    const body = bodyOf(suggestion)
    const target = destination(suggestion, true)
    if (stat(target)) throw new Error("Promotion destination exists; nothing was overwritten")
    const receipt: EvolutionReceipt = { kind: suggestion.kind as "skill" | "workflow", target, hash: hash(body), revision: 1, promotedAt: input.now() }
    // Durable intent precedes the write; an interrupted write remains visible for explicit recovery.
    store.evolution.promotion(suggestion.suggestionId, "blocked", receipt)
    const temporary = path.join(path.dirname(target), `.${suggestion.suggestionId}-${randomUUID()}.tmp`)
    writeFileSync(temporary, body, { flag: "wx", mode: 0o600 })
    try { linkSync(temporary, target) } finally { unlinkSync(temporary) }
    return { suggestion: store.evolution.promotion(suggestion.suggestionId, "accepted", receipt)!, path: target }
  }

  function rollback(suggestionId: number, expectedHash: string, expectedRevision: number) {
    const suggestion = reviewed(suggestionId, expectedHash)
    const receipt = suggestion.receipt
    if (!receipt || !["accepted", "blocked"].includes(suggestion.status) || receipt.revision !== expectedRevision || receipt.rolledBackAt !== undefined) throw new Error("No matching promotion revision")
    const target = destination(suggestion, false)
    if (receipt.target !== target || receipt.kind !== suggestion.kind) throw new Error("Promotion target changed")
    const file = stat(target)
    const archiveDir = folders(input.dir, ["evolution", "retired", `${suggestionId}-${receipt.hash.slice(0, 16)}`], true)
    const archive = path.join(archiveDir, path.basename(target))
    if (file) {
      if (!file.isFile() || file.isSymbolicLink() || file.size > 64 * 1024 || hash(readFileSync(target, "utf8")) !== receipt.hash) throw new Error("Artifact changed after promotion; manual review required")
      if (stat(archive)) throw new Error("Retired artifact already exists; manual review required")
      renameSync(target, archive)
    } else if (stat(archive)) {
      const retired = stat(archive)!
      if (!retired.isFile() || retired.isSymbolicLink() || retired.size > 64 * 1024 || hash(readFileSync(archive, "utf8")) !== receipt.hash) throw new Error("Retired artifact changed; manual review required")
    } else if (suggestion.status !== "blocked") throw new Error("Promoted artifact is missing; manual review required")
    const next = { ...receipt, revision: receipt.revision + 1, rolledBackAt: input.now(), ...(stat(archive) ? { archive } : {}) }
    return { suggestion: store.evolution.promotion(suggestionId, "rolled_back", next)! }
  }

  return { promote, rollback }
}
