import { z } from "zod"
import { WorktreeCreateInput, WorktreeReport } from "./worktrees"
import { lazySchema } from "./lazy"

const text = z.string().min(1).max(4096).refine((value) => !/[\x00-\x1f\x7f]/.test(value), "control characters are not allowed")
export const TsmMux = z.enum(["cmux", "kitty", "ghostty", "wezterm", "auto"])
export const TsmRead = lazySchema(() => z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.enum(["status", "doctor"]) }),
  z.strictObject({ operation: z.literal("open"), target: text }),
  z.strictObject({ operation: z.literal("create"), input: WorktreeCreateInput }),
]))
export type TsmRead = z.infer<typeof TsmRead>
export const TsmChange = lazySchema(() => z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.enum(["plan", "install", "setup", "deactivate", "remove"]) }),
  z.strictObject({ operation: z.literal("activate"), muxBackend: TsmMux.optional() }),
]))
export type TsmChange = z.infer<typeof TsmChange>
export const TsmPolicy = lazySchema(() => z.strictObject({ mode: text.max(100), liveSync: z.boolean(), neverSync: z.array(text).max(100) }))
export const TsmPlan = lazySchema(() => z.strictObject({
  version: z.literal(1), status: z.literal("dry-run"), generatedAt: z.string(), path: text,
  repository: text, supportedRange: text, recommendedVersion: text,
  install: z.strictObject({ executesInstall: z.literal(false), commands: z.array(text).max(10) }),
  activation: z.strictObject({ command: text, requiresDetectedBinary: z.literal(true), delegatesWorktreesImmediately: z.literal(false) }),
  removal: z.strictObject({ command: text, removesExternalTsm: z.literal(false), killsSessions: z.literal(false) }),
}))
export type TsmPlan = z.infer<typeof TsmPlan>
export const TsmPreview = lazySchema(() => z.strictObject({
  action: z.enum(["open", "create"]), target: text, branch: text.nullable(),
  commands: z.array(z.strictObject({ tool: z.literal("tsm"), argv: z.array(text).max(20), cwd: text, destructive: z.literal(false) })).max(5),
  blocked: z.boolean(), blockReasons: z.array(z.string().max(1000)).max(20),
  executesTsm: z.literal(false),
}))
export type TsmPreview = z.infer<typeof TsmPreview>
export const TsmReport = lazySchema(() => z.strictObject({
  operation: z.string(), ok: z.boolean(),
  lifecycle: z.enum(["not-installed", "installed-inactive", "active", "degraded"]), enabled: z.boolean(),
  workspace: WorktreeReport.shape.workspace,
  repository: text, supportedRange: text, recommendedVersion: text,
  binaryPath: text.nullable(), detectedVersion: z.string().max(100).nullable(), worktreeCapable: z.boolean(),
  capabilities: z.array(text).max(10), defaultMuxBackend: TsmMux,
  managedFiles: z.strictObject({ state: text, plan: text, policy: text }),
  policy: TsmPolicy, rootGit: z.boolean(), gitHead: z.boolean(),
  safety: z.strictObject({ installsTsm: z.literal(false), startsSessions: z.literal(false), killsSessions: z.literal(false), removesWorktrees: z.literal(false), explicitActivationRequired: z.literal(true), statusExecutesVersionProbe: z.boolean() }),
  warnings: z.array(z.string().max(1000)).max(20), failures: z.array(z.string().max(1000)).max(20),
  plan: TsmPlan.optional(), preview: TsmPreview.optional(), archivedTo: text.optional(),
}))
export type TsmReport = z.infer<typeof TsmReport>
