import { z } from "zod"
import { SessionId, TurnId } from "./ids"
import { lazySchema } from "./lazy"

export const PermissionAction = z.enum(["ask", "allow", "deny"])
export const PermissionConfig = lazySchema(() => z.union([
  PermissionAction,
  z.record(z.string().min(1).max(200), z.union([PermissionAction, z.record(z.string().min(1).max(4096), PermissionAction)])),
]))
export type PermissionConfig = z.infer<typeof PermissionConfig>
export const PermissionRule = lazySchema(() => z.strictObject({ permission: z.string().min(1).max(200), pattern: z.string().min(1).max(4096), action: PermissionAction }))
export type PermissionRule = z.infer<typeof PermissionRule>

const Digest = z.string().regex(/^[a-f0-9]{64}$/)
export const AuthorityEvidence = lazySchema(() => z.strictObject({
  sourceUserIds: z.array(z.string().min(1).max(200)).max(12),
  objectiveEpoch: z.string().min(1).max(200),
  contextRevision: z.number().int().nonnegative(),
  fingerprint: Digest,
  complete: z.boolean(),
  unknownReasons: z.array(z.string().max(200)).max(16),
}))
export type AuthorityEvidence = z.infer<typeof AuthorityEvidence>

export const ActionIdentity = lazySchema(() => z.strictObject({
  fingerprint: Digest,
  cwd: z.string().max(4096),
  environmentDigest: Digest.optional(),
  executableIdentities: z.array(z.string().max(4096)).max(64),
  complete: z.boolean(),
  unknownReasons: z.array(z.string().max(200)).max(16),
}))
export type ActionIdentity = z.infer<typeof ActionIdentity>
export const PermissionProvenance = lazySchema(() => z.strictObject({ turnId: TurnId, authority: AuthorityEvidence, action: ActionIdentity }))
export type PermissionProvenance = z.infer<typeof PermissionProvenance>

export const PermissionReview = lazySchema(() => z.strictObject({
  reviewId: z.string().min(1).max(200),
  sessionId: SessionId,
  tool: z.string().min(1).max(200),
  status: z.enum(["reviewing", "waiting_manual", "allowed", "denied", "cancelled"]),
  source: z.enum(["deterministic", "grant", "model", "manual"]),
  reason: z.string().max(300),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  provenance: PermissionProvenance,
}))
export type PermissionReview = z.infer<typeof PermissionReview>
