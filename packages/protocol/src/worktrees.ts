import { z } from "zod"
import { lazySchema } from "./lazy"

const text = z.string().min(1).max(4096).refine((value) => !/[\x00-\x1f\x7f]/.test(value), "control characters are not allowed")
export const WorktreeCreateInput = lazySchema(() => z.strictObject({
  name: text.max(100),
  branch: text.max(200).optional(),
  base: text.max(200).optional(),
  path: text.optional(),
  focus: text.max(100).optional(),
}))
export type WorktreeCreateInput = z.infer<typeof WorktreeCreateInput>
export const WorktreeRead = lazySchema(() => z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.enum(["status", "doctor"]) }),
  z.strictObject({ operation: z.enum(["open", "remove", "reset"]), target: text }),
  z.strictObject({ operation: z.literal("preview"), input: WorktreeCreateInput }),
]))
export type WorktreeRead = z.infer<typeof WorktreeRead>
export const WorktreeChange = lazySchema(() => z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.enum(["plan", "create"]), input: WorktreeCreateInput }),
  z.strictObject({ operation: z.literal("adopt"), target: text }),
]))
export type WorktreeChange = z.infer<typeof WorktreeChange>
export const WorktreeRecord = lazySchema(() => z.strictObject({
  id: text,
  path: text,
  branch: text.nullable(),
  head: text.nullable(),
  ownership: z.enum(["owned", "adopted", "external", "stale", "drifted"]),
  dirty: z.strictObject({ clean: z.boolean(), summary: z.string().max(500), checkedAt: z.number().int().nonnegative() }),
  drift: z.array(z.string().max(500)).max(10),
  creator: z.enum(["mendcode", "user-adopted", "git"]),
  executor: z.literal("native"),
  baseRef: text.nullable(),
  cleanupPolicy: z.enum(["remove-when-clean", "manual-only"]),
  sessions: z.array(z.string()).max(100),
  createdAt: z.number().int().nonnegative(),
}))
export type WorktreeRecord = z.infer<typeof WorktreeRecord>
export const WorktreePreview = lazySchema(() => z.strictObject({
  action: z.enum(["create", "open", "remove", "reset"]),
  target: WorktreeRecord,
  commands: z.array(z.strictObject({ tool: z.literal("git"), argv: z.array(text).max(20), cwd: text, destructive: z.boolean() })).max(5),
  stateWrites: z.array(text).max(5),
  blocked: z.boolean(),
  blockReasons: z.array(z.string().max(500)).max(10),
  forceConfirmation: text.nullable(),
  executesGit: z.literal(false),
  executesTsm: z.literal(false),
}))
export type WorktreePreview = z.infer<typeof WorktreePreview>
export const WorktreePlan = lazySchema(() => z.strictObject({ id: text, focus: text, createdAt: z.number().int().nonnegative(), preview: WorktreePreview }))
export type WorktreePlan = z.infer<typeof WorktreePlan>
export const WorktreeReport = lazySchema(() => z.strictObject({
  operation: z.string(),
  ok: z.boolean(),
  workspace: z.strictObject({ currentPath: text, currentBranch: text.nullable(), repoRoot: text.nullable(), isLinkedWorktree: z.boolean() }),
  registryPath: text,
  records: z.array(WorktreeRecord).max(500),
  plans: z.array(WorktreePlan).max(100),
  preview: WorktreePreview.optional(),
  failures: z.array(z.string().max(1000)).max(20),
  warnings: z.array(z.string().max(1000)).max(20),
  truncated: z.boolean(),
  mode: z.literal("preview"),
  executesGit: z.literal(false),
  executesTsm: z.literal(false),
}))
export type WorktreeReport = z.infer<typeof WorktreeReport>
