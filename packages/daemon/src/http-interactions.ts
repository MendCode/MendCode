import { InteractionReport, MemorySideChatPayload, MemorySideChatResponse, RequestId, RestPermissionReply, RestPermissionRequest, RestPlanReviewReply, RestPlanReviewRequest, RestQuestionReply, RestQuestionRequest } from "@mendcode/protocol"
import type { InteractionKind } from "@mendcode/protocol"
import type { HttpPeer } from "./http"

export function interactionRestOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {}
  for (const [route, method, operationId, payload, response] of [
    ["/permission", "get", "permission.list", undefined, RestPermissionRequest.array()],
    ["/permission/{requestID}/reply", "post", "permission.reply", RestPermissionReply, undefined],
    ["/question", "get", "question.list", undefined, RestQuestionRequest.array()],
    ["/question/{requestID}/reply", "post", "question.reply", RestQuestionReply, undefined],
    ["/question/{requestID}/reject", "post", "question.reject", undefined, undefined],
    ["/plan-review", "get", "planReview.list", undefined, RestPlanReviewRequest.array()],
    ["/plan-review/{requestID}/reply", "post", "planReview.reply", RestPlanReviewReply, undefined],
    ["/memory/side-chat", "post", "memory.sideChat", MemorySideChatPayload, MemorySideChatResponse],
  ] as const) {
    paths[route] = { [method]: { operationId, parameters: [
      { name: "directory", in: "query", schema: { type: "string" } }, { name: "workspace", in: "query", schema: { type: "string" } },
      ...(route.includes("{requestID}") ? [{ name: "requestID", in: "path", required: true, schema: RequestId.toJSONSchema() }] : []),
    ], ...(payload ? { requestBody: { required: true, content: { "application/json": { schema: payload.toJSONSchema({ io: "input" }) } } } } : {}), responses: {
      "200": { description: "Success", content: { "application/json": { schema: response?.toJSONSchema({ io: "output" }) ?? { type: "boolean" } } } },
      "400": { description: "Invalid payload or decision" }, "401": { description: "Token required" }, "403": { description: "Full token required or workspace mismatch" }, "404": { description: "Request not pending" }, "409": { description: "Request resolved concurrently" },
    } } }
  }
  return paths
}

export function createHttpInteractions(input: {
  body(request: Request): Promise<unknown>
  command(value: Record<string, unknown>, peer: HttpPeer, directory: string, signal: AbortSignal): Promise<Record<string, unknown>>
}) {
  return async (request: Request, url: URL, peer: HttpPeer, directory: string): Promise<Response | undefined> => {
    const route = url.pathname.replace(/\/$/, "")
    const match = /^\/(permission|question|plan-review)(?:\/([^/]+)\/(reply|reject))?$/.exec(route)
    if (!match && route !== "/memory/side-chat") return undefined
    const json = (value: unknown, status = 200) => Response.json(value, { status })
    if (peer.readOnly) return json({ error: { code: "forbidden", message: "Full token required" } }, 403)
    const call = (value: Record<string, unknown>) => input.command(value, peer, directory, request.signal)
    try {
      if ([...url.searchParams.keys()].some((key) => !["directory", "workspace"].includes(key))) throw new Error("Unknown query")
      if (route === "/memory/side-chat") {
        if (request.method !== "POST") return json({ error: "Unknown method" }, 404)
        return json(MemorySideChatResponse.parse(await call({ type: "memory.side-chat", directory, payload: MemorySideChatPayload.parse(await input.body(request)) })))
      }
      const kind = match![1] as InteractionKind
      if (request.method === "GET" && !match![2]) return json(InteractionReport.parse(await call({ type: "interaction.list", directory, kind })).requests)
      if (request.method !== "POST" || !match![2] || kind !== "question" && match![3] === "reject") return json({ error: "Unknown route" }, 404)
      const id = RequestId.parse(decodeURIComponent(match![2]!))
      let decision: Record<string, unknown>
      if (kind === "permission") {
        const payload = RestPermissionReply.parse(await input.body(request))
        decision = payload.reply === "reject" ? { kind: "deny", ...(payload.message !== undefined ? { reason: payload.message } : {}) } : { kind: "approve", scope: payload.reply === "always" ? "session" : "once" }
      } else if (kind === "question") {
        if (match![3] === "reject") decision = { kind: "deny" }
        else {
          const { answers } = RestQuestionReply.parse(await input.body(request))
          decision = { kind: "answer", answers, text: answers.map((answer) => answer.join(", ")).join("\n") }
        }
      } else decision = { kind: "plan_review", ...RestPlanReviewReply.parse(await input.body(request)) }
      const pending = InteractionReport.parse(await call({ type: "interaction.list", directory, kind })).requests.find((item) => item.id === id)
      if (!pending) return json({ error: { code: "not_found", message: "Request not pending" } }, 404)
      await call({ type: "request.resolve", sessionId: pending.sessionID, requestId: id, decision })
      return json(true)
    } catch (error) {
      if (error instanceof Response) {
        const value = await error.json() as { error?: { code?: string } }
        return json(value, value.error?.code === "request_already_resolved" ? 409 : error.status)
      }
      return json({ error: { code: "invalid_command", message: "Invalid interaction payload or query" } }, 400)
    }
  }
}
