import { z } from "zod"
import { MemoryId } from "./ids"
import { lazySchema } from "./lazy"

export const MemoryConfigPatch = lazySchema(() => z.strictObject({
  memoryEnabled: z.boolean().optional(),
  memoryUse: z.boolean().optional(),
  memoryGenerate: z.boolean().optional(),
  memoryMaxPromptTokens: z.number().int().min(1).max(32_000).optional(),
  memoryMaxEntries: z.number().int().min(1).max(10_000).optional(),
  memoryProjectMaxEntries: z.number().int().min(1).max(10_000).optional(),
  memoryGlobalCompactionMaxEntries: z.number().int().min(1).max(10_000).optional(),
  dreamConsolidationPolicy: z.enum(["disabled", "preview", "auto-consolidate"]).optional(),
}))
export type MemoryConfigPatch = z.infer<typeof MemoryConfigPatch>

export const MemoryControlInput = lazySchema(() => z.strictObject({
  operation: z.enum(["status", "preview", "edit", "delete", "propose", "apply", "reject", "import-codex", "import-v1", "index", "config"]),
  scope: z.enum(["user", "project"]).optional(),
  memoryId: MemoryId.optional(),
  text: z.string().trim().min(1).max(2_000).optional(),
  query: z.string().max(500).optional(),
  mode: z.enum(["request", "after-compaction", "manual"]).optional(),
  provider: z.string().max(100).optional(),
  model: z.string().max(100).optional(),
  category: z.string().max(64).optional(),
  tags: z.array(z.string().max(64)).max(16).optional(),
  from: z.string().min(1).max(4096).optional(),
  fromFile: z.string().min(1).max(4096).optional(),
  apply: z.boolean().optional(),
  maxProposals: z.number().int().min(1).max(50).optional(),
  project: z.boolean().optional(),
  patch: MemoryConfigPatch.optional(),
}).superRefine((value, ctx) => {
  if (["edit", "delete", "apply", "reject"].includes(value.operation) && !value.memoryId) ctx.addIssue({ code: "custom", message: "memoryId is required" })
  if (value.operation === "edit" && !value.text || value.operation === "propose" && !value.text && !value.fromFile) ctx.addIssue({ code: "custom", message: "text or fromFile is required" })
  if (value.text && value.fromFile) ctx.addIssue({ code: "custom", message: "text and fromFile are exclusive" })
  if (value.operation === "import-v1" && !value.from) ctx.addIssue({ code: "custom", message: "from (the v1 sharing folder) is required" })
}))
export type MemoryControlInput = z.infer<typeof MemoryControlInput>

export const DreamControlInput = lazySchema(() => z.strictObject({
  operation: z.enum(["status", "tick", "run", "consolidate"]),
  policy: z.enum(["disabled", "preview", "auto-consolidate"]).optional(),
  /** Skips the configured `memoryConsolidator` model: only the host's deterministic checks decide. */
  deterministic: z.boolean().optional(),
}))
export type DreamControlInput = z.infer<typeof DreamControlInput>
