import path from "node:path"
import { DEFAULT_STATE_DIR, DEFAULT_USERS_ROOT, readGatewayConfig } from "./config"
import { gatewayState } from "./state"
import { BINARY_TARGET, gatewaySetup, inviteAccount, realHost, revokeDeviceOnHost, setAccountStatus, type Host } from "./setup"

export const GATEWAY_USAGE = `usage: mendcode gateway <command>   (Domain mode: several people, each with their own daemon; docs gateway)
  setup --domain NAME [--funnel] [--port N] [--admin NAME] [--no-firewall] [--dry-run]
        one command on a Linux VPS as root: Caddy (free automatic HTTPS) or Tailscale Funnel, the gateway service,
        hardened units, firewall, and a one-time link for the first admin's passkey. Safe to re-run.
  invite NAME [--admin] [--expires-hours N]   a new account (own Linux user and daemon) and its one-time passkey link
  invite --account ID                          a new passkey link for an existing account
  users | status | migrate
  disable ID | enable ID                       stop or restore an account (its access and its daemon)
  revoke-device ID DEVICE                      remove one paired device of an account
  run                                          the gateway service itself (started by systemd)
  Every command takes --state DIR (default ${DEFAULT_STATE_DIR}).
`

type Io = { out: { write(text: string): unknown }; err: { write(text: string): unknown }; host?: Host; binary?: string }

function flags(args: string[], known: { values: string[]; switches: string[] }) {
  const values = new Map<string, string>()
  const switches = new Set<string>()
  const words: string[] = []
  for (let i = 0; i < args.length; i++) {
    const [name, inline] = args[i]!.split(/=(.*)/s, 2) as [string, string | undefined]
    if (known.switches.includes(name)) { if (inline !== undefined) throw new Error(`${name} takes no value`); switches.add(name); continue }
    if (known.values.includes(name)) {
      const value = inline ?? args[++i]
      if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`)
      values.set(name, value)
      continue
    }
    if (name.startsWith("-")) throw new Error(`unknown option ${name}`)
    words.push(name)
  }
  return { values, switches, words }
}

export async function runGatewayCli(args: string[], io: Io): Promise<number> {
  const command = args[0]
  if (!command || command === "--help" || command === "-h" || command === "help") { io.out.write(GATEWAY_USAGE); return command ? 0 : 64 }
  const host = io.host ?? realHost()
  try {
    const rest = args.slice(1)
    if (command === "run") {
      const parsed = flags(rest, { values: ["--state"], switches: [] })
      if (parsed.words.length) throw new Error("run takes no arguments")
      const { runGateway } = await import("./run")
      await runGateway({ stateDir: parsed.values.get("--state") ?? DEFAULT_STATE_DIR, out: io.out })
      return 0
    }
    if (command === "setup") {
      const parsed = flags(rest, { values: ["--domain", "--port", "--admin", "--state", "--binary", "--memory-max", "--cpu-quota"], switches: ["--funnel", "--no-firewall", "--dry-run"] })
      const domain = (parsed.values.get("--domain") ?? parsed.words[0] ?? "").toLowerCase()
      if (!domain || parsed.words.length > (parsed.values.has("--domain") ? 0 : 1)) throw new Error("setup needs --domain NAME")
      const port = Number(parsed.values.get("--port") ?? 7480)
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("--port must be 1024-65535")
      const binary = parsed.values.get("--binary") ?? io.binary ?? process.execPath
      if (!parsed.switches.has("--dry-run") && path.basename(binary) === "bun") throw new Error("setup installs the compiled mendcode binary: run it from an installed release (or pass --binary PATH)")
      return await gatewaySetup({
        domain, mode: parsed.switches.has("--funnel") ? "funnel" : "caddy", port, adminName: parsed.values.get("--admin") ?? "admin", binary,
        firewall: !parsed.switches.has("--no-firewall"), dryRun: parsed.switches.has("--dry-run"),
        ...(parsed.values.has("--state") ? { stateDir: parsed.values.get("--state")! } : {}),
        ...(parsed.values.has("--memory-max") ? { memoryMax: parsed.values.get("--memory-max")! } : {}),
        ...(parsed.values.has("--cpu-quota") ? { cpuQuota: parsed.values.get("--cpu-quota")! } : {}),
      }, host, io.out)
    }
    const parsed = flags(rest, { values: ["--state", "--expires-hours", "--account"], switches: ["--admin", "--json"] })
    const stateDir = parsed.values.get("--state") ?? DEFAULT_STATE_DIR
    if (command === "invite") {
      if (!host.isRoot() && !io.host) throw new Error("invite creates a Linux user and a service: run it as root")
      const hours = Number(parsed.values.get("--expires-hours") ?? 72)
      if (!Number.isInteger(hours) || hours < 1 || hours > 720) throw new Error("--expires-hours must be 1-720")
      const config = readGatewayConfig(stateDir)
      const account = parsed.values.get("--account")
      if (account ? parsed.words.length !== 0 || parsed.switches.has("--admin") : parsed.words.length !== 1) throw new Error("usage: gateway invite NAME [--admin] | gateway invite --account ID")
      const link = await inviteAccount({ host, stateDir, usersRoot: DEFAULT_USERS_ROOT, origin: config.origin, expiresHours: hours, ...(account ? { accountId: account } : { name: parsed.words[0]!, role: parsed.switches.has("--admin") ? "admin" as const : "user" as const }) })
      io.out.write(`One-time link (single use, ${hours} h); send it only to that person:\n  ${link}\n`)
      return 0
    }
    if (command === "users") {
      const accounts = gatewayState(stateDir).read().accounts.map((account) => ({ id: account.id, name: account.name, role: account.role, status: account.status, passkeys: account.passkeys.length, devices: account.devices.filter((device) => device.revokedAt === undefined).map((device) => ({ id: device.id, name: device.name, scope: device.scope })) }))
      if (parsed.switches.has("--json")) io.out.write(`${JSON.stringify({ accounts })}\n`)
      else for (const account of accounts) io.out.write(`${account.id}\t${account.name}\t${account.role}\t${account.status}\t${account.passkeys} passkey(s)\t${account.devices.map((device) => `${device.id}:${device.name}:${device.scope}`).join(",") || "no devices"}\n`)
      return 0
    }
    if (command === "disable" || command === "enable") {
      if (parsed.words.length !== 1) throw new Error(`usage: gateway ${command} ID`)
      await setAccountStatus({ host, stateDir, accountId: parsed.words[0]!, status: command === "disable" ? "disabled" : "active" })
      io.out.write(`${command}d ${parsed.words[0]}\n`)
      return 0
    }
    if (command === "revoke-device") {
      if (parsed.words.length !== 2) throw new Error("usage: gateway revoke-device ID DEVICE")
      await revokeDeviceOnHost({ host, stateDir, accountId: parsed.words[0]!, deviceId: parsed.words[1]! })
      io.out.write("revoked; its connections close within a second\n")
      return 0
    }
    if (command === "status" || command === "migrate") {
      const config = readGatewayConfig(stateDir)
      const state = gatewayState(stateDir).read()
      if (command === "migrate") { io.out.write("gateway state is version 1: up to date\n"); return 0 }
      const active = await host.run(["systemctl", "is-active", "mendcode-gateway.service"])
      io.out.write(`origin ${config.origin}\nlisten ${"unix" in config.listen ? `unix:${config.listen.unix}` : `127.0.0.1:${config.listen.port}`}\nservice ${active.stdout.trim() || "unknown"}\nbinary ${BINARY_TARGET}\naccounts ${state.accounts.length} (${state.accounts.filter((account) => account.status === "active").length} active), pending invites ${state.invites.filter((invite) => invite.expiresAt > Date.now()).length}\n`)
      return 0
    }
    throw new Error(`unknown gateway command ${command}`)
  } catch (error) {
    io.err.write(`error: ${error instanceof Error ? error.message.replace(/^\[GATEWAY\]: /, "") : String(error)}\n`)
    return 1
  }
}
