import { afterEach, describe, expect, test } from "bun:test"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { CHATGPT_AUTH_FILE, CHATGPT_HOST_FILE, createChatgptAuth } from "../src/chatgpt-auth"

// Sign in with ChatGPT for open-source clients (developers.openai.com/siwc/token-sharing-open-source): no client id is configured.
const ISSUER = "https://auth.example"
const ISSUED = "oaiapp_fixture"
const ACCESS = "fixture-plan-access-never-print"
const REFRESH = "fixture-plan-refresh-never-print"
const SCOPE = "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke"
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 })
const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "fixture-key", alg: "RS256", use: "sig" }
const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

function idToken(claims: Record<string, unknown>, key = keys.privateKey) {
  const head = Buffer.from(JSON.stringify({ alg: "RS256", kid: "fixture-key", typ: "JWT" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url")
  return `${head}.${body}.${sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key).toString("base64url")}`
}

function fixture(input: { token?(request: URLSearchParams, nonce: string): Response | Promise<Response> } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-plan-auth-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  let callback!: (request: Request) => Promise<Response>
  let now = 1_800_000_000_000
  let nonce = ""
  const exchanges: URLSearchParams[] = []
  const goodTokens = (audience = ISSUED) => ({ access_token: ACCESS, refresh_token: REFRESH, id_token: idToken({ iss: ISSUER, aud: audience, sub: "user-fixture", exp: now / 1000 + 3600, nonce }), expires_in: 3600, scope: SCOPE })
  const auth = createChatgptAuth({
    dir, issuer: ISSUER, now: () => now,
    startCallback: (handler) => { callback = handler; return { redirectUri: "http://127.0.0.1:1455/auth/callback", close() {} } },
    fetch: async (url, init) => {
      if (url === `${ISSUER}/.well-known/jwks.json`) return Response.json({ keys: [jwk] })
      if (url !== `${ISSUER}/api/accounts/oauth/token`) return new Response("unexpected", { status: 404 })
      const body = new URLSearchParams(String(init?.body))
      exchanges.push(body)
      return input.token ? input.token(body, nonce) : Response.json(goodTokens())
    },
  })
  cleanups.push(() => auth.stop())
  return {
    dir, auth, exchanges, goodTokens, advance: (ms: number) => { now += ms },
    async start() {
      const authorization = await auth.authorize("browser")
      const params = new URL(authorization.url).searchParams
      nonce = params.get("nonce")!
      return { authorization, params }
    },
    back: (params: Record<string, string>) => callback(new Request(`http://127.0.0.1:1455/auth/callback?${new URLSearchParams(params)}`)),
  }
}

describe("Sign in with ChatGPT (own login, no configured client)", () => {
  test("first sign-in registers through dynamic_agent_client, exchanges with the issued client and keeps an own 0600 login", async () => {
    const h = fixture()
    const { authorization, params } = await h.start()
    const url = new URL(authorization.url)
    expect(url.origin + url.pathname).toBe(`${ISSUER}/api/accounts/authorize`)
    expect(params.get("client_id")).toBe("dynamic_agent_client")
    expect(params.get("agent_name_hint")).toBe("MendCode")
    expect(params.get("ext_agent_host_id")).toMatch(/^urn:uuid:[0-9a-f-]{36}$/)
    expect(params.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback")
    expect(params.get("resource")).toBe("https://api.openai.com/v1")
    expect(params.get("scope")!.split(" ")).toContain("chatgpt.tokens.use.direct")
    expect(params.get("code_challenge_method")).toBe("S256")
    expect(h.auth.status().state).toBe("pending")
    const response = await h.back({ state: params.get("state")!, code: "fixture-code", client_id: ISSUED, scope: SCOPE })
    expect(response.status).toBe(200)
    const exchange = h.exchanges[0]!
    expect(exchange.get("client_id")).toBe(ISSUED)
    expect(exchange.get("resource")).toBe("https://api.openai.com/v1")
    expect(exchange.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback")
    expect(createHash("sha256").update(exchange.get("code_verifier")!).digest("base64url")).toBe(params.get("code_challenge")!)
    expect(h.auth.status()).toMatchObject({ state: "authorized", source: "v2" })
    expect(h.auth.route()).toBe("plan")
    expect(h.auth.planAccount()).toBe("user-fixture")
    // Only the bearer token goes to api.openai.com; the subscription backend's account header is not sent.
    expect(await h.auth.headers()).toEqual({ authorization: `Bearer ${ACCESS}` })
    expect(statSync(path.join(h.dir, CHATGPT_AUTH_FILE)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(path.join(h.dir, CHATGPT_HOST_FILE), "utf8"))).toMatchObject({ hostId: params.get("ext_agent_host_id"), clientId: ISSUED })
    for (const secret of [ACCESS, REFRESH, "fixture-code"]) expect(JSON.stringify(h.auth.status())).not.toContain(secret)
  })

  test("a later sign-in reuses the issued client and host id, and a callback naming another client is refused", async () => {
    const h = fixture()
    const first = await h.start()
    await h.back({ state: first.params.get("state")!, code: "code-1", client_id: ISSUED })
    h.auth.logout()
    expect(h.auth.status().source).toBe("none")
    const second = await h.start()
    expect(second.params.get("client_id")).toBe(ISSUED)
    expect(second.params.has("agent_name_hint")).toBe(false)
    expect(second.params.get("ext_agent_host_id")).toBe(first.params.get("ext_agent_host_id"))
    expect((await h.back({ state: second.params.get("state")!, code: "code-2", client_id: "oaiapp_someone_else" })).status).toBe(400)
    expect(h.auth.status()).toMatchObject({ state: "failed", source: "none" })
    expect(h.exchanges).toHaveLength(1)
    // A returning callback may omit the client id: the saved one is used.
    const third = await h.start()
    expect((await h.back({ state: third.params.get("state")!, code: "code-3" })).status).toBe(200)
    expect(h.exchanges.at(-1)!.get("client_id")).toBe(ISSUED)
  })

  test("an ID token that fails verification (signature, audience, nonce, expiry) saves nothing", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
    const cases: ((nonce: string) => string)[] = [
      (nonce) => idToken({ iss: ISSUER, aud: ISSUED, sub: "u", exp: 1_900_000_000, nonce }, other),
      (nonce) => idToken({ iss: ISSUER, aud: "oaiapp_wrong", sub: "u", exp: 1_900_000_000, nonce }),
      () => idToken({ iss: ISSUER, aud: ISSUED, sub: "u", exp: 1_900_000_000, nonce: "replayed" }),
      (nonce) => idToken({ iss: ISSUER, aud: ISSUED, sub: "u", exp: 1_700_000_000, nonce }),
      (nonce) => idToken({ iss: "https://evil.example", aud: ISSUED, sub: "u", exp: 1_900_000_000, nonce }),
    ]
    for (const bad of cases) {
      const h = fixture({ token: (_, nonce) => Response.json({ access_token: ACCESS, refresh_token: REFRESH, id_token: bad(nonce), expires_in: 3600, scope: SCOPE }) })
      const { params } = await h.start()
      expect((await h.back({ state: params.get("state")!, code: "code", client_id: ISSUED })).status).toBe(400)
      expect(h.auth.status()).toMatchObject({ state: "failed", source: "none", error: "ChatGPT sign-in returned an invalid ID token; sign in again" })
      expect(existsSync(path.join(h.dir, CHATGPT_AUTH_FILE))).toBe(false)
    }
  })

  test("declined plan use (access_denied, or a grant without chatgpt.tokens.use.direct) stops before any request and says why", async () => {
    const declined = "ChatGPT plan use was not allowed; sign in again and allow it, or connect OpenAI with an API key"
    const denied = fixture()
    const a = await denied.start()
    expect((await denied.back({ state: a.params.get("state")!, error: "access_denied" })).status).toBe(400)
    expect(denied.auth.status()).toMatchObject({ state: "failed", error: declined })
    expect(denied.exchanges).toHaveLength(0)
    const partial = fixture({ token: (_, nonce) => Response.json({ access_token: ACCESS, refresh_token: REFRESH, id_token: idToken({ iss: ISSUER, aud: ISSUED, sub: "u", exp: 1_900_000_000, nonce }), expires_in: 3600, scope: "openid profile email offline_access" }) })
    const b = await partial.start()
    expect((await partial.back({ state: b.params.get("state")!, code: "code", client_id: ISSUED })).status).toBe(400)
    expect(partial.auth.status()).toMatchObject({ state: "failed", source: "none", error: declined })
    // The registration stays, so allowing it later reuses the same client.
    expect(JSON.parse(readFileSync(path.join(partial.dir, CHATGPT_HOST_FILE), "utf8")).clientId).toBe(ISSUED)
  })

  test("a new-registration callback without an issued client is incomplete, never exchanged as dynamic_agent_client", async () => {
    const h = fixture()
    const { params } = await h.start()
    expect((await h.back({ state: params.get("state")!, code: "code" })).status).toBe(400)
    expect((await (async () => { const again = await h.start(); return h.back({ state: again.params.get("state")!, code: "code", client_id: "dynamic_agent_client" }) })()).status).toBe(400)
    expect(h.exchanges).toHaveLength(0)
    expect(h.auth.status().error).toBe("ChatGPT sign-in did not finish registering MendCode; sign in again")
  })

  test("expiry refreshes with the issued client and resource and stores the rotated refresh token", async () => {
    let refreshes = 0
    const h = fixture({ token: (body, nonce) => body.get("grant_type") === "refresh_token"
      ? (refreshes++, Response.json({ access_token: "renewed-access", refresh_token: "rotated-refresh", expires_in: 3600, scope: SCOPE }))
      : Response.json({ access_token: ACCESS, refresh_token: REFRESH, id_token: idToken({ iss: ISSUER, aud: ISSUED, sub: "user-fixture", exp: 1_900_000_000, nonce }), expires_in: 3600, scope: SCOPE }) })
    const { params } = await h.start()
    await h.back({ state: params.get("state")!, code: "code", client_id: ISSUED })
    h.advance(3_600_000)
    expect(h.auth.status().state).toBe("expired")
    const headers = await Promise.all([h.auth.headers(), h.auth.headers()])
    expect(refreshes).toBe(1)
    expect(headers.every((value) => value.authorization === "Bearer renewed-access")).toBe(true)
    const refresh = h.exchanges.at(-1)!
    expect(refresh.get("client_id")).toBe(ISSUED)
    expect(refresh.get("resource")).toBe("https://api.openai.com/v1")
    expect(refresh.has("scope")).toBe(false)
    const saved = JSON.parse(readFileSync(path.join(h.dir, CHATGPT_AUTH_FILE), "utf8"))
    expect(saved).toMatchObject({ route: "plan", refresh: "rotated-refresh", clientId: ISSUED, account: "user-fixture" })
  })

  test("a dead refresh token clears the login and asks to sign in again; a server failure keeps it", async () => {
    let answer: Response = new Response(null, { status: 503 })
    const h = fixture({ token: (body, nonce) => body.get("grant_type") === "refresh_token" ? answer : Response.json({ access_token: ACCESS, refresh_token: REFRESH, id_token: idToken({ iss: ISSUER, aud: ISSUED, sub: "u", exp: 1_900_000_000, nonce }), expires_in: 3600, scope: SCOPE }) })
    const { params } = await h.start()
    await h.back({ state: params.get("state")!, code: "code", client_id: ISSUED })
    h.advance(3_600_000)
    await expect(h.auth.headers()).rejects.toThrow("retrying later")
    expect(h.auth.status().source).toBe("v2")
    answer = Response.json({ error: "invalid_grant", error_description: REFRESH }, { status: 400 })
    await expect(h.auth.headers()).rejects.toThrow("sign in again with /connect chatgpt")
    expect(h.auth.status()).toMatchObject({ source: "none", state: "failed", error: "ChatGPT sign-in expired; sign in again with /connect chatgpt" })
    expect(JSON.stringify(h.auth.status())).not.toContain(REFRESH)
  })

  test("device code needs a configured client; cancelling a pending sign-in closes it", async () => {
    const h = fixture()
    await expect(h.auth.authorize("headless")).rejects.toThrow("no device code")
    const { params } = await h.start()
    h.auth.cancel()
    expect(h.auth.status().state).toBe("cancelled")
    expect((await h.back({ state: params.get("state")!, code: "code", client_id: ISSUED })).status).toBe(409)
    expect(h.exchanges).toHaveLength(0)
  })
})
