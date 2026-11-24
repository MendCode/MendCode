import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import path from "node:path"
import { isLoopbackHost } from "@mendcode/protocol/wire"
import type { RemoteTransport } from "@mendcode/client"
import { deviceSignedText } from "../../../packages/gateway/src/device-key"

/**
 * `remote login URL` / `remote logout URL`: pairs this terminal with a gateway (docs/gateway.md). The device makes an
 * Ed25519 key that never leaves `<data dir>/remote/gateway/`, shows a code, and its owner approves it on the gateway's
 * page with a passkey. Afterwards every connection signs a fresh challenge for a 10-minute token: no long-lived bearer
 * is stored or sent. Loaded only for these words, or when an attach URL has a saved pairing.
 */
type Fetch = (url: string, init: RequestInit) => Promise<Response>
type Out = { write(text: string): unknown }
export type GatewayProfile = { url: string; deviceId: string; scope: "full" | "read-only" }

const KEY_FILE_MODE = 0o600

export function gatewayOrigin(value: string) {
  let url: URL
  try { url = new URL(value) } catch { throw new Error("remote login needs the gateway's URL, like https://code.example.com") }
  const host = url.hostname.replace(/^\[|\]$/g, "")
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("the gateway URL has no path, query or credentials")
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (host === "localhost" || isLoopbackHost(host)))) throw new Error("a gateway URL is https (plain http only on loopback)")
  return url.origin
}

export const gatewayFiles = (dataDir: string, origin: string) => {
  const name = new URL(origin).host.replace(/[^a-zA-Z0-9.-]/g, "_")
  const dir = path.join(dataDir, "remote", "gateway")
  return { dir, profile: path.join(dir, `${name}.json`), key: path.join(dir, `${name}.key`) }
}

export function readGatewayProfile(dataDir: string, origin: string): GatewayProfile | undefined {
  const files = gatewayFiles(dataDir, origin)
  if (!existsSync(files.profile) || !existsSync(files.key)) return undefined
  try {
    const value = JSON.parse(readFileSync(files.profile, "utf8")) as GatewayProfile
    return value.url === origin && /^d[0-9a-z]{10}$/.test(value.deviceId) ? value : undefined
  } catch { return undefined }
}

async function post(fetcher: Fetch, origin: string, route: string, body: unknown, token?: string) {
  const response = await fetcher(`${origin}/_gw/${route}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), redirect: "error" })
  const value = await response.json().catch(() => ({})) as Record<string, unknown> & { error?: { code?: string; message?: string } }
  return { status: response.status, value }
}

/** Asks the gateway for a short access token by signing its one-use challenge with the device key. */
export async function gatewayAccessToken(input: { dataDir: string; origin: string; fetch?: Fetch }) {
  const fetcher = input.fetch ?? fetch
  const profile = readGatewayProfile(input.dataDir, input.origin)
  if (!profile) throw new Error(`not paired with ${input.origin}; run: remote login ${input.origin}`)
  const key = createPrivateKey(readFileSync(gatewayFiles(input.dataDir, input.origin).key, "utf8"))
  const challenge = await post(fetcher, input.origin, "token/challenge", { deviceId: profile.deviceId })
  if (challenge.status !== 200 || typeof challenge.value.challenge !== "string") throw new Error(`gateway refused a token challenge (${challenge.status})`)
  const signature = sign(null, Buffer.from(deviceSignedText({ origin: input.origin, deviceId: profile.deviceId, challenge: challenge.value.challenge })), key).toString("base64url")
  const issued = await post(fetcher, input.origin, "token", { deviceId: profile.deviceId, challenge: challenge.value.challenge, signature })
  if (issued.status !== 200 || typeof issued.value.accessToken !== "string") throw new Error(issued.status === 401 ? "this device is no longer paired (removed or account disabled); run remote login again" : `gateway refused a token (${issued.status})`)
  return { token: issued.value.accessToken, expiresAt: Date.now() + Number(issued.value.expiresIn ?? 600) * 1000 }
}

/** An HTTP attach to a paired gateway: each (re)connection gets a token that is still valid for at least a minute. */
export function gatewayTransport(remote: { hostname: string; port: number; tls: boolean; httpUrl: string; directory?: string; ca?: string }, dataDir: string): RemoteTransport {
  const origin = gatewayOrigin(remote.httpUrl)
  let cached: { token: string; expiresAt: number } | undefined
  return {
    hostname: remote.hostname, port: remote.port, tls: remote.tls, token: "", httpUrl: remote.httpUrl, ...(remote.directory ? { directory: remote.directory } : {}), ...(remote.ca ? { ca: remote.ca } : {}),
    freshToken: async () => {
      if (!cached || cached.expiresAt - Date.now() < 60_000) cached = await gatewayAccessToken({ dataDir, origin })
      return cached.token
    },
  }
}

export type LoginCommand = { action: "login" | "logout"; origin: string; name: string; dataDir: string }
export function parseLoginCommand(argv: string[], dataDir: string): LoginCommand | undefined {
  const words: string[] = []
  let name: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]!
    if (value === "--name") { name = argv[++i]; if (!name || !/^[\w .@+-]{1,64}$/.test(name)) throw new Error("--name is 1-64 letters, digits or .@+- characters") }
    else if (value === "--dir") i++
    else if (!value.startsWith("-")) words.push(value)
  }
  if (words[0] !== "remote" || (words[1] !== "login" && words[1] !== "logout")) return undefined
  if (words.length !== 3) throw new Error(`usage: remote ${words[1]} https://GATEWAY${words[1] === "login" ? " [--name DEVICE]" : ""}`)
  return { action: words[1], origin: gatewayOrigin(words[2]!), name: name ?? defaultDeviceName(), dataDir }
}

const defaultDeviceName = () => `${hostname().replace(/[^\w.@+-]/g, "-").slice(0, 48) || "device"}-terminal`

export async function runLoginCommand(command: LoginCommand, out: Out, options: { fetch?: Fetch; sleep?: (ms: number) => Promise<unknown>; now?: () => number } = {}) {
  const fetcher = options.fetch ?? fetch
  const sleep = options.sleep ?? Bun.sleep
  const now = options.now ?? Date.now
  const files = gatewayFiles(command.dataDir, command.origin)
  if (command.action === "logout") {
    if (readGatewayProfile(command.dataDir, command.origin)) {
      try {
        const { token } = await gatewayAccessToken({ dataDir: command.dataDir, origin: command.origin, fetch: fetcher })
        await post(fetcher, command.origin, "devices/self/revoke", {}, token)
        out.write("this device was removed from the gateway\n")
      } catch { out.write("could not reach the gateway to remove this device; remove it on the gateway's page\n") }
    }
    rmSync(files.profile, { force: true })
    rmSync(files.key, { force: true })
    out.write("local pairing deleted\n")
    return 0
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const raw = (publicKey.export({ format: "jwk" }) as { x: string }).x
  const started = await post(fetcher, command.origin, "device/start", { name: command.name, publicKey: raw })
  if (started.status !== 200 || typeof started.value.deviceCode !== "string") throw new Error(started.value.error?.message ?? `gateway refused pairing (${started.status})`)
  const deviceCode = started.value.deviceCode
  out.write(`Open ${String(started.value.verificationUri)} , sign in with your passkey and enter this code:\n\n    ${String(started.value.userCode)}\n\nWaiting for approval (${Math.round(Number(started.value.expiresIn) / 60)} minutes)...\n`)
  const deadline = now() + Number(started.value.expiresIn ?? 600) * 1000
  let interval = Math.max(2, Number(started.value.interval ?? 2)) * 1000
  while (now() < deadline) {
    await sleep(interval)
    const polled = await post(fetcher, command.origin, "device/poll", { deviceCode })
    if (polled.status === 429) { interval += 1000; continue }
    if (polled.status === 200 && polled.value.status === "pending") continue
    if (polled.status === 200 && polled.value.status === "approved" && typeof polled.value.deviceId === "string") {
      mkdirSync(files.dir, { recursive: true, mode: 0o700 })
      const temp = `${files.key}.tmp`
      writeFileSync(temp, privateKey.export({ format: "pem", type: "pkcs8" }) as string, { mode: KEY_FILE_MODE, flag: "w" })
      renameSync(temp, files.key)
      writeFileSync(files.profile, `${JSON.stringify({ url: command.origin, deviceId: polled.value.deviceId, scope: polled.value.scope === "read-only" ? "read-only" : "full" } satisfies GatewayProfile)}\n`, { mode: KEY_FILE_MODE })
      out.write(`Paired (${polled.value.scope === "read-only" ? "read only" : "full access"}). Connect with: attach ${command.origin}\n`)
      return 0
    }
    throw new Error(polled.value.error?.message ?? "pairing failed")
  }
  throw new Error("the code expired before it was approved; run remote login again")
}
