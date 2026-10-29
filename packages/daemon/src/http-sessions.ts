import { createIdFactory, RestCommand, RestInit, RestModel, RestPartUpdate, RestPrompt, RestReadInput, RestSessionCreate, RestSessionUpdate, RestShell, RestSummarize, RestV2Prompt, RestSessionDto, RestMessageDto, RestAgentViewDto, SessionId, ItemId, RequestId, TurnOptions, type BlobRef, type RestMessage, type RestSession, type RestReadInput as ReadInput } from "@mendcode/protocol"
import type { HttpPeer } from "./http"

const INIT = "Analyze this repository and create or update its AGENTS.md with compact, verified project instructions. Read existing instructions, manifests, build/test configuration and representative entrypoints first. Preserve useful guidance; record only facts supported by the repository."
const ids = createIdFactory()
const routes = [
  ["/experimental/session", "get", "experimental.session.list"],
  ["/experimental/usage-insights", "get", "experimental.usageInsights.get"],
  ["/session", "get", "session.list"], ["/session", "post", "session.create"],
  ["/session/status", "get", "session.status"], ["/session/agent-view", "get", "session.agent_view.list"],
  ["/session/{sessionID}", "get", "session.get"], ["/session/{sessionID}", "patch", "session.update"], ["/session/{sessionID}", "delete", "session.delete"],
  ...["children", "todo", "diff"].map((name) => [`/session/{sessionID}/${name}`, "get", `session.${name}`]),
  ["/session/{sessionID}/message", "get", "session.messages"], ["/session/{sessionID}/message/{messageID}", "get", "session.message"],
  ["/session/{sessionID}/message", "post", "session.prompt"],
  ["/session/{sessionID}/message/{messageID}", "delete", "session.deleteMessage"],
  ["/session/{sessionID}/message/{messageID}/part/{partID}", "delete", "part.delete"], ["/session/{sessionID}/message/{messageID}/part/{partID}", "patch", "part.update"],
  ["/session/{sessionID}/shell", "post", "session.shell"],
  ...["fork", "abort", "cancel-turn", "interrupt", "init", "summarize", "prompt_async", "command", "revert", "unrevert"].map((name) => [`/session/{sessionID}/${name}`, "post", `session.${name === "cancel-turn" ? "cancelTurn" : name}`]),
  ["/session/{sessionID}/permissions/{permissionID}", "post", "permission.respond"],
  ["/api/session", "get", "v2.session.list"], ["/api/session/{sessionID}/message", "get", "v2.session.messages"],
  ...["prompt", "compact", "wait"].map((name) => [`/api/session/{sessionID}/${name}`, "post", `v2.session.${name}`]),
  ["/api/session/{sessionID}/context", "get", "v2.session.context"],
] as const

export function sessionRestOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {}
  const payloads: Record<string, unknown> = {
    "session.create": RestSessionCreate.toJSONSchema(), "session.update": RestSessionUpdate.toJSONSchema(),
    "session.prompt": RestPrompt.toJSONSchema(), "session.prompt_async": RestPrompt.toJSONSchema(),
    "v2.session.prompt": RestV2Prompt.toJSONSchema(), "session.init": RestInit.toJSONSchema(), "session.summarize": RestSummarize.toJSONSchema(), "session.command": RestCommand.toJSONSchema(),
    "session.shell": RestShell.toJSONSchema(), "part.update": RestPartUpdate.toJSONSchema(),
    "session.fork": { type: "object", additionalProperties: false, properties: { messageID: { type: "string" } } },
    "session.cancelTurn": { type: "object", additionalProperties: false, required: ["targetMessageID"], properties: { targetMessageID: { type: "string" } } },
    "session.revert": { type: "object", additionalProperties: false, required: ["messageID"], properties: { messageID: { type: "string" }, partID: { type: "string" } } },
    "permission.respond": { type: "object", additionalProperties: false, required: ["response"], properties: { response: { enum: ["once", "always", "reject"] } } },
  }
  for (const [route, method, operationId] of routes) {
    const noContent = ["session.prompt_async", "v2.session.compact", "v2.session.wait"].includes(operationId)
    const parameters: unknown[] = [...route.matchAll(/\{(\w+)\}/g)].map((match) => ({ name: match[1], in: "path", required: true, schema: { type: "string" } }))
    parameters.push({ name: "directory", in: "query", schema: { type: "string" } })
    if (method === "get" && !["session.get", "session.status", "session.children", "session.todo", "v2.session.context"].includes(operationId)) for (const name of ["limit", "order", "cursor", "before", "after", "roots", "start", "search", "archived", "view", "unit", "partsLimit", "partsAfter", "messageID"]) parameters.push({ name, in: "query", schema: { type: "string" } })
    if (["session.list", "session.agent_view.list", "experimental.session.list", "v2.session.list"].includes(operationId)) {
      parameters.push({ name: "scope", in: "query", description: "project lists every session of the selected workspace's project, not only its directory", schema: { type: "string", enum: ["project"] } })
      parameters.push({ name: "path", in: "query", description: "Project-relative directory; lists sessions at or below it across the project. An empty value lists the whole project", schema: { type: "string" } })
    }
    const session = RestSessionDto.toJSONSchema(), message = RestMessageDto.toJSONSchema()
    const schema = ["session.list", "experimental.session.list", "session.children"].includes(operationId) ? { type: "array", items: session }
      : ["session.get", "session.create", "session.update", "session.fork", "session.revert", "session.unrevert"].includes(operationId) ? session
      : ["session.message", "session.prompt", "session.command", "session.shell"].includes(operationId) ? message
      : operationId === "session.messages" ? { type: "array", items: message }
      : operationId === "session.agent_view.list" ? { type: "array", items: RestAgentViewDto.toJSONSchema() }
      : operationId === "v2.session.list" || operationId === "v2.session.messages" ? { type: "object", required: ["items", "cursor"], properties: { items: { type: "array", items: operationId === "v2.session.list" ? session : { type: "object", required: ["id", "type", "time"] } }, cursor: { type: "object", properties: { previous: { type: "string" }, next: { type: "string" } } } } }
      : operationId === "session.cancelTurn" ? { type: "string", enum: ["cancelled", "already_terminal", "target_mismatch", "not_running"] }
      : ["session.abort", "session.interrupt", "session.delete", "session.init", "session.summarize", "permission.respond", "session.deleteMessage", "part.delete"].includes(operationId) ? { type: "boolean" } : { type: "object" }
    const responses = { [noContent ? "204" : "200"]: { description: noContent ? "Completed without content" : "v1-compatible projection with native v2 identifiers; unknown provider counters omitted", ...(!noContent ? { content: { "application/json": { schema } } } : {}) }, "400": { description: "Invalid or unsupported payload/cursor" }, "401": { description: "Token required" }, "403": { description: "Forbidden or workspace mismatch" }, "404": { description: "Session or message missing" }, "409": { description: "Busy or wait deadline" }, "501": { description: "Prompt option on a non-native engine (noReply, tools, format), file: URLs, or engine without compaction options" } }
    paths[route] ??= {}
    paths[route]![method] = { operationId, parameters, responses, ...(payloads[operationId] ? { requestBody: { required: operationId !== "session.create" && operationId !== "session.fork", content: { "application/json": { schema: payloads[operationId] } } } } : {}) }
  }
  return paths
}

export function createHttpSessions(input: {
  command(value: Record<string, unknown>, peer: HttpPeer, directory: string, signal: AbortSignal): Promise<Record<string, unknown>>
  body(request: Request): Promise<unknown>
}) {
  return async (request: Request, url: URL, peer: HttpPeer, directory: string): Promise<Response | undefined> => {
    const route = url.pathname
    if (!/^\/(?:session(?:\/|$)|api\/session(?:\/|$)|experimental\/(?:session|usage-insights)$)/.test(route)) return undefined
    const json = (value: unknown, status = 200, headers?: Record<string, string>) => Response.json(value, { status, ...(headers ? { headers } : {}) })
    const call = (value: Record<string, unknown>) => input.command(value, peer, directory, request.signal)
    const choice = async (model: { providerID: string; modelID: string; variant?: string | undefined }) => {
      const report = await call({ type: "models.list" })
      const models = report.models as Array<{ id: string; provider?: string }>
      const found = models.find((entry) => (entry.provider ?? "openai") === model.providerID && [model.modelID, `${model.providerID}:${model.modelID}`].includes(entry.id))
      if (!found) throw json({ error: { code: "invalid_command", message: "Unknown provider/model pair" } }, 400)
      return { model: found.id, ...(model.variant ? { variant: model.variant } : {}) }
    }
    const read = (query: ReadInput) => call({ type: "session.rest.read", directory, input: RestReadInput.parse(query) })
    const body = async (): Promise<Record<string, unknown>> => {
      if (!request.body) return {}
      const value = await input.body(request)
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object body required")
      return value as Record<string, unknown>
    }
    const number = (key: string) => {
      const value = url.searchParams.get(key)
      if (value === null) return undefined
      if (!/^\d+$/.test(value)) throw new Error("invalid number")
      return Number(value)
    }
    const boolean = (key: string) => {
      if (!url.searchParams.has(key)) return undefined
      const value = url.searchParams.get(key)
      if (value !== "true" && value !== "false") throw new Error("invalid boolean")
      return value === "true"
    }
    const query = () => {
      const value = Object.fromEntries([...url.searchParams].filter(([key]) => !["directory", "workspace"].includes(key)))
      for (const key of ["limit", "start", "partsLimit", "messageLimit"]) if (key in value) (value as Record<string, unknown>)[key] = number(key)
      if (route.startsWith("/api/session") && value.limit !== undefined && (Number(value.limit) < 1 || Number(value.limit) > 200)) throw new Error("v2 limit must be 1..200")
      for (const key of ["roots", "archived"]) if (key in value) (value as Record<string, unknown>)[key] = boolean(key)
      if (value.messageID) { (value as Record<string, unknown>).messageId = value.messageID; delete value.messageID }
      if (route === "/experimental/session" && value.cursor && /^\d+$/.test(value.cursor)) { (value as Record<string, unknown>).updatedBefore = number("cursor"); delete value.cursor }
      return value
    }
    const paging = (value: Record<string, unknown>, v2 = false) => {
      if (v2) return json(value)
      const cursors = value.cursor as { previous?: string; next?: string } | undefined
      const headers: Record<string, string> = { "Access-Control-Expose-Headers": "Link, X-Next-Cursor, X-Older-Cursor, X-Newer-Cursor, X-Truncated" }
      const asc = route.endsWith("/message") && url.searchParams.get("order") !== "desc"
      const older = asc ? cursors?.previous : cursors?.next, newer = asc ? cursors?.next : cursors?.previous
      if (older) headers["X-Older-Cursor"] = older
      if (newer) headers["X-Newer-Cursor"] = newer
      const cursor = route.endsWith("/message") ? url.searchParams.has("after") ? newer : older : cursors?.next
      if (cursor) {
        headers["X-Next-Cursor"] = cursor
        const next = new URL(url)
        for (const key of ["before", "after", "order", "roots", "start", "search", "archived", "scope", "path"]) next.searchParams.delete(key)
        next.searchParams.set("cursor", cursor)
        headers.Link = `<${next}>; rel="next"`
      }
      if (route === "/experimental/session" && cursors?.next) {
        const items = value.items as RestSession[]
        headers["X-Next-Cursor"] = String(items.at(-1)!.time.updated)
        delete headers.Link
      }
      if (value.truncated) headers["X-Truncated"] = "true"
      return json(value.items, 200, headers)
    }
    const get = async (id: string) => (await read({ operation: "get", sessionId: SessionId.parse(id) })).value as RestSession
    const unsupported = (message: string) => json({ error: { code: "unsupported", message } }, 501)
    /** A `data:` URL's bytes. Local paths and remote URLs are never fetched for a REST client. */
    const dataUrl = (url: string) => {
      if (!url.startsWith("data:")) throw unsupported("File parts must be data: URLs; the daemon does not read local paths or URLs for REST clients")
      const comma = url.indexOf(",")
      if (comma < 0) throw new Error("invalid data URL")
      const base64 = url.slice(5, comma).endsWith(";base64")
      const payload = url.slice(comma + 1)
      return base64 ? { base64: payload.replace(/\s+/g, ""), text: undefined } : { base64: undefined, text: decodeURIComponent(payload) }
    }
    /** Prompt parts to what the model reads (`text`), what the transcript shows (`displayText`) and the stored attachments. */
    const compose = async (parts: Array<{ type: string; [key: string]: unknown }>, system?: string) => {
      const model: string[] = system ? [`[Instructions for this turn]\n${system}`] : []
      const shown: string[] = []
      const attachments: BlobRef[] = []
      for (const part of parts) {
        if (part.type === "text") {
          const text = String(part.text)
          if (part.ignored) shown.push(text)
          else { model.push(text); if (!part.synthetic) shown.push(text) }
        } else if (part.type === "file") {
          const name = String(part.filename ?? "attachment"), mime = String(part.mime).toLowerCase(), data = dataUrl(String(part.url))
          if (data.text !== undefined || mime.startsWith("text/") || mime === "application/json") {
            const text = data.text ?? Buffer.from(data.base64!, "base64").toString("utf8")
            if (text.length > 64_000) throw new Error("text file too large")
            model.push(`File ${name}:\n${text}`)
            shown.push(`[file ${name}]`)
          } else attachments.push((await call({ type: "attachment.put", name, data: data.base64! })).attachment as BlobRef)
        } else if (part.type === "agent") {
          const hint = `Use the ${String(part.name)} agent for this request through the task tool.`
          model.push(hint)
        } else if (part.type === "subtask") {
          const text = `Delegate this to the ${String(part.agent)} agent through the task tool${part.description ? ` (${String(part.description)})` : ""}:\n${String(part.prompt)}`
          model.push(text)
          shown.push(text)
        }
      }
      let text = model.join("\n")
      if (!text.trim() && !attachments.length) throw new Error("empty prompt")
      if (!text.trim()) text = "See the attached file(s)."
      const display = shown.join("\n")
      return { text, attachments, ...(display !== text ? { displayText: display || "(context)" } : {}) }
    }
    type Submission = { text: string; displayText?: string; attachments?: BlobRef[]; messageId?: string; agent?: string; model?: { providerID: string; modelID: string; variant?: string | undefined }; turnOptions?: TurnOptions }
    const submit = async (sessionId: string, payload: Submission, wait: boolean, v2 = false) => {
      const selection = payload.agent || payload.model ? { ...(payload.agent ? { agent: payload.agent } : {}), ...(payload.model ? { model: await choice(payload.model) } : {}) } : undefined
      // A caller-chosen (or generated) id keeps the message stable from admission, even while it waits behind a running turn.
      const messageId = payload.messageId ?? ids("item")
      const reply = await call({ type: "user.submit", sessionId, text: payload.text, attachments: payload.attachments ?? [], messageId, ...(payload.displayText !== undefined ? { displayText: payload.displayText } : {}), ...(selection ? { selection } : {}), ...(payload.turnOptions ? { turnOptions: payload.turnOptions } : {}) })
      if (wait) await call({ type: "session.rest.control", sessionId, operation: "wait", queueId: reply.queueId })
      const messages = wait ? await read({ operation: "messages", sessionId: SessionId.parse(sessionId), limit: 500, queueId: reply.queueId as ReadInput["queueId"] }) : { items: [] }
      const items = messages.items as RestMessage[]
      const user = items.findLast((message) => message.info.role === "user")
      if (v2) return json({ id: messageId, type: "user", text: user?.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? payload.displayText ?? payload.text, time: user?.info.time ?? { created: Date.now() } })
      return json(items.findLast((message) => message.info.role === "assistant" && (!user || message.info.parentID === user.info.id)) ?? user ?? { queueId: reply.queueId, messageID: messageId })
    }
    /** The model of the request, with a bare `variant` applied to the session's current model. */
    const withVariant = async (sessionId: string, model: { providerID: string; modelID: string; variant?: string | undefined } | undefined, variant: string | undefined) => {
      if (!variant) return model
      const base = model ?? (await get(sessionId)).model
      if (!base) throw new Error("variant needs a model")
      return { providerID: base.providerID, modelID: base.modelID, variant }
    }
    try {
      if (request.method === "GET" && ["/session", "/experimental/session", "/api/session", "/session/agent-view", "/session/status"].includes(route)) {
        const v2 = route === "/api/session"
        const global = route === "/experimental/session" && !url.searchParams.has("directory") && !url.searchParams.has("workspace") && !request.headers.has("x-opencode-directory") && !request.headers.has("x-mendcode-workspace")
        const value = await read({ ...query(), operation: route === "/session/status" ? "status" : route === "/session/agent-view" ? "agent-view" : "list", ...(route === "/experimental/session" ? { global } : {}), ...(v2 ? { v2: true } : {}) })
        return "value" in value ? json(value.value) : paging(value, v2)
      }
      if (route === "/experimental/usage-insights" && request.method === "GET") {
        const start = number("start")
        if (start === undefined || !Number.isSafeInteger(start) || start < 0 || start > Date.now()) throw new Error("invalid usage start")
        const value = await read({ ...query(), operation: "usage", start })
        return json(value.value)
      }
      if (route === "/session" && request.method === "POST") {
        const payload = RestSessionCreate.parse(await body())
        const created = await call({ type: "session.create", directory, title: payload.title, parentId: payload.parentID, agent: payload.agent, ...(payload.model ? { choice: await choice(payload.model) } : {}) })
        if (payload.permission?.length) await call({ type: "session.rest.update", sessionId: SessionId.parse(created.sessionId), patch: { permission: payload.permission } })
        return json(await get(String(created.sessionId)))
      }
      const match = /^\/(api\/)?session\/([^/]+)(?:\/(.*))?$/.exec(route)
      if (!match) return json({ error: { code: "not_found", message: "unknown session route" } }, 404)
      const sessionId = SessionId.parse(decodeURIComponent(match[2]!)), action = match[3] ?? "", isV2 = !!match[1]
      if (!action && request.method === "GET") return json(await get(sessionId))
      if (!action && request.method === "PATCH") return json((await call({ type: "session.rest.update", sessionId, patch: RestSessionUpdate.parse(await body()) })).value)
      if (!action && request.method === "DELETE") { await call({ type: "session.delete", sessionId }); return json(true) }
      if (request.method === "GET") {
        const single = /^message\/([^/]+)$/.exec(action)
        if (single) return json((await read({ ...query(), operation: "message", sessionId, messageId: ItemId.parse(decodeURIComponent(single[1]!)) })).value)
        if (["children", "todo", "diff", "context", "message"].includes(action)) {
          const value = await read({ ...query(), operation: action === "message" ? "messages" : action as ReadInput["operation"], sessionId, ...(isV2 ? { v2: true } : {}) })
          if (action === "context" && "value" in value) return json(value.value, 200, { "X-Context-Source": value.source === "engine" ? "engine" : "transcript", ...(value.truncated ? { "X-Truncated": "true", "Access-Control-Expose-Headers": "X-Truncated, X-Context-Source" } : { "Access-Control-Expose-Headers": "X-Context-Source" }) })
          return "value" in value ? json(value.value) : paging(value, isV2)
        }
      }
      const edit = !isV2 ? /^message\/([^/]+)(?:\/part\/([^/]+))?$/.exec(action) : null
      if (edit && (request.method === "DELETE" || (request.method === "PATCH" && edit[2]))) {
        await get(sessionId)
        const messageId = ItemId.parse(decodeURIComponent(edit[1]!)), partId = edit[2] ? decodeURIComponent(edit[2]) : undefined
        let text: string | undefined
        if (request.method === "PATCH") {
          const update = RestPartUpdate.parse(await body())
          if (update.id !== partId || (update.messageID && update.messageID !== messageId) || (update.sessionID && update.sessionID !== sessionId)) throw new Error("part identity mismatch")
          if (update.type !== "text" || update.text === undefined) throw new Error("only text parts can be updated")
          text = update.text
        }
        const operation = request.method === "PATCH" ? "update-part" : partId ? "delete-part" : "delete-message"
        return json((await call({ type: "session.rest.mutate", sessionId, operation, messageId, ...(partId ? { partId } : {}), ...(text !== undefined ? { text } : {}) })).value)
      }
      if (request.method !== "POST") return json({ error: { code: "not_found", message: "unknown session route" } }, 404)
      await get(sessionId)
      const payload = await body()
      if (["abort", "interrupt", "wait", "cancel-turn"].includes(action)) {
        const allowed = action === "cancel-turn" ? ["targetMessageID"] : []
        if (Object.keys(payload).some((key) => !allowed.includes(key))) throw new Error("invalid control payload")
        const result = await call({ type: "session.rest.control", sessionId, operation: action, ...(action === "cancel-turn" ? { targetMessageId: ItemId.parse(payload.targetMessageID) } : {}) })
        return isV2 && action === "wait" ? new Response(null, { status: 204 }) : json(result.value)
      }
      if (action === "fork") {
        if (Object.keys(payload).some((key) => key !== "messageID")) throw new Error("invalid fork payload")
        const created = await call({ type: "session.fork", sessionId, transcript: true, ...(payload.messageID ? { beforeItemId: ItemId.parse(payload.messageID) } : {}) })
        return json(await get(String(created.sessionId)))
      }
      if (action === "message" || action === "prompt_async" || isV2 && action === "prompt") {        if (isV2) {
          const parsed = RestV2Prompt.parse(payload)
          const files = (parsed.prompt.files ?? []).map((file) => ({ type: "file", mime: file.mime, url: file.uri, ...(file.name ? { filename: file.name } : {}) }))
          const agents = (parsed.prompt.agents ?? []).map((agent) => ({ type: "agent", name: agent.name }))
          const composed = await compose([{ type: "text", text: parsed.prompt.text }, ...files, ...agents])
          return await submit(sessionId, composed, parsed.delivery !== "deferred", true)
        }
        const parsed = RestPrompt.parse(payload)
        // A prompt can only narrow its turn: `tools: { name: false }` removes a tool, `true` never adds one the agent and permissions withhold.
        const excludeTools = Object.entries(parsed.tools ?? {}).filter(([, enabled]) => !enabled).map(([name]) => name)
        const format = parsed.format?.type === "json_schema" ? { schema: parsed.format.schema, ...(parsed.format.retryCount !== undefined ? { retries: parsed.format.retryCount } : {}) } : undefined
        const turnOptions = TurnOptions.parse({ ...(parsed.noReply ? { noReply: true } : {}), ...(excludeTools.length ? { excludeTools } : {}), ...(format ? { format } : {}) })
        const composed = await compose(parsed.parts, parsed.system)
        const model = await withVariant(sessionId, parsed.model, parsed.variant)
        const input = { ...composed, ...(parsed.messageID ? { messageId: parsed.messageID } : {}), ...(parsed.agent ? { agent: parsed.agent } : {}), ...(model ? { model } : {}), ...(Object.keys(turnOptions).length ? { turnOptions } : {}) }
        if (action === "prompt_async") { await submit(sessionId, input, false); return new Response(null, { status: 204 }) }
        return await submit(sessionId, input, true)
      }
      if (action === "command" || action === "init") {
        if (action === "init") {
          const parsed = RestInit.parse(payload)
          await submit(sessionId, { text: INIT, messageId: parsed.messageID, model: { providerID: parsed.providerID, modelID: parsed.modelID } }, true)
          return json(true)
        }
        const parsed = RestCommand.parse(payload)
        let text = INIT
        let defaults: { agent?: string; model?: string; subtask?: boolean } = {}
        if (parsed.command === "init" && parsed.arguments.trim()) text += `\n\nFocus: ${parsed.arguments.trim()}`
        if (parsed.command !== "init") {
          const expanded = await call({ type: "commands.expand", directory, name: parsed.command, args: parsed.arguments })
          text = String(expanded.prompt)
          defaults = { ...(typeof expanded.agent === "string" ? { agent: expanded.agent } : {}), ...(typeof expanded.model === "string" ? { model: expanded.model } : {}), ...(expanded.subtask === true ? { subtask: true } : {}) }
        }
        const agent = parsed.agent ?? defaults.agent
        // A sub-task command is delegated to its agent through the task tool; the turn itself stays on the session's agent.
        if (defaults.subtask) text = `Delegate this to ${agent ? `the ${agent} agent` : "a sub-agent"} through the task tool:\n${text}`
        const spec = parsed.model ?? defaults.model
        const slash = spec?.indexOf("/") ?? -1
        if (spec && slash < 1) throw new Error("model must be provider/model")
        const model = await withVariant(sessionId, spec ? RestModel.parse({ providerID: spec.slice(0, slash), modelID: spec.slice(slash + 1) }) : undefined, parsed.variant)
        const composed = await compose([{ type: "text", text }, ...(parsed.parts ?? [])])
        return await submit(sessionId, { ...composed, ...(parsed.messageID ? { messageId: parsed.messageID } : {}), ...(agent && !defaults.subtask ? { agent } : {}), ...(model ? { model } : {}) }, true)
      }
      if (action === "shell") {
        const parsed = RestShell.parse(payload)
        const known = (await call({ type: "agents.list", directory })).agents as Array<{ name: string }> | undefined
        if (known && !known.some((agent) => agent.name === parsed.agent)) throw new Error("unknown agent")
        if (parsed.model) await choice(parsed.model)
        const messageId = parsed.messageID ?? ids("item")
        const queued = await call({ type: "user.shell", sessionId, command: parsed.command, messageId })
        await call({ type: "session.rest.control", sessionId, operation: "wait", queueId: queued.queueId })
        const items = (await read({ operation: "messages", sessionId: SessionId.parse(sessionId), limit: 500, queueId: queued.queueId as ReadInput["queueId"] })).items as RestMessage[]
        const user = items.findLast((message) => message.info.role === "user")
        const output = items.findLast((message) => message.info.role === "assistant" && (!user || message.info.parentID === user.info.id)) ?? user
        // The requested agent and model describe this run; the transcript stores the session's own.
        return json(output ? { ...output, info: { ...output.info, agent: parsed.agent, ...(parsed.model ? { model: parsed.model } : {}) } } : { queueId: queued.queueId, messageID: messageId })
      }
      if (action === "summarize" || isV2 && action === "compact") {
        const options: { instructions?: string; model?: { model: string; variant?: string | undefined } } = {}
        if (action === "summarize") {
          const parsed = RestSummarize.parse(payload)
          const current = await get(sessionId)
          if (parsed.instructions?.trim()) options.instructions = parsed.instructions.trim()
          if (current.model?.modelID !== parsed.modelID || current.model?.providerID !== parsed.providerID) options.model = await choice({ providerID: parsed.providerID, modelID: parsed.modelID })
        } else if (Object.keys(payload).length) throw new Error("invalid compact payload")
        const queued = await call({ type: "session.compact", sessionId, ...options })
        await call({ type: "session.rest.control", sessionId, operation: "wait", queueId: queued.queueId })
        return isV2 ? new Response(null, { status: 204 }) : json(true)
      }
      if (action === "revert" || action === "unrevert") {
        if (Object.keys(payload).some((key) => action === "revert" ? !["messageID", "partID"].includes(key) : true)) throw new Error("invalid revert payload")
        if (action === "unrevert") {
          // Restores every waiting undo group; with nothing reverted the session is returned unchanged, like v1.
          if ((await get(sessionId)).revert) await call({ type: "session.redo", sessionId, all: true })
          return json(await get(sessionId))
        }
        const messageID = ItemId.parse(payload.messageID)
        if (payload.partID !== undefined) await call({ type: "session.undo", sessionId, atPartId: ItemId.parse(payload.partID) })
        else {
          // A user message reverts that message and everything after; an assistant message reverts from its first part on.
          const role = ((await read({ ...query(), operation: "message", sessionId, messageId: messageID })).value as RestMessage).info.role
          await call({ type: "session.undo", sessionId, ...(role === "user" ? { atItemId: messageID } : { atPartId: messageID }) })
        }
        return json(await get(sessionId))
      }
      const permission = /^permissions\/([^/]+)$/.exec(action)
      if (permission) {
        if (Object.keys(payload).some((key) => key !== "response") || !["once", "always", "reject"].includes(String(payload.response))) throw new Error("invalid permission response")
        await call({ type: "request.resolve", sessionId, requestId: RequestId.parse(permission[1]), decision: payload.response === "reject" ? { kind: "deny" } : { kind: "approve", scope: payload.response === "always" ? "session" : "once" } })
        return json(true)
      }
      return json({ error: { code: "not_found", message: "unknown session route" } }, 404)
    } catch (error) {
      if (error instanceof Response) return error
      return json({ error: { code: "invalid_command", message: "Invalid or unsupported session payload, query or cursor" } }, 400)
    }
  }
}
