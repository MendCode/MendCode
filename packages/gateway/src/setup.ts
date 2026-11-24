import { createHash } from "node:crypto"
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { readableCode, secret, digest } from "./bytes"
import { auditLog } from "./audit"
import { DEFAULT_RUNTIME_ROOT, DEFAULT_STATE_DIR, DEFAULT_USERS_ROOT, GATEWAY_CONFIG_FILE, GATEWAY_SOCKET, validDomain, type GatewayConfig } from "./config"
import { ACCOUNT_ID, ACCOUNT_NAME, gatewayState, type FileOwner } from "./state"
import { CADDY_IMPORT, CADDY_SITE_FILE, CADDYFILE, caddySite, GATEWAY_UNIT, GATEWAY_USER, gatewayUnit, linuxUser, USER_UNIT, userUnit, userUnitTemplate } from "./units"

/**
 * What setup and the admin commands do to the host, behind one small interface so tests run every step against a
 * fake host (no real users, services, Caddy or ACME). The real host runs commands without a shell (no quoting
 * problems) and never prints a captured output: tokens created for an account go straight into 0600 files.
 */
export type CommandResult = { code: number; stdout: string; stderr: string }
export type Host = {
  run(command: string[], options?: { stdin?: string }): Promise<CommandResult>
  read(file: string): string | undefined
  sha256(file: string): string | undefined
  write(file: string, content: string, mode: number, owner?: FileOwner): void
  exists(file: string): boolean
  isRoot(): boolean
  linux(): boolean
}

export const BINARY_TARGET = "/usr/local/lib/mendcode/mendcode"
const SYSTEMD_DIR = "/etc/systemd/system"

export function realHost(): Host {
  return {
    async run(command, options) {
      try {
        const child = Bun.spawn(command, { stdin: options?.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin), stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" } })
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
        return { code, stdout, stderr }
      } catch { return { code: 127, stdout: "", stderr: `${command[0]}: not found` } }
    },
    read(file) { try { return readFileSync(file, "utf8") } catch { return undefined } },
    sha256(file) { try { return sha(readFileSync(file)) } catch { return undefined } },
    write(file, content, mode, owner) {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 })
      writeFileSync(file, content, { mode })
      chmodSync(file, mode)
      if (owner) chownSync(file, owner.uid, owner.gid)
    },
    exists: (file) => existsSync(file),
    isRoot: () => process.getuid?.() === 0,
    linux: () => process.platform === "linux" && existsSync("/run/systemd/system"),
  }
}

export type SetupOptions = {
  domain: string
  mode: "caddy" | "funnel"
  /** Loopback port for Funnel mode (Caddy mode uses a Unix socket). */
  port: number
  adminName: string
  binary: string
  firewall: boolean
  dryRun: boolean
  stateDir?: string
  usersRoot?: string
  runtimeRoot?: string
  memoryMax?: string
  cpuQuota?: string
}
type Out = { write(text: string): unknown }
type Step = { title: string; done(): Promise<boolean>; apply(): Promise<void> }

const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex")

async function must(host: Host, command: string[], what: string, options?: { stdin?: string }) {
  const result = await host.run(command, options)
  if (result.code !== 0) throw new Error(`[GATEWAY]: ${what} failed (${command[0]} exited ${result.code}): ${result.stderr.trim().split("\n").slice(-1)[0] ?? ""}`.slice(0, 400))
  return result
}

async function gatewayOwner(host: Host): Promise<FileOwner | undefined> {
  const uid = await host.run(["id", "-u", GATEWAY_USER])
  const gid = await host.run(["id", "-g", GATEWAY_USER])
  if (uid.code !== 0 || gid.code !== 0) return undefined
  return { uid: Number(uid.stdout.trim()), gid: Number(gid.stdout.trim()) }
}

export function gatewayConfigFor(options: Pick<SetupOptions, "domain" | "mode" | "port" | "runtimeRoot">): GatewayConfig {
  return {
    version: 1,
    origin: `https://${options.domain}`,
    rpId: options.domain,
    name: "MendCode",
    listen: options.mode === "caddy" ? { unix: GATEWAY_SOCKET } : { port: options.port },
    clientIpHeader: options.mode === "caddy" ? "x-real-ip" : "x-forwarded-for",
    runtimeRoot: options.runtimeRoot ?? DEFAULT_RUNTIME_ROOT,
  }
}

/** Runs the steps in order. A finished step is skipped, so a re-run (or a run after a failure) does only what is left. */
async function runSteps(steps: Step[], dryRun: boolean, out: Out) {
  let changed = 0
  for (const step of steps) {
    const done = await step.done()
    if (done) { out.write(`  ok    ${step.title}\n`); continue }
    if (dryRun) { out.write(`  would ${step.title}\n`); changed++; continue }
    out.write(`  ...   ${step.title}\n`)
    await step.apply()
    changed++
  }
  return changed
}

export async function gatewaySetup(options: SetupOptions, host: Host, out: Out): Promise<number> {
  if (!validDomain(options.domain)) throw new Error("[GATEWAY]: --domain needs a public DNS name like code.example.com")
  if (options.mode === "funnel" && !options.domain.endsWith(".ts.net")) throw new Error("[GATEWAY]: --funnel needs this machine's Tailscale name (<machine>.<tailnet>.ts.net)")
  if (!ACCOUNT_NAME.test(options.adminName)) throw new Error("[GATEWAY]: --admin is a name of 1-64 letters, digits or .@+- characters")
  if (!options.dryRun) {
    if (!host.linux()) throw new Error("[GATEWAY]: gateway setup runs on a Linux host with systemd (use --dry-run to see the plan anywhere)")
    if (!host.isRoot()) throw new Error("[GATEWAY]: gateway setup creates users and services: run it as root (or with --dry-run)")
  }
  const stateDir = options.stateDir ?? DEFAULT_STATE_DIR
  const usersRoot = options.usersRoot ?? DEFAULT_USERS_ROOT
  const runtimeRoot = options.runtimeRoot ?? DEFAULT_RUNTIME_ROOT
  const paths = { binary: BINARY_TARGET, stateDir, usersRoot, runtimeRoot, gatewayRuntime: path.dirname(GATEWAY_SOCKET) }
  const config = `${JSON.stringify(gatewayConfigFor({ ...options, runtimeRoot }), null, 2)}\n`
  const units = {
    [path.join(SYSTEMD_DIR, GATEWAY_UNIT)]: gatewayUnit({ ...paths, mode: options.mode }),
    [path.join(SYSTEMD_DIR, USER_UNIT)]: userUnitTemplate({ ...paths, memoryMax: options.memoryMax ?? "2G", cpuQuota: options.cpuQuota ?? "200%", tasksMax: 512 }),
  }
  const site = caddySite({ domain: options.domain, socket: GATEWAY_SOCKET })
  let restart = false
  const steps: Step[] = [
    { title: `install the mendcode binary at ${BINARY_TARGET}`,
      done: async () => host.sha256(BINARY_TARGET) === host.sha256(options.binary) && host.sha256(options.binary) !== undefined,
      apply: async () => { await must(host, ["install", "-D", "-m", "0755", options.binary, BINARY_TARGET], "binary install"); restart = true } },
    { title: `create the system user ${GATEWAY_USER} (no shell, no home)`,
      done: async () => (await host.run(["id", "-u", GATEWAY_USER])).code === 0,
      apply: async () => { await must(host, ["useradd", "--system", "--user-group", "--no-create-home", "--home-dir", "/nonexistent", "--shell", "/usr/sbin/nologin", GATEWAY_USER], "useradd") } },
    { title: `create ${stateDir} (0700, ${GATEWAY_USER}) and ${usersRoot} (0711)`,
      done: async () => host.exists(stateDir) && host.exists(usersRoot),
      apply: async () => {
        await must(host, ["install", "-d", "-m", "0700", "-o", GATEWAY_USER, "-g", GATEWAY_USER, stateDir], "state folder")
        await must(host, ["install", "-d", "-m", "0711", "-o", "root", "-g", "root", usersRoot], "accounts folder")
      } },
    { title: `write ${path.join(stateDir, GATEWAY_CONFIG_FILE)} (origin https://${options.domain})`,
      done: async () => host.read(path.join(stateDir, GATEWAY_CONFIG_FILE)) === config,
      apply: async () => { host.write(path.join(stateDir, GATEWAY_CONFIG_FILE), config, 0o600, await gatewayOwner(host)); restart = true } },
    { title: `write the hardened systemd units ${GATEWAY_UNIT} and ${USER_UNIT}`,
      done: async () => Object.entries(units).every(([file, text]) => host.read(file) === text),
      apply: async () => {
        for (const [file, text] of Object.entries(units)) host.write(file, text, 0o644)
        await must(host, ["systemctl", "daemon-reload"], "systemctl daemon-reload")
        restart = true
      } },
    ...(options.mode === "caddy" ? caddySteps(host, site) : funnelSteps(host, options.port)),
    { title: `start ${GATEWAY_UNIT}`,
      done: async () => !restart && (await host.run(["systemctl", "is-active", "--quiet", GATEWAY_UNIT])).code === 0,
      apply: async () => {
        await must(host, ["systemctl", "enable", GATEWAY_UNIT], "enable gateway")
        await must(host, ["systemctl", "restart", GATEWAY_UNIT], "start gateway")
      } },
    ...(options.firewall ? firewallSteps(host, options.mode) : []),
  ]
  out.write(`${options.dryRun ? "Plan (dry run, nothing changes)" : "Setting up"}: MendCode gateway for https://${options.domain} (${options.mode === "caddy" ? "Caddy + Let's Encrypt" : "Tailscale Funnel"})\n`)
  const changed = await runSteps(steps, options.dryRun, out)
  await adminBootstrap({ host, out, dryRun: options.dryRun, adminName: options.adminName, stateDir, usersRoot, origin: `https://${options.domain}` })
  if (!options.dryRun) await securityReport(host, out)
  out.write(options.dryRun ? `${changed} step(s) would run. Re-run without --dry-run as root to apply.\n` : `Done (${changed} step(s) applied). Re-running is safe: finished steps are skipped.\n`)
  return 0
}

function caddySteps(host: Host, site: string): Step[] {
  return [
    { title: "install Caddy (automatic HTTPS with free Let's Encrypt certificates)",
      done: async () => (await host.run(["caddy", "version"])).code === 0,
      apply: async () => {
        if ((await host.run(["apt-get", "--version"])).code !== 0) throw new Error("[GATEWAY]: install Caddy with your package manager (https://caddyserver.com/docs/install), then re-run setup")
        await must(host, ["apt-get", "install", "-y", "caddy"], "Caddy install")
      } },
    { title: `let Caddy reach the gateway socket and serve the site from ${CADDY_SITE_FILE}`,
      done: async () => host.read(CADDY_SITE_FILE) === site && (host.read(CADDYFILE) ?? "").split("\n").some((line) => line.trim() === CADDY_IMPORT),
      apply: async () => {
        host.write(CADDY_SITE_FILE, site, 0o644)
        const current = host.read(CADDYFILE) ?? ""
        if (!current.split("\n").some((line) => line.trim() === CADDY_IMPORT)) host.write(CADDYFILE, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${CADDY_IMPORT}\n`, 0o644)
        await must(host, ["caddy", "validate", "--config", CADDYFILE, "--adapter", "caddyfile"], "Caddy config check")
        await must(host, ["systemctl", "enable", "caddy"], "enable Caddy")
        await must(host, ["systemctl", "reload-or-restart", "caddy"], "reload Caddy")
      } },
  ]
}

function funnelSteps(host: Host, port: number): Step[] {
  const target = `http://127.0.0.1:${port}`
  return [
    { title: "check that Tailscale is installed and logged in",
      done: async () => (await host.run(["tailscale", "status", "--json"])).code === 0,
      apply: async () => { throw new Error("[GATEWAY]: install Tailscale and run `tailscale up` first (https://tailscale.com/download), then re-run setup") } },
    { title: `publish ${target} on the internet with Tailscale Funnel (free *.ts.net HTTPS)`,
      done: async () => (await host.run(["tailscale", "funnel", "status"])).stdout.includes(target),
      apply: async () => { await must(host, ["tailscale", "funnel", "--bg", "--https=443", target], "tailscale funnel") } },
  ]
}

function firewallSteps(host: Host, mode: "caddy" | "funnel"): Step[] {
  let sshPort: string | undefined
  return [
    { title: `firewall (ufw): deny incoming except SSH${mode === "caddy" ? " and 443/tcp" : ""}`,
      done: async () => {
        const status = await host.run(["ufw", "status"])
        if (status.code !== 0) return false
        const ssh = await host.run(["sshd", "-T"])
        sshPort = /^port (\d+)$/m.exec(ssh.stdout)?.[1]
        return /Status: active/.test(status.stdout) && (mode === "funnel" || /^443\/tcp\s+ALLOW/m.test(status.stdout)) && sshPort !== undefined && new RegExp(`^${sshPort}/tcp\\s+ALLOW`, "m").test(status.stdout)
      },
      apply: async () => {
        if ((await host.run(["ufw", "--version"])).code !== 0) { process.stderr.write("[GATEWAY]: ufw is not installed; restrict incoming traffic to SSH and 443 with your firewall\n"); return }
        if (!sshPort) throw new Error("[GATEWAY]: could not read the SSH port from `sshd -T`; re-run with --no-firewall and configure the firewall yourself")
        for (const rule of [["default", "deny", "incoming"], ["default", "allow", "outgoing"], ["allow", `${sshPort}/tcp`], ...(mode === "caddy" ? [["allow", "443/tcp"]] : [])]) await must(host, ["ufw", ...rule], "ufw rule")
        await must(host, ["ufw", "--force", "enable"], "ufw enable")
      } },
  ]
}

/** The first account: an admin with a one-time code (24 h) to create its passkey. Never repeated once an admin is active. */
async function adminBootstrap(input: { host: Host; out: Out; dryRun: boolean; adminName: string; stateDir: string; usersRoot: string; origin: string }) {
  const existing = input.host.exists(input.stateDir) ? safeRead(input.stateDir) : undefined
  if (existing?.accounts.some((account) => account.role === "admin" && account.status === "active")) { input.out.write("  ok    an admin account is active\n"); return }
  if (input.dryRun) { input.out.write(`  would create the admin account "${input.adminName}" (own Linux user, daemon and data) and print a one-time sign-in link\n`); return }
  const pending = existing?.accounts.find((account) => account.role === "admin" && account.status === "invited")
  const link = await inviteAccount({ host: input.host, stateDir: input.stateDir, usersRoot: input.usersRoot, origin: input.origin, ...(pending ? { accountId: pending.id } : { name: input.adminName, role: "admin" as const }), expiresHours: 24 })
  input.out.write(`\nOpen this one-time link on the device that will hold the admin passkey (valid 24 h, single use):\n  ${link}\n`)
}

function safeRead(stateDir: string) {
  try { return gatewayState(stateDir).read() } catch { return undefined }
}

async function securityReport(host: Host, out: Out) {
  const report = await host.run(["systemd-analyze", "security", "--no-pager", GATEWAY_UNIT])
  const line = report.stdout.split("\n").find((entry) => entry.includes("Overall exposure level"))
  if (line) out.write(`  systemd-analyze security ${GATEWAY_UNIT}: ${line.replace(/^.*Overall exposure level for [^:]+:\s*/, "").trim()}\n`)
}

export type InviteInput = { host: Host; stateDir: string; usersRoot: string; origin: string; expiresHours: number } & ({ name: string; role: "admin" | "user" } | { accountId: string })

/**
 * Provisions an account (a new Linux user `mc-<id>` with a 0700 home, its data and work folders, two daemon tokens
 * the gateway keeps in 0600 files, and its own daemon instance) and returns a one-time link to create a passkey.
 * With `accountId` it only issues a new link for an existing account (another device, or a lost passkey).
 */
export async function inviteAccount(input: InviteInput): Promise<string> {
  const owner = await gatewayOwner(input.host)
  const store = gatewayState(input.stateDir, Date.now, owner)
  const audit = auditLog(input.stateDir, Date.now, owner)
  let accountId: string
  if ("accountId" in input) {
    if (!ACCOUNT_ID.test(input.accountId) || !store.read().accounts.some((account) => account.id === input.accountId)) throw new Error("[GATEWAY]: no such account")
    accountId = input.accountId
  } else {
    if (!ACCOUNT_NAME.test(input.name)) throw new Error("[GATEWAY]: an account name is 1-64 letters, digits or .@+- characters")
    if (store.read().accounts.some((account) => account.name === input.name)) throw new Error("[GATEWAY]: an account with this name exists; use --account ID for a new passkey link")
    accountId = readableCode(10).toLowerCase()
    await provisionAccount(input.host, { accountId, stateDir: input.stateDir, usersRoot: input.usersRoot, owner })
    store.update((state) => { state.accounts.push({ id: accountId, name: input.name, role: input.role, status: "invited", createdAt: Date.now(), passkeys: [], devices: [] }) })
  }
  const code = secret()
  store.update((state) => {
    // One live link per account: a new one replaces the older ones.
    state.invites = state.invites.filter((invite) => invite.accountId !== accountId && invite.expiresAt > Date.now())
    state.invites.push({ hash: digest(code), accountId, createdAt: Date.now(), expiresAt: Date.now() + input.expiresHours * 3600_000 })
  })
  audit.write({ event: "admin.invite", ok: true, account: accountId, detail: { hours: input.expiresHours } })
  return `${input.origin}/_gw/#invite=${code}`
}

async function provisionAccount(host: Host, input: { accountId: string; stateDir: string; usersRoot: string; owner: FileOwner | undefined }) {
  const user = linuxUser(input.accountId)
  const home = path.join(input.usersRoot, input.accountId)
  const data = path.join(home, "data")
  if ((await host.run(["id", "-u", user])).code !== 0) await must(host, ["useradd", "--system", "--user-group", "--create-home", "--home-dir", home, "--shell", "/usr/sbin/nologin", user], "account user")
  await must(host, ["chmod", "0700", home], "account home")
  await must(host, ["install", "-d", "-m", "0700", "-o", user, "-g", user, data, path.join(home, "work")], "account folders")
  const backends = path.join(input.stateDir, "backends", input.accountId)
  for (const [file, flags] of [["full.token", ["--name", "gateway-full"]], ["read.token", ["--read-only", "--name", "gateway-read"]]] as const) {
    if (host.exists(path.join(backends, file))) continue
    const created = await must(host, ["runuser", "-u", user, "--", BINARY_TARGET, "remote", "token", "create", "--dir", data, ...flags], "account daemon token")
    const token = created.stdout.trim()
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) throw new Error("[GATEWAY]: the account daemon gave no token")
    host.write(path.join(backends, file), `${token}\n`, 0o600, input.owner)
  }
  if (input.owner) await must(host, ["chown", "-R", `${GATEWAY_USER}:${GATEWAY_USER}`, path.join(input.stateDir, "backends")], "token ownership")
  await must(host, ["chmod", "0700", path.join(input.stateDir, "backends"), backends], "token folder")
  await must(host, ["systemctl", "enable", "--now", userUnit(input.accountId)], "account daemon")
}

/** `gateway disable|enable ID`: the account's access (sessions, tokens, open connections) and its daemon together. */
export async function setAccountStatus(input: { host: Host; stateDir: string; accountId: string; status: "active" | "disabled" }) {
  const owner = await gatewayOwner(input.host)
  const store = gatewayState(input.stateDir, Date.now, owner)
  const changed = store.update((state) => {
    const account = state.accounts.find((entry) => entry.id === input.accountId)
    if (!account || account.status === "invited") return false
    account.status = input.status
    return true
  })
  if (!changed) throw new Error("[GATEWAY]: no such account (or it has not created a passkey yet)")
  auditLog(input.stateDir, Date.now, owner).write({ event: "admin.account", ok: true, account: input.accountId, detail: { status: input.status, by: "host" } })
  await must(input.host, ["systemctl", input.status === "disabled" ? "disable" : "enable", "--now", userUnit(input.accountId)], "account daemon")
}

export async function revokeDeviceOnHost(input: { host: Host; stateDir: string; accountId: string; deviceId: string }) {
  const owner = await gatewayOwner(input.host)
  const revoked = gatewayState(input.stateDir, Date.now, owner).update((state) => {
    const device = state.accounts.find((entry) => entry.id === input.accountId)?.devices.find((entry) => entry.id === input.deviceId && entry.revokedAt === undefined)
    if (!device) return false
    device.revokedAt = Date.now()
    return true
  })
  if (!revoked) throw new Error("[GATEWAY]: no such device")
  auditLog(input.stateDir, Date.now, owner).write({ event: "device.revoke", ok: true, account: input.accountId, device: input.deviceId, detail: { by: "host" } })
}
