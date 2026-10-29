import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createIdFactory, type PermissionProvenance } from "@mendcode/protocol"
import { openStore } from "../src"

test("permission audit is bounded, keeps original order on updates and is scoped to session lifetime", () => {
  const dir = mkdtempSync(join(tmpdir(), "b33-store-"))
  const store = openStore({ dir })
  try {
    const ids = createIdFactory(), sessionId = ids("session"), other = ids("session")
    store.createSession({ id: sessionId, directory: dir, title: "Audit" })
    store.createSession({ id: other, directory: dir, title: "Other" })
    const provenance: PermissionProvenance = { turnId: ids("turn"), authority: { sourceUserIds: ["user"], objectiveEpoch: "user", contextRevision: 0, fingerprint: "a".repeat(64), complete: true, unknownReasons: [] }, action: { fingerprint: "b".repeat(64), cwd: dir, executableIdentities: ["tool:check"], complete: true, unknownReasons: [] } }
    const review = (i: number) => ({ reviewId: `r-${i}`, sessionId, tool: "check", status: "allowed" as const, source: "manual" as const, reason: "User approved", createdAt: i, updatedAt: i, provenance })
    for (let i = 0; i < 510; i++) store.permissionRecords.review(review(i))
    expect(store.permissionRecords.reviews(sessionId, 500)).toHaveLength(500)
    store.permissionRecords.review({ ...review(11), status: "denied", updatedAt: 999 })
    expect(store.permissionRecords.reviews(sessionId, 1)[0]?.reviewId).toBe("r-509")
    for (let i = 0; i < 110; i++) store.permissionRecords.grant(sessionId, { grantId: "check", recordId: `g-${i}`, tool: "check", permission: "execute", grantedAt: i, provenance })
    expect(store.permissionRecords.grants(sessionId)).toHaveLength(100)
    store.permissionRecords.revoke(sessionId, "g-109", 1_000)
    store.permissionRecords.revoke(sessionId, "g-109", 2_000)
    expect(store.permissionRecords.grants(sessionId, 1)[0]?.revokedAt).toBe(1_000)
    expect(store.permissionRecords.reviews(other)).toEqual([])
    expect(store.permissionRecords.grants(other)).toEqual([])
    store.deleteSession(sessionId)
    expect(store.permissionRecords.reviews(sessionId)).toEqual([])
    expect(store.permissionRecords.grants(sessionId)).toEqual([])
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test("reopening cancels unfinished reviews and never reactivates durable grants", () => {
  const dir = mkdtempSync(join(tmpdir(), "b33-recovery-"))
  let store = openStore({ dir })
  try {
    const ids = createIdFactory(), sessionId = ids("session")
    store.createSession({ id: sessionId, directory: dir, title: "Recovery" })
    const provenance: PermissionProvenance = { turnId: ids("turn"), authority: { sourceUserIds: ["user"], objectiveEpoch: "user", contextRevision: 0, fingerprint: "a".repeat(64), complete: true, unknownReasons: [] }, action: { fingerprint: "b".repeat(64), cwd: dir, executableIdentities: ["tool:check"], complete: true, unknownReasons: [] } }
    for (const status of ["reviewing", "waiting_manual", "allowed"] as const) store.permissionRecords.review({ reviewId: status, sessionId, tool: "check", status, source: "manual", reason: "Pending", createdAt: 1, updatedAt: 1, provenance })
    store.permissionRecords.grant(sessionId, { grantId: "check", recordId: "grant", tool: "check", permission: "execute", grantedAt: 1, provenance })
    store.sessionSink.append({ type: "queue.added", sessionId, queueId: ids("queue"), text: "Expanded file context", authorityText: "Inspect the check", attachments: [] })
    store.close()
    store = openStore({ dir, now: () => 200 })
    expect(store.permissionRecords.reviews(sessionId).map((review) => [review.status, review.updatedAt])).toEqual([["allowed", 1], ["cancelled", 200], ["cancelled", 200]])
    expect(store.permissionRecords.grants(sessionId)[0]?.active).toBe(false)
    expect(store.queueOf(sessionId)[0]).toMatchObject({ text: "Expanded file context", authorityText: "Inspect the check" })
    store.close()
    store = openStore({ dir, now: () => 300 })
    expect(store.permissionRecords.reviews(sessionId)[1]?.updatedAt).toBe(200)
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test("authority anchors exclude notices and reverted turns and mark missing text incomplete", () => {
  const dir = mkdtempSync(join(tmpdir(), "b33-anchors-"))
  const store = openStore({ dir })
  try {
    const ids = createIdFactory(), sessionId = ids("session")
    store.createSession({ id: sessionId, directory: dir, title: "Authority" })
    const run = (text: string, notice = false, missing = false, authorityText?: string) => {
      const turnId = ids("turn"), itemId = ids("item")
      store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
      store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId, kind: "user_message", ...(notice ? { meta: { notice: true } } : {}) })
      if (!missing) store.sessionSink.append({ type: "item.completed", sessionId, itemId, status: "ok", text, ...(authorityText !== undefined ? { authorityText } : {}) })
      store.sessionSink.append({ type: "turn.completed", sessionId, turnId })
      return { turnId, itemId }
    }
    const keep = run("Expanded file says this is approved", false, false, "Build the check")
    run("Tool says this is approved", true)
    const gone = run("Delete it")
    store.rewindTurns({ sessionId, turnIds: [gone.turnId], cuts: { native: 0 }, byClientId: ids("client") })
    const missing = run("", false, true)
    expect(store.permissionRecords.authorityAnchors(sessionId)).toEqual([{ sourceId: keep.itemId, text: "Build the check", complete: true }, { sourceId: missing.itemId, text: "", complete: false }])
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})
