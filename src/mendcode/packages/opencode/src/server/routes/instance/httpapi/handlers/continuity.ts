import { Cause, Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { ToolRegistry } from "@/tool/registry"
import { InstanceState } from "@/effect/instance-state"
import { listRecords } from "@/session/runtime-mailbox"
import { getReasoningState } from "@/mend/prompt/reasoning-state"
import { InstanceHttpApi } from "../api"
import { notFound, badRequest } from "../errors"
import { resolveRuntimeModel } from "@/cli/model-selection"

export const continuityHandlers = HttpApiBuilder.group(InstanceHttpApi, "continuity", (handlers) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const registry = yield* ToolRegistry.Service
    const validate = (sessionID: SessionID) =>
      Effect.gen(function* () {
        const session = yield* sessions
          .get(sessionID)
          .pipe(Effect.catchCause(() => Effect.fail(notFound("Session not found"))))
        const context = yield* InstanceState.context
        if (session.directory !== context.directory)
          return yield* Effect.fail(notFound("Session belongs to a different workspace"))
        return session
      })
    return handlers
      .handle("resolveModel", ({ params, payload }) =>
        Effect.gen(function* () {
          const session = yield* validate(params.sessionID)
          const { model, variant, ...resolved } = yield* resolveRuntimeModel({ session, ...payload }).pipe(
            Effect.catchCause((cause) =>
              Effect.fail(badRequest({ message: String(Cause.squash(cause)).slice(0, 1024) })),
            ),
          )
          return { ...resolved, ...(model ? { model } : {}), ...(variant ? { variant } : {}) }
        }),
      )
      .handle("list", ({ params }) =>
        Effect.gen(function* () {
          yield* validate(params.sessionID)
          const currentReasoning = getReasoningState(params.sessionID)
          return {
            ...(currentReasoning ? { currentReasoning } : {}),
            records: ["job", "question"]
              .flatMap((kind) => listRecords(params.sessionID, kind as "job" | "question", { limit: 50 }))
              .sort((a, b) => b.timeCreated - a.timeCreated)
              .map((record) => ({
                ...record,
                data: {
                  ...(record.data.tool === undefined ? {} : { tool: record.data.tool }),
                  ...(record.data.error === undefined ? {} : { error: record.data.error }),
                  ...(record.data.request === undefined ? {} : { request: record.data.request }),
                },
              })),
          }
        }),
      )
      .handle("cancel", ({ params }) =>
        Effect.gen(function* () {
          yield* validate(params.sessionID)
          return yield* registry
            .cancelJob(params.sessionID, params.jobID)
            .pipe(
              Effect.catchCause((cause) =>
                Effect.fail(badRequest({ message: String(Cause.squash(cause)).slice(0, 1024) })),
              ),
            )
        }),
      )
      .handle("usage", ({ query }) =>
        Effect.gen(function* () {
          const days = query.days === undefined ? undefined : Number(query.days)
          if (days !== undefined && (!Number.isFinite(days) || days < 0))
            return yield* Effect.fail(badRequest({ message: "days must be a finite nonnegative number" }))
          const { aggregateSessionStats } = yield* Effect.promise(() => import("@/cli/cmd/stats"))
          const context = yield* InstanceState.context
          return yield* aggregateSessionStats(days, query.project, context.project)
        }),
      )
  }),
)
