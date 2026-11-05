import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import type { BedrockOptions } from "@mendcode/protocol"
import type { AwsCredentials } from "./aws-signature"

type Env = Record<string, string | undefined>
type Profile = Record<string, string>
const failure = (reason: string) => new Error(`[AUTH]: AWS ${reason}`)

export function readAwsFile(file: string): string {
  if (statSync(file).size > 1024 * 1024) throw failure("credential file exceeds 1 MiB")
  return readFileSync(file, "utf8")
}

function ini(file: string): Record<string, Profile> {
  let text: string
  try { text = readAwsFile(file) } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw failure("credential file could not be read") }
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

export function awsCredentials(raw: Record<string, unknown>): AwsCredentials {
  const accessKeyId = raw.AccessKeyId ?? raw.accessKeyId ?? raw.aws_access_key_id
  const secretAccessKey = raw.SecretAccessKey ?? raw.secretAccessKey ?? raw.aws_secret_access_key
  const sessionToken = raw.SessionToken ?? raw.sessionToken ?? raw.aws_session_token
  const expires = raw.Expiration ?? raw.expiration ?? raw.aws_expiration
  const expiration = typeof expires === "number" ? expires : typeof expires === "string" ? Date.parse(expires) : undefined
  if (typeof accessKeyId !== "string" || !/^[A-Za-z0-9]{8,128}$/.test(accessKeyId) || typeof secretAccessKey !== "string" || !/^[\x21-\x7e]{8,4096}$/.test(secretAccessKey) || sessionToken !== undefined && (typeof sessionToken !== "string" || !/^[\x21-\x7e]{1,16384}$/.test(sessionToken)) || expiration !== undefined && (!Number.isFinite(expiration) || expiration <= Date.now())) throw failure("credentials are invalid or expired")
  return { accessKeyId, secretAccessKey, ...(typeof sessionToken === "string" ? { sessionToken } : {}), ...(expiration !== undefined ? { expiration } : {}) }
}

/** The same local presence view is used by the catalog and the lazily loaded resolver. */
export function awsPresence(input: { env(): Env; options: BedrockOptions; home?: string }) {
  const home = input.home ?? homedir()
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
    return awsCredentials({ AccessKeyId: env.AWS_ACCESS_KEY_ID, SecretAccessKey: env.AWS_SECRET_ACCESS_KEY, SessionToken: env.AWS_SESSION_TOKEN })
  }
  const ready = () => {
    try {
      const env = input.env()
      if (!profileName() && envKeys()) return true
      const selected = files().profiles[profileName() ?? "default"]
      if (selected) return Boolean(selected.aws_access_key_id && selected.aws_secret_access_key || selected.role_arn || selected.sso_session || selected.sso_start_url || selected.credential_process && input.options.allowCredentialProcess)
      return Boolean(env.AWS_WEB_IDENTITY_TOKEN_FILE && env.AWS_ROLE_ARN || input.options.allowMetadata && (env.AWS_CONTAINER_CREDENTIALS_FULL_URI || env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || env.AWS_EC2_METADATA_DISABLED !== "true"))
    } catch { return false }
  }
  return { home, files, profileName, envKeys, ready }
}

export const GOOGLE_TOKEN_ENV = "GOOGLE_OAUTH_ACCESS_TOKEN"
export const AZURE_TOKEN_ENV = "AZURE_OPENAI_AUTH_TOKEN"
export const entraReady = (options: { env(): Env; tokenEnv?: string }) => Boolean(options.env()[options.tokenEnv ?? AZURE_TOKEN_ENV]?.trim() || ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"].every((name) => options.env()[name]?.trim()))

export function googlePresence(options: { env(): Env; tokenEnv?: string; allowMetadata?: boolean }) {
  const file = () => {
    const env = options.env()
    return env.GOOGLE_APPLICATION_CREDENTIALS || (env.CLOUDSDK_CONFIG ? path.join(env.CLOUDSDK_CONFIG, "application_default_credentials.json") : env.HOME ? path.join(env.HOME, ".config", "gcloud", "application_default_credentials.json") : undefined)
  }
  const exists = () => { try { const target = file(); return Boolean(target && statSync(target).isFile()) } catch { return false } }
  return { file, exists, ready: () => Boolean(options.env()[options.tokenEnv ?? GOOGLE_TOKEN_ENV]?.trim() || exists() || options.allowMetadata) }
}
