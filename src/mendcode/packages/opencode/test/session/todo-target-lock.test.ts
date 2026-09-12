import { afterEach, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { Database } from "@/storage/db"
import { SessionTable } from "@/session/session.sql"
import { SessionID } from "@/session/schema"
import { Todo, type TargetIdentity } from "@/session/todo"
import { InstanceState } from "@/effect/instance-state"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@mendcode/core/cross-spawn-spawner"

const it = testEffect(Layer.mergeAll(Todo.defaultLayer, CrossSpawnSpawner.defaultLayer))

afterEach(async () => {
  await disposeAllInstances()
})

it.live("locks operation identity and rejects stale or mismatched updates", () =>
  provideTmpdirInstance(
    () =>
      Effect.gen(function* () {
        const service = yield* Todo.Service
        const instance = yield* InstanceState.context
        const sessionID = SessionID.make("ses_target_lock")
        yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .insert(SessionTable)
              .values({
                id: sessionID,
                project_id: instance.project.id,
                slug: "target-lock",
                directory: instance.directory,
                title: "Target lock",
                version: "test",
              })
              .run(),
          ),
        )

        const target: TargetIdentity = {
          targetID: "12",
          artifact: `${instance.directory}/ocu-firmware-12.bin`,
          sha256: "a".repeat(64),
          port: "COM9",
          stage: "flash",
        }
        const locked = yield* service.setTargetLock({ sessionID, expectedRevision: 0, target })
        expect(locked.revision).toBe(1)

        const mismatch = yield* service
          .beginOperation({
            sessionID,
            expectedRevision: 1,
            target: { ...target, targetID: "11" },
            command: "write-flash ocu-firmware-11.bin COM9",
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(mismatch)).toBe(true)

        const running = yield* service.beginOperation({
          sessionID,
          expectedRevision: 1,
          target,
          command: "write-flash ocu-firmware-12.bin COM9",
        })
        expect(running.revision).toBe(2)

        const stale = yield* service.setTargetLock({ sessionID, expectedRevision: 1, target }).pipe(Effect.exit)
        expect(Exit.isFailure(stale)).toBe(true)

        const completed = yield* service.completeOperation({
          sessionID,
          token: running.token,
          revision: running.revision,
          result: "succeeded",
          output: "verified flash output",
          exitCode: 0,
        })
        expect(completed.revision).toBe(3)
        expect(completed.evidence.at(-1)).toMatchObject({
          targetID: "12",
          artifact: target.artifact,
          port: "COM9",
          stage: "flash",
          result: "succeeded",
          output: "verified flash output",
        })

        const replay = yield* service
          .completeOperation({
            sessionID,
            token: running.token,
            revision: running.revision,
            result: "failed",
            output: "stale",
            exitCode: 1,
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(replay)).toBe(true)
        expect((yield* service.getTargetLock(sessionID))?.evidence.at(-1)?.targetID).toBe("12")
      }),
    { git: true },
  ),
)
