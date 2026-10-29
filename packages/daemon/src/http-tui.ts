import { TuiRequestInput, TuiRequest, TuiResponseBody } from "@mendcode/protocol"
import type { HttpPeer } from "./http"

const routes = [
  ["/tui/append-prompt", "tui.appendPrompt"], ["/tui/open-help", "tui.openHelp"],
  ["/tui/open-sessions", "tui.openSessions"], ["/tui/open-themes", "tui.openThemes"],
  ["/tui/open-models", "tui.openModels"], ["/tui/submit-prompt", "tui.submitPrompt"],
  ["/tui/clear-prompt", "tui.clearPrompt"], ["/tui/execute-command", "tui.executeCommand"],
  ["/tui/show-toast", "tui.showToast"], ["/tui/publish", "tui.publish"],
  ["/tui/select-session", "tui.selectSession"],
] as const

export function tuiOpenApi() {
  const boolean = { type: "boolean" }
  const response = (schema: object) => ({ description: "Success", content: { "application/json": { schema } } })
  const errors = { "400": { description: "Invalid payload or stale response" }, "401": { description: "Token required" }, "403": { description: "Full token and project ownership required" }, "404": { description: "Unknown session" }, "409": { description: "No owner, competing owner, deadline or queue limit" } }
  const variants = TuiRequestInput.options
  return Object.fromEntries([
    ...routes.map(([path, operationId]) => {
      const schema = variants.find((entry) => entry.shape.path.safeParse(path).success)!.shape.body.toJSONSchema({ io: "input" })
      const payload = !["/tui/open-help", "/tui/open-sessions", "/tui/open-themes", "/tui/open-models", "/tui/submit-prompt", "/tui/clear-prompt"].includes(path)
      return [path, { post: { operationId, ...(payload ? { requestBody: { required: true, content: { "application/json": { schema } } } } : {}), responses: { "200": response(boolean), ...errors } } }]
    }),
    ["/tui/control/next", { get: { operationId: "tui.control.next", responses: { "200": response({ type: "object", required: ["requestID", "path", "body"], properties: { requestID: { type: "string" }, path: { type: "string" }, body: {} } }), "204": { description: "No request within 25 seconds" }, ...errors } } }],
    ["/tui/control/response", { post: { operationId: "tui.control.response", requestBody: { required: true, content: { "application/json": { schema: { oneOf: [boolean, { type: "object", required: ["requestID", "response"], additionalProperties: false, properties: { requestID: { type: "string" }, response: boolean } }] } } } }, responses: { "200": response(boolean), ...errors } } }],
  ])
}

export function createHttpTui(input: {
  body(request: Request): Promise<unknown>
  command(command: Record<string, unknown>, peer: HttpPeer, directory: string, signal: AbortSignal): Promise<Record<string, unknown>>
}) {
  return async (request: Request, url: URL, peer: HttpPeer, directory: string): Promise<Response | undefined> => {
    const route = routes.find(([path]) => path === url.pathname)
    const next = url.pathname === "/tui/control/next"
    const response = url.pathname === "/tui/control/response"
    if (!route && !next && !response) return undefined
    if (peer.readOnly || request.headers.has("origin")) return Response.json({ error: { code: "forbidden", message: "TUI control requires a full token and a non-browser client" } }, { status: 403 })
    if (request.method !== (next ? "GET" : "POST")) return Response.json({ error: { code: "invalid_command", message: "Invalid TUI method" } }, { status: 405 })
    try {
      if (next) {
        const result = await input.command({ type: "tui.control.next", directory, timeoutMs: 25_000 }, peer, directory, request.signal)
        if (!result.request) return new Response(null, { status: 204 })
        const pending = TuiRequest.parse(result.request)
        return Response.json({ requestID: pending.requestID, ...pending.request })
      }
      if (response) {
        const value = TuiResponseBody.parse(await input.body(request))
        const result = await input.command({ type: "tui.control.response", directory, ...(typeof value === "boolean" ? { response: value } : value) }, peer, directory, request.signal)
        return Response.json(result.processed)
      }
      const noBody = ["/tui/open-help", "/tui/open-sessions", "/tui/open-themes", "/tui/open-models", "/tui/submit-prompt", "/tui/clear-prompt"].includes(url.pathname)
      const action = TuiRequestInput.parse({ path: url.pathname, body: noBody ? {} : await input.body(request) })
      const result = await input.command({ type: "tui.control.send", directory, request: action }, peer, directory, request.signal)
      return Response.json(result.processed)
    } catch (error) {
      if (error instanceof Response) return error
      return Response.json({ error: { code: "invalid_command", message: "Invalid TUI payload" } }, { status: 400 })
    }
  }
}
