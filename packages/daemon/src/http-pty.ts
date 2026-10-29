import { PtyConnectToken, PtyCreateInput, PtyInfo, PtyShell, PtyUpdateInput } from "@mendcode/protocol"
import type { HttpPeer } from "./http"

export const ptyConnectPath = /^\/pty\/(pty_[a-f0-9]{32})\/connect$/
export async function ptyErrorResponse(error: Response) {
  const value = await error.json()
  return Response.json(value, { status: error.status === 400 && /^PTY (disabled|runtime unavailable)/.test(value.error?.message ?? "") ? 501 : error.status })
}
export function ptyOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {}
  for (const [route, method, operationId, payload, schema] of [
    ["/pty/shells", "get", "pty.shells", undefined, PtyShell.array().toJSONSchema()],
    ["/pty", "get", "pty.list", undefined, PtyInfo.array().toJSONSchema()],
    ["/pty", "post", "pty.create", PtyCreateInput.toJSONSchema(), PtyInfo.toJSONSchema()],
    ["/pty/{ptyID}", "get", "pty.get", undefined, PtyInfo.toJSONSchema()],
    ["/pty/{ptyID}", "put", "pty.update", PtyUpdateInput.toJSONSchema(), PtyInfo.toJSONSchema()],
    ["/pty/{ptyID}", "delete", "pty.remove", undefined, { type: "boolean" }],
    ["/pty/{ptyID}/connect-token", "post", "pty.connectToken", undefined, PtyConnectToken.toJSONSchema()],
    ["/pty/{ptyID}/connect", "get", "pty.connect", undefined, { type: "string" }],
  ] as const) {
    paths[route] ??= {}
    const parameters: Record<string, unknown>[] = [{ name: "directory", in: "query", schema: { type: "string" } }, { name: "workspace", in: "query", schema: { type: "string" } }]
    if (route.includes("{ptyID}")) parameters.push({ name: "ptyID", in: "path", required: true, schema: PtyInfo.shape.id.toJSONSchema() })
    if (operationId === "pty.connectToken") parameters.push({ name: "x-mendcode-ticket", in: "header", required: true, schema: { const: "1" } })
    if (operationId === "pty.connect") parameters.push({ name: "ticket", in: "query", schema: { type: "string" } }, { name: "cursor", in: "query", schema: { type: "integer", minimum: -1 } })
    paths[route]![method] = {
      operationId, parameters,
      ...(payload ? { requestBody: { required: true, content: { "application/json": { schema: payload } } } } : {}),
      responses: { [operationId === "pty.connect" ? "101" : "200"]: { description: "Success", content: { "application/json": { schema } } }, "400": { description: "Invalid request" }, "401": { description: "Token required" }, "403": { description: "Full owner token required" }, "404": { description: "PTY not found" }, "409": { description: "PTY limit" }, "426": { description: "WebSocket required" }, "501": { description: "PTY disabled or runtime unavailable" } },
      ...(operationId === "pty.connect" ? { security: [{ token: [] }, { basicToken: [] }, { ptyTicket: [] }], "x-mendcode-frames": "Text output; binary 0x00 + UTF-8 JSON cursor; text or binary UTF-8 input" } : {}),
    }
  }
  return paths
}

export function createHttpPty(input: {
  body(request: Request): Promise<unknown>
  command(value: Record<string, unknown>, peer: HttpPeer, directory: string, signal: AbortSignal): Promise<Record<string, unknown>>
}) {
  return async (request: Request, url: URL, peer: HttpPeer, directory: string): Promise<Response | undefined> => {
    if (url.pathname !== "/pty" && !url.pathname.startsWith("/pty/")) return
    const json = (value: unknown, status = 200) => Response.json(value, { status })
    if (peer.readOnly) return json({ error: { code: "forbidden", message: "Full token required" } }, 403)
    const call = (value: Record<string, unknown>) => input.command({ ...value, directory }, peer, directory, request.signal)
    try {
      if (url.pathname === "/pty/shells" && request.method === "GET") return json((await call({ type: "pty.shells" })).shells)
      if (url.pathname === "/pty" && request.method === "GET") return json((await call({ type: "pty.list" })).ptys)
      if (url.pathname === "/pty" && request.method === "POST") return json((await call({ type: "pty.create", input: await input.body(request) })).pty)
      const match = /^\/pty\/(pty_[a-f0-9]{32})(\/connect-token)?$/.exec(url.pathname)
      if (match) {
        const ptyId = match[1]!
        if (match[2] && request.method === "POST") {
          if ((request.headers.get("x-mendcode-ticket") ?? request.headers.get("x-opencode-ticket")) !== "1") return json({ error: { code: "forbidden", message: "PTY ticket header required" } }, 403)
          return json((await call({ type: "pty.connect-token", ptyId })).token)
        }
        if (!match[2] && request.method === "GET") return json((await call({ type: "pty.get", ptyId })).pty)
        if (!match[2] && request.method === "PUT") return json((await call({ type: "pty.update", ptyId, input: await input.body(request) })).pty)
        if (!match[2] && request.method === "DELETE") return json((await call({ type: "pty.remove", ptyId })).removed)
      }
      return json({ error: { code: "not_found", message: "Unknown PTY route" } }, 404)
    } catch (error) {
      if (error instanceof Response) return ptyErrorResponse(error)
      return json({ error: { code: "invalid_command", message: "Invalid PTY request" } }, 400)
    }
  }
}
