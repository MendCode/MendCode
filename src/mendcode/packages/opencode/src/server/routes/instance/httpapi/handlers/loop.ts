import { externalSignalRateLimit, LoopID, LoopWorkflow } from "@/session/loop"
import { LoopRunner } from "@/session/loop-runner"
import { ServerAuth } from "@/server/auth"
import { Effect, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Flag } from "@mendcode/core/flag/flag"
import { timingSafeEqual } from "crypto"

const LoopParams = Schema.Struct({
  loopID: LoopID,
})

function webSource(request: HttpServerRequest.HttpServerRequest): Request | undefined {
  return request.source instanceof Request ? request.source : undefined
}

function requestLimit(request: HttpServerRequest.HttpServerRequest) {
  const raw = webSource(request) ? new URL(webSource(request)!.url).searchParams.get("limit") : undefined
  if (raw === undefined || raw === null) return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined
}

function requestGlobalPage(request: HttpServerRequest.HttpServerRequest) {
  const params = new URL(webSource(request)?.url ?? request.url, "http://localhost").searchParams
  const integer = (name: string) => {
    const raw = params.get(name)
    if (raw === null) return undefined
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined
  }
  const selectedID = params.get("selectedID")
  const scope = params.get("scope")
  const pageScope: "all" | "project" | undefined = scope === "project" || scope === "all" ? scope : undefined
  return {
    offset: integer("offset"),
    limit: integer("limit"),
    selectedID: selectedID ? LoopID.make(selectedID) : undefined,
    scope: pageScope,
  }
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

function readObjectBody(request: HttpServerRequest.HttpServerRequest) {
  return Effect.promise(async () => {
    const body = await webSource(request)?.json().catch(() => ({}))
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {}
  })
}

function authenticationRequired() {
  return HttpServerResponse.jsonUnsafe(
    { error: "Loop signal and override endpoints require configured server authentication." },
    { status: 401 },
  )
}

function operatorAuthorized(request: HttpServerRequest.HttpServerRequest) {
  const expected = ServerAuth.header()
  if (!expected) return false
  const source = webSource(request)
  const token = new URL(source?.url ?? request.url, "http://localhost").searchParams.get("auth_token")
  const actual = token ?? /^Basic\s+(.+)$/i.exec(request.headers.authorization ?? "")?.[1]
  if (!actual) return false
  const expectedBytes = Buffer.from(expected.slice("Basic ".length))
  const actualBytes = Buffer.from(actual)
  return expectedBytes.byteLength === actualBytes.byteLength && timingSafeEqual(expectedBytes, actualBytes)
}

export const loopRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const loop = yield* LoopWorkflow.Service
    const runner = yield* LoopRunner.Service

    yield* router.add(
      "GET",
      "/loop/summary",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const limit = requestLimit(request)
        const workflows = yield* loop.list()
        const summaries = yield* Effect.forEach(
          workflows,
          (workflow) => loop.snapshot(workflow.id, limit).pipe(Effect.map(LoopWorkflow.summarizeSnapshot)),
          { concurrency: 4 },
        )
        return HttpServerResponse.jsonUnsafe(summaries)
      }),
    )

    yield* router.add(
      "GET",
      "/loop",
      loop.list().pipe(Effect.map((items) => HttpServerResponse.jsonUnsafe(items))),
    )

    yield* router.add(
      "GET",
      "/loop/global",
      loop.listGlobal().pipe(Effect.map((items) => HttpServerResponse.jsonUnsafe(items))),
    )

    yield* router.add(
      "GET",
      "/loop/global/page",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        return HttpServerResponse.jsonUnsafe(yield* loop.listGlobalPage(requestGlobalPage(request)))
      }),
    )

    yield* router.add(
      "POST",
      "/loop/signal",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (!operatorAuthorized(request)) return authenticationRequired()
        const body = yield* readObjectBody(request)
        if (typeof body.workflowID !== "string" || !body.workflowID.trim() || typeof body.source !== "string" || !body.source.trim() || typeof body.type !== "string" || !body.type.trim()) {
          return HttpServerResponse.jsonUnsafe({ error: "workflowID, source, and type are required" }, { status: 400 })
        }
        if (body.links !== undefined && (!Array.isArray(body.links) || body.links.some((item) => typeof item !== "string"))) {
          return HttpServerResponse.jsonUnsafe({ error: "links must be an array of strings" }, { status: 400 })
        }
        const result = yield* loop.ingestSignal({
          workflowID: LoopID.make(body.workflowID),
          source: body.source,
          type: body.type,
          dedupeKey: typeof body.dedupeKey === "string" ? body.dedupeKey : undefined,
          payloadSummary: typeof body.payloadSummary === "string" ? body.payloadSummary : undefined,
          links: body.links as string[] | undefined,
          rateLimit: externalSignalRateLimit,
        })
        return HttpServerResponse.jsonUnsafe(result, { status: result.rateLimited ? 429 : 200 })
      }),
    )

    yield* router.add(
      "GET",
      "/loop/:loopID/summary",
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaPathParams(LoopParams)
        const request = yield* HttpServerRequest.HttpServerRequest
        return HttpServerResponse.jsonUnsafe(LoopWorkflow.summarizeSnapshot(yield* loop.snapshot(params.loopID, requestLimit(request))))
      }),
    )

    yield* router.add(
      "GET",
      "/loop/:loopID",
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaPathParams(LoopParams)
        const request = yield* HttpServerRequest.HttpServerRequest
        return HttpServerResponse.jsonUnsafe(yield* loop.snapshot(params.loopID, requestLimit(request)))
      }),
    )

    yield* router.add(
      "GET",
      "/loop/:loopID/events",
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaPathParams(LoopParams)
        const request = yield* HttpServerRequest.HttpServerRequest
        return HttpServerResponse.jsonUnsafe(yield* loop.events(params.loopID, requestLimit(request)))
      }),
    )

    const control = (action: "pause" | "resume" | "run-once" | "stop") =>
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaPathParams(LoopParams)
        const request = yield* HttpServerRequest.HttpServerRequest
        const reason = yield* readReasonBody(request)
        if (action === "pause") return HttpServerResponse.jsonUnsafe(yield* loop.pause({ id: params.loopID, reason }))
        if (action === "resume") return HttpServerResponse.jsonUnsafe(yield* loop.resume({ id: params.loopID, reason }))
        if (action === "run-once") {
          return HttpServerResponse.jsonUnsafe(yield* runner.runOne({ id: params.loopID, execute: true, reason, trigger: "run-once" }))
        }
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
    yield* router.add(
      "POST",
      "/loop/:loopID/override",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (!operatorAuthorized(request)) return authenticationRequired()
        const params = yield* HttpRouter.schemaPathParams(LoopParams)
        const body = yield* readObjectBody(request)
        if (body.action !== "waive" && body.action !== "accept" && body.action !== "retry") {
          return HttpServerResponse.jsonUnsafe({ error: "override action must be waive, accept, or retry" }, { status: 400 })
        }
        if (typeof body.reason !== "string" || !body.reason.trim()) {
          return HttpServerResponse.jsonUnsafe({ error: "override reason is required" }, { status: 400 })
        }
        return HttpServerResponse.jsonUnsafe(yield* loop.override({
          id: params.loopID,
          runID: typeof body.runID === "string" ? LoopWorkflow.RunID.make(body.runID) : undefined,
          action: body.action,
          gateID: typeof body.gateID === "string" ? body.gateID : undefined,
          actor: `server:${Flag.OPENCODE_SERVER_USERNAME ?? "mendcode"}`,
          reason: body.reason,
        }))
      }),
    )
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
