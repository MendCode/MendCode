import { InstanceState } from "@/effect/instance-state"
import { loopServiceArgsFromConfig, loopServiceStart } from "@/mend/runtime/loop-service"
import { LoopID, LoopWorkflow } from "@/session/loop"
import { SessionID } from "@/session/schema"
import { lazy } from "@/util/lazy"
import { Effect } from "effect"
import { Hono } from "hono"
import z from "zod"
import { jsonRequest } from "./trace"

const ReasonBody = z.object({
  reason: z.string().optional(),
  ensureService: z.boolean().optional(),
})

const DraftBody = z.object({
  name: z.string().min(1),
  objective: z.string().min(1),
  source: z.enum(["converted-session", "objective", "template", "manual"]).optional(),
  ownerSessionID: SessionID.zod.optional(),
  templateID: z.string().optional(),
  trigger: z
    .object({
      mode: z.enum(["manual", "interval", "adaptive", "external-signal", "self-paced"]).optional(),
      intervalMs: z.number().int().nonnegative().optional(),
    })
    .optional(),
  stopWhen: z.array(z.string()).optional(),
  gates: z.array(z.string()).optional(),
  policy: z
    .object({
      maxTurns: z.number().int().positive().optional(),
      maxRuntimeMs: z.number().int().nonnegative().optional(),
      maxChildren: z.number().int().nonnegative().optional(),
      maxDepth: z.number().int().nonnegative().optional(),
      requireApprovalFor: z.array(z.string()).optional(),
    })
    .optional(),
})

async function readJson<T>(c: { req: { json: () => Promise<unknown> } }, schema: z.ZodType<T>) {
  return schema.parse(await c.req.json().catch(() => ({})))
}

function loopID(value: string) {
  return LoopID.make(value)
}

function limit(value: string | undefined) {
  if (value === undefined) return
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined
}

export const LoopRoutes = lazy(() =>
  new Hono()
    .get("/", async (c) =>
      jsonRequest("LoopRoutes.list", c, function* () {
        const loop = yield* LoopWorkflow.Service
        return yield* loop.list()
      }),
    )
    .post("/draft", async (c) => {
      const body = await readJson(c, DraftBody)
      return jsonRequest("LoopRoutes.draft", c, function* () {
        const loop = yield* LoopWorkflow.Service
        return yield* loop.createDraft(body)
      })
    })
    .get("/:loopID", async (c) =>
      jsonRequest("LoopRoutes.get", c, function* () {
        const loop = yield* LoopWorkflow.Service
        return yield* loop.snapshot(loopID(c.req.param("loopID")), limit(c.req.query("limit")))
      }),
    )
    .get("/:loopID/events", async (c) =>
      jsonRequest("LoopRoutes.events", c, function* () {
        const loop = yield* LoopWorkflow.Service
        return yield* loop.events(loopID(c.req.param("loopID")), limit(c.req.query("limit")))
      }),
    )
    .post("/:loopID/activate", async (c) => {
      const body = await readJson(c, ReasonBody)
      return jsonRequest("LoopRoutes.activate", c, function* () {
        const loop = yield* LoopWorkflow.Service
        const active = yield* loop.activate({ id: loopID(c.req.param("loopID")), reason: body.reason })
        if (body.ensureService !== false) {
          const ctx = yield* InstanceState.context
          yield* Effect.promise(() => loopServiceStart(loopServiceArgsFromConfig(ctx.directory)).catch(() => undefined))
        }
        return active
      })
    })
    .post("/:loopID/pause", async (c) => {
      const body = await readJson(c, ReasonBody)
      return jsonRequest("LoopRoutes.pause", c, function* () {
        const loop = yield* LoopWorkflow.Service
        return yield* loop.pause({ id: loopID(c.req.param("loopID")), reason: body.reason })
      })
    })
    .post("/:loopID/resume", async (c) => {
      const body = await readJson(c, ReasonBody)
      return jsonRequest("LoopRoutes.resume", c, function* () {
        const loop = yield* LoopWorkflow.Service
        return yield* loop.resume({ id: loopID(c.req.param("loopID")), reason: body.reason })
      })
    })
    .post("/:loopID/run-once", async (c) => {
      const body = await readJson(c, ReasonBody)
      return jsonRequest("LoopRoutes.runOnce", c, function* () {
        const loop = yield* LoopWorkflow.Service
        return yield* loop.runOnce({ id: loopID(c.req.param("loopID")), reason: body.reason })
      })
    })
    .post("/:loopID/stop", async (c) => {
      const body = await readJson(c, ReasonBody)
      return jsonRequest("LoopRoutes.stop", c, function* () {
        const loop = yield* LoopWorkflow.Service
        return yield* loop.stop({ id: loopID(c.req.param("loopID")), reason: body.reason })
      })
    })
    .delete("/:loopID", async (c) =>
      jsonRequest("LoopRoutes.delete", c, function* () {
        const loop = yield* LoopWorkflow.Service
        return yield* loop.delete(loopID(c.req.param("loopID")))
      }),
    ),
)
