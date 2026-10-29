import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { CHATGPT_AUTH_FILE, createChatgptAuth } from "../src/chatgpt-auth"

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
const TOKEN = "fixture-access-never-print"
const REFRESH = "fixture-refresh-never-print"
const jwt = (account = "fixture-account") => `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.y`
const tokens = { access_token: TOKEN, refresh_token: REFRESH, id_token: jwt(), expires_in: 3600 }

function fixture(options: Partial<Parameters<typeof createChatgptAuth>[0]> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-auth-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  let callback!: (request: Request) => Promise<Response>
  let closed = 0
  let now = 1_800_000_000_000
  const calls: { url: string; init?: RequestInit }[] = []
  const auth = createChatgptAuth({ dir, clientId: "fixture-client", issuer: "https://oauth.example", now: () => now,
    startCallback: (handler) => { callback = handler; return { redirectUri: "http://localhost:1455/auth/callback", close: () => { closed++ } } },
    fetch: async (url, init) => { calls.push({ url, ...(init ? { init } : {}) }); return Response.json(tokens) }, ...options })
  cleanups.push(() => auth.stop())
  return { dir, auth, calls, closed: () => closed, advance: (ms: number) => { now += ms }, callback: (params: Record<string, string>, method = "GET") => callback(new Request(`http://localhost:1455/auth/callback?${new URLSearchParams(params)}`, { method })),
    async login() { const authorization = await auth.authorize("browser"); const state = new URL(authorization.url).searchParams.get("state")!; const response = await callback(new Request(`http://localhost:1455/auth/callback?${new URLSearchParams({ state, code: "fixture-code" })}`)); expect(response.status).toBe(200); return authorization } }
}

describe("B10 own ChatGPT credentials", () => {
  test("status and availability never call a provider or create files", () => {
    const h = fixture({ clientId: undefined })
    expect(h.auth.available()).toBe(false)
    expect(h.auth.status()).toMatchObject({ state: "none", source: "none", accessTokenPresent: false })
    expect(h.calls).toHaveLength(0)
    expect(() => readFileSync(path.join(h.dir, CHATGPT_AUTH_FILE))).toThrow()
  })
  test("browser login uses PKCE, matching state, loopback callback and 0600 storage; status redacts everything", async () => {
    const h = fixture()
    const authorization = await h.login()
    const params = new URL(authorization.url).searchParams
    expect(params.get("redirect_uri")).toBe("http://localhost:1455/auth/callback")
    expect(params.get("code_challenge_method")).toBe("S256")
    const exchange = new URLSearchParams(String(h.calls[0]!.init!.body))
    expect(createHash("sha256").update(exchange.get("code_verifier")!).digest("base64url")).toBe(params.get("code_challenge")!)
    expect(exchange.get("grant_type")).toBe("authorization_code")
    expect(h.closed()).toBe(1)
    expect(statSync(path.join(h.dir, CHATGPT_AUTH_FILE)).mode & 0o777).toBe(0o600)
    const publicData = JSON.stringify(h.auth.status())
    for (const secret of [TOKEN, REFRESH, "fixture-account", "fixture-code"]) expect(publicData).not.toContain(secret)
    expect(await h.auth.headers()).toMatchObject({ authorization: `Bearer ${TOKEN}`, "chatgpt-account-id": "fixture-account" })
  })
  test("wrong state including denial cannot cancel someone else's pending login", async () => {
    const h = fixture()
    await h.auth.authorize("browser")
    expect((await h.callback({ state: "wrong", error: "denied" })).status).toBe(400)
    expect(h.auth.status().state).toBe("pending")
    expect(h.calls).toHaveLength(0)
    expect((await h.callback({ state: "wrong", code: "code" }, "POST")).status).toBe(404)
    await expect(h.auth.authorize("browser")).rejects.toThrow("already pending")
  })
  test("matching denial is sanitized and closes the listener", async () => {
    const h = fixture()
    const a = await h.auth.authorize("browser")
    await h.callback({ state: new URL(a.url).searchParams.get("state")!, error: "denied", error_description: TOKEN })
    expect(h.auth.status()).toMatchObject({ state: "failed", error: "Authorization denied; retry login" })
    expect(JSON.stringify(h.auth.status())).not.toContain(TOKEN)
    expect(h.closed()).toBe(1)
  })
  test("expiry triggers one refresh for concurrent requests and retains a non-rotated refresh token", async () => {
    let calls = 0
    const h = fixture({ fetch: async () => Response.json(++calls === 1 ? tokens : { access_token: "renewed-token", expires_in: 3600 }) })
    await h.login(); h.advance(3_600_000)
    expect(h.auth.status().state).toBe("expired")
    const headers = await Promise.all([h.auth.headers(), h.auth.headers(), h.auth.headers()])
    expect(calls).toBe(2)
    expect(headers.every((header) => header.authorization === "Bearer renewed-token")).toBe(true)
    expect(JSON.parse(readFileSync(path.join(h.dir, CHATGPT_AUTH_FILE), "utf8")).refresh).toBe(REFRESH)
  })
  test("logout cancels a pending exchange; it cannot resurrect credentials", async () => {
    let resolve!: (response: Response) => void
    const h = fixture({ fetch: () => new Promise((done) => { resolve = done }) })
    const a = await h.auth.authorize("browser")
    const response = h.callback({ state: new URL(a.url).searchParams.get("state")!, code: "code" })
    h.auth.logout(); resolve(Response.json(tokens)); await response
    expect(h.auth.status()).toMatchObject({ state: "none", source: "none" })
    expect(readFileSync(path.join(h.dir, CHATGPT_AUTH_FILE), "utf8").trim()).toBe("{}")
  })
  test("logout invalidates an in-flight refresh, and callback replay makes no second exchange", async () => {
    let resolve!: (response: Response) => void
    let calls = 0
    const h = fixture({ fetch: () => ++calls === 1 ? Promise.resolve(Response.json(tokens)) : new Promise((done) => { resolve = done }) })
    const a = await h.login()
    expect((await h.callback({ state: new URL(a.url).searchParams.get("state")!, code: "code" })).status).toBe(409)
    const refresh = h.auth.refresh(); h.auth.logout(); resolve(Response.json(tokens))
    await expect(refresh).rejects.toThrow("refresh failed")
    expect(h.auth.status().source).toBe("none")
    expect(calls).toBe(2)
  })
  test("refresh and exchange failures do not echo response bodies or exception secrets", async () => {
    const h = fixture({ fetch: async () => new Response(TOKEN, { status: 401 }) })
    const a = await h.auth.authorize("browser")
    await h.callback({ state: new URL(a.url).searchParams.get("state")!, code: "code" })
    expect(JSON.stringify(h.auth.status())).not.toContain(TOKEN)
    expect(h.auth.status().state).toBe("failed")
    expect(h.closed()).toBe(1)
  })
  test("no hardcoded client ID, remote cleartext issuer, or malformed credentials", async () => {
    const h = fixture({ clientId: undefined })
    await expect(h.auth.authorize("browser")).rejects.toThrow("CLIENT_ID")
    expect(() => createChatgptAuth({ dir: h.dir, issuer: "http://remote.example" })).toThrow("HTTPS")
    writeFileSync(path.join(h.dir, CHATGPT_AUTH_FILE), "{invalid")
    expect(h.auth.status().state).toBe("failed")
    await expect(h.auth.headers()).rejects.toThrow("invalid v2 credential store")
  })
  test("timeout releases the callback listener without writing credentials", async () => {
    const h = fixture({ timeoutMs: 10 })
    await h.auth.authorize("browser"); await Bun.sleep(25)
    expect(h.auth.status()).toMatchObject({ state: "failed", error: "OAuth authorization timed out" })
    expect(h.closed()).toBe(1)
  })
  test("headless login polls pending responses and exchanges the authorized code", async () => {
    let polls = 0
    const h = fixture({ wait: async () => {}, fetch: async (url) => url.endsWith("/usercode") ? Response.json({ device_auth_id: "device-id", user_code: "ABCD-EFGH", interval: "1" })
      : url.endsWith("/deviceauth/token") ? ++polls === 1 ? new Response(null, { status: 403 }) : Response.json({ authorization_code: "device-code", code_verifier: "device-verifier" }) : Response.json(tokens) })
    const a = await h.auth.authorize("headless")
    expect(a).toMatchObject({ method: "headless", instructions: "Enter code: ABCD-EFGH" })
    for (let i = 0; i < 20 && h.auth.status().state === "pending"; i++) await Bun.sleep(1)
    expect(h.auth.status().state).toBe("authorized")
    expect(polls).toBe(2)
    expect(JSON.stringify(h.auth.status())).not.toContain("ABCD-EFGH")
  })
  test("headless cancellation aborts polling and masks malformed device responses", async () => {
    const h = fixture({ fetch: async () => Response.json({ device_auth_id: "device", user_code: "ABCD-EFGH" }) })
    await h.auth.authorize("headless"); h.auth.cancel()
    expect(h.auth.status().state).toBe("cancelled")
    const bad = fixture({ fetch: async () => Response.json({ user_code: TOKEN }) })
    await expect(bad.auth.authorize("headless")).rejects.toThrow("invalid device")
    expect(JSON.stringify(bad.auth.status())).not.toContain(TOKEN)
  })
})
