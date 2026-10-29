import { CatalogProvider, RestCredential, RestMcpAdd, RestMcpCallback, RestProviderAuthorize, RestProviderCallback, RestTool, RestLspStatus, FormatterStatus, AgentInfo, SkillsReport, type CatalogRestInput, type McpServerStatus, type McpStatusReport } from "@mendcode/protocol"
import type { HttpPeer } from "./http"
import { restMcpNative } from "./mcp-config"

const routes = [
  ["/config/providers", "get", "config.providers"], ["/auth/{providerID}", "put", "auth.set"], ["/auth/{providerID}", "delete", "auth.remove"],
  ["/experimental/tool", "get", "tool.list"], ["/experimental/tool/ids", "get", "tool.ids"],
  ["/command", "get", "command.list"], ["/agent", "get", "app.agents"], ["/skill", "get", "app.skills"],
  ["/lsp", "get", "lsp.status"], ["/formatter", "get", "formatter.status"],
  ["/mcp", "get", "mcp.status"], ["/mcp", "post", "mcp.add"],
  ["/mcp/{name}/auth", "post", "mcp.auth.start"], ["/mcp/{name}/auth/callback", "post", "mcp.auth.callback"],
  ["/mcp/{name}/auth/authenticate", "post", "mcp.auth.authenticate"], ["/mcp/{name}/auth", "delete", "mcp.auth.remove"],
  ["/mcp/{name}/connect", "post", "mcp.connect"], ["/mcp/{name}/disconnect", "post", "mcp.disconnect"],
  ["/provider", "get", "provider.list"], ["/provider/auth", "get", "provider.auth"],
  ["/provider/{providerID}/oauth/authorize", "post", "provider.oauth.authorize"], ["/provider/{providerID}/oauth/callback", "post", "provider.oauth.callback"],
  ["/experimental/resource", "get", "experimental.resource.list"],
] as const
const object = { type: "object", additionalProperties: true }
const array = { type: "array", items: object }
const stringArray = { type: "array", items: { type: "string" } }
const boolean = { type: "boolean" }
const status = { oneOf: [
  { type: "object", required: ["status"], properties: { status: { enum: ["connected", "disabled", "needs_auth", "pending"] }, expiresAt: { type: "number" } } },
  { type: "object", required: ["status", "error"], properties: { status: { enum: ["failed", "needs_client_registration"] }, error: { type: "string" } } },
] }
const statusMap = { type: "object", additionalProperties: status }
const authorization = { type: "object", required: ["authorizationUrl", "oauthState"], properties: { authorizationUrl: { type: "string" }, oauthState: { type: "string" } } }

export function catalogRestOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {}
  const models = { type: "object", additionalProperties: { type: "object", required: ["id", "providerID"], properties: { id: { type: "string" }, providerID: { type: "string" } }, additionalProperties: true } }
  const providers = { type: "array", items: { type: "object", required: ["id", "name", "models"], properties: { id: { type: "string" }, name: { type: "string" }, models, configured: boolean, enabled: boolean }, additionalProperties: true } }
  const defaults = { type: "object", additionalProperties: { type: "string" } }
  const catalogs: Record<string, unknown> = {
    "provider.list": { type: "object", required: ["all", "default", "connected"], properties: { all: providers, default: defaults, connected: stringArray } },
    "config.providers": { type: "object", required: ["providers", "default"], properties: { providers, default: defaults } },
    "provider.auth": { type: "object", additionalProperties: { type: "array", items: { type: "object", required: ["type", "label"], properties: { type: { enum: ["api", "oauth"] }, label: { type: "string" }, prompts: array } } } },
    "provider.oauth.authorize": { type: "object", required: ["url", "method", "instructions"], properties: { url: { type: "string" }, method: { enum: ["auto", "code"] }, instructions: { type: "string" } } },
    "app.agents": { type: "array", items: AgentInfo.toJSONSchema() },
    "app.skills": { type: "array", items: SkillsReport.shape.skills.element.extend({ location: RestLspStatus.shape.root }).toJSONSchema() },
    "command.list": { type: "array", items: { type: "object", required: ["name", "template"], properties: { name: { type: "string" }, template: { type: "string" }, description: { type: "string" }, argumentHint: { type: "string" }, source: { type: "string" } }, additionalProperties: true } },
  }
  for (const [route, method, operationId] of routes) {
    const payload = operationId === "auth.set" ? RestCredential : operationId === "mcp.add" ? RestMcpAdd : operationId === "mcp.auth.callback" ? RestMcpCallback : operationId === "provider.oauth.authorize" ? RestProviderAuthorize : operationId === "provider.oauth.callback" ? RestProviderCallback : undefined
    const response = operationId === "tool.list" ? { type: "array", items: RestTool.toJSONSchema() } : operationId === "tool.ids" ? stringArray : operationId === "lsp.status" ? { type: "array", items: RestLspStatus.toJSONSchema() } : operationId === "formatter.status" ? { type: "array", items: FormatterStatus.toJSONSchema() } : ["command.list", "app.agents", "app.skills"].includes(operationId) ? array : operationId === "mcp.status" || operationId === "mcp.add" ? statusMap : operationId === "mcp.auth.start" ? authorization : operationId === "mcp.auth.remove" ? { type: "object", required: ["success"], properties: { success: { const: true } } } : operationId.startsWith("mcp.auth.") ? status : operationId === "mcp.connect" || operationId === "mcp.disconnect" || operationId === "auth.set" || operationId === "auth.remove" || operationId === "provider.oauth.callback" ? boolean : object
    const parameters: unknown[] = [{ name: "directory", in: "query", schema: { type: "string" } }, { name: "workspace", in: "query", schema: { type: "string" } }]
    if (route.includes("{providerID}")) parameters.push({ name: "providerID", in: "path", required: true, schema: CatalogProvider.toJSONSchema() })
    if (route.includes("{name}")) parameters.push({ name: "name", in: "path", required: true, schema: { type: "string" } })
    if (operationId === "tool.list") parameters.push(...["provider", "model"].map((name) => ({ name, in: "query", required: true, schema: { type: "string" } })))
    paths[route] ??= {}
    paths[route]![method] = { operationId, parameters,
      ...(payload ? { requestBody: { required: true, content: { "application/json": { schema: payload.toJSONSchema({ io: "input" }) } } } } : {}),
      responses: { "200": { description: "Success (native v2 catalog metadata)", content: { "application/json": { schema: catalogs[operationId] ?? response } } },
        ...(operationId === "mcp.add" ? { "202": { description: "Pending local terminal approval; no connection attempted", content: { "application/json": { schema: statusMap } } } } : {}),
        ...(operationId === "mcp.auth.authenticate" ? { "202": { description: "Open authorization URL explicitly, then complete callback", content: { "application/json": { schema: authorization } } } } : {}),
        "400": { description: "Invalid request or authorization failed" }, "401": { description: "Token required" }, "403": { description: "Full token required or workspace mismatch" }, "404": { description: "Unknown target" }, "409": { description: "Pending authorization" }, "501": { description: "Provider/service adapter unavailable" },
      },
    }
  }
  return paths
}

export function restMcpStatus(server: McpServerStatus) {
  if (server.pending) return { status: "pending", expiresAt: server.pending.expiresAt }
  if (!server.enabled) return { status: "disabled" }
  if (server.auth === "needs_auth" || server.auth === "pending") return { status: "needs_auth" }
  if (server.state === "stopped") return { status: "disabled" }
  if (server.state === "running") return { status: "connected" }
  return { status: "failed", error: "MCP connection failed; inspect native status" }
}
const statusOf = (report: McpStatusReport) => Object.fromEntries(report.servers.map((server) => [server.name, restMcpStatus(server)]))
const authorizationOf = (url: string) => ({ authorizationUrl: url, oauthState: new URL(url).searchParams.get("state") ?? "" })

export function createHttpCatalogRest(input: {
  command(value: Record<string, unknown>, peer: HttpPeer, directory: string, signal: AbortSignal): Promise<Record<string, unknown>>
  body(request: Request): Promise<unknown>
}) {
  return async (request: Request, url: URL, peer: HttpPeer, directory: string): Promise<Response | undefined> => {
    const route = url.pathname
    const auth = /^\/auth\/([^/]+)$/.exec(route)
    const provider = /^\/provider\/([^/]+)\/oauth\/(authorize|callback)$/.exec(route)
    const mcp = /^\/mcp\/([^/]+)\/(auth(?:\/callback|\/authenticate)?|connect|disconnect)$/.exec(route)
    if (!auth && !provider && !mcp && !["/config/providers", "/experimental/tool", "/experimental/tool/ids", "/experimental/resource", "/command", "/agent", "/skill", "/lsp", "/formatter", "/mcp", "/provider", "/provider/auth"].includes(route)) return undefined
    // POST /command is the existing wire bridge; keep its established semantics.
    if (route === "/command" && request.method !== "GET") return undefined
    const json = (body: unknown, status = 200) => Response.json(body, { status })
    if (peer.readOnly) return json({ error: { code: "forbidden", message: "Full token required" } }, 403)
    const call = (command: Record<string, unknown>) => input.command(command, peer, directory, request.signal)
    const control = async (value: CatalogRestInput) => call({ type: "catalog.rest", directory, input: value })
    const read = async (type: string) => call({ type, directory })
    const empty = async () => {
      if (!request.body) return
      const body = await input.body(request)
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) throw new Error("empty body required")
    }
    try {
      if (request.method === "GET") {
        if (route === "/config/providers" || route === "/provider" || route === "/provider/auth" || route === "/lsp" || route === "/command") {
          const operation = route === "/config/providers" ? "config-providers" : route === "/provider" ? "providers" : route === "/provider/auth" ? "auth-methods" : route === "/command" ? "commands" : "lsp"
          return json((await control({ operation })).value)
        }
        if (route === "/experimental/tool" || route === "/experimental/tool/ids") return json((await control({ operation: route.endsWith("/ids") ? "tool-ids" : "tools", ...(url.searchParams.has("provider") ? { provider: url.searchParams.get("provider")! } : {}), ...(url.searchParams.has("model") ? { model: url.searchParams.get("model")! } : {}) })).value)
        if (route === "/agent") return json((await read("agents.list")).agents)
        if (route === "/skill") return json(((await read("skills.list")).skills as Array<{ dir: string }>).map((skill) => ({ ...skill, location: `${skill.dir}/SKILL.md` })))
        if (route === "/formatter") return json((await read("formatter.status")).formatters)
        if (route === "/mcp") return json(statusOf(await read("mcp.status") as McpStatusReport))
        if (route === "/experimental/resource") {
          const resources = (await read("mcp.resources.list")).resources as Array<{ id: string; name: string; uri: string; server: string; description?: string; mimeType?: string }>
          return json(Object.fromEntries(resources.map(({ id, server, ...resource }) => [id, { ...resource, client: server }])))
        }
      }
      if (auth && (request.method === "PUT" || request.method === "DELETE")) {
        const provider = CatalogProvider.parse(decodeURIComponent(auth[1]!))
        if (request.method === "DELETE") { await empty(); return json((await control({ operation: "auth-remove", provider })).value) }
        return json((await control({ operation: "auth-set", provider, credential: RestCredential.parse(await input.body(request)) })).value)
      }
      if (provider && request.method === "POST") {
        const id = CatalogProvider.parse(decodeURIComponent(provider[1]!))
        const value = await input.body(request)
        return json((await control(provider[2] === "authorize" ? { operation: "oauth-authorize", provider: id, ...RestProviderAuthorize.parse(value) } : { operation: "oauth-callback", provider: id, ...RestProviderCallback.parse(value) })).value)
      }
      if (route === "/mcp" && request.method === "POST") {
        const { name, config } = RestMcpAdd.parse(await input.body(request))
        const native = restMcpNative(config)
        const result = await call({ type: "mcp.add", directory, name, scope: "project", config: native, replace: true })
        return json({ [name]: { status: "pending", expiresAt: result.expiresAt } }, 202)
      }
      if (mcp && (request.method === "POST" || request.method === "DELETE")) {
        const server = decodeURIComponent(mcp[1]!)
        const report = await read("mcp.status") as McpStatusReport
        if (!report.servers.some((entry) => entry.name === server)) return json({ error: { code: "not_found", message: "Unknown MCP server" } }, 404)
        if (request.method === "DELETE" && mcp[2] === "auth") { await empty(); await call({ type: "mcp.auth", directory, server, action: "forget" }); return json({ success: true }) }
        if (request.method === "POST") {
          if (mcp[2] === "auth/callback") return json(restMcpStatus((await control({ operation: "mcp-callback", server, ...RestMcpCallback.parse(await input.body(request)) })).value as McpServerStatus))
          await empty()
          if (mcp[2] === "auth") return json(authorizationOf((await call({ type: "mcp.auth", directory, server })).url as string))
          const operation = mcp[2] === "connect" ? "mcp-connect" : mcp[2] === "disconnect" ? "mcp-disconnect" : "mcp-authenticate"
          const result = await control({ operation, server })
          if (result.authorization) return json(authorizationOf(result.authorization as string), 202)
          return json(operation === "mcp-authenticate" ? restMcpStatus(result.value as McpServerStatus) : result.value)
        }
      }
      return json({ error: { code: "not_found", message: "Unknown catalog route or method" } }, 404)
    } catch (error) {
      if (error instanceof Response) return error
      return json({ error: { code: "invalid_command", message: "Invalid catalog request" } }, 400)
    }
  }
}
