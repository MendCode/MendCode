import { Effect, Layer, Context, Schema } from "effect"
import { Bus } from "../bus"
import { Snapshot } from "../snapshot"
import { Storage } from "@/storage/storage"
import { SyncEvent } from "../sync"
import * as Log from "@mendcode/core/util/log"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID, PartID } from "./schema"
import { SessionRunState } from "./run-state"
import { SessionSummary } from "./summary"

const log = Log.create({ service: "session.revert" })

export const RevertInput = Schema.Struct({
  sessionID: SessionID,
  messageID: MessageID,
  partID: Schema.optional(PartID),
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type RevertInput = Schema.Schema.Type<typeof RevertInput>

export interface Interface {
  readonly revert: (input: RevertInput) => Effect.Effect<Session.Info>
  readonly unrevert: (input: { sessionID: SessionID }) => Effect.Effect<Session.Info>
  readonly cleanup: (session: Session.Info) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRevert") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snap = yield* Snapshot.Service
    const storage = yield* Storage.Service
    const bus = yield* Bus.Service
    const summary = yield* SessionSummary.Service
    const state = yield* SessionRunState.Service
    const sync = yield* SyncEvent.Service

    const revert = Effect.fn("SessionRevert.revert")(function* (input: RevertInput) {
      yield* state.assertNotBusy(input.sessionID)
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      const scan = MessageV2.revertScan(input)
      if (!scan) return session

      const rev: NonNullable<Session.Info["revert"]> = {
        messageID: scan.messageID,
        partID: scan.partID,
      }
      rev.snapshot = session.revert?.snapshot ?? (yield* snap.track())
      if (session.revert?.snapshot) yield* snap.restore(session.revert.snapshot)
      yield* snap.revert(scan.patches)
      if (rev.snapshot) rev.diff = yield* snap.diff(rev.snapshot)
      const diffs = yield* summary.computeDiff({ messages: scan.range })
      yield* storage.write(["session_diff", input.sessionID], diffs).pipe(Effect.ignore)
      yield* bus.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: diffs })
      yield* sessions.setRevert({
        sessionID: input.sessionID,
        revert: rev,
        summary: {
          additions: diffs.reduce((sum, x) => sum + x.additions, 0),
          deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
          files: diffs.length,
        },
      })
      return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
    })

    const unrevert = Effect.fn("SessionRevert.unrevert")(function* (input: { sessionID: SessionID }) {
      log.info("unreverting", input)
      yield* state.assertNotBusy(input.sessionID)
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      if (!session.revert) return session
      if (session.revert.snapshot) yield* snap.restore(session.revert.snapshot)
      yield* sessions.clearRevert(input.sessionID)
      return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
    })

    const cleanup = Effect.fn("SessionRevert.cleanup")(function* (session: Session.Info) {
      if (!session.revert) return
      const sessionID = session.id
      const messageID = session.revert.messageID
      const cleanup = MessageV2.revertCleanup({
        sessionID,
        messageID,
        partID: session.revert.partID,
      })
      for (const removedMessageID of cleanup.messageIDs) {
        yield* sync.run(MessageV2.Event.Removed, {
          sessionID,
          messageID: removedMessageID,
          reason: "revert",
        })
      }
      for (const partID of cleanup.partIDs) {
        yield* sync.run(MessageV2.Event.PartRemoved, {
          sessionID,
          messageID,
          partID,
        })
      }
      yield* sessions.clearRevert(sessionID)
    })

    return Service.of({ revert, unrevert, cleanup })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(SessionRunState.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(Storage.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(SessionSummary.defaultLayer),
    Layer.provide(SyncEvent.defaultLayer),
  ),
)

export * as SessionRevert from "./revert"
