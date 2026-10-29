import { MAX_FRAME_BYTES, RestWorkflowAnswerTask, RestWorkflowControl, RestWorkflowPermission, RestWorkflowPreview, RestWorkflowRetryPhase, RestWorkflowRetryTask, RestWorkflowSave, RestWorkflowStart, WorkflowId, type LedgerPage, type WorkflowRevisionReceipt, type WorkflowRun, type WorkflowSummary } from "@mendcode/protocol"
import type { HttpPeer } from "./http"
import { GATE_PREFIX, nativeWorkflowPlan, restPlanOf, UnsupportedWorkflowPlan, workflowRestIds, workflowRestPreview } from "./workflow-rest-plan"
import { workflowRestReceipt, workflowRestSnapshot } from "./workflow-rest-snapshot"

export function workflowRestOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {}
  const snapshot = { type: "object", required: ["definition", "revision", "run", "preview", "phases", "tasks", "events", "artifacts", "gates"], properties: Object.fromEntries(["definition", "revision", "run", "preview"].map((key) => [key, { type: "object" }])) }
  const preview = { type: "object", required: ["phaseCount", "taskCount", "taskUpperBound", "maxConcurrency", "maxFanOut", "sideEffectClasses"] }
  for (const [route, method, operationId, payload, schema] of [
    ["/workflow/preview", "post", "workflow.preview", RestWorkflowPreview, preview],
    ["/workflow/save", "post", "workflow.save", RestWorkflowSave, { type: "object", required: ["definitionID", "revisionID", "revision", "plan", "preview"] }],
    ["/workflow/start", "post", "workflow.start", RestWorkflowStart, snapshot],
    ["/workflow", "get", "workflow.list", undefined, { type: "array", items: snapshot }],
    ["/workflow/{runID}", "get", "workflow.show", undefined, snapshot],
    ["/workflow/{runID}", "delete", "workflow.delete", undefined, { type: "boolean" }],
    ["/workflow/{runID}/events", "get", "workflow.events", undefined, { type: "array", items: { type: "object", required: ["id", "sequence", "level", "type", "title", "summary", "createdAt"] } }],
    ["/workflow/{runID}/artifacts", "get", "workflow.artifacts", undefined, { type: "array", items: { type: "object", required: ["id", "runID", "kind", "summary", "status", "schemaValidated", "outputRefs", "evidence", "createdAt"] } }],
    ["/workflow/{runID}/pause", "post", "workflow.pause", RestWorkflowControl, snapshot],
    ["/workflow/{runID}/resume", "post", "workflow.resume", RestWorkflowControl, snapshot],
    ["/workflow/{runID}/stop", "post", "workflow.stop", RestWorkflowControl, snapshot],
    ["/workflow/{runID}/permission-mode", "post", "workflow.permissionMode", RestWorkflowPermission, snapshot],
    ["/workflow/{runID}/retry-task", "post", "workflow.retryTask", RestWorkflowRetryTask, snapshot],
    ["/workflow/{runID}/retry-phase", "post", "workflow.retryPhase", RestWorkflowRetryPhase, snapshot],
    ["/workflow/{runID}/approve-task", "post", "workflow.approveTask", RestWorkflowAnswerTask, snapshot],
    ["/workflow/{runID}/reject-task", "post", "workflow.rejectTask", RestWorkflowAnswerTask, snapshot],
  ] as const) {
    paths[route] ??= {}
    paths[route]![method] = { operationId, parameters: [
      { name: "directory", in: "query", schema: { type: "string" } }, { name: "workspace", in: "query", schema: { type: "string" } },
      ...(route.includes("{runID}") ? [{ name: "runID", in: "path", required: true, schema: { type: "string" } }] : []),
      ...(method === "get" && (route === "/workflow" || route.endsWith("events") || route.endsWith("artifacts")) ? [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } }] : []),
      ...(route.endsWith("events") || route.endsWith("artifacts") ? [{ name: "before", in: "query", schema: { type: "integer", minimum: 1 } }] : []),
    ], ...(payload ? { requestBody: { required: true, content: { "application/json": { schema: payload.toJSONSchema({ io: "input" }) } } } } : {}), responses: {
      "200": { description: "Success", content: { "application/json": { schema } } }, "400": { description: "Invalid payload, plan or state" }, "401": { description: "Token required" }, "403": { description: "Full token required or workspace mismatch" }, "404": { description: "Unknown workflow, revision, task or phase" }, "501": { description: "Plan feature has no native equivalent" },
    } }
  }
  return paths
}

export function createHttpWorkflows(input: {
  body(request: Request): Promise<unknown>
  command(value: Record<string, unknown>, peer: HttpPeer, directory: string, signal: AbortSignal): Promise<Record<string, unknown>>
}) {
  return async (request: Request, url: URL, peer: HttpPeer, directory: string): Promise<Response | undefined> => {
    const route = url.pathname.replace(/\/$/, "")
    if (route !== "/workflow" && !route.startsWith("/workflow/")) return undefined
    const json = (value: unknown, status = 200, headers?: Record<string, string>) => Response.json(value, { status, ...(headers ? { headers } : {}) })
    if (peer.readOnly) return json({ error: "Full token required" }, 403)
    const call = (value: Record<string, unknown>) => input.command(value, peer, directory, request.signal)
    const body = () => request.body ? input.body(request) : Promise.resolve({})
    const number = (key: string, fallback?: number) => {
      const value = url.searchParams.get(key)
      if (value === null) return fallback
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("Invalid workflow query")
      return Number(value)
    }
    const native = async (plan: Parameters<typeof nativeWorkflowPlan>[0]) => nativeWorkflowPlan(plan, "formatVersion" in plan ? (await call({ type: "models.list" })).models as Array<{ id: string; provider?: string }> : [])
    const preview = async (plan: Parameters<typeof nativeWorkflowPlan>[0]) => {
      const converted = await native(plan)
      const result = await call({ type: "workflow.preview", directory, plan: converted.plan })
      if ((result.problems as string[]).length) throw json({ error: "Invalid workflow plan", issues: result.problems }, 400)
      return converted
    }
    const receiptOf = async (run: WorkflowRun) => {
      if (!run.revisionId) throw json({ error: "Historical workflow has no immutable revision" }, 501)
      return (await call({ type: "workflow.revision.get", directory, revisionId: run.revisionId })).receipt as WorkflowRevisionReceipt
    }
    const snapshot = async (id: string, limit = 50, before?: number) => {
      const run = (await call({ type: "workflow.get", workflowId: WorkflowId.parse(id) })).workflow as WorkflowRun
      // Script workflows run code and have no static tasks or phases: they are not part of the REST surface.
      if (run.plan.script) throw json({ error: "Script workflows are not available over REST" }, 501)
      const receipt = await receiptOf(run)
      const events = (await call({ type: "workflow.events", workflowId: run.workflowId, limit, ...(before ? { before } : {}) })).ledger as LedgerPage
      const artifacts = (await call({ type: "workflow.artifacts", workflowId: run.workflowId, limit, ...(before ? { before } : {}) })).ledger as LedgerPage
      return { value: workflowRestSnapshot(run, receipt, events, artifacts), run, receipt }
    }
    const session = (id: string | undefined) => id ? call({ type: "session.rest.read", directory, input: { operation: "get", sessionId: id } }) : Promise.resolve()
    try {
      if ([...url.searchParams.keys()].some((key) => !["directory", "workspace", "limit", "before"].includes(key))) throw new Error("Unknown workflow query")
      const limit = Math.min(100, number("limit", 50)!), before = number("before")
      if (request.method === "POST" && route === "/workflow/preview") {
        const { plan, restPlan } = await preview(RestWorkflowPreview.parse(await body()).plan)
        return json(workflowRestPreview(plan, restPlan))
      }
      if (request.method === "POST" && route === "/workflow/save") {
        const payload = RestWorkflowSave.parse(await body()), converted = await preview(payload.plan)
        await session(payload.ownerSessionID)
        const receipt = (await call({ type: "workflow.save", directory, plan: converted.plan, restPlan: converted.restPlan, definitionId: payload.definitionID, name: payload.name, description: payload.description ?? converted.restPlan?.description, source: payload.source, saved: payload.saved, ownerSessionId: payload.ownerSessionID })).receipt as WorkflowRevisionReceipt
        return json(workflowRestReceipt(receipt))
      }
      if (request.method === "POST" && route === "/workflow/start") {
        const payload = RestWorkflowStart.parse(await body())
        await session(payload.originSessionID)
        let plan: unknown = payload.revisionID ? { revisionId: payload.revisionID } : { definitionId: payload.definitionID }
        if (payload.plan) {
          const converted = await preview(payload.plan)
          const receipt = (await call({ type: "workflow.save", directory, plan: converted.plan, restPlan: converted.restPlan, name: payload.name, description: payload.description ?? converted.restPlan?.description, source: payload.source ?? "session-generated", saved: false })).receipt as WorkflowRevisionReceipt
          plan = { revisionId: receipt.revisionId }
        }
        const run = (await call({ type: "workflow.start", directory, plan, originSessionId: payload.originSessionID, startKey: payload.overlapKey, loopId: payload.loopID, loopRunId: payload.loopRunID })).workflow as WorkflowSummary
        return json((await snapshot(run.workflowId)).value)
      }
      if (request.method === "GET" && route === "/workflow") {
        const runs = ((await call({ type: "workflow.list", directory })).workflows as WorkflowSummary[]).filter((run) => !run.script)
        const values: Array<ReturnType<typeof workflowRestSnapshot>> = []
        let bytes = 2
        for (const run of runs.slice(0, limit)) {
          const value = (await snapshot(run.workflowId)).value
          const size = Buffer.byteLength(JSON.stringify(value)) + 1
          if (bytes + size > MAX_FRAME_BYTES) break
          values.push(value)
          bytes += size
        }
        return json(values, 200, values.length < runs.length ? { "X-Truncated": "true" } : undefined)
      }
      const match = /^\/workflow\/([^/]+)(?:\/([^/]+))?$/.exec(route)
      if (!match) return json({ error: "Unknown workflow route" }, 404)
      const id = WorkflowId.parse(decodeURIComponent(match[1]!)), action = match[2] ?? ""
      const current = await snapshot(id, limit, before)
      if (request.method === "GET" && !action) return json(current.value)
      if (request.method === "GET" && (action === "events" || action === "artifacts")) {
        const page = current.value.pagination[action]
        return json(current.value[action], 200, { "Access-Control-Expose-Headers": "X-Next-Before, X-Truncated", ...(page.nextBefore ? { "X-Next-Before": String(page.nextBefore) } : {}), ...(page.truncated ? { "X-Truncated": "true" } : {}) })
      }
      if (request.method === "DELETE" && !action) { await call({ type: "workflow.control", workflowId: id, action: "delete" }); return json(true) }
      if (request.method !== "POST") return json({ error: "Unknown workflow method" }, 404)
      const payload = await body()
      if (["pause", "resume", "stop"].includes(action)) {
        const parsed = RestWorkflowControl.parse(payload)
        await call({ type: "workflow.control", workflowId: id, action, ...(parsed.reason ? { reason: parsed.reason } : {}) })
      } else if (action === "permission-mode") {
        const parsed = RestWorkflowPermission.parse(payload)
        await call({ type: "workflow.permissions", workflowId: id, mode: parsed.mode, ...(parsed.sessionMode !== undefined ? { sessionPermission: parsed.sessionMode === null || parsed.sessionMode === "global_default" ? null : { approval: "ask", smart: "edits", full_access: "full" }[parsed.sessionMode] } : {}), reason: parsed.reason })
      } else if (action === "approve-task" || action === "reject-task") {
        const donor = restPlanOf(current.receipt), ids = donor ? workflowRestIds(donor) : undefined
        const parsed = RestWorkflowAnswerTask.parse(payload), taskId = ids?.tasks.get(parsed.taskID) ?? ids?.tasks.get(`${GATE_PREFIX}${parsed.taskID}`) ?? parsed.taskID
        if (!current.run.tasks.some((task) => task.id === taskId)) return json({ error: "Unknown workflow task", id: parsed.taskID }, 404)
        await call({ type: "workflow.control", workflowId: id, action: action === "approve-task" ? "approve" : "reject", taskId, ...(parsed.reason ? { reason: parsed.reason } : {}) })
      } else if (action === "retry-task" || action === "retry-phase") {
        const donor = restPlanOf(current.receipt), ids = donor ? workflowRestIds(donor) : undefined
        if (action === "retry-task") {
          const parsed = RestWorkflowRetryTask.parse(payload), taskId = ids?.tasks.get(parsed.taskID) ?? parsed.taskID
          if (!current.run.tasks.some((task) => task.id === taskId)) return json({ error: "Unknown workflow task", id: parsed.taskID }, 404)
          await call({ type: "workflow.control", workflowId: id, action: "retry", taskId, ...(parsed.reason ? { reason: parsed.reason } : {}) })
        } else {
          const parsed = RestWorkflowRetryPhase.parse(payload), phaseId = ids?.phases.get(parsed.phaseID) ?? parsed.phaseID
          if (!current.run.plan.phases?.some((phase) => phase.id === phaseId)) return json({ error: "Unknown workflow phase", id: parsed.phaseID }, 404)
          await call({ type: "workflow.retry-phase", workflowId: id, phaseId, reason: parsed.reason })
        }
      } else return json({ error: "Unknown workflow action" }, 404)
      return json((await snapshot(id)).value)
    } catch (error) {
      if (error instanceof Response) {
        const body = await error.json().catch(() => ({})) as { error?: { code?: string; message?: string } | string }
        if (typeof body.error === "string") return json(body, error.status)
        const message = body.error?.message ?? "Invalid workflow request"
        const unknown = /unknown workflow|unknown.*revision|unknown.*definition/.test(message)
        return json({ error: message }, error.status === 403 && !unknown ? 403 : unknown ? 404 : 400)
      }
      return json({ error: error instanceof UnsupportedWorkflowPlan ? error.message : "Invalid workflow payload, query or plan" }, error instanceof UnsupportedWorkflowPlan ? 501 : 400)
    }
  }
}
