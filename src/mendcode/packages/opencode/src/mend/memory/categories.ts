import { existsSync } from "fs"
import { mkdir, readFile, writeFile } from "fs/promises"
import path from "path"
import { memoryPaths, type MemoryScope } from "./config"

export type MemoryFactScope = MemoryScope | "workspace" | "group-view"
export type MemoryWritePolicy = "disabled" | "pending" | "auto-apply-safe" | "manual-only"

export type MemoryCategory = {
  id: string
  label: string
  description: string
  allowedScopes: MemoryFactScope[]
  defaultScope: MemoryFactScope
  promptPriority: number
  promptEnabled: boolean
  writePolicy: MemoryWritePolicy
  staleAfterDays: number | null
}

export type MemoryCategoryPolicy = {
  categoryID: string
  writePolicy: MemoryWritePolicy
  promptEnabled: boolean
  promptPriority: number
}

export type MemoryPolicyScope = "global" | "project"

export const DEFAULT_MEMORY_CATEGORIES: MemoryCategory[] = [
  {
    id: "project.objective",
    label: "Project objective",
    description: "Stable product purpose and goals.",
    allowedScopes: ["project", "workspace", "group-view"],
    defaultScope: "project",
    promptPriority: 10,
    promptEnabled: true,
    writePolicy: "pending",
    staleAfterDays: null,
  },
  {
    id: "project.stack",
    label: "Project stack",
    description: "Frameworks, runtimes, package managers, and core dependencies.",
    allowedScopes: ["project", "workspace"],
    defaultScope: "project",
    promptPriority: 20,
    promptEnabled: true,
    writePolicy: "pending",
    staleAfterDays: 120,
  },
  {
    id: "project.architecture",
    label: "Architecture",
    description: "Durable module boundaries, data flow, and services.",
    allowedScopes: ["project", "workspace", "group-view"],
    defaultScope: "project",
    promptPriority: 30,
    promptEnabled: true,
    writePolicy: "pending",
    staleAfterDays: 180,
  },
  {
    id: "project.commands",
    label: "Commands",
    description: "Recurring commands, validation gates, and release commands.",
    allowedScopes: ["project", "workspace"],
    defaultScope: "project",
    promptPriority: 40,
    promptEnabled: true,
    writePolicy: "pending",
    staleAfterDays: 90,
  },
  {
    id: "project.release",
    label: "Release",
    description: "Versioning, changelog, branch, PR, and release rules.",
    allowedScopes: ["project", "workspace"],
    defaultScope: "project",
    promptPriority: 15,
    promptEnabled: true,
    writePolicy: "pending",
    staleAfterDays: 90,
  },
  {
    id: "project.constraints",
    label: "Constraints",
    description: "Permanent constraints, compatibility promises, and ownership rules.",
    allowedScopes: ["project", "workspace", "group-view"],
    defaultScope: "project",
    promptPriority: 12,
    promptEnabled: true,
    writePolicy: "pending",
    staleAfterDays: null,
  },
  {
    id: "project.security",
    label: "Security",
    description: "Security posture, secret handling, and permission rules.",
    allowedScopes: ["project", "workspace", "group-view"],
    defaultScope: "project",
    promptPriority: 11,
    promptEnabled: true,
    writePolicy: "pending",
    staleAfterDays: null,
  },
  {
    id: "user.preferences",
    label: "User preferences",
    description: "Cross-project communication and workflow preferences.",
    allowedScopes: ["global"],
    defaultScope: "global",
    promptPriority: 60,
    promptEnabled: true,
    writePolicy: "pending",
    staleAfterDays: null,
  },
  {
    id: "agent.policy",
    label: "Agent policy",
    description: "How MendCode should behave for this user or project.",
    allowedScopes: ["global", "project", "workspace"],
    defaultScope: "project",
    promptPriority: 13,
    promptEnabled: true,
    writePolicy: "pending",
    staleAfterDays: null,
  },
  {
    id: "memory.policy",
    label: "Memory policy",
    description: "Memory save, retrieve, category, and Dream rules.",
    allowedScopes: ["global", "project", "workspace"],
    defaultScope: "project",
    promptPriority: 14,
    promptEnabled: true,
    writePolicy: "pending",
    staleAfterDays: null,
  },
  {
    id: "todo.stable",
    label: "Stable roadmap",
    description: "Durable roadmap or recurring future work, not current task status.",
    allowedScopes: ["project", "workspace", "group-view"],
    defaultScope: "project",
    promptPriority: 80,
    promptEnabled: true,
    writePolicy: "pending",
    staleAfterDays: 60,
  },
  {
    id: "volatile.reject",
    label: "Volatile reject",
    description: "Explicit non-save class for fast-changing facts.",
    allowedScopes: ["project", "workspace", "global"],
    defaultScope: "project",
    promptPriority: 999,
    promptEnabled: false,
    writePolicy: "disabled",
    staleAfterDays: 0,
  },
  {
    id: "uncategorized",
    label: "Uncategorized",
    description: "Compatibility bucket for legacy facts without a better category yet.",
    allowedScopes: ["global", "project", "workspace", "group-view"],
    defaultScope: "project",
    promptPriority: 500,
    promptEnabled: true,
    writePolicy: "pending",
    staleAfterDays: 90,
  },
]

export function normalizeMemoryWritePolicy(value: unknown, fallback: MemoryWritePolicy = "pending"): MemoryWritePolicy {
  return value === "disabled" || value === "pending" || value === "auto-apply-safe" || value === "manual-only" ? value : fallback
}

export function memoryCategoryByID(id: string | null | undefined) {
  return DEFAULT_MEMORY_CATEGORIES.find((category) => category.id === id) ?? DEFAULT_MEMORY_CATEGORIES.find((category) => category.id === "uncategorized")!
}

export function normalizeMemoryCategoryIDs(value: unknown): string[] {
  const known = new Set(DEFAULT_MEMORY_CATEGORIES.map((category) => category.id))
  const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : []
  const ids = raw.filter((item): item is string => typeof item === "string" && known.has(item))
  return ids.length ? [...new Set(ids)] : ["uncategorized"]
}

export function normalizeMemoryCategoryPolicies(value: unknown): Record<string, MemoryCategoryPolicy> {
  const record = typeof value === "object" && value !== null ? value as Record<string, unknown> : {}
  return Object.fromEntries(DEFAULT_MEMORY_CATEGORIES.map((category) => {
    const raw = typeof record[category.id] === "object" && record[category.id] !== null ? record[category.id] as Record<string, unknown> : {}
    return [category.id, {
      categoryID: category.id,
      writePolicy: normalizeMemoryWritePolicy(raw.writePolicy, category.writePolicy),
      promptEnabled: typeof raw.promptEnabled === "boolean" ? raw.promptEnabled : category.promptEnabled,
      promptPriority: typeof raw.promptPriority === "number" && Number.isFinite(raw.promptPriority) ? raw.promptPriority : category.promptPriority,
    }]
  }))
}

function policyFile(scope: MemoryPolicyScope, root?: string) {
  const paths = memoryPaths(root)
  return scope === "global"
    ? path.join(paths.globalDir, "policies.json")
    : path.join(paths.projectDir, "policies.json")
}

async function readPolicyOverrides(scope: MemoryPolicyScope, root?: string) {
  const file = policyFile(scope, root)
  if (!existsSync(file)) return {}
  const raw = JSON.parse(await readFile(file, "utf8"))
  return typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {}
}

function applyPolicyOverrides(
  base: Record<string, MemoryCategoryPolicy>,
  overrides: Record<string, unknown>,
) {
  const next = { ...base }
  for (const category of DEFAULT_MEMORY_CATEGORIES) {
    const raw = typeof overrides[category.id] === "object" && overrides[category.id] !== null
      ? overrides[category.id] as Record<string, unknown>
      : null
    if (!raw) continue
    next[category.id] = normalizeMemoryCategoryPolicies({
      [category.id]: {
        ...next[category.id],
        ...raw,
      },
    })[category.id]!
  }
  return next
}

export async function readMemoryCategoryPolicies(root?: string) {
  const base = normalizeMemoryCategoryPolicies({})
  const globalOverrides = await readPolicyOverrides("global", root).catch(() => ({}))
  const projectOverrides = await readPolicyOverrides("project", root).catch(() => ({}))
  return applyPolicyOverrides(applyPolicyOverrides(base, globalOverrides), projectOverrides)
}

export async function writeMemoryCategoryPolicy(
  scope: MemoryPolicyScope,
  categoryID: string,
  patch: Partial<Omit<MemoryCategoryPolicy, "categoryID">>,
  root?: string,
) {
  const category = memoryCategoryByID(categoryID)
  const file = policyFile(scope, root)
  const current = await readPolicyOverrides(scope, root).catch(() => ({}))
  const existing = typeof current[category.id] === "object" && current[category.id] !== null
    ? current[category.id] as Record<string, unknown>
    : {}
  const normalized = normalizeMemoryCategoryPolicies({ [category.id]: { ...existing, ...patch } })[category.id]!
  const nextRaw: Record<string, unknown> = { ...existing, categoryID: category.id }
  if (patch.writePolicy !== undefined) nextRaw.writePolicy = normalized.writePolicy
  if (patch.promptEnabled !== undefined) nextRaw.promptEnabled = normalized.promptEnabled
  if (patch.promptPriority !== undefined) nextRaw.promptPriority = normalized.promptPriority
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify({ ...current, [category.id]: nextRaw }, null, 2)}\n`)
  return { path: file, scope, policy: normalized }
}

export function inferMemoryCategoryIDs(input: { text?: string | null; tags?: string[] | null; source?: string | null }) {
  const haystack = [input.text ?? "", ...(input.tags ?? []), input.source ?? ""].join(" ").toLowerCase()
  const categories: string[] = []
  if (/\b(release|version|changelog|pr|merge|main|dev|tag|ship|publish)\b/.test(haystack)) categories.push("project.release")
  if (/\b(test|bun|pnpm|npm|command|script|typecheck|lint|build|smoke)\b/.test(haystack)) categories.push("project.commands")
  if (/\b(auth|secret|token|permission|security|sandbox|keepass|env)\b/.test(haystack)) categories.push("project.security")
  if (/\b(architecture|module|service|api|database|schema|runtime|flow|contract)\b/.test(haystack)) categories.push("project.architecture")
  if (/\b(stack|framework|react|solid|typescript|bun|node|package manager)\b/.test(haystack)) categories.push("project.stack")
  if (/\b(always|never|prefer|style|language|respond|responde|prefiere)\b/.test(haystack)) categories.push("user.preferences")
  if (/\b(memory|dream|proposal|retrieve|extractor|remember)\b/.test(haystack)) categories.push("memory.policy")
  if (/\b(todo|roadmap|later|future|backlog)\b/.test(haystack)) categories.push("todo.stable")
  if (/\b(currently|right now|ahora|just happened|log|trace|status|pending task)\b/.test(haystack)) categories.push("volatile.reject")
  return categories.length ? [...new Set(categories)] : ["uncategorized"]
}

export function scopeReasonForMemory(input: { requestedScope?: MemoryScope; text?: string | null; tags?: string[] | null }) {
  const haystack = [input.text ?? "", ...(input.tags ?? [])].join(" ").toLowerCase()
  const projectSpecific = /\b(mendcode|opencode|repo|project|package|changelog|release|branch|local path|\/users\/|src\/|test\/|bun|pnpm|tui|cli)\b/.test(haystack)
  const globalPreference = /\b(across projects|cross-project|global|siempre en todos|all repos|communication style|responde en|answer in)\b/.test(haystack)
  if (input.requestedScope === "global" && projectSpecific && !globalPreference) {
    return { scope: "project" as const, reason: "Project/product/path/toolchain facts default to project scope." }
  }
  if (input.requestedScope === "global") return { scope: "global" as const, reason: "Explicit global or user-level preference." }
  return { scope: "project" as const, reason: projectSpecific ? "Project-specific fact." : "Conservative default scope." }
}
