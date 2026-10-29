import { FileContent, FileNode, FilePathQuery, FileSearchMatch, FileStatus, FileSymbol, FindFileQuery, FindSymbolQuery, FindTextQuery } from "@mendcode/protocol"
import type { HttpPeer } from "./http"

const routes = [
  ["/find", "find.text", FindTextQuery, FileSearchMatch.array()],
  ["/find/file", "find.files", FindFileQuery, { toJSONSchema: () => ({ type: "array", items: { type: "string" } }) }],
  ["/find/symbol", "find.symbols", FindSymbolQuery, FileSymbol.array()],
  ["/file", "file.list", FilePathQuery, FileNode.array()],
  ["/file/content", "file.read", FilePathQuery, FileContent],
  ["/file/status", "file.status", undefined, FileStatus.array()],
] as const

export function fileRestOpenApi() {
  return Object.fromEntries(routes.map(([route, operationId, query, response]) => [route, { get: {
    operationId,
    parameters: [
      ...Object.entries(query?.toJSONSchema().properties ?? {}).map(([name, schema]) => ({ name, in: "query", required: query?.toJSONSchema().required?.includes(name) ?? false, schema })),
      { name: "directory", in: "query", schema: { type: "string" } }, { name: "workspace", in: "query", schema: { type: "string" } },
    ],
    responses: {
      "200": { description: "Success", content: { "application/json": { schema: response.toJSONSchema() } } },
      "400": { description: "Invalid query, pattern or file/output limit" }, "401": { description: "Token required" },
      "403": { description: "Full token required or path/workspace mismatch" }, "405": { description: "GET required" },
      "501": { description: "ripgrep is not installed" },
    },
  } }]))
}

export function createHttpFiles(input: { command(value: Record<string, unknown>, peer: HttpPeer, directory: string, signal: AbortSignal): Promise<Record<string, unknown>> }) {
  return async (request: Request, url: URL, peer: HttpPeer, directory: string): Promise<Response | undefined> => {
    const route = routes.find(([path]) => path === url.pathname)
    if (!route) return undefined
    if (peer.readOnly) return Response.json({ error: { code: "forbidden", message: "Full token required" } }, { status: 403 })
    if (request.method !== "GET") return Response.json({ error: { code: "invalid_command", message: "GET required" } }, { status: 405, headers: { allow: "GET" } })
    const [, operation, schema] = route
    const params: Record<string, string> = {}
    for (const [key, value] of url.searchParams) {
      if (["directory", "workspace"].includes(key)) continue
      if (key in params) return Response.json({ error: { code: "invalid_command", message: "Duplicate file query parameter" } }, { status: 400 })
      params[key] = value
    }
    const parsed = schema?.safeParse(params)
    if (parsed && !parsed.success || !schema && Object.keys(params).length) return Response.json({ error: { code: "invalid_command", message: "Invalid file query" } }, { status: 400 })
    const query = parsed?.success ? parsed.data : {}
    try {
      const result = await input.command({ type: "file.rest.read", directory, input: { operation, ...query, ...("dirs" in query ? { dirs: query.dirs !== "false" } : {}) } }, peer, directory, request.signal)
      return Response.json(result.value)
    } catch (error) {
      if (error instanceof Response) {
        const body = await error.json()
        return Response.json(body, { status: body.error?.message === "ripgrep is not installed" ? 501 : error.status })
      }
      return Response.json({ error: { code: "invalid_command", message: "File request failed" } }, { status: 400 })
    }
  }
}
