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
