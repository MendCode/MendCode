import { ConsoleOrg, ConsoleState, ConsoleSwitchInput } from "@mendcode/protocol"
import type { HttpPeer } from "./http"

export function consoleOpenApi() {
  const endpoint = (operationId: string, schema: unknown) => ({ operationId, responses: {
    "200": { description: "Success", content: { "application/json": { schema } } },
    "400": { description: "Invalid request" }, "401": { description: "Token required" }, "403": { description: "Full token and non-browser client required" },
  } })
  return {
    "/experimental/console": { get: endpoint("experimental.console.get", ConsoleState.toJSONSchema()) },
    "/experimental/console/orgs": { get: endpoint("experimental.console.listOrgs", { type: "object", required: ["orgs"], properties: { orgs: { type: "array", items: ConsoleOrg.toJSONSchema() } } }) },
    "/experimental/console/switch": { post: { ...endpoint("experimental.console.switchOrg", { type: "boolean" }), requestBody: { required: true, content: { "application/json": { schema: ConsoleSwitchInput.toJSONSchema() } } } } },
  }
}

/** Donor-shaped replies over the same native Console commands; account control stays local. */
export function createHttpConsole(input: {
  body(request: Request): Promise<unknown>
  command(value: Record<string, unknown>, peer: HttpPeer, directory: string, signal: AbortSignal): Promise<Record<string, unknown>>
}) {
  return async (request: Request, url: URL, peer: HttpPeer, directory: string): Promise<Response | undefined> => {
    if (!["/experimental/console", "/experimental/console/orgs", "/experimental/console/switch"].includes(url.pathname)) return undefined
    if (peer.readOnly || request.headers.has("origin")) return Response.json({ error: { code: "forbidden", message: "Console requires a full token and a non-browser client" } }, { status: 403 })
    const switching = url.pathname.endsWith("/switch")
    if (request.method !== (switching ? "POST" : "GET")) return Response.json({ error: { code: "invalid_command", message: "Invalid Console method" } }, { status: 405 })
    const call = (value: Record<string, unknown>) => input.command(value, peer, directory, request.signal)
    try {
      if (switching) {
        const value = ConsoleSwitchInput.parse(await input.body(request))
        await call({ type: "console.switchOrg", ...value })
        return Response.json(true)
      }
      if (url.pathname.endsWith("/orgs")) {
        const result = await call({ type: "console.listOrgs" })
        return Response.json({ orgs: result.orgs })
      }
      const result = await call({ type: "console.get" })
      return Response.json(ConsoleState.parse({ consoleManagedProviders: result.consoleManagedProviders, switchableOrgCount: result.switchableOrgCount, ...(result.activeOrgName ? { activeOrgName: result.activeOrgName } : {}) }))
    } catch (error) {
      if (error instanceof Response) return error
      return Response.json({ error: { code: "invalid_command", message: "Invalid Console request" } }, { status: 400 })
    }
  }
}
