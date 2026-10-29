// In-process fake of a remote MCP server plus its OAuth authorization server, on 127.0.0.1 only. Nothing leaves the machine.
import { createHash, randomBytes } from "node:crypto"
import { catalogAnswer } from "./catalog-data"

export type FakeRemoteOptions = {
  /** Require a bearer token on /mcp and /sse (default true). */
  protectedServer?: boolean
  /** Serve RFC 9728 protected resource metadata (default true); without it the client falls back to the origin. */
  resourceMetadata?: boolean
  /** Offer RFC 7591 dynamic registration (default true). */
  registration?: boolean
  /** Answer initialize and calls as an event stream with a notification and a server ping first. */
  streamResponses?: boolean
  /** No streamable HTTP endpoint: POST /mcp answers 405 and the server speaks the older HTTP+SSE transport on /sse. */
  legacyOnly?: boolean
  /** Lifetime reported for access tokens, in seconds (default 3600). */
  tokenLifetimeSec?: number
  /** Client ids accepted without registration. */
  presetClients?: Record<string, { secret?: string }>
  /** Require client_secret_basic for clients that have a secret. */
  authMethods?: string[]
  catalog?: boolean
}

type Grant = { clientId: string; redirectUri: string; challenge: string; resource: string | undefined }

export async function startFakeRemote(options: FakeRemoteOptions = {}) {
  const config = { protectedServer: true, resourceMetadata: true, registration: true, tokenLifetimeSec: 3600, ...options }
  const clients = new Map<string, { redirectUris: string[]; secret?: string }>()
  const codes = new Map<string, Grant>()
  const accessTokens = new Set<string>()
  const refreshTokens = new Map<string, string>()
  const sessions = new Set<string>()
  const legacyStreams = new Map<string, ReadableStreamDefaultController<Uint8Array>>()
  const encoder = new TextEncoder()
  const state = {
    registrations: [] as Array<Record<string, unknown>>,
    authorizeRequests: [] as Array<Record<string, string>>,
    tokenRequests: [] as Array<Record<string, string>>,
    tokenAuthHeaders: [] as Array<string | null>,
    refreshes: 0,
    mcpRequests: [] as Array<{ method: string; authorization: string | null; session: string | null; headers: Record<string, string> }>,
    deletes: 0,
    initializes: 0,
  }
  let origin = ""

  const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } })
  const challenge = () => new Response("unauthorized", { status: 401, headers: { "www-authenticate": `Bearer realm="fake"${config.resourceMetadata ? `, resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` : ""}, scope="mcp:read"` } })
  const authorized = (request: Request) => {
    if (!config.protectedServer) return true
    const header = request.headers.get("authorization") ?? ""
    return header.startsWith("Bearer ") && accessTokens.has(header.slice(7))
  }

  const tools = [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } } }]
  function answer(message: any): unknown {
    if (message.method === "initialize") {
      state.initializes++
      return { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {}, ...(config.catalog ? { resources: {}, prompts: {} } : {}) }, serverInfo: { name: "fake-remote", version: "1" } } }
    }
    if (message.method === "tools/list") return { jsonrpc: "2.0", id: message.id, result: { tools } }
    if (message.method === "tools/call") return { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `echo:${String(message.params?.arguments?.text ?? "")}` }] } }
    if (config.catalog) {
      try {
        const result = catalogAnswer(message.method, message.params)
        if (result !== undefined) return { jsonrpc: "2.0", id: message.id, result }
      } catch (error) { return { jsonrpc: "2.0", id: message.id, error: { code: -32000, message: String(error) } } }
    }
    return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } }
  }

  async function mcp(request: Request): Promise<Response> {
    if (request.method === "DELETE") {
      state.deletes++
      sessions.delete(request.headers.get("mcp-session-id") ?? "")
      return new Response(null, { status: 200 })
    }
    if (request.method === "GET") return new Response("no stream", { status: 405 })
    if (config.legacyOnly) return new Response("use /sse", { status: 405 })
    const message: any = await request.json()
    const headers: Record<string, string> = {}
    request.headers.forEach((value, key) => (headers[key] = value))
    state.mcpRequests.push({ method: String(message.method), authorization: request.headers.get("authorization"), session: request.headers.get("mcp-session-id"), headers })
    if (message.method !== "initialize" && !sessions.has(request.headers.get("mcp-session-id") ?? "")) return new Response("unknown session", { status: 404 })
    if (message.id === undefined) return new Response(null, { status: 202 })
    const reply = answer(message)
    const extra: Record<string, string> = {}
    if (message.method === "initialize") {
      const session = `sess-${randomBytes(4).toString("hex")}`
      sessions.add(session)
      extra["mcp-session-id"] = session
    }
    if (!config.streamResponses) return json(reply, 200, extra)
    const text = JSON.stringify(reply)
    const cut = text.indexOf(",") + 1
    const events = [
      `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "hi" } })}\n\n`,
      `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: "srv-1", method: "ping" })}\r\n\r\n`,
      `: keep-alive\n\n`,
      `event: message\r\ndata: ${text.slice(0, cut)}\r\ndata: ${text.slice(cut)}\r\n\r\n`,
    ]
    // Multi-line data joins with "\n", which is whitespace between JSON tokens, so the split message parses back.
    return new Response(events.join(""), { status: 200, headers: { "content-type": "text/event-stream", ...extra } })
  }

  function legacySse(request: Request): Response {
    const id = randomBytes(4).toString("hex")
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        legacyStreams.set(id, controller)
        controller.enqueue(encoder.encode(`event: endpoint\ndata: /messages?sessionId=${id}\n\n`))
        request.signal.addEventListener("abort", () => legacyStreams.delete(id))
      },
      cancel() {
        legacyStreams.delete(id)
      },
    })
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
  }

  async function legacyMessage(request: Request, url: URL): Promise<Response> {
    const controller = legacyStreams.get(url.searchParams.get("sessionId") ?? "")
    if (!controller) return new Response("no such stream", { status: 404 })
    const message: any = await request.json()
    state.mcpRequests.push({ method: String(message.method), authorization: request.headers.get("authorization"), session: url.searchParams.get("sessionId"), headers: {} })
    if (message.id !== undefined) controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(answer(message))}\n\n`))
    return new Response("Accepted", { status: 202 })
  }

  async function token(request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text())
    const params = Object.fromEntries(form.entries())
    state.tokenRequests.push(params)
    state.tokenAuthHeaders.push(request.headers.get("authorization"))
    const fail = (error: string, status = 400) => json({ error, error_description: `${error} by fake` }, status)
    const issue = (clientId: string, resource: string | undefined) => {
      const access = `at-${randomBytes(8).toString("hex")}`
      const refresh = `rt-${randomBytes(8).toString("hex")}`
      accessTokens.add(access)
      refreshTokens.set(refresh, clientId)
      return json({ access_token: access, token_type: "Bearer", expires_in: config.tokenLifetimeSec, refresh_token: refresh, scope: "mcp:read", ...(resource ? {} : {}) })
    }
    if (params.grant_type === "authorization_code") {
      const grant = codes.get(params.code ?? "")
      if (!grant) return fail("invalid_grant")
      codes.delete(params.code as string)
      if (params.redirect_uri !== grant.redirectUri) return fail("invalid_grant")
      if (params.client_id !== grant.clientId && !request.headers.get("authorization")) return fail("invalid_client", 401)
      const verifier = params.code_verifier ?? ""
      if (verifier.length < 43 || createHash("sha256").update(verifier).digest("base64url") !== grant.challenge) return fail("invalid_grant")
      if (grant.resource && params.resource !== grant.resource) return fail("invalid_target")
      return issue(grant.clientId, grant.resource)
    }
    if (params.grant_type === "refresh_token") {
      state.refreshes++
      const owner = refreshTokens.get(params.refresh_token ?? "")
      if (!owner) return fail("invalid_grant")
      refreshTokens.delete(params.refresh_token as string)
      return issue(owner, params.resource)
    }
    return fail("unsupported_grant_type")
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 60,
    async fetch(request) {
      const url = new URL(request.url)
      switch (url.pathname) {
        case "/.well-known/oauth-protected-resource/mcp":
        case "/.well-known/oauth-protected-resource":
          return config.resourceMetadata ? json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["mcp:read"] }) : new Response("nope", { status: 404 })
        case "/.well-known/oauth-authorization-server":
          return json({
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            ...(config.registration ? { registration_endpoint: `${origin}/register` } : {}),
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: config.authMethods ?? ["none", "client_secret_basic"],
          })
        case "/register": {
          const body: any = await request.json()
          state.registrations.push(body)
          const id = `client-${clients.size + 1}`
          clients.set(id, { redirectUris: body.redirect_uris })
          return json({ client_id: id, redirect_uris: body.redirect_uris }, 201)
        }
        case "/authorize": {
          const query = Object.fromEntries(url.searchParams.entries())
          state.authorizeRequests.push(query)
          const client = clients.get(query.client_id ?? "") ?? (config.presetClients?.[query.client_id ?? ""] ? { redirectUris: [query.redirect_uri ?? ""] } : undefined)
          if (!client) return new Response("unknown client", { status: 400 })
          if (!query.redirect_uri || !client.redirectUris.includes(query.redirect_uri) || !/^https?:\/\//.test(query.redirect_uri)) return new Response("bad redirect_uri", { status: 400 })
          if (query.response_type !== "code" || query.code_challenge_method !== "S256" || !query.code_challenge || !query.state) return new Response("bad request", { status: 400 })
          const code = `code-${randomBytes(6).toString("hex")}`
          codes.set(code, { clientId: query.client_id as string, redirectUri: query.redirect_uri, challenge: query.code_challenge, resource: query.resource })
          const redirect = new URL(query.redirect_uri)
          redirect.searchParams.set("code", code)
          redirect.searchParams.set("state", query.state)
          return new Response(null, { status: 302, headers: { location: redirect.href } })
        }
        case "/token":
          return token(request)
        case "/mcp":
          return authorized(request) ? mcp(request) : challenge()
        case "/sse":
          if (!authorized(request)) return challenge()
          return request.method === "GET" ? legacySse(request) : new Response("use GET", { status: 405 })
        case "/messages":
          return authorized(request) ? legacyMessage(request, url) : challenge()
        default:
          return new Response("not found", { status: 404 })
      }
    },
  })
  origin = `http://127.0.0.1:${server.port}`

  return {
    origin,
    url: `${origin}/mcp`,
    sseUrl: `${origin}/sse`,
    state,
    /** Makes every issued access token unknown to the server (refresh tokens stay valid). */
    revokeAccessTokens: () => accessTokens.clear(),
    revokeRefreshTokens: () => refreshTokens.clear(),
    forgetSessions: () => sessions.clear(),
    issuedAccessTokens: () => [...accessTokens],
    stop: () => server.stop(true),
  }
}

export type FakeRemote = Awaited<ReturnType<typeof startFakeRemote>>

/** Plays the browser: opens the authorization URL without following redirects, then visits the loopback redirect. */
export async function approveInBrowser(authorizationUrl: string): Promise<Response> {
  const first = await fetch(authorizationUrl, { redirect: "manual" })
  const location = first.headers.get("location")
  if (!location) throw new Error(`authorization endpoint answered ${first.status}: ${await first.text()}`)
  return fetch(location)
}
