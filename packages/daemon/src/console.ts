import { z } from "zod"
import { randomBytes } from "node:crypto"
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { ConsoleUrl, type ConsoleAccount, type ConsoleLogin, type ConsoleOrg, type ConsolePoll, type ConsoleReport, type Settings } from "@mendcode/protocol"

const text = z.string().min(1).max(200)
const token = z.string().min(1).max(8192).regex(/^[^\s\x00-\x1f\x7f]+$/)
const orgSchema = z.object({ id: text, name: text })
const credential = z.object({ id: text, email: text, url: ConsoleUrl, access: token, refresh: token, expiresAt: z.number().nonnegative(), orgID: text.nullable() })
const configSchema = z.object({ enabled: z.boolean(), url: ConsoleUrl.optional(), tokenFile: z.string().max(4096).optional(), activeID: text.optional(), accounts: z.array(credential).max(100) })
type Credential = z.infer<typeof credential>
export type ConsoleAccess = { url: string; accountID?: string; orgID?: string; headers: Record<string, string>; resource: "share" | "shares" }

/** Private, bounded files; refuse links and never expose the contents in diagnostics. */
export function privateText(file: string, max = 2_000_000): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > max || (stat.mode & 0o077) !== 0) throw new Error("Private file must be regular, bounded and mode 0600")
    return readFileSync(fd, "utf8")
  } finally { closeSync(fd) }
}
export function savePrivate(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`
  writeFileSync(temp, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 })
  renameSync(temp, file)
}
export function localUrl(value: string) { return ConsoleUrl.parse(value).replace(/\/$/, "") }
export function serviceLink(value: string, origin: string): string {
  const url = new URL(value, origin)
  if (url.origin !== new URL(origin).origin || url.username || url.password || url.hash) throw new Error("Console returned a non-local link")
  return url.href
}

export function createConsole(input: { dir: string; settings(): Settings; request?: typeof fetch; now?: () => number; openUrl?(url: string): Promise<void> }) {
  const file = path.join(input.dir, "console.json"), now = input.now ?? Date.now
  let state: z.infer<typeof configSchema>
  try { state = configSchema.parse(JSON.parse(privateText(file))) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Console state unreadable")
    state = { enabled: false, accounts: [] }
  }
  const logins = new Map<string, ConsoleLogin & { server: string; device: string; nextAt: number }>()
  let tail: Promise<unknown> = Promise.resolve()
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const next = tail.then(run, run)
    tail = next.catch(() => {})
    return next
  }
  const save = () => savePrivate(file, state)
  const server = () => localUrl(state.url ?? input.settings().enterprise?.url ?? "")
  const enabled = () => { if (!state.enabled) throw new Error("Console is off; configure and enable it first") }
  function bootstrap() {
    enabled()
    if (!state.tokenFile) throw new Error("Console needs a private token file")
    let value: string
    try { value = privateText(state.tokenFile, 8192).trim() } catch { throw new Error("Console token file unreadable or not private") }
    if (!token.safeParse(value).success) throw new Error("Console token file invalid")
    return { authorization: `Bearer ${value}` }
  }
  async function http(url: string, endpoint: string, headers: Record<string, string>, body?: unknown, method = body === undefined ? "GET" : "POST", allowError = false): Promise<unknown> {
    localUrl(url)
    let response: Response
    try { response = await (input.request ?? fetch)(new URL(endpoint, url), { method, headers: { accept: "application/json", "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", credentials: "omit", signal: AbortSignal.timeout(5000) }) }
    catch { throw new Error("Console request failed") }
    if (response.status === 404 && endpoint === "/api/config") { await response.body?.cancel(); return undefined }
    if (!response.ok && !allowError) { await response.body?.cancel(); throw new Error(`Console returned HTTP ${response.status}`) }
    if (!response.body) throw new Error("Console returned an empty response")
    const reader = response.body.getReader(), chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const result = await reader.read()
        if (result.done) break
        size += result.value.byteLength
        if (size > 2_000_000) throw new Error("Console response too large")
        chunks.push(result.value)
      }
      try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) } catch { throw new Error("Console returned invalid JSON") }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  }
  function decode<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value)
    if (!result.success) throw new Error("Console returned invalid data")
    return result.data
  }
  async function resolve(account: Credential) {
    enabled()
    if (account.expiresAt <= now() + 300_000) {
      const fresh = decode(z.object({ access_token: token, refresh_token: token, expires_in: z.number().positive().max(31_536_000) }), await http(account.url, "/auth/device/token", bootstrap(), { grant_type: "refresh_token", refresh_token: account.refresh, client_id: "opencode-cli" }))
      account.access = fresh.access_token
      account.refresh = fresh.refresh_token
      account.expiresAt = now() + fresh.expires_in * 1000
      save()
    }
    return { authorization: `Bearer ${account.access}`, ...(account.orgID ? { "x-org-id": account.orgID } : {}) } as Record<string, string>
  }
  function accounts(): ConsoleAccount[] { return state.accounts.map((a) => ({ accountID: a.id, accountEmail: a.email, accountUrl: a.url, active: a.id === state.activeID, activeOrgID: a.orgID })) }
  async function orgs() {
    enabled()
    const result: ConsoleOrg[] = [], unavailableAccountIDs: string[] = []
    for (const account of state.accounts) {
      try {
        const listed = decode(z.array(orgSchema).max(100), await http(account.url, "/api/orgs", await resolve(account)))
        result.push(...listed.map((org) => ({ accountID: account.id, accountEmail: account.email, accountUrl: account.url, orgID: org.id, orgName: org.name, active: state.activeID === account.id && account.orgID === org.id })))
      } catch { unavailableAccountIDs.push(account.id) }
    }
    result.sort((a, b) => Number(b.active) - Number(a.active) || a.accountEmail.localeCompare(b.accountEmail) || new URL(a.accountUrl).host.localeCompare(new URL(b.accountUrl).host) || a.orgName.localeCompare(b.orgName))
    return { orgs: result.slice(0, 1000), ...(unavailableAccountIDs.length ? { unavailableAccountIDs } : {}) }
  }
  async function report(refresh: boolean): Promise<ConsoleReport> {
    const groups = refresh && state.enabled ? await orgs() : { orgs: [] }
    const listed = groups.orgs
    const active = state.accounts.find((a) => a.id === state.activeID), activeOrg = listed.find((o) => o.active)
    const result: ConsoleReport = { enabled: state.enabled, ...(state.url ?? input.settings().enterprise?.url ? { url: (state.url ?? input.settings().enterprise?.url)! } : {}), tokenConfigured: !!state.tokenFile, accounts: accounts(), ...groups, consoleManagedProviders: [], switchableOrgCount: listed.length, ...(activeOrg ? { activeOrgName: activeOrg.orgName } : {}) }
    if (refresh && state.enabled && active?.orgID) {
      try {
        const raw = await http(active.url, "/api/config", await resolve(active))
        if (raw !== undefined) {
          const data = decode(z.object({ config: z.object({ provider: z.record(z.string(), z.unknown()).optional() }).passthrough(), quota: z.object({ used: z.number().nonnegative(), limit: z.number().positive(), resetAt: z.number().nonnegative().optional() }).optional(), billingUrl: z.string().min(1).max(2048).optional() }), raw)
          result.consoleManagedProviders = Object.keys(data.config.provider ?? {}).slice(0, 200)
          if (data.quota) result.quota = data.quota
          if (data.billingUrl) result.billingUrl = serviceLink(data.billingUrl, active.url)
        }
      } catch { result.metadataError = "Console metadata unavailable" }
    }
    return result
  }
  return {
    http,
    snapshot: () => report(false),
    get: () => serial(() => report(true)),
    listOrgs: () => serial(orgs),
    configure: (config: { enabled: boolean; url?: string; tokenFile?: string }) => serial(async () => {
      const next = { ...state, enabled: config.enabled, ...(config.url ? { url: localUrl(config.url) } : {}), ...(config.tokenFile ? { tokenFile: path.resolve(config.tokenFile) } : {}) }
      if (config.enabled) {
        localUrl(next.url ?? input.settings().enterprise?.url ?? "")
        if (!next.tokenFile || !token.safeParse(privateText(next.tokenFile, 8192).trim()).success) throw new Error("Console needs a private token file")
      }
      state = next
      if (!config.enabled) logins.clear()
      save()
      return report(false)
    }),
    login: (url?: string) => serial(async (): Promise<ConsoleLogin> => {
      enabled()
      const origin = url ? localUrl(url) : server()
      if (origin !== server()) throw new Error("Login URL must match the configured Console")
      for (const [id, login] of logins) if (login.expiresAt <= now()) logins.delete(id)
      if (logins.size >= 10) throw new Error("Too many pending Console logins")
      const data = decode(z.object({ device_code: token, user_code: z.string().min(1).max(100), verification_uri_complete: z.string().max(2048), expires_in: z.number().positive().max(3600), interval: z.number().positive().max(60) }), await http(origin, "/auth/device/code", bootstrap(), { client_id: "opencode-cli" }))
      const login: ConsoleLogin = { loginID: randomBytes(16).toString("hex"), url: serviceLink(data.verification_uri_complete, origin), userCode: data.user_code, expiresAt: now() + data.expires_in * 1000, intervalMs: Math.max(1000, data.interval * 1000) }
      logins.set(login.loginID, { ...login, server: origin, device: data.device_code, nextAt: now() + login.intervalMs })
      return login
    }),
    cancel: (id: string) => serial(async () => { logins.delete(id); return { cancelled: true } }),
    poll: (id: string) => serial(async (): Promise<ConsolePoll> => {
      enabled()
      const login = logins.get(id)
      if (!login || login.expiresAt <= now()) { logins.delete(id); return { status: "expired" } }
      if (login.nextAt > now()) return { status: "pending", intervalMs: login.nextAt - now() }
      const raw = await http(login.server, "/auth/device/token", bootstrap(), { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: login.device, client_id: "opencode-cli" }, "POST", true)
      const error = z.object({ error: z.string().max(100) }).safeParse(raw)
      if (error.success) {
        if (["authorization_pending", "slow_down"].includes(error.data.error)) {
          if (error.data.error === "slow_down") login.intervalMs += 5000
          login.nextAt = now() + login.intervalMs
          return { status: error.data.error === "slow_down" ? "slow" : "pending", intervalMs: login.intervalMs }
        }
        logins.delete(id)
        if (error.data.error === "access_denied") return { status: "denied" }
        if (error.data.error === "expired_token") return { status: "expired" }
        throw new Error("Console authorization failed")
      }
      const data = decode(z.object({ access_token: token, refresh_token: token, token_type: z.literal("Bearer"), expires_in: z.number().positive().max(31_536_000) }), raw)
      const headers = { authorization: `Bearer ${data.access_token}` }
      const user = decode(z.object({ id: text, email: text }), await http(login.server, "/api/user", headers))
      const groups = decode(z.array(orgSchema).max(100), await http(login.server, "/api/orgs", headers))
      const other = state.accounts.filter((a) => a.id !== user.id)
      if (other.length >= 100) throw new Error("Console account limit reached")
      state.accounts = [...other, { id: user.id, email: user.email, url: login.server, access: data.access_token, refresh: data.refresh_token, expiresAt: now() + data.expires_in * 1000, orgID: groups[0]?.id ?? null }]
      state.activeID = user.id
      save()
      logins.delete(id)
      return { status: "success", accountEmail: user.email }
    }),
    logout: (id: string) => serial(async () => {
      if (!state.accounts.some((a) => a.id === id)) throw new Error("Console account not found")
      state.accounts = state.accounts.filter((a) => a.id !== id)
      if (state.activeID === id) { if (state.accounts[0]) state.activeID = state.accounts[0].id; else delete state.activeID }
      save()
      return report(false)
    }),
    switchOrg: (accountID: string, orgID: string) => serial(async () => {
      const listed = (await orgs()).orgs
      if (!listed.some((o) => o.accountID === accountID && o.orgID === orgID)) throw new Error("Console organization unavailable")
      state.accounts.find((a) => a.id === accountID)!.orgID = orgID
      state.activeID = accountID
      save()
      return report(true)
    }),
    access: (owner?: { url: string; accountID?: string; orgID?: string }) => serial(async (): Promise<ConsoleAccess> => {
      enabled()
      const account = state.accounts.find((a) => a.id === (owner?.accountID ?? state.activeID))
      if (owner?.accountID && !account) throw new Error("Share owner account is logged out")
      const url = owner?.url ?? account?.url ?? server()
      if (account) {
        if (owner && new URL(owner.url).origin !== new URL(account.url).origin) throw new Error("Share owner backend changed")
        const headers = await resolve(account), orgID = owner ? owner.orgID : account.orgID ?? undefined
        delete headers["x-org-id"]
        if (orgID) headers["x-org-id"] = orgID
        return { url, accountID: account.id, ...(orgID ? { orgID } : {}), headers, resource: orgID ? "shares" : "share" }
      }
      if (url !== server()) throw new Error("Share backend changed; restore its Console configuration")
      return { url, headers: bootstrap(), resource: "share" }
    }),
    open: (target: "console" | "billing" = "console", loginID?: string) => serial(async () => {
      enabled()
      const active = state.accounts.find((a) => a.id === state.activeID)
      const login = loginID ? logins.get(loginID) : undefined
      if (loginID && (!login || login.expiresAt <= now())) throw new Error("Console login expired")
      if (!login && !active) throw new Error("No active Console account")
      const url = login?.url ?? (target === "billing" ? (await report(true)).billingUrl : active!.url)
      if (!url) throw new Error("Console has no billing link")
      if (input.openUrl) await input.openUrl(url)
      else {
        const child = Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url], { stdout: "ignore", stderr: "ignore" })
        if (await child.exited !== 0) throw new Error("Could not open Console")
      }
      return { url, opened: true }
    }),
  }
}
export type ConsoleService = ReturnType<typeof createConsole>
