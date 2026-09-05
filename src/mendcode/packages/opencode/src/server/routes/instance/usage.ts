import { Hono } from "hono"
import { validator } from "hono-openapi"
import { Effect } from "effect"
import z from "zod"
import { InstanceState } from "@/effect/instance-state"
import { jsonRequest } from "./trace"

export function UsageRoutes() {
  return new Hono().get(
    "/",
    validator(
      "query",
      z.object({
        days: z.coerce.number().finite().nonnegative().optional(),
        project: z.string().optional(),
      }),
    ),
    (c) =>
      jsonRequest("UsageRoutes.get", c, function* () {
        const { aggregateSessionStats } = yield* Effect.promise(() => import("@/cli/cmd/stats"))
        const context = yield* InstanceState.context
        const query = c.req.valid("query")
        return yield* aggregateSessionStats(query.days, query.project, context.project)
      }),
  )
}
