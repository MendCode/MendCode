import { createHash, randomUUID } from "node:crypto"
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { AIConfigInput, AIConfigRecipe, MODEL_ROLES, redactSecrets, type AIConfigAlternative, type AIConfigInput as Input, type AIConfigInspection, type AIConfigIssue, type AIConfigModel, type AIConfigPlan, type AIConfigReport, type AIConfigTarget, type AIConfigValidation, type ModelChoice, type ModelInfo, type ModelRole, type Settings, type SessionId } from "@mendcode/protocol"
import { canonicalDir, type AIConfigPort } from "@mendcode/tools"
import { invalidChoice, type ModelCatalog } from "./models"
import { rolesFor } from "./profiles"

const MAX_BYTES = 16 * 1024
const digest = (text: string) => createHash("sha256").update(text).digest("hex")
const clean = (text: string) => redactSecrets(text).text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
const warnings = ["Quality is unknown; candidate order is not an intelligence ranking.", "Saved recipes run only after an explicit recipe apply; the active session is unchanged."]

export class AIConfigError extends Error {
  constructor(readonly code: "invalid_command" | "target_mismatch", message: string) { super(message) }
}

export function createAIConfigService(input: {
  dir: string
  catalog: ModelCatalog
  settings(): Settings
  engine: string
  providers?(): Array<{ id: string; baseUrl: string; enabled: boolean; error?: string | undefined }>
  sessionDirectory(sessionId: SessionId): string | undefined
  now(): number
  /** The catalog with each engine alias's resolved model (`model-resolutions.ts`), so the model reads which Opus `claude-opus` is. */
  resolve?(models: ModelInfo[]): ModelInfo[]
}) {
  const catalog: ModelCatalog = { ...input.catalog, list: () => input.resolve ? input.resolve(input.catalog.list(true)) : input.catalog.list(true) }
  function root(directory: string, scope: "project" | "global") {
    const base = scope === "global" ? canonicalDir(input.dir) : canonicalDir(directory)
    return { base, folder: path.join(base, ...(scope === "global" ? [] : [".mendcode"]), "recipes") }
  }

  function safePath(directory: string, scope: "project" | "global", file: string) {
    const { base, folder } = root(directory, scope)
    const suppliedBase = path.resolve(scope === "global" ? input.dir : directory)
    const supplied = path.resolve(file)
    // Normalize only the caller's root alias (/var → /private/var on macOS), never a descendant symlink.
    const absolute = supplied.startsWith(suppliedBase + path.sep) ? path.join(base, path.relative(suppliedBase, supplied)) : supplied
    if (path.dirname(absolute) !== folder || !/^[a-z][a-z0-9_-]{0,39}\.json$/.test(path.basename(absolute))) throw new AIConfigError("invalid_command", "Target must be a named JSON recipe in the selected scope's recipes directory")
    let current = base
    for (const segment of path.relative(base, absolute).split(path.sep)) {
      current = path.join(current, segment)
      try {
        if (lstatSync(current).isSymbolicLink()) throw new AIConfigError("invalid_command", "Recipe targets and their parent directories cannot be symlinks")
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    }
    return absolute
  }

  function target(directory: string, scope: "project" | "global", file: string): AIConfigTarget {
    const absolute = safePath(directory, scope, file)
    const exists = existsSync(absolute)
    if (exists && (!statSync(absolute).isFile() || statSync(absolute).size > MAX_BYTES)) throw new AIConfigError("invalid_command", "Recipe target must be a file no larger than 16 KB")
    let ancestor = absolute
    while (!existsSync(ancestor)) ancestor = path.dirname(ancestor)
    let writable = true
    try { accessSync(ancestor, constants.W_OK) } catch { writable = false }
    return { scope, path: absolute, exists, writable, digest: digest(exists ? readFileSync(absolute, "utf8") : "") }
  }

  function recipe(file: AIConfigTarget): AIConfigRecipe | undefined {
    if (!file.exists) return undefined
    try { return AIConfigRecipe.parse(JSON.parse(readFileSync(file.path, "utf8"))) }
    catch { throw new AIConfigError("invalid_command", "Existing target is not a valid recipe; nothing was written") }
  }

  function models(): AIConfigModel[] {
    const settings = input.settings()
    const providers = input.providers?.() ?? []
    return catalog.list().slice(0, 1000).map((model) => {
      const provider = providers.find((item) => item.id === model.provider)
      const price = model.provider ? settings.budgets?.prices[model.id] : undefined
      let apiOrigin: string | null = null
      try { if (provider) apiOrigin = new URL(provider.baseUrl).origin } catch {}
      return { id: clean(model.id), name: clean(model.name), ...(model.resolved ? { resolved: clean(model.resolved) } : {}), provider: clean(model.provider ?? model.engine ?? "chatgpt"), engine: model.engine ?? input.engine, efforts: model.efforts, variants: Object.keys(model.variants ?? {}), ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}), configured: input.catalog.selectable && (!model.provider || !!provider && provider.enabled && !provider.error), apiOrigin, pricing: price ? { input: price.input, output: price.output, source: "local-budget" as const } : null }
    })
  }

  function inspect(directory: string): AIConfigInspection {
    const configSources: AIConfigTarget[] = []
    for (const scope of ["project", "global"] as const) {
      const folder = root(directory, scope).folder
      // Reading never follows a project-controlled recipes symlink.
      safePath(directory, scope, path.join(folder, "preview.json"))
      if (!existsSync(folder)) continue
      for (const entry of readdirSync(folder).sort().filter((name) => /^[a-z][a-z0-9_-]{0,39}\.json$/.test(name)).slice(0, 100)) {
        configSources.push(target(directory, scope, path.join(folder, entry)))
      }
    }
    const list = models()
    return { action: "inspect", version: 1, models: list, roles: rolesFor(input.settings(), directory), configSources, effective: { compactAtTokens: input.settings().compactAtTokens ?? null }, missingInformation: [
      ...(list.some((model) => !model.pricing) ? ["Pricing is incomplete; unknown cost and subscription quota are not free API usage."] : []),
      "Comparable dated quality evidence is unavailable.",
      "Model recipes bind roles only; use /compound for cascade or critic and /compaction for compaction profiles.",
    ], advisor: "off" }
  }

  function diff(before: AIConfigRecipe | undefined, after: AIConfigRecipe): string[] {
    const lines: string[] = []
    for (const key of ["description", "version", ...MODEL_ROLES] as const) {
      const left = key === "description" || key === "version" ? before?.[key] : before?.roles[key]
      const right = key === "description" || key === "version" ? after[key] : after.roles[key]
      if (JSON.stringify(left) === JSON.stringify(right)) continue
      const label = key === "description" || key === "version" ? key : `roles.${key}`
      if (left !== undefined) lines.push(clean(`- ${label}: ${JSON.stringify(left)}`))
      if (right !== undefined) lines.push(clean(`+ ${label}: ${JSON.stringify(right)}`))
    }
    return lines
  }

  function validate(directory: string, request: Extract<Input, { action: "validate" | "apply" }>): AIConfigValidation {
    const file = target(directory, request.scope, request.target)
    const before = recipe(file)
    const issues: AIConfigIssue[] = []
    if (!file.writable) issues.push({ code: "not-writable", path: "target", message: "Target is not writable" })
    if (request.expectedHash && request.expectedHash !== file.digest) issues.push({ code: "stale-target", path: "expectedHash", message: "Target changed since preview" })
    for (const [role, choice] of Object.entries(request.patch.roles)) {
      const problem = choice && invalidChoice(choice, catalog, role as ModelRole)
      const configured = models().find((model) => model.id === choice?.model)?.configured
      if (problem || !configured) issues.push({ code: "unavailable-model", path: `roles.${role}`, message: clean(problem ?? `${choice?.model} is not configured`) })
    }
    if (Buffer.byteLength(JSON.stringify(request.patch)) > MAX_BYTES) issues.push({ code: "too-large", path: "patch", message: "Recipe exceeds 16 KB" })
    return { action: "validate", valid: !issues.length, issues, warnings: [...warnings], target: file, patch: request.patch, diff: diff(before, request.patch) }
  }

  function plan(directory: string, request: Extract<Input, { action: "plan" }>): AIConfigPlan {
    const roles = rolesFor(input.settings(), directory)
    const refs = request.candidates.length ? request.candidates : (request.selectedRoles ?? []).map((role) => ({ role }))
    const candidates: ModelChoice[] = []
    for (const ref of refs) {
      const choice = "role" in ref ? roles[ref.role] : ref
      if (!choice) throw new AIConfigError("invalid_command", "Candidate role has no configured model")
      const problem = invalidChoice(choice, catalog)
      if (problem || !models().find((model) => model.id === choice.model)?.configured) throw new AIConfigError("invalid_command", clean(problem ?? `Candidate ${choice.model} is not configured`))
      if (!candidates.some((item) => JSON.stringify(item) === JSON.stringify(choice))) candidates.push(choice)
    }
    if (!candidates.length) throw new AIConfigError("invalid_command", "Plan requires candidate models or configured selectedRoles")
    const rate = (choice: ModelChoice) => {
      const price = models().find((model) => model.id === choice.model)?.pricing
      return price ? Math.max(price.input, price.output) : null
    }
    if (request.intent !== "quality") candidates.sort((a, b) => (rate(a) ?? Infinity) - (rate(b) ?? Infinity))
    const alternatives: AIConfigAlternative[] = candidates.slice(0, 3).map((primary, index) => ({ id: `single-${index + 1}`, strategy: "single", primary, feasibility: "feasible", reason: "One configured model; activated only by explicit recipe apply", estimatedMaxCostUsd: rate(primary) === null ? null : rate(primary)! * 32_000 / 1_000_000, quality: "unknown" }))
    const profileName = request.profileName ?? `${request.taskKind}-${request.intent}`
    const file = target(directory, request.scope, request.target ?? path.join(root(directory, request.scope).folder, `${profileName}.json`))
    const before = recipe(file)
    const patch: AIConfigRecipe = { description: `${request.taskKind} · ${request.intent}`, version: "1", roles: { main: alternatives[0]!.primary } }
    return { action: "plan", version: 1, alternatives, selectedAlternative: alternatives[0]!.id, patch, target: file, expectedHash: file.digest, diff: diff(before, patch), warnings: [...warnings, ...(rate(candidates[0]!) === null ? ["Selected route has unknown pricing; no dollar coverage is claimed."] : []), "32K-token estimate uses the larger local input/output rate; it is not an enforced run cap."], evidence: { observedAt: input.now(), quality: "unknown", pricing: "local-budget", callsProviders: false } }
  }

  function run(directory: string, raw: unknown): AIConfigReport {
    const request = AIConfigInput.parse(raw)
    if (request.action === "inspect") return inspect(directory)
    if (request.action === "plan") return plan(directory, request)
    const checked = validate(directory, request)
    if (request.action === "validate") return checked
    const sessionDirectory = input.sessionDirectory(request.sessionId)
    if (!sessionDirectory || canonicalDir(sessionDirectory) !== canonicalDir(directory)) throw new AIConfigError("invalid_command", "Apply requires a causal session in this project")
    if (!checked.valid) throw new AIConfigError(checked.issues.some((issue) => issue.code === "stale-target") ? "target_mismatch" : "invalid_command", checked.issues.map((issue) => issue.message).join("; "))
    const beforeHash = checked.target.digest
    if (!checked.diff.length) return { action: "apply", changed: false, changedKeys: [], target: checked.target, beforeHash, afterHash: beforeHash, backupPath: null, warnings: checked.warnings }
    const file = checked.target.path
    mkdirSync(path.dirname(file), { recursive: true })
    safePath(directory, request.scope, file)
    const before = checked.target.exists ? readFileSync(file, "utf8") : ""
    if (digest(before) !== beforeHash) throw new AIConfigError("target_mismatch", "Target changed since preview; nothing was written")
    const backupPath = checked.target.exists ? `${file}.bak-${beforeHash}` : null
    if (backupPath) {
      try { writeFileSync(backupPath, before, { mode: 0o600, flag: "wx" }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || lstatSync(backupPath).isSymbolicLink() || readFileSync(backupPath, "utf8") !== before) throw error }
    }
    const text = JSON.stringify(request.patch, null, 2) + "\n"
    const temporary = `${file}.${randomUUID()}.tmp`
    writeFileSync(temporary, text, { mode: 0o600, flag: "wx" })
    // Recheck the exact bytes and directory after preparing the replacement.
    safePath(directory, request.scope, file)
    if (target(directory, request.scope, file).digest !== beforeHash) throw new AIConfigError("target_mismatch", "Target changed before save; nothing was written")
    renameSync(temporary, file)
    return { action: "apply", changed: true, changedKeys: checked.diff.filter((line) => line.startsWith("+ ")).map((line) => line.slice(2).split(":")[0]!), target: target(directory, request.scope, file), beforeHash, afterHash: digest(text), backupPath, warnings: checked.warnings }
  }

  function port(sessionId: SessionId): AIConfigPort {
    return {
      run(request) {
        const directory = input.sessionDirectory(sessionId)
        if (!directory) throw new AIConfigError("invalid_command", "Unknown causal session")
        return run(directory, request.action === "apply" ? { ...request, sessionId, confirm: true } : request)
      },
    }
  }
  return { run, port }
}
