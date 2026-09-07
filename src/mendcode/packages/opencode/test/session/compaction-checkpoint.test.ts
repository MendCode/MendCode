import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"

import { Session } from "../../src/session/session"
import { InstanceState } from "../../src/effect/instance-state"
import { SessionID } from "../../src/session/schema"
import * as Mailbox from "../../src/session/runtime-mailbox"
import * as Checkpoint from "../../src/session/compaction-checkpoint"
import { CrossSpawnSpawner } from "@mendcode/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, CrossSpawnSpawner.defaultLayer))

const binding = {
  providerID: "openai",
  apiOrigin: "https://api.openai.com",
  credentialFingerprint: "api:openai",
  modelID: "gpt-6-astra",
  protocol: "openai-responses-api-v1" as const,
}

function makeCheckpoint(
  sessionID: SessionID,
  generation: number,
  text: string,
  overrides: Partial<Checkpoint.NativeCheckpoint> = {},
): Checkpoint.NativeCheckpoint {
  const canonicalOutput = JSON.stringify([
    { type: "compaction", id: `cmp_${generation}`, encrypted_content: text },
  ])
  return {
    namespace: Checkpoint.NATIVE_COMPACTION_NAMESPACE,
    version: 1 as const,
    sessionID,
    generation,
    boundaryMessageID: `msg_${generation}`,
    boundaryPartIDs: [],
    binding,
    instructionsFingerprint: "instructions",
    toolsFingerprint: "tools",
    canonicalOutput,
    outputBytes: new TextEncoder().encode(canonicalOutput).byteLength,
    inputBytes: 100,
    requestID: `req_${generation}`,
    timing: {
      prepareMs: 1,
      providerMs: 2,
      installMs: null,
      resumeMs: null,
      totalMs: null,
      method: "native" as const,
    },
    createdAt: Date.now(),
    ...overrides,
  }
}

describe("native compaction checkpoints", () => {
  it.instance("rotates active state atomically and reloads the previous window", Effect.gen(function* () {
        const sessions = yield* Session.Service
        const context = yield* InstanceState.context
        const session = yield* sessions.create({ title: "checkpoint rotation" })
        const first = makeCheckpoint(session.id, 0, "first")
        const second = makeCheckpoint(session.id, 0, "second", { requestID: "req_2" })

        expect(
          Checkpoint.commitIfCurrent({
            checkpoint: first,
            directory: context.directory,
            expectedGeneration: 0,
            expectedBinding: binding,
          }),
        ).toBe(true)
        expect(Checkpoint.load(session.id, binding, 0)?.canonicalOutput).toBe(first.canonicalOutput)
        expect(Checkpoint.loadPrevious(session.id)).toBeUndefined()

        expect(
          Checkpoint.commitIfCurrent({
            checkpoint: second,
            directory: context.directory,
            expectedGeneration: 0,
            expectedBinding: binding,
          }),
        ).toBe(true)
        expect(Checkpoint.load(session.id, binding, 0)?.canonicalOutput).toBe(second.canonicalOutput)
        expect(Checkpoint.loadPrevious(session.id)?.canonicalOutput).toBe(first.canonicalOutput)
        expect(Mailbox.getRecord(session.id, `native_compaction_previous_${session.id}`)?.status).toBe("previous")
      }))

  it.instance("rejects stale generations and binding changes without replacing usable state", Effect.gen(function* () {
        const sessions = yield* Session.Service
        const context = yield* InstanceState.context
        const session = yield* sessions.create({ title: "checkpoint stale" })
        const first = makeCheckpoint(session.id, 0, "first")
        expect(
          Checkpoint.commitIfCurrent({
            checkpoint: first,
            directory: context.directory,
            expectedGeneration: 0,
            expectedBinding: binding,
          }),
        ).toBe(true)

        Mailbox.cancelGeneration(session.id, context.directory)
        expect(
          Checkpoint.commitIfCurrent({
            checkpoint: makeCheckpoint(session.id, 0, "late"),
            directory: context.directory,
            expectedGeneration: 0,
            expectedBinding: binding,
          }),
        ).toBe(false)
        expect(Checkpoint.loadActive(session.id)?.canonicalOutput).toBe(first.canonicalOutput)
        expect(Checkpoint.load(session.id, binding, 1)).toBeUndefined()
        expect(Checkpoint.load(session.id, { ...binding, credentialFingerprint: "other" }, 1)).toBeUndefined()
      }))

  it.instance("rejects corrupt checkpoint payloads and invalidates the active record", Effect.gen(function* () {
        const sessions = yield* Session.Service
        const context = yield* InstanceState.context
        const session = yield* sessions.create({ title: "checkpoint corruption" })
        const valid = makeCheckpoint(session.id, 0, "valid")
        expect(
          Checkpoint.commitIfCurrent({
            checkpoint: { ...valid, outputBytes: valid.outputBytes + 1 },
            directory: context.directory,
            expectedGeneration: 0,
            expectedBinding: binding,
          }),
        ).toBe(false)
        expect(
          Checkpoint.commitIfCurrent({
            checkpoint: valid,
            directory: context.directory,
            expectedGeneration: 0,
            expectedBinding: binding,
            timingStartedAt: performance.now(),
          }),
        ).toBe(true)
        expect(Checkpoint.invalidate(session.id, context.directory, "test mismatch")).toBe(true)
        expect(Checkpoint.load(session.id, binding, 0)).toBeUndefined()
        expect(Mailbox.getRecord(session.id, `native_compaction_active_${session.id}`)?.status).toBe("invalid")
        expect(Mailbox.getRecord(session.id, `native_compaction_active_${session.id}`)?.data.invalidReason).toBe("test mismatch")
      }))
})
