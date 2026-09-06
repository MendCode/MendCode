import { createHash } from "node:crypto"
import type { ActionFactsV1 } from "@/tool/shell-analysis"
import type { AuthorityContextV1 } from "./smart-context"

export type SmartReviewStatus = "reviewing" | "waiting_manual" | "allowed" | "denied" | "cancelled"
export type SmartReviewSource = "deterministic" | "grant" | "model" | "manual"

export type SmartGrant = {
  id: string
  permission: string
  actionFingerprint: string
  sessionID: string
  objectiveEpoch: string
  contextRevision: number
  createdAt: number
  expiresAt: number
  revokedAt?: number
}

export type SmartReviewRecord = {
  id: string
  requestID: string
  sessionID: string
  actionFingerprint: string
  status: SmartReviewStatus
  source: SmartReviewSource
  reasonCode: string
  summary: string
  createdAt: number
  updatedAt: number
}

export type SmartStore = {
  version: 1
  grants: SmartGrant[]
  reviews: SmartReviewRecord[]
}

export function emptySmartStore(): SmartStore {
  return { version: 1, grants: [], reviews: [] }
}

export function normalizeSmartStore(value: unknown): SmartStore {
  if (!value || typeof value !== "object") return emptySmartStore()
  const input = value as Partial<SmartStore>
  const grants = Array.isArray(input.grants) ? input.grants.filter(isGrant).slice(-100) : []
  const reviews = Array.isArray(input.reviews) ? input.reviews.filter(isReview).slice(-500) : []
  return { version: 1, grants, reviews }
}

function isGrant(value: unknown): value is SmartGrant {
  if (!value || typeof value !== "object") return false
  const item = value as Partial<SmartGrant>
  return (
    typeof item.id === "string" &&
    typeof item.permission === "string" &&
    typeof item.actionFingerprint === "string" &&
    typeof item.sessionID === "string" &&
    typeof item.objectiveEpoch === "string" &&
    Number.isSafeInteger(item.contextRevision) &&
    Number.isSafeInteger(item.createdAt) &&
    Number.isSafeInteger(item.expiresAt)
  )
}

function isReview(value: unknown): value is SmartReviewRecord {
  if (!value || typeof value !== "object") return false
  const item = value as Partial<SmartReviewRecord>
  return (
    typeof item.id === "string" &&
    typeof item.requestID === "string" &&
    typeof item.sessionID === "string" &&
    typeof item.actionFingerprint === "string" &&
    typeof item.status === "string" &&
    typeof item.source === "string" &&
    typeof item.reasonCode === "string" &&
    typeof item.summary === "string" &&
    Number.isSafeInteger(item.createdAt) &&
    Number.isSafeInteger(item.updatedAt)
  )
}

export function actionFingerprint(input: {
  permission: string
  patterns: readonly string[]
  actionFacts?: ActionFactsV1
}) {
  if (input.actionFacts?.fingerprint) return input.actionFacts.fingerprint
  return createHash("sha256")
    .update(JSON.stringify({ permission: input.permission, patterns: [...input.patterns].sort() }))
    .digest("hex")
}

export function authorityForRequest(metadata: Readonly<Record<string, unknown>>) {
  const value = metadata.authorityContext
  return value && typeof value === "object" ? (value as AuthorityContextV1) : undefined
}

export function factsForRequest(metadata: Readonly<Record<string, unknown>>) {
  const value = metadata.actionFacts
  return value && typeof value === "object" ? (value as ActionFactsV1) : undefined
}

export function matchingSmartGrant(
  store: SmartStore,
  input: { permission: string; actionFingerprint: string; sessionID: string; authority?: AuthorityContextV1 },
  now = Date.now(),
) {
  return store.grants.find(
    (grant) =>
      grant.permission === input.permission &&
      grant.actionFingerprint === input.actionFingerprint &&
      grant.sessionID === input.sessionID &&
      grant.revokedAt === undefined &&
      grant.expiresAt > now &&
      input.authority !== undefined &&
      grant.objectiveEpoch === input.authority.objectiveEpoch &&
      grant.contextRevision === input.authority.contextRevision,
  )
}

export function appendSmartReview(store: SmartStore, record: SmartReviewRecord) {
  store.reviews = [...store.reviews.filter((item) => item.id !== record.id), record].slice(-500)
}

export function createSmartGrant(input: {
  permission: string
  actionFingerprint: string
  sessionID: string
  authority: AuthorityContextV1
  now?: number
  ttlMs?: number
}) {
  const now = input.now ?? Date.now()
  return {
    id: `smart-grant:${createHash("sha256").update(`${input.sessionID}:${input.actionFingerprint}:${now}`).digest("hex").slice(0, 24)}`,
    permission: input.permission,
    actionFingerprint: input.actionFingerprint,
    sessionID: input.sessionID,
    objectiveEpoch: input.authority.objectiveEpoch,
    contextRevision: input.authority.contextRevision,
    createdAt: now,
    expiresAt: Math.min(now + (input.ttlMs ?? 30 * 60 * 1000), now + 30 * 60 * 1000),
  } satisfies SmartGrant
}

export function revokeSmartGrant(store: SmartStore, grantID: string, now = Date.now()) {
  const grant = store.grants.find((item) => item.id === grantID)
  if (!grant) return false
  if (!grant.revokedAt) grant.revokedAt = now
  return true
}

export function summarizeSmartReason(reason: string) {
  return reason.replace(/\s+/g, " ").trim().slice(0, 160) || "Manual approval is required."
}
