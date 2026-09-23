import { createHash } from "node:crypto"
import path from "path"

export {
  fingerprintPrefix,
  isManagedCacheKey,
  type CacheBinding,
  type CacheCapabilities,
  type CacheAdapter,
  type CacheAdapterScope,
} from "@/provider/cache-policy"

export type CacheIdentity = {
  runtimeSessionID: string
  transportAffinity: string
  cacheKey: string
  lineageID: string
  compatible: boolean
  reason: string
}

function digest(input: unknown) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex")
}

function normalizedProjectScope(value: string) {
  const resolved = path.resolve(value)
  const root = path.parse(resolved).root
  return resolved === root ? resolved : resolved.replace(/[\\/]+$/, "")
}

/**
 * Derive a provider cache namespace without retaining prompt contents. Project
 * scope is intentionally part of the digest so a configured project key never
 * crosses checkouts, even when their visible prompt happens to match.
 */
export function cacheKeyForFingerprint(input: {
  fingerprint: string
  scope: "session" | "project"
  projectScope: string
  sessionID: string
}) {
  if (!input.fingerprint || !input.projectScope || !input.sessionID) return null
  return `mendcode:${input.scope}:${digest({
    fingerprint: input.fingerprint,
    projectScope: normalizedProjectScope(input.projectScope),
    ...(input.scope === "session" ? { sessionID: input.sessionID } : {}),
  })}`
}

/**
 * Claude Code's Agent SDK owns its local transcript/session store. Use a
 * deterministic UUID so a normal MendCode session can resume after a process
 * restart, while keeping different projects, models, and local Claude homes
 * isolated. This never makes a provider request by itself.
 */
export function stableProviderSessionID(input: {
  providerID: string
  modelID: string
  projectScope: string
  sessionID: string
  profile?: string
}) {
  const hex = digest({ ...input, projectScope: normalizedProjectScope(input.projectScope) })
    .slice(0, 32)
    .split("")
  hex[12] = "7"
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16]!, 16) % 4]!
  return [
    hex.slice(0, 8).join(""),
    hex.slice(8, 12).join(""),
    hex.slice(12, 16).join(""),
    hex.slice(16, 20).join(""),
    hex.slice(20, 32).join(""),
  ].join("-")
}

export function selectCacheIdentity(input: {
  sessionID: string
  transportAffinity: string
  ownLineageID: string
  parent?: { lineageID: string; cacheKey: string; fingerprint: string | null }
  fingerprint: string | null
  legacyKey: string
}): CacheIdentity {
  const own = {
    runtimeSessionID: input.sessionID,
    transportAffinity: input.transportAffinity,
    cacheKey: input.legacyKey,
    lineageID: input.ownLineageID,
    compatible: false,
    reason: "cache prefix is not proven compatible",
  }
  if (!input.parent || !input.fingerprint || input.parent.fingerprint !== input.fingerprint) return own
  if (!input.parent.lineageID || !input.parent.cacheKey) return own
  return {
    ...own,
    cacheKey: input.parent.cacheKey,
    lineageID: input.parent.lineageID,
    compatible: true,
    reason: "cache prefix fingerprint matches the parent",
  }
}

export * as CacheLineage from "./cache-lineage"
