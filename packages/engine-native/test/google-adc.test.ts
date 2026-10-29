import { afterEach, describe, expect, test } from "bun:test"
import { generateKeyPairSync, verify } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createGoogleAdcCredential, GOOGLE_CLOUD_SCOPE, RetryableProviderError, type Fetch } from "../src"

const TOKEN = "adc-access-fixture-never-print-0123456789"
const SECRET = "adc-refresh-fixture-never-print-0123456789"
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-adc-")); dirs.push(dir); return dir }
const signal = () => new AbortController().signal
const token = () => Response.json({ access_token: TOKEN, expires_in: 3600, token_type: "Bearer" })
function fixture(raw: Record<string, unknown>) {
  const dir = temp(), file = path.join(dir, "adc.json")
  writeFileSync(file, JSON.stringify(raw), { mode: 0o600 })
  return { dir, file, env: { GOOGLE_APPLICATION_CREDENTIALS: file } }
}
const user = { type: "authorized_user", client_id: "local-client", client_secret: SECRET, refresh_token: SECRET, token_uri: "http://127.0.0.1:9911/token", quota_project_id: "quota-fixture" }

describe("B10.04 Google ADC", () => {
  test("presence is offline; explicit access token rotates without reading files or fetching", async () => {
    const env: Record<string, string> = { GOOGLE_OAUTH_ACCESS_TOKEN: TOKEN, GOOGLE_APPLICATION_CREDENTIALS: "/does-not-exist" }
    let calls = 0
    const adc = createGoogleAdcCredential({ env: () => env, fetch: async () => { calls++; throw new Error("no network") } })
    expect(adc.ready()).toBe(true)
    expect(await adc.token(signal())).toBe(TOKEN)
    env.GOOGLE_OAUTH_ACCESS_TOKEN = "rotated-access-token"
    expect(await adc.token(signal())).toBe("rotated-access-token")
    expect(calls).toBe(0)
    env.GOOGLE_OAUTH_ACCESS_TOKEN = "bad token"
    await expect(adc.token(signal())).rejects.toThrow("invalid")
  })

  test("ADC precedence, cache, expiry and file rotation; credential bytes remain unchanged", async () => {
    const f = fixture(user), before = readFileSync(f.file, "utf8")
    let now = 1_000_000, calls = 0, refresh = SECRET
    const adc = createGoogleAdcCredential({ env: () => ({ ...f.env, CLOUDSDK_CONFIG: "/missing" }), now: () => now, fetch: async (url, init) => {
      calls++
      expect(url).toBe(user.token_uri)
      expect(init.redirect).toBe("error")
      expect(new URLSearchParams(String(init.body)).get("refresh_token")).toBe(refresh)
      return token()
    } })
    expect(adc.ready()).toBe(true)
    expect(calls).toBe(0)
    expect(await adc.token(signal())).toBe(TOKEN)
    expect(adc.quotaProject()).toBe("quota-fixture")
    await adc.token(signal())
    expect(calls).toBe(1)
    now += 3_541_000
    await adc.token(signal())
    expect(calls).toBe(2)
    expect(readFileSync(f.file, "utf8")).toBe(before)
    refresh = "rotated-refresh-token"
    writeFileSync(f.file, JSON.stringify({ ...user, refresh_token: refresh }))
    await adc.token(signal())
    expect(calls).toBe(3)
  })

  test("gcloud default locations are read-only and an explicit missing or corrupt file cannot fall through", async () => {
    const dir = temp(), gcloud = path.join(dir, ".config", "gcloud")
    mkdirSync(gcloud, { recursive: true })
    writeFileSync(path.join(gcloud, "application_default_credentials.json"), JSON.stringify(user))
    for (const env of [{ HOME: dir }, { CLOUDSDK_CONFIG: gcloud }]) {
      const adc = createGoogleAdcCredential({ env: () => env, fetch: async () => token() })
      expect(adc.ready()).toBe(true)
      expect(await adc.token(signal())).toBe(TOKEN)
    }
    let calls = 0
    for (const content of [undefined, "", "{bad-json", "[]", "{\"type\":\"unknown\"}"]) {
      const file = path.join(dir, `invalid-${String(content?.length)}.json`)
      if (content !== undefined) writeFileSync(file, content)
      const adc = createGoogleAdcCredential({ env: () => ({ HOME: dir, GOOGLE_APPLICATION_CREDENTIALS: file }), allowMetadata: true, fetch: async () => { calls++; return token() } })
      await expect(adc.token(signal())).rejects.toThrow("Vertex ADC")
    }
    expect(calls).toBe(0)
  })

  test("service account signs a real RS256 JWT with audience, cloud scope and bounded lifetime", async () => {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const f = fixture({ type: "service_account", client_email: "agent@local-project.iam.gserviceaccount.com", private_key: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), token_uri: user.token_uri })
    const adc = createGoogleAdcCredential({ env: () => f.env, now: () => 1_000_000, fetch: async (url, init) => {
      const body = new URLSearchParams(String(init.body))
      expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer")
      const [header, payload, signature] = body.get("assertion")!.split(".")
      expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toMatchObject({ alg: "RS256" })
      expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toMatchObject({ aud: url, scope: GOOGLE_CLOUD_SCOPE, iat: 1000, exp: 4600 })
      expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), keys.publicKey, Buffer.from(signature!, "base64url"))).toBe(true)
      return token()
    } })
    expect(await adc.token(signal())).toBe(TOKEN)
  })

  test("file federation exchanges the subject and optionally impersonates a service account", async () => {
    const dir = temp(), subject = path.join(dir, "subject.json")
    writeFileSync(subject, JSON.stringify({ identity_token: SECRET }))
    const f = fixture({ type: "external_account", audience: "//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/local/providers/local", subject_token_type: "urn:ietf:params:oauth:token-type:jwt", token_url: "http://127.0.0.1:9911/sts", credential_source: { file: subject, format: { type: "json", subject_token_field_name: "identity_token" } }, service_account_impersonation_url: "http://127.0.0.1:9911/impersonate" })
    const sent: string[] = []
    const adc = createGoogleAdcCredential({ env: () => f.env, fetch: async (url, init) => {
      sent.push(url)
      if (url.endsWith("sts")) { expect(new URLSearchParams(String(init.body)).get("subject_token")).toBe(SECRET); return token() }
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`)
      expect(JSON.parse(String(init.body))).toEqual({ scope: [GOOGLE_CLOUD_SCOPE], lifetime: "3600s" })
      return Response.json({ accessToken: "impersonated-access-token", expireTime: new Date(Date.now() + 3_600_000).toISOString() })
    } })
    expect(await adc.token(signal())).toBe("impersonated-access-token")
    expect(sent).toHaveLength(2)
  })

  test("gcloud impersonated ADC delegates to its source credentials", async () => {
    const f = fixture({ type: "impersonated_service_account", source_credentials: user, service_account_impersonation_url: "http://127.0.0.1:9911/iam" })
    const adc = createGoogleAdcCredential({ env: () => f.env, fetch: async (url) => url.endsWith("iam") ? Response.json({ accessToken: TOKEN, expireTime: new Date(Date.now() + 3_600_000).toISOString() }) : token() })
    expect(await adc.token(signal())).toBe(TOKEN)
  })

  test("metadata is opt-in and fixed to the Google metadata endpoint", async () => {
    let calls = 0
    const fetch: Fetch = async (url, init) => { calls++; expect(url).toBe("http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token"); expect(new Headers(init.headers).get("Metadata-Flavor")).toBe("Google"); return token() }
    const off = createGoogleAdcCredential({ env: () => ({}), fetch })
    expect(off.ready()).toBe(false)
    await expect(off.token(signal())).rejects.toThrow("metadata is off")
    expect(calls).toBe(0)
    expect(await createGoogleAdcCredential({ env: () => ({}), fetch, allowMetadata: true }).token(signal())).toBe(TOKEN)
  })

  test("concurrent calls share refresh; one cancelled waiter does not cancel another", async () => {
    const f = fixture(user)
    let calls = 0, resolve: (response: Response) => void = () => {}
    const adc = createGoogleAdcCredential({ env: () => f.env, fetch: async () => { calls++; return new Promise((done) => { resolve = done }) } })
    const controller = new AbortController()
    const first = adc.token(controller.signal).catch(() => "cancelled")
    const second = adc.token(signal())
    controller.abort()
    expect(await first).toBe("cancelled")
    resolve(token())
    expect(await second).toBe(TOKEN)
    expect(calls).toBe(1)
    const stopped = new AbortController(); stopped.abort()
    await expect(adc.token(stopped.signal)).rejects.toThrow()
    expect(calls).toBe(1)
    let requestSignal: AbortSignal | undefined
    const waiting = createGoogleAdcCredential({ env: () => f.env, fetch: async (_, init) => {
      requestSignal = init.signal as AbortSignal
      return new Promise((_, reject) => requestSignal!.addEventListener("abort", () => reject(requestSignal!.reason), { once: true }))
    } })
    const only = new AbortController()
    const cancelled = waiting.token(only.signal).catch(() => "cancelled")
    only.abort()
    expect(await cancelled).toBe("cancelled")
    expect(requestSignal?.aborted).toBe(true)
  })

  test("unsafe token endpoints and executable/URL/AWS federation fail without sending secrets", async () => {
    let calls = 0
    for (const token_uri of ["https://attacker.example/token", "http://remote.example/token", "https://user:secret@oauth2.googleapis.com/token", "https://oauth2.googleapis.com/token?secret=bad"]) {
      const f = fixture({ ...user, token_uri })
      const adc = createGoogleAdcCredential({ env: () => f.env, fetch: async () => { calls++; return token() } })
      await expect(adc.token(signal())).rejects.toThrow("token endpoint must")
    }
    for (const source of [{ url: "http://remote.example" }, { executable: { command: "danger" } }, { environment_id: "aws1" }]) {
      const f = fixture({ type: "external_account", credential_source: source })
      await expect(createGoogleAdcCredential({ env: () => f.env, fetch: async () => { calls++; return token() } }).token(signal())).rejects.toThrow("disabled")
    }
    expect(calls).toBe(0)
  })

  test("auth and transport errors never echo credentials, endpoint bodies or tokens; transient statuses retry", async () => {
    const f = fixture(user)
    for (const status of [400, 401, 403, 429, 503]) {
      const adc = createGoogleAdcCredential({ env: () => f.env, fetch: async () => Response.json({ secret: SECRET }, { status, headers: { "retry-after": "2" } }) })
      const error = await adc.token(signal()).catch((error: Error) => error) as Error
      expect(error.message).not.toContain(SECRET)
      expect(error instanceof RetryableProviderError).toBe(status >= 429)
      if (error instanceof RetryableProviderError) expect(error.retryAfterMs).toBe(2000)
    }
    for (const fetch of [async () => { throw new Error(SECRET) }, async () => new Response(SECRET), async () => Response.json({ access_token: TOKEN, expires_in: -1 })]) {
      const error = await createGoogleAdcCredential({ env: () => f.env, fetch }).token(signal()).catch((error: Error) => error) as Error
      expect(error.message).not.toContain(SECRET)
      expect(error.message).not.toContain(TOKEN)
    }
  })
})
