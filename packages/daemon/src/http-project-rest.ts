import { ProjectRestInfo, ProjectRestInput, ProjectRestPatch, RestWorkspaceCreate, RestWorkspaceInfo, RestWorktreeCreate, RestWorktreeTarget, SyncBlobPutInput, SyncBlobReadInput, SyncHistoryInput, SyncReplayInput, WorkspaceWarpInput } from "@mendcode/protocol"
import type { HttpPeer } from "./http"

const routes = [
  ["/project", "get", "project.list", "list", "projects"], ["/project/current", "get", "project.current", "current", "project"],
  ["/project/git/init", "post", "project.initGit", "init-git", "project"], ["/project/{projectID}", "patch", "project.update", "update", "project"],
  ["/path", "get", "path.get", "path", "path"], ["/vcs", "get", "vcs.get", "vcs", "vcs"], ["/vcs/diff", "get", "vcs.diff", "vcs-diff", "files"],
  ["/experimental/worktree", "get", "worktree.list", "worktree-list", "directories"], ["/experimental/worktree", "post", "worktree.create", "worktree-create", "worktree"],
  ["/experimental/worktree", "delete", "worktree.remove", "worktree-remove", "removed"], ["/experimental/worktree/reset", "post", "worktree.reset", "worktree-reset", "reset"],
  ["/experimental/workspace/adapter", "get", "experimental.workspace.adapter.list", "workspace-adapters", "adapters"],
  ["/experimental/workspace", "get", "experimental.workspace.list", "workspace-list", "workspaces"], ["/experimental/workspace", "post", "experimental.workspace.create", "workspace-create", "workspace"],
  ["/experimental/workspace/status", "get", "experimental.workspace.status", "workspace-status", "statuses"],
  ["/experimental/workspace/{id}", "delete", "experimental.workspace.remove", "workspace-remove", "workspace"], ["/experimental/workspace/warp", "post", "experimental.workspace.warp", "workspace-warp", ""],
  ["/sync/start", "post", "sync.start", "sync-start", "started"], ["/sync/replay", "post", "sync.replay", "sync-replay", ""],
  ["/sync/steal", "post", "sync.steal", "sync-steal", ""], ["/sync/history", "post", "sync.history.list", "sync-history", "events"],
  // Native extension: the donor carries no blob transfer, so events that reference blobs travel with these two routes.
  ["/sync/blob", "post", "sync.blob.put", "sync-blob-put", ""], ["/sync/blob/read", "post", "sync.blob.read", "sync-blob-read", ""],
] as const

export function projectRestOpenApi() {
  const object = { type: "object" }, string = { type: "string" }, boolean = { type: "boolean" }
  const info = ProjectRestInfo.toJSONSchema(), workspace = RestWorkspaceInfo.toJSONSchema()
  const tree = { type: "object", required: ["name", "branch", "directory"], properties: { name: string, branch: string, directory: string } }
  const schemas: Record<string, object> = { projects: { type: "array", items: info }, project: info, path: { type: "object", required: ["home", "state", "config", "worktree", "directory"], properties: Object.fromEntries(["home", "state", "config", "worktree", "directory"].map((key) => [key, string])) }, vcs: { type: "object", properties: { branch: string, default_branch: string } }, files: { type: "array", items: { type: "object", required: ["file", "patch", "additions", "deletions"], properties: { file: string, patch: string, additions: { type: "integer", minimum: 0 }, deletions: { type: "integer", minimum: 0 }, status: { enum: ["added", "deleted", "modified"] } } } }, directories: { type: "array", items: string }, worktree: tree, removed: boolean, reset: boolean, workspaces: { type: "array", items: workspace }, workspace, adapters: { type: "array", items: { type: "object", required: ["type", "name", "description"], properties: { type: string, name: string, description: string } } }, statuses: { type: "array", items: { type: "object", required: ["workspaceID", "status"], properties: { workspaceID: string, status: { enum: ["connected", "disconnected"] } } } }, started: boolean, events: { type: "array", items: { type: "object", required: ["id", "aggregate_id", "seq", "type", "data"], properties: { id: string, aggregate_id: string, seq: { type: "integer", minimum: 0 }, type: string, data: object } } } }
  const payloads = { update: ProjectRestPatch, "worktree-create": RestWorktreeCreate, "worktree-remove": RestWorktreeTarget, "worktree-reset": RestWorktreeTarget, "workspace-create": RestWorkspaceCreate, "workspace-warp": WorkspaceWarpInput, "sync-replay": SyncReplayInput, "sync-history": SyncHistoryInput, "sync-blob-put": SyncBlobPutInput, "sync-blob-read": SyncBlobReadInput }
  const paths: Record<string, Record<string, unknown>> = {}
  for (const [route, method, operationId, operation, result] of routes) {
    const payload = payloads[operation as keyof typeof payloads]?.toJSONSchema({ io: "input" }) ?? (operation === "sync-steal" ? { type: "object", required: ["sessionID"], additionalProperties: false, properties: { sessionID: string } } : undefined)
    const noContent = operation === "workspace-warp"
    const schema = result ? schemas[result] : operation === "sync-blob-put" ? { type: "object", required: ["sha256", "bytes", "received", "stored"], properties: { sha256: string, bytes: { type: "integer" }, received: { type: "integer" }, stored: boolean } } : operation === "sync-blob-read" ? { type: "object", required: ["sha256", "mime", "bytes", "offset", "data", "done"], properties: { sha256: string, mime: string, bytes: { type: "integer" }, offset: { type: "integer" }, data: { type: "string", description: "base64 chunk" }, done: boolean } } : { type: "object", required: ["sessionID"], properties: { sessionID: string } }
    const parameters: object[] = [{ name: "directory", in: "query", schema: string }, { name: "workspace", in: "query", schema: string }]
    if (route.includes("{")) parameters.push({ name: route.includes("projectID") ? "projectID" : "id", in: "path", required: true, schema: string })
    if (operation === "vcs-diff") parameters.push({ name: "mode", in: "query", required: true, schema: { enum: ["git", "branch"] } })
    const path = paths[route] ??= {}
    path[method] = { operationId, parameters, ...(payload ? { requestBody: { required: operation !== "worktree-create", content: { "application/json": { schema: payload } } } } : {}), responses: { [noContent ? "204" : "200"]: { description: "Success", ...(noContent ? {} : { content: { "application/json": { schema } } }) }, "400": { description: "Invalid payload" }, "401": { description: "Token required" }, "403": { description: "Full token or matching project required" }, "404": { description: "Unknown session" }, "409": { description: "Busy, unsafe worktree or conflicting history" }, "501": { description: "Unsupported donor event, adapter or startup policy" } } }
  }
  return paths
}

export function createHttpProjectRest(input: {
  body(request: Request): Promise<unknown>
  command(command: Record<string, unknown>, peer: HttpPeer, directory: string, signal: AbortSignal): Promise<Record<string, unknown>>
}) {
  return async (request: Request, url: URL, peer: HttpPeer, directory: string): Promise<Response | undefined> => {
    const project = /^\/project\/([^/]+)$/.exec(url.pathname)
    const workspace = /^\/experimental\/workspace\/(ws_[a-f0-9]{24})$/.exec(url.pathname)
    const route = routes.find(([path, method]) => method.toUpperCase() === request.method && (path === url.pathname || path === "/project/{projectID}" && project || path === "/experimental/workspace/{id}" && workspace))
    if (!route && !routes.some(([path]) => path === url.pathname) && !project && !workspace) return undefined
    if (peer.readOnly) return Response.json({ error: { code: "forbidden", message: "Full token required" } }, { status: 403 })
    if (request.method !== "GET" && request.headers.has("origin")) return Response.json({ error: { code: "forbidden", message: "Project mutations require a non-browser client" } }, { status: 403 })
    if (!route) return Response.json({ error: { code: "invalid_command", message: "Invalid project method" } }, { status: 405 })
    try {
      const [, , , operation, field] = route
      const body = () => request.body ? input.body(request) : Promise.resolve({})
      let value: Record<string, unknown> = { operation }
      if (operation === "update") value = { operation, projectID: decodeURIComponent(project![1]!), patch: ProjectRestPatch.parse(await body()) }
      if (operation === "vcs-diff") value = { operation, mode: url.searchParams.get("mode") }
      if (operation === "worktree-create") value = { operation, input: RestWorktreeCreate.parse(await body()) }
      if (operation === "worktree-remove" || operation === "worktree-reset") value = { operation, input: RestWorktreeTarget.parse(await body()) }
      if (operation === "workspace-create") {
        const raw = await body()
        // Preserve the pre-existing native registration payload and its wrapper.
        if (raw && typeof raw === "object" && ("adapter" in raw || "directory" in raw)) return Response.json(await input.command({ ...raw, type: "workspace.create" }, peer, directory, request.signal))
        value = { operation, input: RestWorkspaceCreate.parse(raw) }
      }
      if (operation === "workspace-remove") value = { operation, id: workspace![1] }
      if (operation === "workspace-warp") value = { operation, input: WorkspaceWarpInput.parse(await body()) }
      if (operation === "sync-replay") value = { operation, input: SyncReplayInput.parse(await body()) }
      if (operation === "sync-history") value = { operation, cursors: SyncHistoryInput.parse(await body()) }
      if (operation === "sync-blob-put") value = { operation, input: SyncBlobPutInput.parse(await body()) }
      if (operation === "sync-blob-read") value = { operation, input: SyncBlobReadInput.parse(await body()) }
      if (operation === "sync-steal") {
        const raw = await body()
        if (!raw || typeof raw !== "object" || Object.keys(raw).some((key) => key !== "sessionID")) throw new Error("Invalid steal payload")
        value = { operation, sessionID: (raw as { sessionID?: unknown }).sessionID }
      }
      if (operation === "init-git" || operation === "sync-start") {
        const raw = await body()
        if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length) throw new Error("Expected empty body")
      }
      const result = await input.command({ type: "project.rest", directory, input: ProjectRestInput.parse(value) }, peer, directory, request.signal)
      if (operation === "workspace-remove" && result.nativeWorkspace) return Response.json({ workspace: result.nativeWorkspace })
      if (operation === "workspace-warp" || operation === "workspace-remove" && result.workspace === undefined) return new Response(null, { status: 204 })
      if (operation === "sync-history") return Response.json(result.events, { headers: { "x-mendcode-sync-more": String(result.hasMore === true) } })
      return Response.json(field ? result[field] : result)
    } catch (error) {
      if (error instanceof Response) return error
      return Response.json({ error: { code: "invalid_command", message: "Invalid project payload" } }, { status: 400 })
    }
  }
}
