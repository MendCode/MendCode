import { InstanceState } from "@/effect/instance-state"
import { loopServiceArgsFromConfig, loopServiceStart } from "@/mend/runtime/loop-service"
import { externalSignalRateLimit, LoopID, LoopWorkflow } from "@/session/loop"
import { SessionID } from "@/session/schema"
import { lazy } from "@/util/lazy"
import { Effect } from "effect"
import { Hono } from "hono"
import z from "zod"
import { jsonRequest, runRequest } from "./trace"
import { Flag } from "@mendcode/core/flag/flag"

const ReasonBody = z.object({
  reason: z.string().optional(),
  ensureService: z.boolean().optional(),
})

const AgentBody = z.object({
  agent: z.string().optional(),
  reason: z.string().optional(),
})

const SignalBody = z.object({
  workflowID: LoopID.zod,
  source: z.string().trim().min(1),
  type: z.string().trim().min(1),
  dedupeKey: z.string().optional(),
  payloadSummary: z.string().optional(),
  links: z.array(z.string()).optional(),
})

const OverrideBody = z.object({
  runID: z.string().optional(),
  action: z.enum(["waive", "accept", "retry"]),
  gateID: z.string().optional(),
  reason: z.string().min(1),
})

function securedOperator(c: { json: (value: unknown, status?: 401) => Response }) {
  if (Flag.OPENCODE_SERVER_PASSWORD) return
  return c.json({ error: "Loop signal and override endpoints require configured server authentication." }, 401)
}

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
    .get("/summary", async (c) =>
      jsonRequest("LoopRoutes.summaryList", c, function* () {
        const loop = yield* LoopWorkflow.Service
        const workflows = yield* loop.list()
        return yield* Effect.forEach(
          workflows,
          (workflow) => loop.snapshot(workflow.id, limit(c.req.query("limit"))).pipe(Effect.map(LoopWorkflow.summarizeSnapshot)),
          { concurrency: 4 },
        )
      }),
    )
    .get("/", async (c) =>
      jsonRequest("LoopRoutes.list", c, function* () {
        const loop = yield* LoopWorkflow.Service
        return yield* loop.list()
      }),
    )
    .get("/global", async (c) =>
      jsonRequest("LoopRoutes.listGlobal", c, function* () {
        const loop = yield* LoopWorkflow.Service
        return yield* loop.listGlobal()
      }),
    )
    .get("/global/page", async (c) =>
      jsonRequest("LoopRoutes.listGlobalPage", c, function* () {
        const loop = yield* LoopWorkflow.Service
        const selectedID = c.req.query("selectedID")
        return yield* loop.listGlobalPage({
          offset: limit(c.req.query("offset")),
          limit: limit(c.req.query("limit")),
          selectedID: selectedID ? loopID(selectedID) : undefined,
        })
      }),
    )
    .post("/draft", async (c) => {
      const body = await readJson(c, DraftBody)
      return jsonRequest("LoopRoutes.draft", c, function* () {
        const loop = yield* LoopWorkflow.Service
        return yield* loop.createDraft(body)
      })
    })
    .post("/signal", async (c) => {
      const unauthorized = securedOperator(c)
      if (unauthorized) return unauthorized
      const body = SignalBody.safeParse(await c.req.json().catch(() => ({})))
      if (!body.success) return c.json({ error: "workflowID, source, and type are required" }, 400)
      const result = await runRequest("LoopRoutes.signal", c, Effect.gen(function* () {
        const loop = yield* LoopWorkflow.Service
        return yield* loop.ingestSignal({ ...body.data, rateLimit: externalSignalRateLimit })
      }))
      return c.json(result, result.rateLimited ? 429 : 200)
    })
    .get("/:loopID/summary", async (c) =>
      jsonRequest("LoopRoutes.summaryGet", c, function* () {
        const loop = yield* LoopWorkflow.Service
        return LoopWorkflow.summarizeSnapshot(yield* loop.snapshot(loopID(c.req.param("loopID")), limit(c.req.query("limit"))))
      }),
    )
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
    .post("/:loopID/agent", async (c) => {
      const body = await readJson(c, AgentBody)
      return jsonRequest("LoopRoutes.updateAgent", c, function* () {
        const loop = yield* LoopWorkflow.Service
        return yield* loop.updateAgent({ id: loopID(c.req.param("loopID")), agent: body.agent, reason: body.reason })
      })
    })
    .post("/:loopID/run-once", async (c) => {
      const body = await readJson(c, ReasonBody)
      return jsonRequest("LoopRoutes.runOnce", c, function* () {
        const loop = yield* LoopWorkflow.Service
        return yield* loop.runOnce({ id: loopID(c.req.param("loopID")), reason: body.reason })
      })
    })
    .post("/:loopID/override", async (c) => {
      const unauthorized = securedOperator(c)
      if (unauthorized) return unauthorized
      const body = OverrideBody.safeParse(await c.req.json().catch(() => ({})))
      if (!body.success) return c.json({ error: "override action and reason are required" }, 400)
      return jsonRequest("LoopRoutes.override", c, function* () {
        const loop = yield* LoopWorkflow.Service
        return yield* loop.override({
          id: loopID(c.req.param("loopID")),
          runID: body.data.runID ? LoopWorkflow.RunID.make(body.data.runID) : undefined,
          action: body.data.action,
          gateID: body.data.gateID,
          actor: `server:${Flag.OPENCODE_SERVER_USERNAME ?? "mendcode"}`,
          reason: body.data.reason,
        })
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
