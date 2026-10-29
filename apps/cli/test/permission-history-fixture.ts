import { createIdFactory } from "@mendcode/protocol/wire"
import type { PermissionsHistoryReport, SessionId } from "@mendcode/protocol"

export function permissionHistoryFixture(sessionId: SessionId, now: number): PermissionsHistoryReport {
  const ids = createIdFactory({ now: () => now, random: (n) => new Uint8Array(n) })
  const provenance = { turnId: ids("turn"), authority: { sourceUserIds: ["user:local-check"], objectiveEpoch: "user:local-check", contextRevision: 0, fingerprint: "a".repeat(64), complete: true, unknownReasons: [] }, action: { fingerprint: "b".repeat(64), cwd: "/work/project", environmentDigest: "c".repeat(64), executableIdentities: ["/bin/sh:1:2:1024:0:0", "/usr/bin/node:1:3:2048:0:0", "/work/project/check.js:1:4:128:0:0"], complete: true, unknownReasons: [] } }
  const grant = { grantId: "shell", recordId: "local-grant", tool: "shell", permission: "execute" as const, grantedAt: now - 60_000, provenance }
  return {
    grants: [{ grant, active: true }, { grant: { ...grant, recordId: "revoked-grant", grantedAt: now - 300_000 }, revokedAt: now - 120_000, active: false }, { grant: { ...grant, recordId: "inactive-grant", grantedAt: now - 600_000 }, active: false }],
    reviews: [
      { reviewId: "local-review", sessionId, tool: "shell", status: "allowed", source: "grant", reason: "Exact causal action grant", createdAt: now - 30_000, updatedAt: now - 30_000, provenance },
      { reviewId: "manual-review", sessionId, tool: "shell", status: "allowed", source: "manual", reason: "User approved", createdAt: now - 60_000, updatedAt: now - 60_000, provenance },
      { reviewId: "denied-review", sessionId, tool: "shell", status: "denied", source: "deterministic", reason: "Execution identity changed after approval", createdAt: now - 180_000, updatedAt: now - 180_000, provenance },
    ],
  }
}
