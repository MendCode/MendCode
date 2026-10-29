import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import type { BedrockOptions } from "@mendcode/protocol"
import type { Fetch } from "./provider-http"
import { awsHost, signAws, type AwsCredentials } from "./aws-signature"

type Env = Record<string, string | undefined>
type Profile = Record<string, string>
const failure = (reason: string) => new Error(`[AUTH]: AWS ${reason}`)

function read(file: string): string {
  if (statSync(file).size > 1024 * 1024) throw failure("credential file exceeds 1 MiB")
  return readFileSync(file, "utf8")
}

function ini(file: string): Record<string, Profile> {
  let text: string
  try { text = read(file) } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw failure("credential file could not be read") }
  const sections: Record<string, Profile> = Object.create(null)
  let section: Profile | undefined
  for (const line of text.split(/\r?\n/)) {
    const title = /^\s*\[([^\]]+)\]\s*(?:[#;].*)?$/.exec(line)
    if (title) { section = sections[title[1]!.replace(/^profile /, "")] ??= Object.create(null); continue }
    const entry = /^\s*([a-zA-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (section && entry) section[entry[1]!] = entry[2]!
  }
  return sections
}

function credentials(raw: Record<string, unknown>): AwsCredentials {
  const accessKeyId = raw.AccessKeyId ?? raw.accessKeyId ?? raw.aws_access_key_id
  const secretAccessKey = raw.SecretAccessKey ?? raw.secretAccessKey ?? raw.aws_secret_access_key
  const sessionToken = raw.SessionToken ?? raw.sessionToken ?? raw.aws_session_token
  const expires = raw.Expiration ?? raw.expiration ?? raw.aws_expiration
  const expiration = typeof expires === "number" ? expires : typeof expires === "string" ? Date.parse(expires) : undefined
  if (typeof accessKeyId !== "string" || !/^[A-Za-z0-9]{8,128}$/.test(accessKeyId) || typeof secretAccessKey !== "string" || !/^[\x21-\x7e]{8,4096}$/.test(secretAccessKey) || sessionToken !== undefined && (typeof sessionToken !== "string" || !/^[\x21-\x7e]{1,16384}$/.test(sessionToken)) || expiration !== undefined && (!Number.isFinite(expiration) || expiration <= Date.now())) throw failure("credentials are invalid or expired")
  return { accessKeyId, secretAccessKey, ...(typeof sessionToken === "string" ? { sessionToken } : {}), ...(expiration !== undefined ? { expiration } : {}) }
}

function processArgs(command: string): string[] {
  const args: string[] = []
  let word = "", quote = "", escaped = false
  for (const char of command) {
    if (escaped) { word += char; escaped = false }
    else if (char === "\\" && quote !== "'") escaped = true
    else if (quote) { if (char === quote) quote = ""; else word += char }
    else if (char === "'" || char === '"') quote = char
    else if (/\s/.test(char)) { if (word) args.push(word); word = "" }
    else word += char
  }
  if (quote || escaped) throw failure("credential_process has invalid quoting")
  if (word) args.push(word)
  if (!args.length) throw failure("credential_process is empty")
  return args
}

/** Read-only AWS files, per-call environment, temporary credentials cached only until refresh. No SDK dependency. */
export function createAwsCredentialChain(input: { env(): Env; options: BedrockOptions; region: string; fetch?: Fetch; home?: string }) {
  const doFetch: Fetch = input.fetch ?? ((url, init) => fetch(url, init))
  const home = input.home ?? homedir()
  const cache = new Map<string, AwsCredentials>()
  const pending = new Map<string, Promise<AwsCredentials>>()
  const ssoTokens = new Map<string, { stamp: string; token: Record<string, unknown> }>()
  const files = () => {
    const env = input.env()
    const config = ini(env.AWS_CONFIG_FILE ?? path.join(home, ".aws/config"))
    const keys = ini(env.AWS_SHARED_CREDENTIALS_FILE ?? path.join(home, ".aws/credentials"))
    return { config, profiles: Object.fromEntries([...new Set([...Object.keys(config), ...Object.keys(keys)])].map((id) => [id, { ...config[id], ...keys[id] }])) }
  }
  const profileName = () => input.options.profile ?? input.env().AWS_PROFILE
  const envKeys = (): AwsCredentials | undefined => {
    const env = input.env()
    if (!env.AWS_ACCESS_KEY_ID && !env.AWS_SECRET_ACCESS_KEY) return undefined
    return credentials({ AccessKeyId: env.AWS_ACCESS_KEY_ID, SecretAccessKey: env.AWS_SECRET_ACCESS_KEY, SessionToken: env.AWS_SESSION_TOKEN })
  }
  async function remote(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    let response: Response
    try { response = await doFetch(url, { ...init, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) }) }
    catch { if (signal.aborted) throw signal.reason; throw failure("credential service unavailable") }
    if (!response.ok) throw failure(`credential service returned HTTP ${response.status}`)
    return response
  }
  async function memo(key: unknown, run: () => Promise<AwsCredentials>): Promise<AwsCredentials> {
    const id = createHash("sha256").update(JSON.stringify(key)).digest("hex")
    const saved = cache.get(id)
    if (saved?.expiration && saved.expiration > Date.now() + 60_000) return saved
    if (pending.has(id)) return pending.get(id)!
    const promise = run().then((value) => { if (cache.size > 32) cache.clear(); cache.set(id, value); return value }).finally(() => pending.delete(id))
    pending.set(id, promise)
    return promise
  }
  async function sts(fields: Record<string, string>, signal: AbortSignal, source?: AwsCredentials): Promise<AwsCredentials> {
    const url = awsHost("sts", input.region)
    const body = new URLSearchParams({ Version: "2011-06-15", ...fields }).toString()
    const headers = { "content-type": "application/x-www-form-urlencoded" }
    const response = await remote(url, { method: "POST", body, headers: source ? signAws({ url, method: "POST", body, region: input.region, service: "sts", credentials: source, headers }) : headers }, signal)
    const text = await response.text()
    const value = (tag: string) => new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(text)?.[1]?.replace(/&amp;/g, "&")
    return credentials({ AccessKeyId: value("AccessKeyId"), SecretAccessKey: value("SecretAccessKey"), SessionToken: value("SessionToken"), Expiration: value("Expiration") })
  }
  async function webIdentity(roleArn: string, file: string, session: string, signal: AbortSignal) {
    let token: string
    try { token = read(file).trim() } catch { throw failure("web identity token file could not be read") }
    return memo(["web", roleArn, token, session], () => sts({ Action: "AssumeRoleWithWebIdentity", RoleArn: roleArn, RoleSessionName: session, WebIdentityToken: token }, signal))
  }
  async function fromProcess(command: string, signal: AbortSignal): Promise<AwsCredentials> {
    if (!input.options.allowCredentialProcess) throw failure("credential_process is off; opt in with allowCredentialProcess")
    const argv = processArgs(command)
    return memo(["process", command], () => new Promise((resolve, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), { env: input.env(), stdio: ["ignore", "pipe", "ignore"], signal })
      let output = ""
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(failure("credential_process timed out")) }, 5000)
      child.stdout.on("data", (chunk) => { output += chunk; if (output.length > 64_000) { child.kill("SIGKILL"); reject(failure("credential_process output too large")) } })
      child.on("error", () => { clearTimeout(timer); reject(failure("credential_process failed")) })
      child.on("close", (code) => {
        clearTimeout(timer)
        try { if (code !== 0) throw failure("credential_process failed"); const raw = JSON.parse(output); if (raw.Version !== 1) throw failure("credential_process requires Version 1"); resolve(credentials(raw)) }
        catch { reject(failure("credential_process returned invalid credentials")) }
      })
    }))
  }
  async function sso(profile: Profile, config: Record<string, Profile>, signal: AbortSignal) {
    const session = profile.sso_session ? config[`sso-session ${profile.sso_session}`] ?? {} : profile
    const region = session.sso_region ?? profile.sso_region
    const start = session.sso_start_url ?? profile.sso_start_url
    if (!region || !start || !profile.sso_account_id || !profile.sso_role_name) throw failure("SSO profile is incomplete")
    const id = createHash("sha1").update(profile.sso_session ?? start).digest("hex")
    let token: Record<string, unknown>
    let stamp: string
    try {
      const text = read(path.join(home, ".aws/sso/cache", `${id}.json`))
      stamp = createHash("sha256").update(text).digest("hex")
      token = ssoTokens.get(id)?.stamp === stamp ? ssoTokens.get(id)!.token : JSON.parse(text)
    } catch { throw failure("SSO login is missing; run aws sso login externally") }
    let access = token.accessToken
    if (typeof access !== "string") throw failure("SSO token is invalid")
    if (typeof token.expiresAt !== "string" || !Number.isFinite(Date.parse(token.expiresAt)) || Date.parse(token.expiresAt) <= Date.now() + 60_000) {
      if (!token.refreshToken || !token.clientId || !token.clientSecret) throw failure("SSO login expired; run aws sso login externally")
      const response = await remote(`${awsHost("oidc", region)}/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grantType: "refresh_token", clientId: token.clientId, clientSecret: token.clientSecret, refreshToken: token.refreshToken }) }, signal)
      const refreshed = await response.json() as { accessToken?: string; expiresIn?: number }
      access = refreshed.accessToken
      if (typeof access !== "string") throw failure("SSO refresh returned no access token")
      token = { ...token, accessToken: access, expiresAt: new Date(Date.now() + (refreshed.expiresIn ?? 300) * 1000).toISOString() }
      if (ssoTokens.size > 32) ssoTokens.clear()
      ssoTokens.set(id, { stamp, token })
    }
    const url = new URL(`${awsHost("portal.sso", region)}/federation/credentials`)
    url.searchParams.set("account_id", profile.sso_account_id)
    url.searchParams.set("role_name", profile.sso_role_name)
    return memo(["sso", profile, access], async () => {
      const response = await remote(url.href, { method: "GET", headers: { "x-amz-sso_bearer_token": access as string } }, signal)
      const raw = await response.json() as { roleCredentials?: Record<string, unknown> }
      return credentials(raw.roleCredentials ?? {})
    })
  }
  async function metadata(signal: AbortSignal, containerOnly = false): Promise<AwsCredentials> {
    if (!input.options.allowMetadata) throw failure("container/instance metadata is off; opt in with allowMetadata")
    const env = input.env()
    const container = env.AWS_CONTAINER_CREDENTIALS_FULL_URI ?? (env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ? `http://169.254.170.2${env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI}` : undefined)
    if (container) {
      const url = new URL(container)
      if (url.username || url.password || url.hash || !(url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]", "169.254.170.2", "169.254.170.23", "[fd00:ec2::23]"].includes(url.hostname))) throw failure("unsafe container credential endpoint")
      let token = env.AWS_CONTAINER_AUTHORIZATION_TOKEN
      if (env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE) try { token = read(env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE).trim() } catch { throw failure("container auth token file could not be read") }
      if (token && /[\r\n]/.test(token)) throw failure("invalid container auth token")
      return memo(["container", container, token], async () => credentials(await (await remote(url.href, { method: "GET", ...(token ? { headers: { authorization: token } } : {}) }, signal)).json() as Record<string, unknown>))
    }
    if (containerOnly || env.AWS_EC2_METADATA_DISABLED === "true") throw failure("instance metadata is disabled")
    return memo(["imds"], async () => {
      const base = "http://169.254.169.254/latest"
      const token = await (await remote(`${base}/api/token`, { method: "PUT", headers: { "x-aws-ec2-metadata-token-ttl-seconds": "60" } }, signal)).text()
      const headers = { "x-aws-ec2-metadata-token": token }
      const role = (await (await remote(`${base}/meta-data/iam/security-credentials/`, { method: "GET", headers }, signal)).text()).trim()
      if (!/^[A-Za-z0-9_+=,.@-]{1,128}$/.test(role)) throw failure("instance role is invalid")
      return credentials(await (await remote(`${base}/meta-data/iam/security-credentials/${role}`, { method: "GET", headers }, signal)).json() as Record<string, unknown>)
    })
  }
  async function fromProfile(name: string, loaded: ReturnType<typeof files>, signal: AbortSignal, seen = new Set<string>()): Promise<AwsCredentials> {
    if (seen.has(name) || seen.size >= 8) throw failure("profile role chain is cyclic or too deep")
    seen.add(name)
    const profile = loaded.profiles[name]
    if (!profile) throw failure("selected profile was not found")
    if (profile.mfa_serial) throw failure("MFA requires external AWS login with temporary credentials")
    if (profile.role_arn && profile.web_identity_token_file) return webIdentity(profile.role_arn, profile.web_identity_token_file, profile.role_session_name ?? "mendcode", signal)
    if (profile.role_arn) {
      const source = profile.source_profile ? await fromProfile(profile.source_profile, loaded, signal, seen) : profile.credential_source === "Environment" ? envKeys() : ["Ec2InstanceMetadata", "EcsContainer"].includes(profile.credential_source ?? "") ? await metadata(signal, profile.credential_source === "EcsContainer") : undefined
      if (!source) throw failure("role profile needs source_profile or credential_source")
      return memo(["role", profile, source], () => sts({ Action: "AssumeRole", RoleArn: profile.role_arn!, RoleSessionName: profile.role_session_name ?? "mendcode", ...(profile.external_id ? { ExternalId: profile.external_id } : {}), ...(profile.duration_seconds ? { DurationSeconds: profile.duration_seconds } : {}) }, signal, source))
    }
    if (profile.aws_access_key_id || profile.aws_secret_access_key) return credentials(profile)
    if (profile.sso_session || profile.sso_start_url) return sso(profile, loaded.config, signal)
    if (profile.credential_process) return fromProcess(profile.credential_process, signal)
    throw failure("selected profile contains no supported credentials")
  }
  return {
    /** Candidate presence only: never resolves a remote role or executes a credential process. */
    ready(): boolean {
      try {
        const env = input.env()
        if (!profileName() && envKeys()) return true
        const selected = files().profiles[profileName() ?? "default"]
        if (selected) return Boolean(selected.aws_access_key_id && selected.aws_secret_access_key || selected.role_arn || selected.sso_session || selected.sso_start_url || selected.credential_process && input.options.allowCredentialProcess)
        return Boolean(env.AWS_WEB_IDENTITY_TOKEN_FILE && env.AWS_ROLE_ARN || input.options.allowMetadata && (env.AWS_CONTAINER_CREDENTIALS_FULL_URI || env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || env.AWS_EC2_METADATA_DISABLED !== "true"))
      } catch { return false }
    },
    async get(signal: AbortSignal): Promise<AwsCredentials> {
      if (signal.aborted) throw signal.reason
      if (!profileName()) { const keys = envKeys(); if (keys) return keys }
      const loaded = files()
      const name = profileName() ?? "default"
      if (profileName() || loaded.profiles[name]) return fromProfile(name, loaded, signal)
      const env = input.env()
      if (env.AWS_WEB_IDENTITY_TOKEN_FILE && env.AWS_ROLE_ARN) return webIdentity(env.AWS_ROLE_ARN, env.AWS_WEB_IDENTITY_TOKEN_FILE, env.AWS_ROLE_SESSION_NAME ?? "mendcode", signal)
      if (input.options.allowMetadata) return metadata(signal)
      throw failure("credentials are missing; set environment keys or an AWS profile")
    },
  }
}
