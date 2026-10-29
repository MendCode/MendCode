import { createHash, randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

type Credential = { env: string; token: string }
const ENV = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const DNS_NAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
/** Exact lowercase hostnames the operator trusts to name a local auth command; no wildcards or IP literals. */
const trustedHosts = (value: string | undefined) => (value ?? "").split(",").map((host) => host.trim().toLowerCase()).filter((host) => DNS_NAME.test(host))
const tokenText =(value: unknown): value is string => typeof value === "string" && /^[\x21-\x7e]{1,16384}$/.test(value)

async function runCommand(argv: string[], directory: string): Promise<string> {
  const child = Bun.spawn(argv, { cwd: directory, stdin: "ignore", stdout: "pipe", stderr: "ignore" })
  const timer = setTimeout(() => child.kill(), 15_000)
  const reader = child.stdout.getReader()
  let output = ""
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      output += Buffer.from(next.value).toString("utf8")
      if (output.length > 16384) throw new Error("output too large")
    }
    if (await child.exited !== 0) throw new Error("command failed")
    return output.trim()
  } finally { clearTimeout(timer); child.kill(); reader.releaseLock() }
}

/** Trusted local well-known auth, disabled unless explicitly configured. Command output never leaves the daemon. */
export function createProviderMetadataAuth(options: { dir: string; env?: Record<string, string | undefined>; fetch?: (url: string, init?: RequestInit) => Promise<Response>; runCommand?(argv: string[], directory: string): Promise<string> }) {
  const file = path.join(options.dir, "provider-metadata-auth.json")
  const env = options.env ?? process.env
  function read(): Record<string, Credential> {
    try {
      const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, Credential>
      if (!value || typeof value !== "object" || Object.values(value).some((item) => !item || !ENV.test(item.env) || !tokenText(item.token))) throw new Error()
      return value
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return {}
      throw new Error("Provider metadata credential store is invalid")
    }
  }
  function write(entries: Record<string, Credential>) {
    mkdirSync(options.dir, { recursive: true, mode: 0o700 })
    const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`
    writeFileSync(temporary, `${JSON.stringify(entries)}\n`, { mode: 0o600, flag: "wx" })
    renameSync(temporary, file)
  }
  const wellKnownKey = (provider: string) => createHash("sha256").update(`wellknown:${provider}`).digest("hex")
  return {
    /** Stores a well-known credential imported through REST: `env` is the variable name a provider entry reads, `token` its value. Nothing is run or fetched. */
    set(input: { provider: string; env: string; token: string }) {
      if (!ENV.test(input.env) || !tokenText(input.token)) throw new Error("Invalid well-known credential")
      write({ ...read(), [wellKnownKey(input.provider)]: { env: input.env, token: input.token } })
    },
    remove(provider: string) {
      const entries = read(), key = wellKnownKey(provider)
      if (!(key in entries)) return
      delete entries[key]
      write(entries)
    },
    keyForEnv(name: string) { return Object.values(read()).find((item) => item.env === name)?.token },
    async login(input: { url: string; execute?: boolean | undefined }) {
      const url = new URL(input.url)
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Provider metadata login requires an http(s) URL without credentials")
      const trusted = trustedHosts(env.MENDCODE_PROVIDER_METADATA_HOSTS)
      if (!loopback && (url.protocol !== "https:" || !DNS_NAME.test(url.hostname) || !trusted.includes(url.hostname))) throw new Error("Provider metadata login requires a loopback URL, or an https host listed in MENDCODE_PROVIDER_METADATA_HOSTS")
      const enabled = env.MENDCODE_PROVIDER_METADATA === "1" && tokenText(env.MENDCODE_PROVIDER_METADATA_TOKEN)
      if (!input.execute) return { executesNow: false, callsProvider: false, writesSecrets: false, enabled, loopbackOnly: loopback, trustedHost: loopback || trusted.includes(url.hostname), tokenAuthRequired: loopback }
      if (!enabled) throw new Error("Set MENDCODE_PROVIDER_METADATA=1 and MENDCODE_PROVIDER_METADATA_TOKEN to enable metadata login")
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/.well-known/opencode`
      let metadata: { auth?: { env?: unknown; command?: unknown } }
      try {
        // The local token authenticates loopback services only; it is never sent to a public host.
        const response = await (options.fetch ?? fetch)(url.href, { headers: loopback ? { authorization: `Bearer ${env.MENDCODE_PROVIDER_METADATA_TOKEN}` } : {}, redirect: "error", signal: AbortSignal.timeout(10_000) })
        if (!response.ok) throw new Error()
        const text = await response.text()
        if (text.length > 32768) throw new Error()
        metadata = JSON.parse(text)
      } catch { throw new Error("Provider metadata request failed") }
      const auth = metadata?.auth
      if (!auth || typeof auth.env !== "string" || !ENV.test(auth.env) || !Array.isArray(auth.command) || !auth.command.length || auth.command.length > 32 || auth.command.some((value) => typeof value !== "string" || !value || value.length > 4096 || /[\x00\r\n]/.test(value)) || !path.isAbsolute(auth.command[0])) throw new Error("Provider metadata requires an environment name and an absolute local command")
      let token: string
      try { token = (await (options.runCommand ?? runCommand)(auth.command, options.dir)).trim(); if (!tokenText(token)) throw new Error() }
      catch { throw new Error("Provider metadata auth command failed") }
      const entries = read(), key = createHash("sha256").update(input.url.replace(/\/+$/, "")).digest("hex")
      entries[key] = { env: auth.env, token }
      write(entries)
      return { executesNow: true, credentialStored: true, environment: auth.env, secretsPrinted: false }
    },
  }
}
export type ProviderMetadataAuth = ReturnType<typeof createProviderMetadataAuth>
