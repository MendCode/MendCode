import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { createAuthStore, createMcpAuth, createMcpManager, createRemoteMcpClient, discoverAuthorization, loadMcpConfig, mcpTools, McpAuthRequiredError, parseChallenge, parseSse, type McpAuth, type McpClient, type McpManager, type McpServerConfig } from "../src"
import { approveInBrowser, startFakeRemote, type FakeRemote, type FakeRemoteOptions } from "./fixtures/fake-remote"
import { put, tempDir } from "./helpers"

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function remote(options: FakeRemoteOptions = {}): Promise<FakeRemote> {
  const fake = await startFakeRemote(options)
  cleanups.push(() => fake.stop())
  return fake
}

type Setup = { fake: FakeRemote; dir: string; auth: McpAuth; manager: McpManager; clock: { now: number } }

async function setup({ server = {}, options = {}, callbackTimeoutMs }: { server?: Partial<McpServerConfig>; options?: FakeRemoteOptions; callbackTimeoutMs?: number } = {}): Promise<Setup> {
  const fake = await remote(options)
  const dir = tempDir()
  const clock = { now: Date.now() }
  const auth = createMcpAuth({ dir, now: () => clock.now, ...(callbackTimeoutMs ? { callbackTimeoutMs } : {}) })
  // A legacy server has one URL: the event stream, which also answers 405 to the streamable POST.
  const config: McpServerConfig = { url: options.legacyOnly ? fake.sseUrl : fake.url, ...server }
  const manager = createMcpManager({ configLoader: () => ({ servers: { remote: config }, errors: [] }), auth })
  cleanups.push(() => manager.stop())
  return { fake, dir, auth, manager, clock }
}

const PROJECT = "/tmp/project"

function callbackPort() {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") })
  const port = server.port!
  server.stop(true)
  return port
}

test("OAuth callbackPort binds the selected port and redirectUri overrides port and callback path", async () => {
  for (const custom of [false, true]) {
    const port = callbackPort()
    const redirectUri = `http://127.0.0.1:${port}/oauth/custom`
    const h = await setup({ server: { oauth: { callbackPort: custom ? callbackPort() : port, ...(custom ? { redirectUri } : {}) } } })
    const flow = await h.manager.startAuth({ directory: PROJECT, server: "remote" })
    const redirect = new URL(new URL(flow.url).searchParams.get("redirect_uri")!)
    expect(Number(redirect.port)).toBe(port)
    expect(redirect.pathname).toBe(custom ? "/oauth/custom" : "/mcp/oauth/callback")
    expect(h.fake.state.registrations[0]?.redirect_uris).toEqual([redirect.href])
    if (custom) expect((await fetch(`${redirect.origin}/callback?state=wrong`)).status).toBe(404)
    await approveInBrowser(flow.url)
    expect((await flow.completion).state).toBe("running")
    expect(h.fake.state.tokenRequests[0]?.redirect_uri).toBe(redirect.href)
  }
})

test("a busy OAuth callback port fails without registering a client", async () => {
  const busy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("busy") })
  cleanups.push(() => busy.stop(true))
  const h = await setup({ server: { oauth: { callbackPort: busy.port! } } })
  await expect(h.manager.startAuth({ directory: PROJECT, server: "remote" })).rejects.toThrow("port unavailable")
  expect(h.fake.state.registrations).toEqual([])
})

test("an external HTTPS redirect retains its URI while a local forwarder reaches the callback", async () => {
  const port = callbackPort()
  const redirectUri = `https://callback.example.test:${port}/oauth/custom?project=docs`
  const h = await setup({ server: { oauth: { redirectUri } } })
  const flow = await h.manager.startAuth({ directory: PROJECT, server: "remote" })
  expect(new URL(flow.url).searchParams.get("redirect_uri")).toBe(redirectUri)
  expect(h.fake.state.registrations[0]?.redirect_uris).toEqual([redirectUri])
  const response = await fetch(flow.url, { redirect: "manual" })
  const callback = new URL(response.headers.get("location")!)
  expect(callback.searchParams.get("project")).toBe("docs")
  expect((await fetch(`http://127.0.0.1:${port}${callback.pathname}${callback.search}`)).status).toBe(200)
  expect((await flow.completion).state).toBe("running")
  expect(h.fake.state.tokenRequests[0]?.redirect_uri).toBe(redirectUri)
})

test("OAuth config preserves HTTP(S) callbacks and rejects credentials, fragments and malformed ports", async () => {
  const userDir = tempDir()
  put({ root: userDir, path: "mcp.json", content: JSON.stringify({ servers: {
    valid: { url: "https://mcp.test", oauth: { callbackPort: 19876, redirectUri: "http://localhost:19877/custom" } },
    external: { url: "https://mcp.test", oauth: { redirectUri: "https://external.test/callback?project=docs" } },
    credentials: { url: "https://mcp.test", oauth: { redirectUri: "http://user:secret@localhost:19876/callback" } },
    fragment: { url: "https://mcp.test", oauth: { redirectUri: "http://localhost:19876/callback#invalid" } },
    port: { url: "https://mcp.test", oauth: { callbackPort: 0 } },
  } }) })
  const config = await loadMcpConfig({ directory: tempDir(), userDir })
  expect(config.servers.valid?.oauth).toEqual({ callbackPort: 19876, redirectUri: "http://localhost:19877/custom" })
  expect(config.servers.external?.oauth).toEqual({ redirectUri: "https://external.test/callback?project=docs" })
  expect(config.errors).toHaveLength(3)
})

async function authorize({ manager }: Pick<Setup, "manager">) {
  const started = await manager.startAuth({ directory: PROJECT, server: "remote" })
  await approveInBrowser(started.url)
  return { started, status: await started.completion }
}

describe("config", () => {
  test("a server has either a command or a url, never both or neither", async () => {
    const directory = tempDir()
    const userDir = tempDir()
    put({
      root: userDir,
      path: "mcp.json",
      content: JSON.stringify({
        servers: {
          local: { command: "x" },
          web: { url: "https://mcp.example.com/mcp?k=1", headers: { "x-api-key": "${MCP_KEY}" }, oauth: { clientId: "${MCP_CLIENT}" } },
          both: { command: "x", url: "https://a.b/" },
          none: {},
          badurl: { url: "ftp://a.b/" },
          off: { url: "https://a.b/", oauth: false, transport: "sse" },
        },
      }),
    })
    const { servers, errors } = await loadMcpConfig({ directory, userDir, env: { MCP_KEY: "secret", MCP_CLIENT: "cid" } })
    expect(Object.keys(servers).sort()).toEqual(["local", "off", "web"])
    expect(servers.web).toEqual({ url: "https://mcp.example.com/mcp?k=1", headers: { "x-api-key": "secret" }, oauth: { clientId: "cid" } })
    expect(servers.off).toEqual({ url: "https://a.b/", oauth: false, transport: "sse" })
    expect(errors.map((error) => error.server).sort()).toEqual(["badurl", "both", "none"])
    expect(errors.find((error) => error.server === "both")?.message).toContain("exactly one of command")
  })
})

describe("challenge parsing and discovery", () => {
  test("reads resource_metadata, scope and error from a Bearer challenge", () => {
    expect(parseChallenge('Bearer realm="x", resource_metadata="https://h/.well-known/oauth-protected-resource/mcp", scope="a b", error=invalid_token')).toEqual({
      resourceMetadata: "https://h/.well-known/oauth-protected-resource/mcp",
      scope: "a b",
      error: "invalid_token",
    })
    expect(parseChallenge(null)).toEqual({})
  })

  test("RFC 9728 then RFC 8414: finds the endpoints and the resource", async () => {
    const fake = await remote()
    const found = await discoverAuthorization({ serverUrl: fake.url, fetch })
    expect(found).toMatchObject({ issuer: fake.origin, authorizationEndpoint: `${fake.origin}/authorize`, tokenEndpoint: `${fake.origin}/token`, registrationEndpoint: `${fake.origin}/register`, resource: `${fake.origin}/mcp`, scopesFromResource: ["mcp:read"] })
  })

  test("a server without resource metadata is its own authorization server", async () => {
    const fake = await remote({ resourceMetadata: false })
    const found = await discoverAuthorization({ serverUrl: fake.url, fetch })
    expect(found.issuer).toBe(fake.origin)
    expect(found.resource).toBe(fake.url)
  })

  test("a server that is not OAuth-protected at all is a clear error", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("nope", { status: 404 }) })
    cleanups.push(() => server.stop(true))
    await expect(discoverAuthorization({ serverUrl: `http://127.0.0.1:${server.port}/mcp`, fetch })).rejects.toThrow("no OAuth authorization server metadata")
  })

  test("refuses metadata endpoints that are not https (outside loopback)", async () => {
    const meta: ReturnType<typeof Bun.serve> = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request): Response =>
        new URL(request.url).pathname.includes("oauth-authorization-server")
          ? Response.json({ issuer: `http://127.0.0.1:${meta.port}`, authorization_endpoint: "http://evil.example/authorize", token_endpoint: `http://127.0.0.1:${meta.port}/token` })
          : new Response("no", { status: 404 }),
    })
    cleanups.push(() => meta.stop(true))
    await expect(discoverAuthorization({ serverUrl: `http://127.0.0.1:${meta.port}/mcp`, fetch })).rejects.toThrow("must use https")
  })
})

describe("OAuth with streamable HTTP", () => {
  test("a 401 server needs authorization; the flow authorizes it and the tools work", async () => {
    const { fake, dir, manager } = await setup()

    // Before anything runs, no credentials exist and nothing was probed.
    const idle = (await manager.status(PROJECT)).servers[0]
    expect(idle).toMatchObject({ name: "remote", state: "stopped", transport: "remote", auth: "none", command: `${fake.origin}/mcp` })

    // Using the server hits the 401.
    const listed = await manager.listTools(PROJECT)
    expect(listed.tools).toEqual([])
    expect(listed.issues[0]?.message).toContain("needs authorization")
    const refused = (await manager.status(PROJECT)).servers[0]
    expect(refused).toMatchObject({ state: "failed", auth: "needs_auth" })
    expect(refused?.lastError).toContain("needs authorization")
    expect(refused?.command).toContain("[oauth: needs authorization]")

    // Start the flow: a URL to open, a loopback redirect on 127.0.0.1 and a random port, PKCE S256.
    const started = await manager.startAuth({ directory: PROJECT, server: "remote" })
    const authorizeUrl = new URL(started.url)
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(`${fake.origin}/authorize`)
    const redirect = new URL(authorizeUrl.searchParams.get("redirect_uri") as string)
    expect(redirect.hostname).toBe("127.0.0.1")
    expect(Number(redirect.port)).toBeGreaterThan(0)
    expect(redirect.pathname).toBe("/callback")
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256")
    expect(authorizeUrl.searchParams.get("resource")).toBe(`${fake.origin}/mcp`)
    expect(authorizeUrl.searchParams.get("scope")).toBe("mcp:read")
    expect(fake.state.registrations[0]).toMatchObject({ client_name: "MendCode", token_endpoint_auth_method: "none", redirect_uris: [redirect.href] })
    expect((await manager.status(PROJECT)).servers[0]?.auth).toBe("pending")

    // The user approves in the browser; the flow completes and the server comes up.
    const page = await approveInBrowser(started.url)
    expect(page.status).toBe(200)
    const status = await started.completion
    expect(status).toMatchObject({ state: "running", tools: 1, auth: "authorized" })
    expect(status.command).toContain("[oauth: authorized]")
    expect(fake.state.tokenRequests[0]).toMatchObject({ grant_type: "authorization_code", redirect_uri: redirect.href, resource: `${fake.origin}/mcp` })

    // Tokens: stored in <dataDir>/mcp-auth.json with mode 0600; the server saw a bearer token.
    const file = join(dir, "mcp-auth.json")
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const stored = JSON.parse(readFileSync(file, "utf8"))
    expect(stored.servers[`${fake.origin}/mcp`].tokens.accessToken).toMatch(/^at-/)
    expect(fake.state.mcpRequests.some((request) => request.authorization?.startsWith("Bearer at-"))).toBe(true)

    const tools = await mcpTools(manager, PROJECT)
    const echo = tools.find((tool) => tool.name === "mcp__remote__echo")
    expect(echo).toBeDefined()
    const result = await echo!.execute({ text: "hi" }, { cwd: PROJECT, signal: new AbortController().signal })
    expect(result).toMatchObject({ output: "echo:hi", isError: false })
  })

  test("the loopback ignores a redirect with the wrong state and finishes on the right one", async () => {
    const { manager } = await setup()
    const started = await manager.startAuth({ directory: PROJECT, server: "remote" })
    const redirect = new URL(new URL(started.url).searchParams.get("redirect_uri") as string)
    const wrong = await fetch(`${redirect.origin}/callback?code=stolen&state=nope`)
    expect(wrong.status).toBe(400)
    expect((await fetch(`${redirect.origin}/elsewhere`)).status).toBe(404)
    await approveInBrowser(started.url)
    expect((await started.completion).state).toBe("running")
  })

  test("a denied authorization rejects the flow and stores nothing", async () => {
    const { manager, dir } = await setup()
    const started = await manager.startAuth({ directory: PROJECT, server: "remote" })
    const url = new URL(started.url)
    const redirect = url.searchParams.get("redirect_uri")
    const denied = await fetch(`${redirect}?error=access_denied&error_description=no&state=${url.searchParams.get("state")}`)
    expect(denied.status).toBe(400)
    await expect(started.completion).rejects.toThrow("access_denied")
    expect(() => statSync(join(dir, "mcp-auth.json"))).toThrow()
    expect((await manager.status(PROJECT)).servers[0]?.auth).not.toBe("pending")
  })

  test("OAuth callbacks require GET and the random state, and never echo provider error content", async () => {
    const { manager, dir } = await setup()
    const started = await manager.startAuth({ directory: PROJECT, server: "remote" })
    const authorize = new URL(started.url)
    const callback = new URL(authorize.searchParams.get("redirect_uri")!)
    expect(callback.hostname).toBe("127.0.0.1")
    callback.searchParams.set("state", authorize.searchParams.get("state")!)
    callback.searchParams.set("code", "unused")
    expect((await fetch(callback, { method: "POST" })).status).toBe(405)
    callback.searchParams.delete("state")
    expect((await fetch(callback)).status).toBe(400)
    expect((await manager.status(PROJECT)).servers[0]?.auth).toBe("pending")
    const secret = "opaquePrivateValueWithoutCredentialPrefix"
    callback.searchParams.set("state", authorize.searchParams.get("state")!)
    callback.searchParams.set("error", secret)
    callback.searchParams.set("error_description", `password=s3cr3t ${secret}`)
    const response = await fetch(callback)
    expect(response.status).toBe(400)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.text()).not.toContain(secret)
    const error = await started.completion.catch((error: Error) => error)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain(secret)
    expect(String(error)).not.toContain("s3cr3t")
    expect(() => statSync(join(dir, "mcp-auth.json"))).toThrow()
  })

  test("OAuth registration and token failures never expose remote descriptions, token types or transport errors", async () => {
    const fake = await remote()
    const secret = "opaquePrivateValueWithoutCredentialPrefix"
    for (const failure of ["registration", "transport", "description", "token-type"] as const) {
      const dir = tempDir()
      const auth = createMcpAuth({ dir, fetch: async (url, init) => {
        if (failure === "registration" && url.endsWith("/register")) throw new Error(secret)
        if (url.endsWith("/token")) {
          if (failure === "transport") throw new Error(secret)
          return failure === "description"
            ? Response.json({ error: "invalid_grant", error_description: secret }, { status: 400 })
            : Response.json({ access_token: secret, token_type: secret })
        }
        return fetch(url, init)
      } })
      if (failure === "registration") {
        await expect(auth.start({ serverName: "remote", serverUrl: fake.url })).rejects.toThrow("client registration request failed")
      } else {
        const flow = await auth.start({ serverName: "remote", serverUrl: fake.url })
        const authorize = new URL(flow.url), callback = new URL(authorize.searchParams.get("redirect_uri")!)
        callback.searchParams.set("state", authorize.searchParams.get("state")!)
        callback.searchParams.set("code", "unused")
        expect((await fetch(callback)).status).toBe(200)
        const error = await flow.completion.catch((error: Error) => error)
        expect(error).toBeInstanceOf(Error)
        expect(String(error)).not.toContain(secret)
        if (failure === "description") expect(String(error)).toContain("invalid_grant")
      }
      expect(() => statSync(join(dir, "mcp-auth.json"))).toThrow()
    }
  })

  test("cancelAuth stops a waiting flow and frees the loopback port", async () => {
    const { manager } = await setup()
    const started = await manager.startAuth({ directory: PROJECT, server: "remote" })
    const redirect = new URL(new URL(started.url).searchParams.get("redirect_uri") as string)
    await manager.cancelAuth({ directory: PROJECT, server: "remote" })
    await expect(started.completion).rejects.toThrow("cancelled")
    await Bun.sleep(120)
    await expect(fetch(`${redirect.origin}/callback?code=x&state=y`)).rejects.toThrow()
  })

  test("a flow nobody completes times out", async () => {
    const { manager } = await setup({ callbackTimeoutMs: 80 })
    const started = await manager.startAuth({ directory: PROJECT, server: "remote" })
    await expect(started.completion).rejects.toThrow("timed out")
  })

  test("without dynamic registration a configured clientId is used and a missing one is explained", async () => {
    const missing = await setup({ options: { registration: false } })
    await expect(missing.manager.startAuth({ directory: PROJECT, server: "remote" })).rejects.toThrow("oauth")
    const preset = await setup({ options: { registration: false, presetClients: { mine: {} } }, server: { oauth: { clientId: "mine", scope: "custom" } } })
    const started = await preset.manager.startAuth({ directory: PROJECT, server: "remote" })
    expect(new URL(started.url).searchParams.get("client_id")).toBe("mine")
    expect(new URL(started.url).searchParams.get("scope")).toBe("custom")
    await approveInBrowser(started.url)
    expect((await started.completion).auth).toBe("authorized")
    expect(preset.fake.state.registrations).toHaveLength(0)
  })

  test("a client secret goes in the Authorization header unless the server only accepts the body", async () => {
    const basic = await setup({ options: { registration: false, presetClients: { mine: { secret: "s3cret-value" } } }, server: { oauth: { clientId: "mine", clientSecret: "s3cret-value" } } })
    let started = await basic.manager.startAuth({ directory: PROJECT, server: "remote" })
    await approveInBrowser(started.url)
    await started.completion
    expect(basic.fake.state.tokenAuthHeaders[0]).toBe(`Basic ${Buffer.from("mine:s3cret-value").toString("base64")}`)
    expect(basic.fake.state.tokenRequests[0]?.client_secret).toBeUndefined()

    const post = await setup({ options: { registration: false, authMethods: ["client_secret_post"], presetClients: { mine: { secret: "s3cret-value" } } }, server: { oauth: { clientId: "mine", clientSecret: "s3cret-value" } } })
    started = await post.manager.startAuth({ directory: PROJECT, server: "remote" })
    await approveInBrowser(started.url)
    await started.completion
    expect(post.fake.state.tokenAuthHeaders[0]).toBeNull()
    expect(post.fake.state.tokenRequests[0]?.client_secret).toBe("s3cret-value")
  })

  test("tokens expire: an expiring token is refreshed before the request, and the refresh token rotates", async () => {
    const { fake, manager, dir, clock } = await setup({ options: { tokenLifetimeSec: 3600 } })
    await authorize({ manager })
    const first = JSON.parse(readFileSync(join(dir, "mcp-auth.json"), "utf8")).servers[`${fake.origin}/mcp`].tokens
    expect(first.expiresAt).toBeGreaterThan(clock.now)
    clock.now += 3600 * 1000 - 30_000 // inside the 60 s skew
    await manager.restart({ directory: PROJECT, server: "remote" })
    expect(fake.state.refreshes).toBe(1)
    const second = JSON.parse(readFileSync(join(dir, "mcp-auth.json"), "utf8")).servers[`${fake.origin}/mcp`].tokens
    expect(second.accessToken).not.toBe(first.accessToken)
    expect(second.refreshToken).not.toBe(first.refreshToken)
    expect(fake.state.tokenRequests.at(-1)).toMatchObject({ grant_type: "refresh_token", refresh_token: first.refreshToken })
    const call = await manager.callTool({ directory: PROJECT, server: "remote", tool: "echo", args: { text: "after refresh" } })
    expect(call.text).toBe("echo:after refresh")
    expect(fake.state.mcpRequests.at(-1)?.authorization).toBe(`Bearer ${second.accessToken}`)
  })

  test("a token the server revoked gets one refresh and the request is retried", async () => {
    const { fake, manager } = await setup()
    await authorize({ manager })
    fake.revokeAccessTokens()
    const call = await manager.callTool({ directory: PROJECT, server: "remote", tool: "echo", args: { text: "retried" } })
    expect(call.text).toBe("echo:retried")
    expect(fake.state.refreshes).toBe(1)
  })

  test("a rejected refresh token is dropped and the server asks for authorization again", async () => {
    const { fake, manager, dir } = await setup()
    await authorize({ manager })
    fake.revokeAccessTokens()
    fake.revokeRefreshTokens()
    await expect(manager.callTool({ directory: PROJECT, server: "remote", tool: "echo", args: {} })).rejects.toThrow("needs authorization")
    const stored = JSON.parse(readFileSync(join(dir, "mcp-auth.json"), "utf8")).servers[`${fake.origin}/mcp`]
    expect(stored.tokens).toBeUndefined()
    expect(stored.clientId).toMatch(/^client-/)
    expect((await manager.status(PROJECT)).servers[0]?.auth).toBe("needs_auth")
  })

  test("concurrent requests with an expiring token share one refresh", async () => {
    const { fake, manager, auth, clock } = await setup()
    await authorize({ manager })
    clock.now += 3600 * 1000
    const url = fake.url
    const tokens = await Promise.all([auth.accessToken(url), auth.accessToken(url), auth.accessToken(url)])
    expect(fake.state.refreshes).toBe(1)
    expect(new Set(tokens).size).toBe(1)
  })

  test("forgetAuth removes the credentials and disconnects", async () => {
    const { manager, dir, fake } = await setup()
    await authorize({ manager })
    const status = await manager.forgetAuth({ directory: PROJECT, server: "remote" })
    expect(status).toMatchObject({ state: "stopped", auth: "none" })
    expect(JSON.parse(readFileSync(join(dir, "mcp-auth.json"), "utf8")).servers).toEqual({})
    expect(statSync(join(dir, "mcp-auth.json")).mode & 0o777).toBe(0o600)
    expect(fake.state.deletes).toBe(1)
  })

  test("a second authorization replaces the first flow", async () => {
    const { manager } = await setup()
    const first = await manager.startAuth({ directory: PROJECT, server: "remote" })
    const second = await manager.startAuth({ directory: PROJECT, server: "remote" })
    await expect(first.completion).rejects.toThrow("cancelled")
    await approveInBrowser(second.url)
    expect((await second.completion).state).toBe("running")
  })

  test("local servers and oauth:false servers cannot start OAuth", async () => {
    const off = await setup({ server: { oauth: false } })
    await expect(off.manager.startAuth({ directory: PROJECT, server: "remote" })).rejects.toThrow("turned off")
    const fake = await remote()
    const manager = createMcpManager({ configLoader: () => ({ servers: { local: { command: "x" }, web: { url: fake.url } }, errors: [] }), auth: createMcpAuth({ dir: tempDir() }) })
    await expect(manager.startAuth({ directory: PROJECT, server: "local" })).rejects.toThrow("local server")
    await expect(manager.startAuth({ directory: PROJECT, server: "nope" })).rejects.toThrow("unknown")
    const noAuth = createMcpManager({ configLoader: () => ({ servers: { web: { url: fake.url } }, errors: [] }) })
    await expect(noAuth.startAuth({ directory: PROJECT, server: "web" })).rejects.toThrow("not available")
  })
})

describe("remote transports", () => {
  test("static headers reach the server; an unprotected server needs no OAuth", async () => {
    const fake = await remote({ protectedServer: false })
    const client = createRemoteMcpClient({ name: "open", config: { url: fake.url, headers: { "X-Api-Key": "k-123" } } })
    cleanups.push(() => client.close())
    expect((await client.listTools()).map((tool) => tool.name)).toEqual(["echo"])
    expect(fake.state.mcpRequests[0]?.headers["x-api-key"]).toBe("k-123")
    expect(fake.state.mcpRequests.every((request) => request.headers["mcp-protocol-version"] !== undefined || request.method === "initialize")).toBe(true)
    expect(client.state).toBe("running")
    expect(client.toolCount).toBe(1)
  })

  test("a 401 with oauth:false names the configured credentials, not OAuth", async () => {
    const fake = await remote()
    const client = createRemoteMcpClient({ name: "keyed", config: { url: fake.url, oauth: false, headers: { authorization: "Bearer wrong" } }, auth: createMcpAuth({ dir: tempDir() }) })
    cleanups.push(() => client.close())
    await expect(client.listTools()).rejects.toThrow("rejected the configured credentials")
    expect(client.needsAuth).toBe(false)
  })

  test("a 401 surfaces as McpAuthRequiredError with the challenge for discovery", async () => {
    const fake = await remote()
    const client = createRemoteMcpClient({ name: "locked", config: { url: fake.url }, auth: createMcpAuth({ dir: tempDir() }) })
    cleanups.push(() => client.close())
    await expect(client.start()).rejects.toBeInstanceOf(McpAuthRequiredError)
    expect(client.needsAuth).toBe(true)
    expect(client.authChallenge).toMatchObject({ resourceMetadata: `${fake.origin}/.well-known/oauth-protected-resource/mcp`, scope: "mcp:read" })
    expect(client.state).toBe("failed")
  })

  test("event-stream responses: notifications, server pings, comments and CRLF multi-line data are handled", async () => {
    const { manager } = await setup({ options: { streamResponses: true } })
    const { status } = await authorize({ manager })
    expect(status).toMatchObject({ state: "running", tools: 1 })
    const call = await manager.callTool({ directory: PROJECT, server: "remote", tool: "echo", args: { text: "streamed" } })
    expect(call.text).toBe("echo:streamed")
  })

  test("a server that forgot the session gets a new one and the request is repeated", async () => {
    const fake = await remote({ protectedServer: false })
    const client = createRemoteMcpClient({ name: "s", config: { url: fake.url } })
    cleanups.push(() => client.close())
    await client.listTools()
    fake.forgetSessions()
    const call = await client.callTool("echo", { text: "again" })
    expect(call.text).toBe("echo:again")
    expect(fake.state.initializes).toBe(2)
  })

  test("the legacy HTTP+SSE transport works with OAuth: the stream announces an endpoint and carries the answers", async () => {
    const { fake, manager } = await setup({ options: { legacyOnly: true } })
    const { status } = await authorize({ manager })
    expect(status).toMatchObject({ state: "running", tools: 1, auth: "authorized" })
    const call = await manager.callTool({ directory: PROJECT, server: "remote", tool: "echo", args: { text: "legacy" } })
    expect(call.text).toBe("echo:legacy")
    expect(fake.state.mcpRequests.filter((request) => request.method === "tools/call")[0]?.authorization).toMatch(/^Bearer at-/)
  })

  test("transport:sse goes straight to the SSE endpoint", async () => {
    const { manager, fake } = await setup({ options: { legacyOnly: true }, server: { transport: "sse" } })
    await authorize({ manager })
    expect(fake.state.mcpRequests.some((request) => request.method === "initialize")).toBe(true)
    expect((await manager.callTool({ directory: PROJECT, server: "remote", tool: "echo", args: { text: "x" } })).text).toBe("echo:x")
  })

  test("transport:http does not fall back to SSE", async () => {
    const fake = await remote({ protectedServer: false, legacyOnly: true })
    const client: McpClient = createRemoteMcpClient({ name: "h", config: { url: fake.url, transport: "http" } })
    cleanups.push(() => client.close())
    await expect(client.start()).rejects.toThrow("HTTP 405")
  })

  test("closing a remote client ends its session", async () => {
    const fake = await remote({ protectedServer: false })
    const client = createRemoteMcpClient({ name: "c", config: { url: fake.url } })
    await client.listTools()
    await client.close()
    expect(fake.state.deletes).toBe(1)
    expect(client.state).toBe("stopped")
    await expect(client.start()).rejects.toThrow("closed")
  })

  test("an aborted tool call is cancelled without failing the connection", async () => {
    const fake = await remote({ protectedServer: false })
    const client = createRemoteMcpClient({ name: "a", config: { url: fake.url } })
    cleanups.push(() => client.close())
    await client.listTools()
    const controller = new AbortController()
    controller.abort()
    await expect(client.callTool("echo", {}, controller.signal)).rejects.toThrow("cancelled")
    expect((await client.callTool("echo", { text: "ok" })).text).toBe("echo:ok")
  })
})

describe("auth store", () => {
  test("tokens persist across instances and the file stays 0600 after rewrites", async () => {
    const dir = tempDir()
    const store = createAuthStore({ dir })
    const entry = { issuer: "https://a", clientId: "c", tokenEndpoint: "https://a/token", authMethod: "none" as const, tokens: { accessToken: "x", tokenType: "Bearer" } }
    await store.set("https://h/mcp#frag", entry)
    await store.set("https://h/other", { ...entry, clientId: "d" })
    expect((await createAuthStore({ dir }).get("https://h/mcp"))?.clientId).toBe("c")
    expect(statSync(store.file).mode & 0o777).toBe(0o600)
    await store.set("https://h/mcp", undefined)
    expect(await store.get("https://h/mcp")).toBeUndefined()
    expect((await store.get("https://h/other"))?.clientId).toBe("d")
  })

  test("a corrupt file counts as empty instead of crashing", async () => {
    const dir = tempDir()
    put({ root: dir, path: "mcp-auth.json", content: "{not json" })
    expect(await createAuthStore({ dir }).get("https://h/mcp")).toBeUndefined()
  })

  test("parallel writes do not lose entries", async () => {
    const store = createAuthStore({ dir: tempDir() })
    const entry = { issuer: "i", clientId: "c", tokenEndpoint: "https://a/t", authMethod: "none" as const }
    await Promise.all(Array.from({ length: 12 }, (_, index) => store.set(`https://h/${index}`, entry)))
    const present = await Promise.all(Array.from({ length: 12 }, (_, index) => store.get(`https://h/${index}`)))
    expect(present.every(Boolean)).toBe(true)
  })
})

describe("server-sent events", () => {
  const stream = (chunks: string[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
        controller.close()
      },
    })
  const collect = async (chunks: string[]) => {
    const events = []
    for await (const event of parseSse(stream(chunks))) events.push(event)
    return events
  }

  test("parses LF, CRLF and CR endings, comments, multi-line data and events split across chunks", async () => {
    expect(await collect(["event: a\ndata: 1\n\n", ": c\r\ndata: 2\r\ndata: 3\r\n\r", "\ndata:4\r\r", "event: x\ndata: tail"])).toEqual([
      { event: "a", data: "1" },
      { event: "message", data: "2\n3" },
      { event: "message", data: "4" },
      { event: "x", data: "tail" },
    ])
  })

  test("an event with no data is not dispatched", async () => {
    expect(await collect(["event: ping\n\n", "id: 7\n\n"])).toEqual([])
  })
})
