import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAwsCredentialChain, type Fetch } from "../src"
import type { BedrockOptions } from "@mendcode/protocol"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const KEY = "AKIDEXAMPLE", SECRET = "secret-fixture-never-print", TOKEN = "session-fixture-never-print"
const temporary = () => ({ AccessKeyId: KEY, SecretAccessKey: SECRET, SessionToken: TOKEN, Expiration: new Date(Date.now() + 3600_000).toISOString() })
const xml = () => `<AssumeRoleResponse><Credentials><AccessKeyId>${KEY}</AccessKeyId><SecretAccessKey>${SECRET}</SecretAccessKey><SessionToken>${TOKEN}</SessionToken><Expiration>${temporary().Expiration}</Expiration></Credentials></AssumeRoleResponse>`
function fixture(options: BedrockOptions = {}, fetch: Fetch = async () => { throw new Error("no network") }) {
  const home = mkdtempSync(path.join(tmpdir(), "mendcode-aws-")); dirs.push(home)
  mkdirSync(path.join(home, ".aws/sso/cache"), { recursive: true })
  const env: Record<string, string | undefined> = { AWS_CONFIG_FILE: path.join(home, ".aws/config"), AWS_SHARED_CREDENTIALS_FILE: path.join(home, ".aws/credentials") }
  return { home, env, chain: createAwsCredentialChain({ env: () => env, options, region: "us-east-1", home, fetch }), config: (text: string) => writeFileSync(env.AWS_CONFIG_FILE!, text), keys: (text: string) => writeFileSync(env.AWS_SHARED_CREDENTIALS_FILE!, text) }
}
const signal = () => new AbortController().signal

describe("B10.01 AWS chain without SDK", () => {
  test("environment/session keys are live; a selected profile overrides the environment", async () => {
    const f = fixture()
    expect(f.chain.ready()).toBe(false)
    Object.assign(f.env, { AWS_ACCESS_KEY_ID: KEY, AWS_SECRET_ACCESS_KEY: SECRET, AWS_SESSION_TOKEN: TOKEN })
    expect(f.chain.ready()).toBe(true)
    expect(await f.chain.get(signal())).toMatchObject({ accessKeyId: KEY, secretAccessKey: SECRET, sessionToken: TOKEN })
    f.env.AWS_SECRET_ACCESS_KEY = `${SECRET}-new`
    expect((await f.chain.get(signal())).secretAccessKey).toBe(`${SECRET}-new`)
    f.config(`[profile team]\naws_access_key_id = PROFILEKEY\naws_secret_access_key = profile-secret\n`)
    f.env.AWS_PROFILE = "team"
    expect((await f.chain.get(signal())).accessKeyId).toBe("PROFILEKEY")
    f.keys(`[team]\naws_access_key_id = FILEKEYVALUE\naws_secret_access_key = file-secret\n`)
    expect((await f.chain.get(signal())).accessKeyId).toBe("FILEKEYVALUE")
  })

  test("explicit profile wins, default profile works and invalid credentials never echo a value", async () => {
    const f = fixture({ profile: "explicit" })
    f.env.AWS_PROFILE = "other"
    f.keys(`[explicit]\naws_access_key_id=${KEY}\naws_secret_access_key=${SECRET}\n[other]\naws_access_key_id=OTHERKEYVALUE\naws_secret_access_key=other-secret\n`)
    expect((await f.chain.get(signal())).accessKeyId).toBe(KEY)
    const plain = fixture()
    plain.keys(`[default]\naws_access_key_id=${KEY}\naws_secret_access_key=${SECRET}\n`)
    expect(plain.chain.ready()).toBe(true)
    expect((await plain.chain.get(signal())).accessKeyId).toBe(KEY)
    plain.env.AWS_ACCESS_KEY_ID = SECRET
    await expect(plain.chain.get(signal())).rejects.toThrow("invalid or expired")
    try { await plain.chain.get(signal()) } catch (error) { expect(String(error)).not.toContain(SECRET) }
  })

  test("web identity STS is offline until get, token rotation applies, remote credentials are single flight", async () => {
    let calls = 0
    const f = fixture({}, async (url, init) => {
      calls++
      expect(url).toBe("https://sts.us-east-1.amazonaws.com")
      const body = new URLSearchParams(String(init.body))
      expect(body.get("Action")).toBe("AssumeRoleWithWebIdentity")
      expect(body.get("WebIdentityToken")).toBe(calls === 1 ? "web-token" : "web-token-rotated")
      expect(new Headers(init.headers).has("authorization")).toBe(false)
      expect(init.redirect).toBe("error")
      return new Response(xml())
    })
    const file = path.join(f.home, "web-token")
    writeFileSync(file, "web-token")
    Object.assign(f.env, { AWS_WEB_IDENTITY_TOKEN_FILE: file, AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/test" })
    expect(f.chain.ready()).toBe(true); expect(calls).toBe(0)
    await Promise.all([f.chain.get(signal()), f.chain.get(signal()), f.chain.get(signal())])
    expect(calls).toBe(1)
    writeFileSync(file, "web-token-rotated")
    await f.chain.get(signal()); expect(calls).toBe(2)
  })

  test("assume-role signs STS using source profile, retains external id and rejects cycles/MFA", async () => {
    let calls = 0
    const f = fixture({ profile: "role" }, async (_, init) => {
      calls++
      expect(new Headers(init.headers).get("authorization")).toContain("/us-east-1/sts/aws4_request")
      const body = new URLSearchParams(String(init.body))
      expect(body.get("Action")).toBe("AssumeRole")
      expect(body.get("ExternalId")).toBe("test-external")
      return new Response(xml())
    })
    f.config(`[profile role]\nrole_arn=arn:aws:iam::123456789012:role/test\nsource_profile=source\nexternal_id=test-external\n[profile source]\naws_access_key_id=${KEY}\naws_secret_access_key=${SECRET}\n`)
    expect((await f.chain.get(signal())).sessionToken).toBe(TOKEN)
    await f.chain.get(signal()); expect(calls).toBe(1)
    f.config(`[profile role]\nrole_arn=arn:aws:iam::123456789012:role/test\nsource_profile=role\n`)
    await expect(f.chain.get(signal())).rejects.toThrow("cyclic")
    f.config(`[profile role]\nmfa_serial=arn:aws:iam::123456789012:mfa/test\n`)
    await expect(f.chain.get(signal())).rejects.toThrow("external AWS login")
  })

  test("profile web identity and credential_source Environment use the documented chain", async () => {
    let action = ""
    const f = fixture({ profile: "role" }, async (_, init) => { action = new URLSearchParams(String(init.body)).get("Action")!; return new Response(xml()) })
    const file = path.join(f.home, "identity")
    writeFileSync(file, "local-web-token")
    f.config(`[profile role]\nrole_arn=arn:aws:iam::123456789012:role/test\nweb_identity_token_file=${file}\n`)
    await f.chain.get(signal()); expect(action).toBe("AssumeRoleWithWebIdentity")
    Object.assign(f.env, { AWS_ACCESS_KEY_ID: KEY, AWS_SECRET_ACCESS_KEY: SECRET })
    f.config(`[profile role]\nrole_arn=arn:aws:iam::123456789012:role/test\ncredential_source=Environment\n`)
    await f.chain.get(signal()); expect(action).toBe("AssumeRole")
  })

  test("SSO cached session loads and refreshes only in memory, never writes AWS files", async () => {
    const calls: string[] = []
    const f = fixture({ profile: "team" }, async (url, init) => {
      calls.push(url)
      if (url.includes("oidc")) { expect(JSON.parse(String(init.body)).grantType).toBe("refresh_token"); return Response.json({ accessToken: "refreshed-sso-token", expiresIn: 3600 }) }
      expect(new Headers(init.headers).get("x-amz-sso_bearer_token")).toBe("refreshed-sso-token")
      return Response.json({ roleCredentials: { accessKeyId: KEY, secretAccessKey: SECRET, sessionToken: TOKEN, expiration: Date.now() + 3600_000 } })
    })
    f.config("[profile team]\nsso_session=work\nsso_account_id=123456789012\nsso_role_name=Developer\n[sso-session work]\nsso_region=us-east-1\nsso_start_url=https://example.awsapps.com/start\n")
    const file = path.join(f.home, ".aws/sso/cache", `${createHash("sha1").update("work").digest("hex")}.json`)
    const original = JSON.stringify({ accessToken: "expired-sso-token", expiresAt: "2000-01-01T00:00:00Z", clientId: "client", clientSecret: "client-secret", refreshToken: "refresh-token" })
    writeFileSync(file, original)
    expect(f.chain.ready()).toBe(true); expect(calls).toEqual([])
    expect((await f.chain.get(signal())).sessionToken).toBe(TOKEN)
    await f.chain.get(signal())
    expect(calls).toHaveLength(2)
    expect(readFileSync(file, "utf8")).toBe(original)
  })

  test("credential_process is opt-in, argv has no shell, output is bounded and errors are private", async () => {
    const denied = fixture({ profile: "process" })
    denied.config('[profile process]\ncredential_process="/must-not-execute"\n')
    expect(denied.chain.ready()).toBe(false)
    await expect(denied.chain.get(signal())).rejects.toThrow("off")
    const f = fixture({ profile: "process", allowCredentialProcess: true })
    const script = path.join(f.home, "fake process.js")
    writeFileSync(script, `process.stdout.write(JSON.stringify(${JSON.stringify({ Version: 1, ...temporary() })}))`)
    f.config(`[profile process]\ncredential_process="${process.execPath}" "${script}"\n`)
    expect((await f.chain.get(signal())).accessKeyId).toBe(KEY)
    f.config(`[profile process]\ncredential_process="${process.execPath}" -e "process.stdout.write('not JSON private-secret')"\n`)
    await expect(f.chain.get(signal())).rejects.toThrow("invalid credentials")
  }, 10_000)

  test("container metadata is opt-in, supports auth token and rejects unsafe HTTP endpoints", async () => {
    let calls = 0
    const disabled = fixture()
    disabled.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = "http://127.0.0.1:1234/creds"
    expect(disabled.chain.ready()).toBe(false)
    await expect(disabled.chain.get(signal())).rejects.toThrow("missing")
    const f = fixture({ allowMetadata: true }, async (url, init) => { calls++; expect(url).toBe("http://127.0.0.1:1234/creds"); expect(new Headers(init.headers).get("authorization")).toBe("container-token"); return Response.json(temporary()) })
    Object.assign(f.env, { AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://127.0.0.1:1234/creds", AWS_CONTAINER_AUTHORIZATION_TOKEN: "container-token" })
    expect(f.chain.ready()).toBe(true); expect(calls).toBe(0)
    await f.chain.get(signal()); expect(calls).toBe(1)
    f.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = "http://remote.example/creds"
    await expect(f.chain.get(signal())).rejects.toThrow("unsafe")
  })

  test("instance metadata uses IMDSv2 only, and respects explicit disable", async () => {
    const f = fixture({ allowMetadata: true }, async (url, init) => {
      if (url.endsWith("/api/token")) { expect(init.method).toBe("PUT"); return new Response("imds-token") }
      expect(new Headers(init.headers).get("x-aws-ec2-metadata-token")).toBe("imds-token")
      return url.endsWith("/security-credentials/") ? new Response("test-role") : Response.json(temporary())
    })
    expect((await f.chain.get(signal())).accessKeyId).toBe(KEY)
    f.env.AWS_EC2_METADATA_DISABLED = "true"
    await expect(f.chain.get(signal())).rejects.toThrow("disabled")
  })

  test("aborted calls and expired credential replies fail before use", async () => {
    const f = fixture({ allowMetadata: true }, async () => Response.json({ ...temporary(), Expiration: "2000-01-01T00:00:00Z" }))
    f.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = "http://127.0.0.1:1234/creds"
    await expect(f.chain.get(signal())).rejects.toThrow("expired")
    const abort = new AbortController(); abort.abort(new Error("cancelled"))
    await expect(f.chain.get(abort.signal)).rejects.toThrow("cancelled")
  })
})
