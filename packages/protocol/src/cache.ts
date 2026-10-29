import { z } from "zod"
import { lazySchema } from "./lazy"

const id = z.string().min(1).max(200)
const directory = z.string().min(1).max(4096)
export const CacheScope = z.enum(["session", "project"])
const mode = z.enum(["off", "smart"])
const policy = lazySchema(() => z.strictObject({ mode: mode.optional(), scope: CacheScope.optional() }))
export const CacheConfig = lazySchema(() => z.strictObject({
  mode: mode.optional(),
  scope: CacheScope.optional(),
  projects: z.record(directory, policy).optional(),
  sessions: z.strictObject({ mode: z.enum(["all", "selected", "none"]).optional(), include: z.array(id).max(1000).optional(), exclude: z.array(id).max(1000).optional() }).optional(),
  providers: z.record(id, policy.extend({ models: z.array(id).max(1000).optional(), exclude_models: z.array(id).max(1000).optional() })).optional(),
}))
export type CacheConfig = z.infer<typeof CacheConfig>
export type CacheScope = z.infer<typeof CacheScope>

export const CacheTarget = lazySchema(() => z.strictObject({
  directory,
  global: z.boolean().optional(),
  provider: id.optional(),
  model: id.optional(),
  session: id.optional(),
  projectPath: directory.optional(),
  scope: CacheScope.optional(),
}))
export type CacheTarget = z.infer<typeof CacheTarget>
export const CacheMutation = lazySchema(() => CacheTarget.extend({ action: z.enum(["enable", "disable"]) }).refine((input) =>
  !(input.model && !input.provider || input.projectPath && (!input.global || input.provider || input.model || input.session) || input.session && (input.provider || input.model)),
{ message: "Invalid cache target combination" }))
export type CacheMutation = z.infer<typeof CacheMutation>
export type CacheSelection = { mode: "legacy" | "off" | "smart"; scope: CacheScope; source: "default" | "project" | "session" | "provider" | "model"; reason: string }
export type CacheStatus = CacheSelection & { project: string; configured: CacheConfig | null; local: CacheConfig | null; global: CacheConfig | null; activeKeeper: false }
