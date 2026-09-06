import { describe, expect, test } from "bun:test"
import {
  actionFingerprint,
  createSmartGrant,
  emptySmartStore,
  matchingSmartGrant,
  normalizeSmartStore,
  revokeSmartGrant,
} from "../../src/mend/permission/smart-service"

const authority = {
  version: 1 as const,
  objectiveEpoch: "session:objective",
  contextRevision: 2,
  sourceUserIDs: ["user"],
  userText: "Inspect the workspace",
  explicitConstraints: [],
  complete: true,
  unknownReasons: [],
  fingerprint: "authority",
}

describe("Smart Approval service records", () => {
  test("normalizes malformed and bounded persisted state", () => {
    const store = normalizeSmartStore({
      version: 99,
      grants: Array.from({ length: 120 }, (_, index) => ({
        id: `grant-${index}`,
        permission: "bash",
        actionFingerprint: `fingerprint-${index}`,
        sessionID: "session",
        objectiveEpoch: "objective",
        contextRevision: 0,
        createdAt: index,
        expiresAt: index + 100,
      })),
      reviews: Array.from({ length: 520 }, (_, index) => ({
        id: `review-${index}`,
        requestID: `request-${index}`,
        sessionID: "session",
        actionFingerprint: `fingerprint-${index}`,
        status: "allowed",
        source: "deterministic",
        reasonCode: "allowed",
        summary: "bounded",
        createdAt: index,
        updatedAt: index,
      })),
    })

    expect(store.version).toBe(1)
    expect(store.grants).toHaveLength(100)
    expect(store.reviews).toHaveLength(500)
  })

  test("matches only the exact action, objective, context, and live grant", () => {
    const action = actionFingerprint({ permission: "bash", patterns: ["ls"], actionFacts: undefined })
    const grant = createSmartGrant({
      permission: "bash",
      actionFingerprint: action,
      sessionID: "session",
      authority,
      now: 1_000,
      ttlMs: 10_000,
    })
    const store = { ...emptySmartStore(), grants: [grant] }

    expect(
      matchingSmartGrant(
        store,
        { permission: "bash", actionFingerprint: action, sessionID: "session", authority },
        2_000,
      ),
    ).toEqual(grant)
    expect(
      matchingSmartGrant(
        store,
        {
          permission: "bash",
          actionFingerprint: action,
          sessionID: "session",
          authority: { ...authority, contextRevision: 3 },
        },
        2_000,
      ),
    ).toBeUndefined()
    expect(revokeSmartGrant(store, grant.id, 3_000)).toBe(true)
    expect(
      matchingSmartGrant(
        store,
        { permission: "bash", actionFingerprint: action, sessionID: "session", authority },
        4_000,
      ),
    ).toBeUndefined()
  })
})
