import { permissionMatch } from "./permission-rules"
import { createHash, randomUUID } from "node:crypto"
import type { PermissionGrant, PermissionGrantHistory, PermissionProvenance, PermissionReview, SessionId } from "@mendcode/protocol"

export type PermissionAudit = {
  grant(sessionId: SessionId, grant: PermissionGrant): void
  revoke(sessionId: SessionId, recordId: string, at: number): void
  grants(sessionId: SessionId, limit?: number): PermissionGrantHistory[]
  review(record: PermissionReview): void
  reviews(sessionId: SessionId, limit?: number): PermissionReview[]
}

/**
 * Session approvals: mode grants use the tool name as id, granular grants use the rule permission and pattern.
 * The daemon lists/revokes them and the engine checks them before asking.
 */
export type GrantStore = {
  list(sessionId: SessionId): PermissionGrant[]
  has(sessionId: SessionId, tool: string, pattern?: string, rulePermission?: string): boolean
  add(sessionId: SessionId, tool: string, permission: PermissionGrant["permission"], pattern?: string, rulePermission?: string, provenance?: PermissionProvenance): void
  hasExact(sessionId: SessionId, tool: string, provenance: PermissionProvenance): boolean
  review(record: PermissionReview): void
  history(sessionId: SessionId, limit?: number): { grants: PermissionGrantHistory[]; reviews: PermissionReview[] }
  /** Removes one grant (by id) or all of a session's; returns how many were removed. */
  revoke(sessionId: SessionId, grantId: string | "all"): number
  /** The call the permission reviewer last refused in the session; kept so the user can approve one retry (`/approve`). */
  noteDenial(sessionId: SessionId, denial: Omit<ReviewerDenial, "at">): void
  lastDenial(sessionId: SessionId): ReviewerDenial | undefined
  /** Lets the last denied call run once without the reviewer or a prompt; undefined when nothing recent was denied. */
  approveRetry(sessionId: SessionId): ReviewerDenial | undefined
  /** True once for the approved retry: the same action (by fingerprint) while the approval is still fresh. */
  takeRetry(sessionId: SessionId, fingerprint: string): boolean
}

/** A call the reviewer refused: `summary` is its first line of detail, already masked and clipped. */
export type ReviewerDenial = { fingerprint: string; tool: string; summary: string; reason: string; at: number }

/** How long a denial can be approved, and how long an approval for a retry lasts. */
export const RETRY_WINDOW_MS = 10 * 60_000
const MAX_DENIAL_SESSIONS = 200

export function createGrantStore(now: () => number = Date.now, audit?: PermissionAudit): GrantStore {
  const key = (tool: string, pattern?: string, permission?: string) => pattern === undefined ? tool : `${permission ?? tool}:${createHash("sha256").update(pattern).digest("hex").slice(0, 24)}`
  const grants = new Map<SessionId, Map<string, PermissionGrant>>()
  const denials = new Map<SessionId, ReviewerDenial>()
  const retries = new Map<SessionId, { fingerprint: string; at: number }>()
  const fresh = (at: number) => now() - at <= RETRY_WINDOW_MS
  return {
    noteDenial(sessionId, denial) {
      denials.set(sessionId, { ...denial, at: now() })
      if (denials.size > MAX_DENIAL_SESSIONS) denials.delete(denials.keys().next().value!)
    },
    lastDenial: (sessionId) => {
      const denial = denials.get(sessionId)
      return denial && fresh(denial.at) ? denial : undefined
    },
    approveRetry(sessionId) {
      const denial = denials.get(sessionId)
      if (!denial || !fresh(denial.at)) return undefined
      retries.set(sessionId, { fingerprint: denial.fingerprint, at: now() })
      if (retries.size > MAX_DENIAL_SESSIONS) retries.delete(retries.keys().next().value!)
      return denial
    },
    takeRetry(sessionId, fingerprint) {
      const retry = retries.get(sessionId)
      if (!retry || retry.fingerprint !== fingerprint) return false
      retries.delete(sessionId)
      denials.delete(sessionId)
      return fresh(retry.at)
    },
    list: (sessionId) => [...(grants.get(sessionId)?.values() ?? [])],
    has(sessionId, tool, pattern, permission) {
      const session = grants.get(sessionId)
      if (pattern === undefined) return session?.has(tool) ?? false
      return [...(session?.values() ?? [])].some((grant) => grant.pattern !== undefined && grant.rulePermission === (permission ?? tool) && permissionMatch(pattern, grant.pattern))
    },
    hasExact(sessionId, tool, provenance) {
      return [...(grants.get(sessionId)?.values() ?? [])].some((grant) => grant.tool === tool && grant.pattern === undefined && grant.provenance?.authority.fingerprint === provenance.authority.fingerprint && grant.provenance?.action.fingerprint === provenance.action.fingerprint)
    },
    review: (record) => audit?.review(record),
    history(sessionId, limit = 100) {
      const active = new Set([...grants.get(sessionId)?.values() ?? []].map((grant) => grant.recordId))
      return { grants: (audit?.grants(sessionId, limit) ?? []).map((entry) => ({ ...entry, active: entry.revokedAt === undefined && active.has(entry.grant.recordId) })), reviews: audit?.reviews(sessionId, limit) ?? [] }
    },
    add(sessionId, tool, permission, pattern, rulePermission, provenance) {
      const session = grants.get(sessionId) ?? new Map<string, PermissionGrant>()
      const grantId = key(tool, pattern, rulePermission)
      if (!session.has(grantId) || provenance && (session.get(grantId)?.provenance?.action.fingerprint !== provenance.action.fingerprint || session.get(grantId)?.provenance?.authority.fingerprint !== provenance.authority.fingerprint)) {
        const grant: PermissionGrant = { grantId, tool, permission, grantedAt: now(), ...(pattern !== undefined ? { pattern, rulePermission } : {}), ...(provenance ? { provenance } : {}), ...(audit ? { recordId: randomUUID() } : {}) }
        audit?.grant(sessionId, grant)
        session.set(grantId, grant)
      }
      grants.set(sessionId, session)
    },
    revoke(sessionId, grantId) {
      const session = grants.get(sessionId)
      if (!session) return 0
      if (grantId === "all") {
        const count = session.size
        for (const grant of session.values()) if (grant.recordId) audit?.revoke(sessionId, grant.recordId, now())
        grants.delete(sessionId)
        return count
      }
      const grant = session.get(grantId)
      if (grant?.recordId) audit?.revoke(sessionId, grant.recordId, now())
      const removed = session.delete(grantId) ? 1 : 0
      if (session.size === 0) grants.delete(sessionId)
      return removed
    },
  }
}
