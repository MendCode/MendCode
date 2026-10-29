import { z } from "zod"
import { MemoryId } from "./ids"
import { MEMORY_POLICIES } from "./constants"
import { lazySchema } from "./lazy"

/** Settings a reviewed `propose-policy` draft may change; approval and requirement settings stay out of reach of the assistant. */
export const MemoryAssistantSettings = lazySchema(() => z.strictObject({
  memoryUse: z.boolean().optional(),
  memoryGenerate: z.boolean().optional(),
  memoryMaintenance: z.enum(["disabled", "preview", "auto-consolidate"]).optional(),
  dreamConsolidationPolicy: z.enum(["disabled", "preview", "auto-consolidate"]).optional(),
}))
export type MemoryAssistantSettings = z.infer<typeof MemoryAssistantSettings>

export const MemoryAssistantAction = lazySchema(() => z.strictObject({
  kind: z.enum(["propose-memory", "propose-policy", "explain-state", "dream-dry-run", "dream-service-start", "create-memory", "edit-memory", "delete-memory", "move-memory", "graph-upsert", "graph-link", "create-category", "edit-category", "delete-category"]),
  text: z.string().trim().min(1).max(2_000),
  scope: z.enum(["user", "global", "project"]).optional(),
  targetID: MemoryId.optional(),
  targetScope: z.enum(["user", "global", "project"]).optional(),
  categoryID: z.string().max(64).optional(),
  categoryIDs: z.array(z.string().max(64)).max(16).optional(),
  fromFactID: MemoryId.optional(),
  toFactID: MemoryId.optional(),
  linkKind: z.enum(["related", "conflicts", "supersedes", "supports"]).optional(),
  /** Control drafts: the category policy (propose-policy/edit-category), memory settings (propose-policy) and the daily Dream time `HH:MM` (dream-service-start). */
  policy: z.enum(MEMORY_POLICIES).optional(),
  settings: MemoryAssistantSettings.optional(),
  dreamAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
}).superRefine((action, ctx) => {
  if (["edit-memory", "delete-memory", "move-memory"].includes(action.kind) && !action.targetID) ctx.addIssue({ code: "custom", message: "targetID is required", path: ["targetID"] })
  if (action.kind === "graph-link" && (!action.fromFactID || !action.toFactID || action.fromFactID === action.toFactID)) ctx.addIssue({ code: "custom", message: "Two different fact ids are required", path: ["fromFactID"] })
}))
export type MemoryAssistantAction = z.infer<typeof MemoryAssistantAction>

export const MemoryDetails = lazySchema(() => z.strictObject({
  durability: z.number().min(0).max(1).optional(),
  changeRisk: z.number().min(0).max(1).optional(),
  tags: z.array(z.string().max(64)).max(32).optional(),
  categoryIDs: z.array(z.string().max(64)).max(16).optional(),
  evidence: z.string().max(2_000).optional(),
  confidence: z.number().min(0).max(1).optional(),
  sensitivity: z.enum(["low", "medium", "high"]).optional(),
  action: MemoryAssistantAction.optional(),
  originDirectory: z.string().max(4096).optional(),
  graphScope: z.enum(["workspace", "group-view"]).optional(),
}))
export type MemoryDetails = z.infer<typeof MemoryDetails>

export const MemoryModelInput = lazySchema(() => z.strictObject({
  action: z.enum(["status", "categories", "list", "search", "context", "add", "update", "delete", "propose", "overview", "upsert_fact", "link", "validate"]),
  scope: z.enum(["user", "global", "project", "workspace", "group-view"]).optional(),
  id: MemoryId.optional(),
  query: z.string().max(500).optional(),
  text: z.string().trim().min(1).max(2_000).optional(),
  category: z.string().max(64).optional(),
  tags: z.array(z.string().max(64)).max(32).optional(),
  categoryIDs: z.array(z.string().max(64)).max(16).optional(),
  evidence: z.string().max(2_000).optional(),
  confidence: z.number().min(0).max(1).optional(),
  sensitivity: z.enum(["low", "medium", "high"]).optional(),
  maxEntries: z.number().int().positive().max(100).optional(),
  maxFacts: z.number().int().positive().max(100).optional(),
  from: MemoryId.optional(),
  to: MemoryId.optional(),
  kind: z.enum(["related", "supports", "conflicts", "supersedes"]).optional(),
}))
export type MemoryModelInput = z.infer<typeof MemoryModelInput>

export const MemoryAssistantSelection = lazySchema(() => z.strictObject({
  view: z.enum(["project", "user", "all"]).optional(),
  root: z.string().min(1).max(4096).optional(),
  group: z.string().max(4096).optional(),
  category: z.string().max(64).optional(),
  memoryId: MemoryId.optional(),
  tab: z.string().max(32).optional(),
}))
export type MemoryAssistantSelection = z.infer<typeof MemoryAssistantSelection>

export const MemoryAssistantThread = lazySchema(() => z.strictObject({
  messages: z.array(z.strictObject({ role: z.enum(["user", "assistant"]), text: z.string().max(24_000) })).max(24),
  busy: z.boolean(),
  canceled: z.boolean().optional(),
  error: z.string().max(500).optional(),
  selection: MemoryAssistantSelection.optional(),
  proposals: z.array(MemoryId).max(200),
}))
export type MemoryAssistantThread = z.infer<typeof MemoryAssistantThread>

/** An assistant chat set aside from the live thread; restoring brings it back, `delete` forgets it. */
export const MemoryAssistantArchive = lazySchema(() => z.strictObject({
  archiveId: z.string().regex(/^[a-z0-9-]{1,40}$/),
  archivedAt: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative(),
  proposals: z.number().int().nonnegative(),
  title: z.string().max(120),
}))
export type MemoryAssistantArchive = z.infer<typeof MemoryAssistantArchive>
export const MEMORY_ASSISTANT_ARCHIVE_MAX = 20
