import { LoopID, LoopWorkflow } from "@/session/loop"
import { Effect, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

const LoopParams = Schema.Struct({
  loopID: LoopID,
})

function webSource(request: HttpServerRequest.HttpServerRequest): Request | undefined {
  return request.source instanceof Request ? request.source : undefined
}

function readReasonBody(request: HttpServerRequest.HttpServerRequest) {
  return Effect.promise(async () => {
    const body = await webSource(request)?.json().catch(() => ({}))
    if (!body || typeof body !== "object") return undefined
    const reason = (body as { reason?: unknown }).reason
    return typeof reason === "string" ? reason : undefined
  })
}

function readAgentBody(request: HttpServerRequest.HttpServerRequest) {
  return Effect.promise(async () => {
    const body = await webSource(request)?.json().catch(() => ({}))
    if (!body || typeof body !== "object") return {}
    const agent = (body as { agent?: unknown }).agent
    const reason = (body as { reason?: unknown }).reason
    return {
      agent: typeof agent === "string" ? agent : undefined,
      reason: typeof reason === "string" ? reason : undefined,
    }
  })
}

export const loopRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const loop = yield* LoopWorkflow.Service

    yield* router.add(
      "GET",
      "/loop",
      loop.list().pipe(Effect.map((items) => HttpServerResponse.jsonUnsafe(items))),
    )

    yield* router.add(
      "GET",
      "/loop/:loopID",
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaPathParams(LoopParams)
        return HttpServerResponse.jsonUnsafe(yield* loop.snapshot(params.loopID))
      }),
    )

    yield* router.add(
      "GET",
      "/loop/:loopID/events",
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaPathParams(LoopParams)
        return HttpServerResponse.jsonUnsafe(yield* loop.events(params.loopID))
      }),
    )

    const control = (action: "pause" | "resume" | "run-once" | "stop") =>
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaPathParams(LoopParams)
        const request = yield* HttpServerRequest.HttpServerRequest
        const reason = yield* readReasonBody(request)
        if (action === "pause") return HttpServerResponse.jsonUnsafe(yield* loop.pause({ id: params.loopID, reason }))
        if (action === "resume") return HttpServerResponse.jsonUnsafe(yield* loop.resume({ id: params.loopID, reason }))
        if (action === "run-once") return HttpServerResponse.jsonUnsafe(yield* loop.runOnce({ id: params.loopID, reason }))
        return HttpServerResponse.jsonUnsafe(yield* loop.stop({ id: params.loopID, reason }))
      })

    yield* router.add("POST", "/loop/:loopID/pause", control("pause"))
    yield* router.add("POST", "/loop/:loopID/resume", control("resume"))
    yield* router.add(
      "POST",
      "/loop/:loopID/agent",
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaPathParams(LoopParams)
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* readAgentBody(request)
        return HttpServerResponse.jsonUnsafe(yield* loop.updateAgent({ id: params.loopID, ...body }))
      }),
    )
    yield* router.add("POST", "/loop/:loopID/run-once", control("run-once"))
    yield* router.add("POST", "/loop/:loopID/stop", control("stop"))
    yield* router.add(
      "DELETE",
      "/loop/:loopID",
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaPathParams(LoopParams)
        return HttpServerResponse.jsonUnsafe(yield* loop.delete(params.loopID))
      }),
    )
  }),
)
