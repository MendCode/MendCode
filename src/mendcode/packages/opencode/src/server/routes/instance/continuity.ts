import { Hono } from "hono"
import { validator } from "hono-openapi"
import z from "zod"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { listRecords } from "@/session/runtime-mailbox"
import { jsonRequest } from "./trace"
import { ToolRegistry } from "@/tool/registry"
import { InstanceState } from "@/effect/instance-state"
import { getReasoningState } from "@/mend/prompt/reasoning-state"
import { resolveRuntimeModel } from "@/cli/model-selection"

/** Shared Hono endpoint also mounted alongside the experimental HttpApi bridge. */
export function ContinuityRoutes() {
  return new Hono()
    .post(
      "/:sessionID/model-resolution",
      validator("param", z.object({ sessionID: SessionID.zod })),
      validator(
        "json",
        z.object({
          explicitAgent: z.string().optional(),
          explicitModel: z.string().optional(),
          explicitVariant: z.string().optional(),
        }),
      ),
      (c) =>
        jsonRequest("ContinuityRoutes.resolveModel", c, function* () {
          const sessions = yield* Session.Service
          const session = yield* sessions.get(c.req.valid("param").sessionID)
          const context = yield* InstanceState.context
          if (session.directory !== context.directory) throw new Error("Session belongs to a different workspace")
          return yield* resolveRuntimeModel({ session, ...c.req.valid("json") })
        }),
    )
    .post(
      "/:sessionID/:jobID/cancel",
      validator("param", z.object({ sessionID: SessionID.zod, jobID: z.string() })),
      (c) =>
        jsonRequest("ContinuityRoutes.cancel", c, function* () {
          const sessions = yield* Session.Service
          const registry = yield* ToolRegistry.Service
          const params = c.req.valid("param")
          const session = yield* sessions.get(params.sessionID)
          const context = yield* InstanceState.context
          if (session.directory !== context.directory) throw new Error("Session belongs to a different workspace")
          return yield* registry.cancelJob(params.sessionID, params.jobID)
        }),
    )
    .get("/:sessionID", validator("param", z.object({ sessionID: SessionID.zod })), (c) =>
      jsonRequest("ContinuityRoutes.list", c, function* () {
        const sessions = yield* Session.Service
        const sessionID = c.req.valid("param").sessionID
        const session = yield* sessions.get(sessionID)
        const context = yield* InstanceState.context
        if (session.directory !== context.directory) throw new Error("Session belongs to a different workspace")
        return {
          currentReasoning: getReasoningState(sessionID),
          records: ["job", "question"]
            .flatMap((kind) => listRecords(sessionID, kind as "job" | "question", { limit: 50 }))
            .sort((a, b) => b.timeCreated - a.timeCreated)
            .slice(0, 100)
            .map((record) => ({
              ...record,
              data: { tool: record.data.tool, error: record.data.error, request: record.data.request },
            })),
        }
      }),
    )
}
