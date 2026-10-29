import { z } from "zod"
import { ClientId, CommandId, MemoryId } from "./ids"
import { MemoryEntry, MemoryGraphReport } from "./queries"
import { lazySchema } from "./lazy"

const base = { id: CommandId, clientId: ClientId }
const directory = z.string().min(1).max(4096).optional()
export const SharingScope = z.enum(["project", "user"])
export type SharingScope = z.infer<typeof SharingScope>
export const MemoryWorkspaceList = lazySchema(() => z.strictObject({ ...base, type: z.literal("memory.workspaces"), directory }))
export const MemoryBrowse = lazySchema(() => z.strictObject({ ...base, type: z.literal("memory.browse"), directory, view: z.enum(["project", "user", "all"]), root: directory }))
export const MemorySharingStatus = lazySchema(() => z.strictObject({ ...base, type: z.literal("memory.sharing.status"), directory, scope: SharingScope }))
export const MemorySharingConfigure = lazySchema(() => z.strictObject({ ...base, type: z.literal("memory.sharing.configure"), directory, scope: SharingScope, enabled: z.boolean(), confirmation: z.string().max(32).optional() }))
export const MemorySharingExport = lazySchema(() => z.strictObject({ ...base, type: z.literal("memory.sharing.export"), directory, scope: SharingScope }))
export const MemorySharingImport = lazySchema(() => z.strictObject({ ...base, type: z.literal("memory.sharing.import"), directory, scope: SharingScope }))

export const MemoryWorkspace = lazySchema(() => z.strictObject({
  root: z.string(), label: z.string(), group: z.string(), profile: z.string(),
  source: z.enum(["current-session", "historical-session", "imported-root"]),
  pending: z.number().int().nonnegative(), saved: z.number().int().nonnegative(), archived: z.number().int().nonnegative(),
  user: z.number().int().nonnegative(), agent: z.number().int().nonnegative(), sessions: z.number().int().nonnegative(),
  firstActiveAt: z.number().int().nonnegative(), lastActiveAt: z.number().int().nonnegative(),
}))
export type MemoryWorkspace = z.infer<typeof MemoryWorkspace>
export const MemoryWorkspacesReport = lazySchema(() => z.strictObject({ workspaces: z.array(MemoryWorkspace).max(200), omitted: z.number().int().nonnegative() }))
export type MemoryWorkspacesReport = z.infer<typeof MemoryWorkspacesReport>
export const MemoryBrowseReport = lazySchema(() => z.strictObject({ memories: z.array(MemoryEntry).max(200), graph: MemoryGraphReport, omitted: z.number().int().nonnegative() }))
export type MemoryBrowseReport = z.infer<typeof MemoryBrowseReport>
export const SharingStatusReport = lazySchema(() => z.strictObject({ scope: SharingScope, enabled: z.boolean(), directory: z.string(), format: z.literal("mendcode-v2"), entries: z.number().int().nonnegative() }))
export type SharingStatusReport = z.infer<typeof SharingStatusReport>
export const SharingIssue = lazySchema(() => z.strictObject({ id: z.string(), reason: z.string() }))
export const SharingResult = lazySchema(() => z.strictObject({
  ...SharingStatusReport.shape,
  action: z.enum(["export", "import"]), exported: z.array(z.string()).max(200), proposals: z.array(MemoryId).max(200),
  conflicts: z.array(SharingIssue).max(201), skipped: z.array(SharingIssue).max(200),
}))
export type SharingResult = z.infer<typeof SharingResult>
