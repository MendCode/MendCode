import { z } from "zod"
import { MODEL_ROLES } from "./constants"
import { SessionId } from "./ids"
import { ModelChoice, ModelRoles } from "./queries"
import { lazySchema } from "./lazy"

const scope = z.enum(["project", "global"])
const name = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/)
const target = z.string().min(1).max(4096)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const AIConfigRecipe = lazySchema(() => z.strictObject({
  description: z.string().min(1).max(300),
  version: z.string().max(40).optional(),
  roles: ModelRoles.refine((roles) => Object.keys(roles).length > 0, { message: "at least one role is required" }),
}))
export type AIConfigRecipe = z.infer<typeof AIConfigRecipe>

export const AIConfigPlanInput = lazySchema(() => z.strictObject({
  action: z.literal("plan"),
  intent: z.enum(["economical", "balanced", "quality"]),
  taskKind: z.enum(["repair", "terminal", "frontend", "architecture", "review", "general"]),
  candidates: z.array(z.union([ModelChoice, z.strictObject({ role: z.enum(MODEL_ROLES) })])).max(30).default([]),
  selectedRoles: z.array(z.enum(MODEL_ROLES)).max(MODEL_ROLES.length).optional(),
  profileName: name.optional(),
  scope: scope.default("project"),
  target: target.optional(),
}))
export type AIConfigPlanInput = z.infer<typeof AIConfigPlanInput>

export const AIConfigInput = lazySchema(() => z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("inspect") }),
  AIConfigPlanInput,
  z.strictObject({ action: z.literal("validate"), patch: AIConfigRecipe, scope: scope.default("project"), target, expectedHash: hash.optional() }),
  z.strictObject({ action: z.literal("apply"), patch: AIConfigRecipe, scope, target, expectedHash: hash, sessionId: SessionId, confirm: z.literal(true) }),
]))
export type AIConfigInput = z.infer<typeof AIConfigInput>

export type AIConfigTarget = { scope: "project" | "global"; path: string; exists: boolean; writable: boolean; digest: string }
export type AIConfigModel = { id: string; name: string; /** The model an engine alias (`claude-opus`) last ran on here (`claude-opus-5-5`); requests keep the alias. */ resolved?: string; provider: string; engine: string; efforts: string[]; variants: string[]; contextWindow?: number; configured: boolean; apiOrigin: string | null; pricing: { input: number; output: number; source: "local-budget" } | null }
export type AIConfigIssue = { code: string; path: string; message: string }
export type AIConfigAlternative = { id: string; strategy: "single" | "cascade" | "critic"; primary: z.infer<typeof ModelChoice>; secondary?: z.infer<typeof ModelChoice>; feasibility: "feasible" | "blocked"; reason: string; estimatedMaxCostUsd: number | null; quality: "unknown" }
export type AIConfigInspection = {
  action: "inspect"; version: 1; models: AIConfigModel[]; roles: z.infer<typeof ModelRoles>; configSources: AIConfigTarget[]
  effective: { compactAtTokens: number | null }; missingInformation: string[]; advisor: "off"
}
export type AIConfigPlan = {
  action: "plan"; version: 1; alternatives: AIConfigAlternative[]; selectedAlternative: string; patch: AIConfigRecipe
  target: AIConfigTarget; expectedHash: string; diff: string[]; warnings: string[]
  evidence: { observedAt: number; quality: "unknown"; pricing: "local-budget"; callsProviders: false }
}
export type AIConfigValidation = { action: "validate"; valid: boolean; issues: AIConfigIssue[]; warnings: string[]; target: AIConfigTarget; patch: AIConfigRecipe; diff: string[] }
export type AIConfigApplied = { action: "apply"; changed: boolean; changedKeys: string[]; target: AIConfigTarget; beforeHash: string; afterHash: string; backupPath: string | null; warnings: string[] }
export type AIConfigReport = AIConfigInspection | AIConfigPlan | AIConfigValidation | AIConfigApplied
