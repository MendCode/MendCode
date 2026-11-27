import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { hostname as osHostname, tmpdir } from "node:os"
import path from "node:path"
import { redactSecrets } from "@mendcode/protocol/wire"
import { readRemoteProfiles, writeRemoteProfiles, type RemoteProfiles } from "./remote-profiles"
import { mapProject, normalizeGitRemote, parsePathRule, readLedger, writeLedger, type PathRule, type ProjectIdentity, type RemoteRepo } from "./remote-setup-projects"

/**
 * `remote setup|pair|unpair`: provisions a Linux host that runs Tailscale over SSH and saves it as a remote of this machine.
 * Loaded only by those commands. Every step first looks at what the host already has, so a repeated or resumed run skips finished work.
 * Tokens travel from the host's token store to a 0600 file on this machine and are never printed or logged.
 */
export const DEFAULT_INSTALLER_URL = "https://github.com/MendCode/MendCode/releases/latest/download/install.sh"
const DEFAULT_PORT = 9876

export type SetupCommand = Provision | Unpair
type Unpair = { action: "unpair"; dir: string; device: string; remote?: string; ssh?: string; remoteDir: string; dryRun: boolean }
type Provision =
  { action: "setup" | "pair"; dir: string; host: string; ssh: string; name: string; device: string; port?: number; remoteDir: string; upgrade: boolean; channel?: string; installerUrl: string; makeDefault: boolean; expiresDays?: number; rotate: boolean; reinstallService: boolean; dryRun: boolean; migrateSettings: boolean; migrateSessions: boolean; acpAgents: boolean; pathMaps: PathRule[]; cloneMissing: boolean; searchRoots: string[]; sessionLimit: number; sync: boolean; tailscale?: string; tailscaleSocket?: string }

const VALUE_FLAGS = ["--dir", "--ssh", "--name", "--device", "--port", "--remote-dir", "--channel", "--installer-url", "--expires-days", "--path-map", "--search-root", "--session-limit", "--remote", "--tailscale", "--tailscale-socket"]
const BOOLEAN_FLAGS = ["--upgrade", "--dry-run", "--migrate-settings", "--migrate-sessions", "--acp-agents", "--clone-missing", "--no-default", "--rotate", "--reinstall-service", "--sync"]
export const SETUP_USAGE = "usage: remote setup HOST [--ssh USER@HOST] [--name N] [--device D] [--port P] [--remote-dir DIR] [--upgrade] [--channel stable|beta|nightly] [--expires-days N] [--rotate] [--reinstall-service] [--no-default] [--migrate-settings] [--migrate-sessions [--path-map LOCAL=REMOTE] [--clone-missing] [--search-root DIR] [--session-limit N]] [--acp-agents] [--sync [--path-map LOCAL=REMOTE]] [--tailscale PATH] [--tailscale-socket PATH] [--dry-run]\n       remote pair HOST [--ssh USER@HOST] [--name N] [--device D] [--expires-days N] [--rotate] [--no-default] [--sync] [--tailscale PATH] [--tailscale-socket PATH]\n       remote unpair DEVICE [--remote N] [--ssh USER@HOST] [--dry-run]"

const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,251}$/
const SSH_TARGET = /^[A-Za-z0-9_][A-Za-z0-9._@:[\]-]{0,252}$/
const NAME = /^[A-Za-z0-9_-]{1,64}$/
const REMOTE_PATH = /^(~|\/)[A-Za-z0-9_./-]*$/

function checkRemotePath(value: string, flag: string) {
  if (!REMOTE_PATH.test(value) || value.split("/").includes("..")) throw new Error(`${flag} needs an absolute path or ~/path (letters, digits, _ . - /)`)
  return value
}

export function parseSetupCommand(argv: string[], fallbackDir: string, hostName: () => string = osHostname): SetupCommand | undefined {
  const words: string[] = []
  const values = new Map<string, string[]>()
  const flags = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (VALUE_FLAGS.includes(token)) {
      const next = argv[++i]
      if (!next || next.startsWith("--")) throw new Error(`${token} needs a value`)
      values.set(token, [...values.get(token) ?? [], next])
    } else if (BOOLEAN_FLAGS.includes(token)) flags.add(token)
    else words.push(token)
  }
  if (words[0] !== "remote" || !["setup", "pair", "unpair"].includes(words[1] ?? "")) return undefined
  const action = words[1] as "setup" | "pair" | "unpair"
  if (words.length !== 3) throw new Error(SETUP_USAGE)
  const one = (flag: string) => values.get(flag)?.at(-1)
  const dir = path.resolve(one("--dir") ?? fallbackDir)
  const remoteDir = checkRemotePath(one("--remote-dir") ?? "~/.mendcode", "--remote-dir")
  const sshTarget = one("--ssh")
  if (sshTarget !== undefined && !SSH_TARGET.test(sshTarget)) throw new Error("--ssh needs [user@]host")
  const expires = one("--expires-days")
  const expiresDays = expires === undefined ? undefined : Number(expires)
  if (expiresDays !== undefined && (!Number.isInteger(expiresDays) || expiresDays < 1 || expiresDays > 3650)) throw new Error("--expires-days needs a whole number from 1 to 3650")
  const device = one("--device") ?? (hostName().split(".")[0] ?? "device").toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 60)
  if (!NAME.test(device)) throw new Error("--device uses 1–64 letters, digits, _ or -")
  if (action === "unpair") {
    const unpairOnly = ["--migrate-settings", "--migrate-sessions", "--acp-agents", "--upgrade", "--clone-missing", "--rotate", "--reinstall-service", "--no-default", "--sync"].find((flag) => flags.has(flag))
    const tailscaleFlag = ["--tailscale", "--tailscale-socket"].find((flag) => values.has(flag))
    if (tailscaleFlag) throw new Error(`${tailscaleFlag} does not apply to remote unpair`)
    if (unpairOnly) throw new Error(`${unpairOnly} does not apply to remote unpair`)
    const target = words[2]!
    if (!NAME.test(target)) throw new Error("device name uses 1–64 letters, digits, _ or -")
    return { action, dir, device: target, ...(one("--remote") ? { remote: one("--remote")! } : {}), ...(sshTarget ? { ssh: sshTarget } : {}), remoteDir, dryRun: flags.has("--dry-run") }
  }
  const host = words[2]!.toLowerCase().replace(/\.$/, "")
  if (!HOST.test(host)) throw new Error("HOST must be the host's Tailscale name, like machine.tailnet.ts.net")
  const port = one("--port") === undefined ? undefined : Number(one("--port"))
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("--port needs 1–65535")
  const name = one("--name") ?? host.split(".")[0]!
  if (!NAME.test(name)) throw new Error("--name uses 1–64 letters, digits, _ or -")
  const channel = one("--channel")
  if (channel !== undefined && !["stable", "beta", "nightly"].includes(channel)) throw new Error("--channel needs stable, beta or nightly")
  const installerUrl = one("--installer-url") ?? DEFAULT_INSTALLER_URL
  if (!/^https:\/\/[A-Za-z0-9._~:/?&=%+-]+$/.test(installerUrl)) throw new Error("--installer-url must be an https URL")
  const limit = one("--session-limit") === undefined ? 100 : Number(one("--session-limit"))
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("--session-limit needs 1–500")
  const migrateSessions = flags.has("--migrate-sessions")
  if (!migrateSessions && values.has("--path-map") && !flags.has("--sync")) throw new Error("--path-map needs --migrate-sessions or --sync")
  if (!migrateSessions && (values.has("--search-root") || values.has("--session-limit") || flags.has("--clone-missing"))) throw new Error("--path-map, --search-root, --session-limit and --clone-missing need --migrate-sessions")
  if (action === "pair" && (migrateSessions || flags.has("--migrate-settings") || flags.has("--acp-agents") || flags.has("--upgrade") || values.has("--port") || values.has("--channel"))) throw new Error("remote pair only adds this device; migration, upgrades and the port belong to remote setup")
  return {
    action, dir, host, ssh: sshTarget ?? host, name, device, ...(port ? { port } : {}), remoteDir, upgrade: flags.has("--upgrade"), ...(channel ? { channel } : {}), installerUrl,
    makeDefault: !flags.has("--no-default"), ...(expiresDays ? { expiresDays } : {}), rotate: flags.has("--rotate"), reinstallService: flags.has("--reinstall-service"), dryRun: flags.has("--dry-run"),
    migrateSettings: flags.has("--migrate-settings"), migrateSessions, acpAgents: flags.has("--acp-agents"), pathMaps: (values.get("--path-map") ?? []).map(parsePathRule),
    cloneMissing: flags.has("--clone-missing"), searchRoots: (values.get("--search-root") ?? []).map((root) => checkRemotePath(root, "--search-root")), sessionLimit: limit,
    sync: flags.has("--sync"),
    ...(one("--tailscale") ? { tailscale: checkRemotePath(one("--tailscale")!, "--tailscale") } : {}),
    ...(one("--tailscale-socket") ? { tailscaleSocket: checkRemotePath(one("--tailscale-socket")!, "--tailscale-socket") } : {}),
  }
}

export type SshResult = { code: number; stdout: string; stderr: string }
/** One remote shell script, with optional stdin. The default runs `ssh` in batch mode; tests pass a fake. */
export type SshRunner = (call: { script: string; input?: string | Uint8Array }) => Promise<SshResult>
export type LocalSession = { id: string; title: string; directory: string }
export type LocalPort = {
  dataDir: string
  exportBundle(file: string): Promise<void>
  listSessions(limit: number): Promise<LocalSession[]>
  exportSession(id: string): Promise<{ text: string; truncated: boolean }>
  identity(directory: string): Promise<ProjectIdentity>
  reachable(address: string): Promise<boolean>
  sleep(ms: number): Promise<void>
}
export type SetupDeps = { ssh: (target: string) => SshRunner; local: LocalPort; out: { write(text: string): unknown }; now?: () => number }

class SetupError extends Error {}

const shq = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`
/** `~/x` stays expandable by the host's shell; everything else is literal (the path alphabet has no quote, `$` or backtick). */
const shellPath = (value: string) => value.startsWith("~") ? `"$HOME"${value.slice(1)}` : `"${value}"`
/** Long token-like runs never reach a message. */
const scrub = (text: string) => text.replace(/[A-Za-z0-9_-]{32,}/g, "***").replace(/\s+/g, " ").trim().slice(0, 300)
const PRELUDE = (remoteDir: string) => `set -eu
export PATH="\${PATH:-/usr/bin:/bin}:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/sbin:/usr/sbin:/sbin"
MC="$HOME/.local/bin/mendcode"; if command -v mendcode >/dev/null 2>&1; then MC=$(command -v mendcode); fi
export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
D=${shellPath(remoteDir)}
`

/** Finds tailscale (the given path, PATH, then the usual user and system bin directories) and its socket (the given one, else the unprivileged user's own when the system socket is absent). Prints what it found as `tailscale=`, `tailscale_path=` and `tailscale_socket=`. */
function findTailscale(command: { tailscale?: string; tailscaleSocket?: string }) {
  return `TS=${command.tailscale ? shellPath(command.tailscale) : '""'}
if [ -z "$TS" ]; then TS=$(command -v tailscale 2>/dev/null || true); fi
if [ -z "$TS" ]; then for d in "$HOME/.local/bin" /usr/local/bin /usr/bin /opt/homebrew/bin; do if [ -x "$d/tailscale" ]; then TS="$d/tailscale"; break; fi; done; fi
if [ -n "$TS" ] && [ ! -x "$TS" ]; then TS=""; fi
SOCK=${command.tailscaleSocket ? shellPath(command.tailscaleSocket) : '""'}
if [ -z "$SOCK" ] && [ ! -S /var/run/tailscale/tailscaled.sock ] && [ -S "$HOME/.local/state/tailscale/tailscaled.sock" ]; then SOCK="$HOME/.local/state/tailscale/tailscaled.sock"; fi
if [ -n "$TS" ]; then echo tailscale=yes; else echo tailscale=no; fi
echo "tailscale_path=$TS"; echo "tailscale_socket=$SOCK"`
}

const SAFE_PATH = /^[A-Za-z0-9_./+-]*$/
/** Defines `ts` in a remote script: the tailscale binary found by the probe, with --socket when one is used. */
function tailscaleFunction(found: { path: string; socket: string }) {
  return `TS=${shq(found.path)}; SOCK=${shq(found.socket)}
ts() { if [ -n "$SOCK" ]; then "$TS" --socket "$SOCK" "$@"; else "$TS" "$@"; fi; }
`
}

function fields(text: string) {
  const map = new Map<string, string>()
  for (const line of text.split("\n")) { const at = line.indexOf("="); if (at > 0) map.set(line.slice(0, at), line.slice(at + 1).trim()) }
  return map
}

/** The ordered list of steps and what each does; `--dry-run` prints exactly this and runs nothing. */
export function setupPlan(command: SetupCommand): string[] {
  if (command.action === "unpair") return [`revoke the token ${command.device} and its sync token ${command.device}-sync (if any) on the host over SSH (its devices drop within a second)`, `delete this machine's token files for ${command.device}, its session sync setup and the saved remote that use them, if any`]
  const where = command.tailscale ? `tailscale at ${command.tailscale}` : "tailscale (found in PATH, ~/.local/bin, /usr/local/bin, /usr/bin or /opt/homebrew/bin)"
  const lines = [`check ${command.ssh} over SSH (read-only): Linux with systemd, ${where}${command.tailscaleSocket ? ` with the socket ${command.tailscaleSocket}` : " (a user socket under ~/.local/state/tailscale is used when the system one is absent)"} running, and the name ${command.host}; detect whether Tailscale runs in userspace networking (its address is on no network interface of the host)`]
  if (command.action === "setup") {
    lines.push(
      `install MendCode on the host with ${command.installerUrl} (the installer checks the binary's SHA256${command.upgrade ? "; --upgrade also replaces an installed version" : "; an installed version is kept"})`,
      `get the TLS certificate with tailscale cert into ${command.remoteDir}/tls and add a systemd user timer that renews it every 30 days (the same tailscale path and socket); if the tailnet has no HTTPS certificates, make a private CA with openssl on the host instead (825 days, no timer, re-run setup to renew) and save its ca.pem here for the remote`,
      `write ${command.remoteDir}/remote.json with port ${command.port ?? `${DEFAULT_PORT} (or the one already set)`}: with a system Tailscale (mode tailscale) the listener binds the host's tailnet address; with userspace Tailscale (no root) it binds 127.0.0.1 with TLS, because tailscaled forwards inbound tailnet TCP to localhost on the same port`,
    )
  } else lines.push(`read ${command.remoteDir}/remote.json on the host for the address and port`)
  lines.push(`create the token ${command.device}${command.expiresDays ? ` (expires in ${command.expiresDays} days)` : ""} on the host and save it to ${tokenFile(command.dir, command.name, command.device)} (mode 0600, never printed)`)
  if (command.action === "setup") lines.push(`install the daemon service with a listener (\`daemon service install --listener\`) and start it${command.reinstallService ? " (reinstalling)" : ""}`)
  if (command.sync) lines.push(`create the sync token ${command.device}-sync (it may only sync sessions) on the host and save it to ${syncTokenFile(command.dir, command.name)}`)
  lines.push(`save the remote ${command.name} (${command.host}:${command.port ?? DEFAULT_PORT}) in ${path.join(command.dir, "remotes.json")}${command.makeDefault ? " as the default, so a bare mendcode connects" : ""}`, "check that the host answers over the tailnet")
  if (command.sync) lines.push(`turn on session sync with ${command.name} (${path.join(command.dir, "sync.json")}): the host's sessions appear here, \`mendcode sync take ID\` continues one on this machine`)
  if (command.action === "setup") {
    if (command.migrateSettings) lines.push("export this machine's settings bundle and import it on the host with --rewrite-home (credentials, tokens and authority settings never travel; those wait for approval there)")
    if (command.acpAgents) lines.push("add the ACP agents of this machine that are on the host's PATH (command and args only; no env values, no credentials)")
    if (command.migrateSessions) lines.push(`move up to ${command.sessionLimit} sessions: match each project by git remote and path in the repo${command.pathMaps.length ? " (after --path-map rules)" : ""}${command.cloneMissing ? ", cloning missing ones on the host" : ""}, then import the transcript there; sessions already moved are skipped`)
  }
  return lines
}

export type SetupResult = { code: number }

export async function runSetup(command: SetupCommand, deps: SetupDeps): Promise<SetupResult> {
  const say = (line: string) => deps.out.write(`${line}\n`)
  const lines = setupPlan(command)
  if (command.dryRun) {
    say(`remote ${command.action} plan (nothing is run, no SSH connection is opened):`)
    lines.forEach((line, index) => say(`  ${index + 1}. ${line}`))
    return { code: 0 }
  }
  try {
    if (command.action === "unpair") await unpair(command, deps, say)
    else await provision(command, deps, say)
    return { code: 0 }
  } catch (error) {
    const message = error instanceof SetupError ? error.message : `unexpected failure: ${scrub(error instanceof Error ? error.message : String(error))}`
    say(`error: ${message}`)
    if (command.action !== "unpair") say("Finished steps are skipped on the next run: fix the cause and run the same command again.")
    return { code: 1 }
  }
}

/** One file per (remote, device): this machine's device name is the same for every host it sets up, and each host issues its own token. */
function tokenFile(dir: string, remote: string, device: string) { return path.join(dir, "remote", `${remote}.${device}.token`) }
/** Profiles saved before token files were per remote point at `<device>.token`; unpair still recognizes and removes that file. */
function legacyTokenFile(dir: string, device: string) { return path.join(dir, "remote", `${device}.token`) }
/** Where `--sync` keeps the sync-scoped token; `mendcode sync enable NAME` looks there too. */
function syncTokenFile(dir: string, remote: string) { return path.join(dir, "remote", `${remote}.sync-token`) }

/** The CA of a host whose tailnet cannot issue certificates; saved next to the token (mode 0600, in the 0700 remote directory). */
function caFileOf(dir: string, remote: string) { return path.join(dir, "remote", `${remote}.ca.pem`) }

/** What `tailscale cert` prints when HTTPS certificates are not enabled for the tailnet ("your Tailscale account does not support getting TLS certs"). */
const NO_TAILNET_CERTS = /does not support getting TLS certs|HTTPS (certificates )?(are |is )?not enabled|enable HTTPS/i

/**
 * Fallback for a tailnet without HTTPS certificates: an EC P-256 CA on the host (key 0600 in <remote dir>/tls, reused when it exists) signs a 825-day
 * server certificate for the DNS name, the short name, the tailnet IP and 127.0.0.1. It writes cert.pem and key.pem, the files `remote.json` already names.
 * Exit 127 means openssl is missing.
 */
export function privateCaScript(facts: { dns: string; ip: string }) {
  const short = facts.dns.split(".")[0]!
  return `command -v openssl >/dev/null 2>&1 || { echo "openssl is not installed on the host" >&2; exit 127; }
umask 077; mkdir -p "$D/tls"; cd "$D/tls"
ABS=$(cd "$D" && pwd); echo "abs=$ABS"
if [ ! -s ca.key ] || [ ! -s ca.pem ]; then
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out ca.key >&2
  openssl req -x509 -new -key ca.key -sha256 -days 3650 -subj "/CN=MendCode private CA" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" -out ca.pem >&2
fi
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out key.pem >&2
openssl req -new -key key.pem -subj "/CN=${facts.dns}" -out server.csr >&2
printf '%s\\n' "subjectAltName=DNS:${facts.dns},DNS:${short},IP:${facts.ip},IP:127.0.0.1" "basicConstraints=CA:FALSE" "keyUsage=digitalSignature" "extendedKeyUsage=serverAuth" > server.ext
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 825 -sha256 -extfile server.ext -out cert.pem >&2
rm -f server.csr server.ext ca.srl
chmod 600 ca.key key.pem cert.pem ca.pem
echo "expires=$(openssl x509 -in cert.pem -noout -enddate | sed 's/^notAfter=//')"`
}

function writePrivate(file: string, text: string) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, text, { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, file)
}

async function unpair(command: Unpair,deps: SetupDeps, say: (line: string) => void) {
  const profiles = readRemoteProfiles(command.dir)
  const remote = command.remote ?? profiles?.defaultRemote
  const profile = remote ? profiles?.remotes[remote] : undefined
  const target = command.ssh ?? (profile ? parseHost(profile.connect) : undefined)
  if (!target || !SSH_TARGET.test(target)) throw new SetupError("name the host with --ssh USER@HOST or --remote NAME")
  const run = deps.ssh(target)
  const result = await run({ script: `${PRELUDE(command.remoteDir)}"$MC" remote token revoke ${shq(command.device)} --dir "$D"` })
  if (result.code !== 0 && !/unknown token name/.test(result.stderr + result.stdout)) throw new SetupError(`could not revoke ${command.device} on the host: ${scrub(result.stderr || result.stdout)}`)
  say(result.code === 0 ? `revoked ${command.device} on the host` : `${command.device} was not on the host (already revoked)`)
  // The sync credential `--sync` issued beside it (`<device>-sync`) is revoked too: a copy of it stays valid on the host otherwise.
  const syncName = `${command.device}-sync`
  const syncResult = await run({ script: `${PRELUDE(command.remoteDir)}"$MC" remote token revoke ${shq(syncName)} --dir "$D"` })
  if (syncResult.code !== 0 && !/unknown token name/.test(syncResult.stderr + syncResult.stdout)) throw new SetupError(`could not revoke ${syncName} on the host: ${scrub(syncResult.stderr || syncResult.stdout)}`)
  if (syncResult.code === 0) say(`revoked ${syncName} on the host`)
  if (!remote) return
  const file = tokenFile(command.dir, remote, command.device)
  const legacy = legacyTokenFile(command.dir, command.device)
  const ownFile = profile?.tokenFile === file || profile?.tokenFile === legacy
  rmSync(file, { force: true })
  // The earlier name had no remote in it, so another saved remote may still point at the same file: it stays while one does.
  const legacyShared = Object.entries(profiles?.remotes ?? {}).some(([name, other]) => name !== remote && other.tokenFile === legacy)
  if (profile?.tokenFile === legacy && !legacyShared) rmSync(legacy, { force: true })
  if (ownFile) {
    // This machine is the device that was unpaired: its sync token file and the sync setup that uses it go too.
    rmSync(syncTokenFile(command.dir, remote), { force: true })
    rmSync(caFileOf(command.dir, remote), { force: true })
    const { readSyncConfig, writeSyncConfig } = await import("@mendcode/daemon/sync-config")
    let syncing: string | undefined
    try { syncing = readSyncConfig(command.dir)?.remote } catch { /* an unreadable sync.json is left for `sync` to report */ }
    if (syncing === remote) {
      writeSyncConfig(command.dir, undefined)
      say(`turned off session sync with ${remote}`)
    }
  }
  if (profiles && ownFile) {
    const next: RemoteProfiles = { ...profiles, remotes: { ...profiles.remotes } }
    delete next.remotes[remote]
    if (next.defaultRemote === remote) delete next.defaultRemote
    writeRemoteProfiles(command.dir, next)
    say(`removed the saved remote ${remote}`)
  }
}

const parseHost = (address: string) => address.replace(/:\d+$/, "")

type Facts = { dns: string; ip: string; home: string; version?: string; systemd: boolean; userspace: boolean }

async function provision(command: Provision,deps: SetupDeps, say: (line: string) => void) {
  const run = deps.ssh(command.ssh)
  const remote = async (body: string, input?: string | Uint8Array) => run({ script: PRELUDE(command.remoteDir) + body, ...(input === undefined ? {} : { input }) })
  const must = async (what: string, body: string, input?: string | Uint8Array) => {
    const result = await remote(body, input)
    if (result.code !== 0) throw new SetupError(`${what}: ${scrub(result.stderr || result.stdout) || `exit ${result.code}`}`)
    return result.stdout
  }
  const total = command.action === "setup" ? 7 : 4
  let step = 0
  const begin = (title: string) => say(`[${++step}/${total}] ${title}`)

  begin("checking the host")
  const probe = await remote(`echo "os=$(uname -s)"; echo "arch=$(uname -m)"; echo "home=$HOME"
if command -v systemctl >/dev/null 2>&1; then echo systemd=yes; else echo systemd=no; fi
${findTailscale(command)}
if [ -x "$MC" ]; then echo "mendcode=$("$MC" --version 2>/dev/null | head -n 1 || true)"; else echo mendcode=none; fi`)
  if (probe.code !== 0) throw new SetupError(`cannot run commands on ${command.ssh} over SSH: ${scrub(probe.stderr) || `exit ${probe.code}`}. Check that \`ssh ${command.ssh}\` works without a password prompt.`)
  const seen = fields(probe.stdout)
  if (seen.get("os") !== "Linux") throw new SetupError(`the host runs ${seen.get("os") || "an unknown system"}; remote setup supports Linux with systemd`)
  if (seen.get("systemd") !== "yes") throw new SetupError("the host has no systemd; remote setup installs a systemd user service")
  if (seen.get("tailscale") !== "yes") throw new SetupError("Tailscale is not installed on the host (looked in PATH, ~/.local/bin, /usr/local/bin, /usr/bin and /opt/homebrew/bin): install it and run `tailscale up` there first, or give its location with --tailscale PATH (and --tailscale-socket PATH)")
  const found = { path: seen.get("tailscale_path") ?? "", socket: seen.get("tailscale_socket") ?? "" }
  if (!found.path.startsWith("/") || !SAFE_PATH.test(found.path) || !SAFE_PATH.test(found.socket)) throw new SetupError("the host's tailscale path or socket has characters this tool does not pass to a remote shell; pass a plain path with --tailscale and --tailscale-socket")
  const tsDefinition = tailscaleFunction(found)
  say(`  tailscale ${found.path}${found.socket ? ` (socket ${found.socket})` : ""}`)
  const status = await remote(`${tsDefinition}ts status --json`)
  let facts: Facts
  try {
    const parsed = JSON.parse(status.stdout) as { BackendState?: string; Self?: { DNSName?: string; TailscaleIPs?: string[] } }
    if (parsed.BackendState !== "Running") throw new SetupError(`Tailscale on the host is ${parsed.BackendState ?? "not running"}: run \`tailscale up\` there`)
    const dns = (parsed.Self?.DNSName ?? "").replace(/\.$/, "").toLowerCase()
    const ip = parsed.Self?.TailscaleIPs?.find((address) => /^\d+\.\d+\.\d+\.\d+$/.test(address))
    if (!dns || !ip) throw new SetupError("Tailscale on the host reports no name or IPv4 address; enable MagicDNS and HTTPS certificates in the Tailscale admin console")
    facts = { dns, ip, home: seen.get("home") ?? "", systemd: true, userspace: false, ...(seen.get("mendcode") && seen.get("mendcode") !== "none" ? { version: seen.get("mendcode")! } : {}) }
  } catch (error) {
    if (error instanceof SetupError) throw error
    throw new SetupError(`cannot read \`tailscale status --json\` on the host: ${scrub(status.stderr || status.stdout)}`)
  }
  if (facts.dns !== command.host) throw new SetupError(`the host's Tailscale name is ${facts.dns}, not ${command.host}: run again with that name`)
  // `tailscale status --json` has no field for the networking mode. In userspace networking (no TUN device, no root) the tailnet address is on no
  // interface of the host; a system Tailscale puts it on tailscale0. When the host cannot tell (no ip and no /proc), the system mode is assumed.
  const iface = fields((await remote(`IP=${shq(facts.ip)}
if command -v ip >/dev/null 2>&1; then if ip -o addr 2>/dev/null | grep -F "inet $IP/" >/dev/null; then echo iface=yes; else echo iface=no; fi
elif [ -r /proc/net/fib_trie ]; then if grep -F "|-- $IP" /proc/net/fib_trie >/dev/null; then echo iface=yes; else echo iface=no; fi
else echo iface=unknown; fi`)).stdout).get("iface")
  facts.userspace = iface === "no"
  say(`  ${facts.dns} · ${facts.ip} · ${facts.userspace ? "userspace networking (no root)" : "system networking"} · ${facts.version ? `MendCode ${facts.version}` : "MendCode not installed"}`)

  let port = command.port
  let changedListener = false
  let caFile: string | undefined
  if (command.action === "setup") {
    begin("installing MendCode")
    if (facts.version && !command.upgrade) say(`  already installed (${facts.version}); --upgrade replaces it`)
    else {
      const fetch = `if command -v curl >/dev/null 2>&1; then curl -fsSL ${shq(command.installerUrl)} -o "$T/install.sh"; elif command -v wget >/dev/null 2>&1; then wget -q -O "$T/install.sh" ${shq(command.installerUrl)}; else echo "curl or wget is required" >&2; exit 1; fi`
      await must("installing MendCode failed", `T=$(mktemp -d); trap 'rm -rf "$T"' EXIT\n${fetch}\nsh "$T/install.sh"${command.channel ? ` --channel ${command.channel}` : ""} >&2`)
      const version = (await must("MendCode is not runnable after the install", `"$MC" --version`)).trim().split("\n")[0]
      say(`  installed ${version}`)
    }

    begin("TLS certificate and renewal timer")
    let cert = await remote(`umask 077; mkdir -p "$D/tls"
${tsDefinition}ts cert --cert-file "$D/tls/cert.pem" --key-file "$D/tls/key.pem" ${facts.dns} >&2
chmod 600 "$D/tls/key.pem"
ABS=$(cd "$D" && pwd); echo "abs=$ABS"`)
    let privateCa = false
    if (cert.code !== 0 && NO_TAILNET_CERTS.test(cert.stderr + cert.stdout)) {
      say("  tailscale cert is not available for this tailnet (HTTPS certificates are not enabled): using a private CA made on the host")
      cert = await remote(privateCaScript(facts))
      if (cert.code === 127) throw new SetupError(`tailscale cert failed: ${scrub(cert.stderr || cert.stdout)}. Enable HTTPS certificates for the tailnet in the Tailscale admin console (or install openssl on the host so setup can make a private CA).`)
      if (cert.code !== 0) throw new SetupError(`making the private CA on the host failed: ${scrub(cert.stderr || cert.stdout) || `exit ${cert.code}`}`)
      privateCa = true
    } else if (cert.code !== 0) {
      const hint = /access denied|permission|operator|not allowed/i.test(cert.stderr) ? " Run once on the host: sudo tailscale set --operator=$USER" : /https|certificate|not enabled/i.test(cert.stderr) ? " Enable HTTPS certificates for the tailnet in the Tailscale admin console." : ""
      throw new SetupError(`tailscale cert failed: ${scrub(cert.stderr || cert.stdout)}.${hint}`)
    }
    const certFacts = fields(cert.stdout)
    const absolute = certFacts.get("abs")
    if (!absolute || !absolute.startsWith("/")) throw new SetupError("could not resolve the data directory on the host")
    if (privateCa) {
      const ca = (await must("could not read the private CA from the host", `cat "$D/tls/ca.pem"`)).trim()
      if (!ca.startsWith("-----BEGIN CERTIFICATE-----")) throw new SetupError("the host returned something that is not a CA certificate")
      caFile = caFileOf(command.dir, command.name)
      writePrivate(caFile, `${ca}\n`)
      say(`  saved ${caFile}; the CA key stays on the host in ${command.remoteDir}/tls (mode 0600)`)
      say(`  server certificate valid until ${certFacts.get("expires") ?? "about 825 days from now"}; no renewal timer: run the same \`remote setup\` command again before then to renew it`)
      say("  tip: enable HTTPS certificates in the Tailscale admin console, then run setup again to use real certificates that renew themselves")
    } else {
      const timer = await remote(`${tsDefinition}ABS=$(cd "$D" && pwd)
TSX="$TS"; if [ -n "$SOCK" ]; then TSX="$TS --socket $SOCK"; fi
U="$HOME/.config/systemd/user"; mkdir -p "$U"
cat > "$U/mendcode-cert.service" <<EOF
[Unit]
Description=Renew the Tailscale certificate of the MendCode daemon

[Service]
Type=oneshot
ExecStart=$TSX cert --cert-file $ABS/tls/cert.pem --key-file $ABS/tls/key.pem ${facts.dns}
EOF
cat > "$U/mendcode-cert.timer" <<EOF
[Unit]
Description=Renew the MendCode daemon certificate every 30 days

[Timer]
OnBootSec=15min
OnUnitActiveSec=30d
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now mendcode-cert.timer >&2
if ! loginctl enable-linger "$USER" >&2 2>&1; then echo "linger=failed"; fi`)
      if (timer.code !== 0) throw new SetupError(`could not set up the certificate renewal timer: ${scrub(timer.stderr || timer.stdout) || `exit ${timer.code}`}`)
      if (fields(timer.stdout).get("linger") === "failed") say("  warning: loginctl enable-linger failed; run `sudo loginctl enable-linger $USER` on the host so the service survives a logout and reboot")
    }

    begin("listener settings")
    const existingText = (await remote(`cat "$D/remote.json" 2>/dev/null || true`)).stdout.trim()
    let existing: Record<string, unknown> = {}
    if (existingText) {
      try { existing = JSON.parse(existingText) as Record<string, unknown> } catch { throw new SetupError("remote.json on the host is not valid JSON: fix or remove it, then run again") }
      if (!existing || typeof existing !== "object" || Array.isArray(existing)) throw new SetupError("remote.json on the host is not an object")
    }
    const existingPort = typeof existing.listen === "string" ? Number(/:(\d+)$/.exec(existing.listen)?.[1]) : undefined
    port ??= existingPort && existingPort > 0 ? existingPort : DEFAULT_PORT
    // Userspace tailscaled forwards inbound tailnet TCP to 127.0.0.1 on the same port (wgengine/netstack acceptTCP), so the daemon listens on loopback with TLS;
    // mode tailscale would refuse that listener and its peer check would see 127.0.0.1.
    const desired: Record<string, unknown> = { ...existing, listen: `${facts.userspace ? "127.0.0.1" : facts.ip}:${port}`, tlsCert: `${absolute}/tls/cert.pem`, tlsKey: `${absolute}/tls/key.pem` }
    if (facts.userspace) delete desired.mode
    else desired.mode = "tailscale"
    if (facts.userspace) say("  Tailscale runs in userspace networking: the daemon listens on 127.0.0.1 with TLS and tailscaled forwards the tailnet port to it")
    changedListener = JSON.stringify(desired) !== JSON.stringify(existing)
    if (changedListener) {
      await must("could not write remote.json on the host", `umask 077; cat > "$D/remote.json.tmp" && chmod 600 "$D/remote.json.tmp" && mv "$D/remote.json.tmp" "$D/remote.json"`, `${JSON.stringify(desired, null, 2)}\n`)
      say(`  wrote remote.json (${desired.listen})`)
    } else say(`  remote.json already set (${desired.listen})`)
  } else {
    begin("reading the host's listener")
    const text = (await remote(`cat "$D/remote.json" 2>/dev/null || true`)).stdout
    const listen = (() => { try { return (JSON.parse(text) as { listen?: unknown }).listen } catch { return undefined } })()
    const found = typeof listen === "string" ? Number(/:(\d+)$/.exec(listen)?.[1]) : NaN
    if (!found) throw new SetupError("the host has no listener configured: run `remote setup` from the first device before pairing another")
    port = found
    say(`  listener ${listen as string}`)
  }

  begin("device token")
  const file = tokenFile(command.dir, command.name, command.device)
  const listed = (await must("could not list the host's tokens", `"$MC" remote token list --dir "$D" || true`)).split("\n").map((line) => line.split("\t")[0]).filter(Boolean)
  const onHost = listed.includes(command.device)
  if (onHost && existsSync(file) && !command.rotate) say(`  token ${command.device} already exists; --rotate replaces it`)
  else {
    if (onHost) await must("could not revoke the old token", `"$MC" remote token revoke ${shq(command.device)} --dir "$D"`)
    const created = (await must("could not create the token", `"$MC" remote token create --dir "$D" --name ${shq(command.device)}${command.expiresDays ? ` --expires-days ${command.expiresDays}` : ""}`)).trim()
    if (!/^[A-Za-z0-9_-]{20,}$/.test(created)) throw new SetupError("the host returned something that is not a token")
    writePrivate(file, `${created}\n`)
    say(`  saved ${file}`)
  }
  if (command.sync) {
    const syncName = `${command.device}-sync`
    const syncFile = syncTokenFile(command.dir, command.name)
    if (listed.includes(syncName) && existsSync(syncFile) && !command.rotate) say(`  sync token ${syncName} already exists`)
    else {
      if (listed.includes(syncName)) await must("could not revoke the old sync token", `"$MC" remote token revoke ${shq(syncName)} --dir "$D"`)
      const created = (await must("could not create the sync token", `"$MC" remote token create --sync --dir "$D" --name ${shq(syncName)}${command.expiresDays ? ` --expires-days ${command.expiresDays}` : ""}`)).trim()
      if (!/^[A-Za-z0-9_-]{20,}$/.test(created)) throw new SetupError("the host returned something that is not a token")
      writePrivate(syncFile, `${created}\n`)
      say(`  saved ${syncFile}`)
    }
  }

  if (command.action === "setup") {
    begin("daemon service")
    const state = (await must("could not read the service state", `"$MC" daemon service status --dir "$D" 2>&1 || true`))
    const installed = /Service: [^\n]*· installed/.test(state)
    const loaded = /Service: [^\n]*· loaded/.test(state)
    const drift = /Drift:/.test(state)
    // A service installed without a listener (`--local-only` in its definition) is no resume point: only its own definition says which kind it is.
    const definition = /^Definition: (.+)$/m.exec(state)?.[1]?.trim()
    const localOnly = installed && definition !== undefined && (await remote(`grep -q -e '--local-only' ${shq(definition)}`)).code === 0
    if (!installed || drift || localOnly || changedListener || command.reinstallService) {
      if (loaded) await must("could not stop the service (a turn may be running; try again when it is idle)", `"$MC" daemon service stop --dir "$D"`)
      await must("could not install the service", `"$MC" daemon service install --listener --dir "$D"`)
      await must("could not start the service", `"$MC" daemon service start --dir "$D"`)
      say("  service installed and started with the listener")
    } else if (!loaded) {
      await must("could not start the service", `"$MC" daemon service start --dir "$D"`)
      say("  service started")
    } else say("  service already running with the listener")
  }

  begin("saving the remote and checking it")
  const address = `${command.host}:${port}`
  const profiles = readRemoteProfiles(command.dir) ?? { remotes: {} }
  const next: RemoteProfiles = { ...profiles, remotes: { ...profiles.remotes, [command.name]: { connect: address, tokenFile: file, ...(caFile ? { ca: caFile } : {}), tls: true } }, ...(command.makeDefault ? { defaultRemote: command.name } : {}) }
  writeRemoteProfiles(command.dir, next)
  let up = false
  for (let attempt = 0; attempt < 10 && !up; attempt++) {
    up = await deps.local.reachable(address)
    if (!up) await deps.local.sleep(1000)
  }
  if (!up) throw new SetupError(`${address} does not answer from this machine. Check that Tailscale is connected here (tailscale status) and that the service runs on the host (mendcode daemon service status). The remote ${command.name} is saved; run the same command again to continue.`)
  say(`  ${address} answers · saved as ${command.name}${command.makeDefault ? " (default)" : ""}`)
  if (command.sync) {
    const { writeSyncConfig } = await import("@mendcode/daemon/sync-config")
    writeSyncConfig(command.dir, { remote: command.name, tokenFile: syncTokenFile(command.dir, command.name), pathMap: command.pathMaps, memories: true, settings: true })
    say(`  session sync on with ${command.name}: it starts with this machine's daemon, or now with \`mendcode sync now\``)
  }

  if (command.action === "setup") await migrate(command, deps, remote, must, say, address)
  say(command.makeDefault ? `Done. Run \`mendcode\` to use ${command.name}, or \`mendcode --remote ${command.name}\`. \`mendcode --local\` stays on this machine.` : `Done. Run \`mendcode --remote ${command.name}\`.`)
  if (command.action === "setup") say("Another device: run `mendcode remote pair " + command.host + " --ssh USER@HOST` on it. Remove one: `mendcode remote unpair DEVICE`.")
}

type Remote = (body: string, input?: string | Uint8Array) => Promise<SshResult>
type Must = (what: string, body: string, input?: string | Uint8Array) => Promise<string>

async function migrate(command: Provision,deps: SetupDeps, remote: Remote, must: Must, say: (line: string) => void, address: string) {
  const ledger = readLedger(command.dir, command.name, address)
  const save = () => writeLedger(command.dir, command.name, ledger)
  const now = deps.now ?? Date.now
  if (command.migrateSettings) {
    say("[migrate] settings")
    if (ledger.settings) say("  already imported (delete the ledger file to import again)")
    else {
      const temporary = mkdtempSync(path.join(tmpdir(), "mendcode-bundle-"))
      try {
        const file = path.join(temporary, "settings.bundle")
        await deps.local.exportBundle(file)
        const bundle = readFileSync(file)
        const out = await must("importing the settings on the host failed", `T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
cat > "$T/settings.bundle"
"$MC" config-bundle inspect "$T/settings.bundle" --dir "$D" >&2
P=$("$MC" config-bundle import "$T/settings.bundle" --dir "$D" --rewrite-home --on-conflict keep --json | tr -d '\\n' | sed -n 's/.*"planId"[[:space:]]*:[[:space:]]*"\\([A-Za-z0-9]*\\)".*/\\1/p')
[ -n "$P" ] || { echo "the preview reported no plan id" >&2; exit 12; }
"$MC" config-bundle import "$T/settings.bundle" --dir "$D" --rewrite-home --on-conflict keep --apply --plan "$P"`, bundle)
        for (const line of out.split("\n").filter((entry) => /^(import |comparison|waiting|quarantined)/.test(entry))) say(`  ${scrub(line)}`)
        ledger.settings = { at: now() }
        save()
      } finally { rmSync(temporary, { recursive: true, force: true }) }
    }
  }
  if (command.acpAgents) await migrateAgents(command, deps, remote, must, say, ledger, save, now)
  if (command.migrateSessions) await migrateSessions(command, deps, remote, must, say, ledger, save, now)
}

const CREDENTIAL_NAME = /key|token|secret|passw(?:or)?d|credential|auth|bearer|cookie/i
/** Whether an agent's arguments could carry a credential: a key-like flag with a value, a header, a URL with userinfo or a secret in its query, or anything the secret scanner finds. Such an agent is not copied. */
export function argsCarryCredential(args: string[]): boolean {
  return args.some((arg, index) => {
    if (redactSecrets(arg).count > 0 || /[A-Za-z0-9_-]{32,}/.test(arg)) return true
    if (/^[a-z][a-z0-9+.-]*:\/\/[^/\s]*@/i.test(arg) || /[?&;](?:[\w-]*(?:key|token|secret|passw(?:or)?d|auth)[\w-]*)=/i.test(arg)) return true
    if (/(?:^|=)\s*(?:authorization|x-api-key|cookie|proxy-authorization)\s*:/i.test(arg) || /\bbearer\s+\S/i.test(arg)) return true
    const flag = /^--?([^=\s]+)=(.+)$/s.exec(arg)
    if (flag) return CREDENTIAL_NAME.test(flag[1]!)
    const next = args[index + 1]
    return /^--?[A-Za-z][\w-]*$/.test(arg) && CREDENTIAL_NAME.test(arg) && next !== undefined && !next.startsWith("-")
  })
}

async function migrateAgents(command: Provision,deps: SetupDeps, remote: Remote, must: Must, say: (line: string) => void, ledger: ReturnType<typeof readLedger>, save: () => void, now: () => number) {
  say("[migrate] ACP agents")
  let local: Record<string, { command?: unknown; args?: unknown }> = {}
  try { local = JSON.parse(readFileSync(path.join(deps.local.dataDir, "acp-agents.json"), "utf8")) } catch { say("  this machine has no acp-agents.json; nothing to add"); return }
  let have: Record<string, unknown>
  try { have = JSON.parse((await remote(`cat "$D/acp-agents.json" 2>/dev/null || echo '{}'`)).stdout.trim() || "{}") as Record<string, unknown> } catch { throw new SetupError("acp-agents.json on the host is not valid JSON: fix it, then run again") }
  const added: Record<string, { command: string; args: string[] }> = {}
  for (const [name, entry] of Object.entries(local)) {
    const executable = typeof entry?.command === "string" ? entry.command : ""
    const args = Array.isArray(entry?.args) ? entry.args.filter((arg): arg is string => typeof arg === "string") : []
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name) || !/^[A-Za-z0-9._+-]+$/.test(executable)) { say(`  skipped ${name}: its command is a path or not a plain program name (machine-specific)`); continue }
    if (name in have) { say(`  ${name} already exists on the host`); continue }
    if (argsCarryCredential(args)) { say(`  skipped ${name}: its arguments look like they carry a credential (a key, token, password or authenticated URL); add it on the host yourself`); continue }
    if ((await remote(`command -v ${shq(executable)} >/dev/null 2>&1`)).code !== 0) { say(`  skipped ${name}: ${executable} is not on the host's PATH (install and sign in there, then run again)`); continue }
    added[name] = { command: executable, args }
  }
  const names = Object.keys(added)
  if (names.length) {
    await must("could not write acp-agents.json on the host", `umask 077; cat > "$D/acp-agents.json.tmp" && chmod 600 "$D/acp-agents.json.tmp" && mv "$D/acp-agents.json.tmp" "$D/acp-agents.json"`, `${JSON.stringify({ ...have, ...added }, null, 2)}\n`)
    say(`  added ${names.join(", ")} (command and args only; sign in on the host, and list the agent in remoteEngines there to use it from this machine)`)
  }
  ledger.acpAgents = { at: now(), names: [...(ledger.acpAgents?.names ?? []), ...names] }
  save()
}

async function migrateSessions(command: Provision,deps: SetupDeps, remote: Remote, must: Must, say: (line: string) => void, ledger: ReturnType<typeof readLedger>, save: () => void, now: () => number) {
  say("[migrate] sessions")
  const sessions = (await deps.local.listSessions(command.sessionLimit)).filter((session) => !ledger.sessions[session.id])
  if (!sessions.length) { say("  nothing new to move"); return }
  const identities = new Map<string, ProjectIdentity>()
  for (const session of sessions) if (!identities.has(session.directory)) identities.set(session.directory, await deps.local.identity(session.directory))
  let repos: RemoteRepo[] = []
  if ([...identities.values()].some((identity) => identity.id)) {
    const roots = [...new Set(["~/code", "~/src", "~/projects", "~/work", "~/dev", "~/repos", "~/git", ...command.searchRoots])]
    const scan = await remote(`for r in ${roots.map(shellPath).join(" ")}; do [ -d "$r" ] && find "$r" -maxdepth 4 -name .git -type d -prune 2>/dev/null; done | while IFS= read -r g; do t=$(dirname "$g"); u=$(git -C "$t" remote get-url origin 2>/dev/null || true); printf '%s\\t%s\\n' "$t" "$u"; done`)
    repos = scan.stdout.split("\n").filter(Boolean).map((line) => { const [top = "", url = ""] = line.split("\t"); return { top, ...(url ? { url } : {}) } })
  }
  const mappings = new Map<string, ReturnType<typeof mapProject>>()
  const cloned = new Map<string, string>()
  const claimed = new Map<string, string>()
  for (const [directory, project] of identities) {
    let mapping = mapProject({ project, rules: command.pathMaps, repos, cloneMissing: command.cloneMissing, cloneRoot: "~/code" })
    if (mapping.directory === undefined && mapping.clone) {
      const { url, name, rel } = mapping.clone
      if (!/^[A-Za-z0-9@:/._~+-]+$/.test(url) || url.startsWith("-")) mapping = { reason: "its git remote is not a plain URL; clone it on the host yourself" }
      else {
        const target = cloned.get(url) ?? `~/code/${name}`
        const taken = claimed.get(target)
        if (taken !== undefined && taken !== url) mapping = { reason: `another project cloned in this run already uses ${target}; clone it on the host yourself or use --path-map` }
        else {
          // An existing checkout counts only when its origin is this project: a same-named repository of someone else is not a clone of it.
          const done = await remote(`mkdir -p "$HOME/code"; if [ -d ${shellPath(target)}/.git ]; then echo "origin=$(git -C ${shellPath(target)} remote get-url origin 2>/dev/null || true)"; exit 0; fi; git clone -- ${shq(url)} ${shellPath(target)} >&2`)
          const origin = fields(done.stdout).get("origin")
          if (done.code !== 0) mapping = { reason: `git clone failed on the host (${scrub(done.stderr)}); sign in to git there or clone it yourself` }
          else if (origin !== undefined && (normalizeGitRemote(origin) ?? origin) !== (normalizeGitRemote(url) ?? url)) mapping = { reason: `${target} on the host is a different repository; clone this one elsewhere and use --path-map` }
          else {
            mapping = { directory: rel ? `${target}/${rel}` : target, how: "clone" }
            cloned.set(url, target)
            claimed.set(target, url)
          }
        }
      }
    }
    if (mapping.directory !== undefined && (!REMOTE_PATH.test(mapping.directory) || mapping.directory.split("/").includes(".."))) mapping = { reason: `${mapping.directory} has characters this tool does not pass to a remote shell; use --path-map to a plain path` }
    mappings.set(directory, mapping)
  }
  const wanted = [...new Set([...mappings.values()].flatMap((mapping) => mapping.directory ? [mapping.directory] : []))]
  const missing = new Set<string>()
  if (wanted.length) {
    const check = await remote(wanted.map((directory) => `[ -d ${shellPath(directory)} ] || echo ${shq(directory)}`).join("\n"))
    for (const line of check.stdout.split("\n").filter(Boolean)) missing.add(line)
  }
  let moved = 0
  let skipped = 0
  for (const session of sessions) {
    const mapping = mappings.get(session.directory)!
    const reason = mapping.directory === undefined ? mapping.reason : missing.has(mapping.directory) ? `${mapping.directory} does not exist on the host` : undefined
    if (reason) { say(`  skipped "${session.title.slice(0, 60)}": ${reason}`); skipped++; continue }
    if (mapping.directory === undefined) continue
    const exported = await deps.local.exportSession(session.id)
    const out = await remote(`T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
cat > "$T/session.json"
cd ${shellPath(mapping.directory)} && "$MC" import "$T/session.json" --from mendcode --dir "$D" --json`, exported.text)
    let remoteId: string
    try {
      if (out.code !== 0) throw new SetupError(scrub(out.stderr || out.stdout))
      remoteId = parseImportResult(out.stdout)
    } catch (error) { say(`  failed "${session.title.slice(0, 60)}": ${error instanceof Error ? error.message : String(error)}`); skipped++; continue }
    ledger.sessions[session.id] = { at: now(), directory: mapping.directory, ...(remoteId ? { remoteId } : {}), ...(exported.truncated ? { truncated: true } : {}) }
    save()
    moved++
    if (exported.truncated) say(`  note: "${session.title.slice(0, 60)}" was cut to the export limit`)
  }
  say(`  moved ${moved}, skipped ${skipped}${skipped ? " (run again after fixing the reasons above)" : ""}`)
}

/** The `ssh` runner: batch mode (never a password prompt), a connect timeout, the script as one `sh -c` argument and data on stdin. */
export function sshRunner(target: string): SshRunner {
  return async ({ script, input }) => {
    if (!SSH_TARGET.test(target)) throw new SetupError("invalid SSH target")
    const { runProcess } = await import("@mendcode/upgrade/process")
    return runProcess(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "--", target, `sh -c ${shq(script)}`], input === undefined ? {} : { input })
  }
}

/** This program, run as a child of this machine's own CLI (compiled binary or `bun entry.ts`). */
function selfCommand() {
  return /(^|\/)bun(-[a-z0-9]+)?$/.test(process.execPath) ? [process.execPath, process.argv[1]!] : [process.execPath]
}

async function self(args: string[]) {
  const { runProcess } = await import("@mendcode/upgrade/process")
  const { stdout, stderr, code } = await runProcess([...selfCommand(), ...args])
  return { stdout, stderr, code }
}

async function git(directory: string, args: string[]) {
  const { runProcess } = await import("@mendcode/upgrade/process")
  const { stdout, code } = await runProcess(["git", "-C", directory, ...args], { stderr: "ignore" })
  return code === 0 ? stdout.trim() : undefined
}

export function defaultLocalPort(dataDir: string): LocalPort {
  return {
    dataDir,
    async exportBundle(file) {
      const result = await self(["config-bundle", "export", file, "--dir", dataDir, "--json"])
      if (result.code !== 0) throw new SetupError(`exporting this machine's settings failed: ${scrub(result.stderr || result.stdout)}`)
    },
    async listSessions(limit) {
      const result = await self(["session", "list", "--all-projects", "--limit", String(limit), "--dir", dataDir, "--json"])
      if (result.code !== 0) throw new SetupError(`listing local sessions failed: ${scrub(result.stderr || result.stdout)}`)
      return parseSessionList(result.stdout)
    },
    async exportSession(id) {
      const result = await self(["export", id, "--format", "json", "--dir", dataDir])
      if (result.code !== 0 || !result.stdout.trim()) throw new SetupError(`exporting session ${id} failed: ${scrub(result.stderr || result.stdout)}`)
      return { text: result.stdout, truncated: result.stderr.includes(EXPORT_TRUNCATED_NOTE) }
    },
    async identity(directory) {
      const top = await git(directory, ["rev-parse", "--show-toplevel"])
      const url = top ? await git(top, ["remote", "get-url", "origin"]) : undefined
      const id = url ? normalizeGitRemote(url) : undefined
      return { directory, ...(top ? { top } : {}), ...(url ? { url } : {}), ...(id ? { id } : {}), rel: top ? path.relative(top, directory) : "" }
    },
    async reachable(address) {
      const { defaultProbes } = await import("./remote-profiles")
      return defaultProbes.reachable(address)
    },
    sleep: (ms) => Bun.sleep(ms),
  }
}

/**
 * The one line a `--json` CLI command prints (automation.ts `result`/`fail`): `{"schema":"mendcode.cli","kind":"result",
 * "command":NAME,"data":{…}}`, or `kind: "error"` with `error.message`. Anything else is refused.
 */
function cliResult(text: string, command: string, what: string): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(text.trim()) } catch { throw new SetupError(`${what} was not JSON`) }
  const line = value as { schema?: unknown; kind?: unknown; command?: unknown; data?: unknown; error?: { message?: unknown } }
  if (!line || typeof line !== "object" || line.schema !== "mendcode.cli" || line.command !== command) throw new SetupError(`${what} was not the ${command} result`)
  if (line.kind === "error") throw new SetupError(`${what} failed: ${typeof line.error?.message === "string" ? scrub(line.error.message) : "unknown error"}`)
  if (line.kind !== "result" || !line.data || typeof line.data !== "object" || Array.isArray(line.data)) throw new SetupError(`${what} was not the ${command} result`)
  return line.data as Record<string, unknown>
}

/** `session list --all-projects --json`: `data.sessions` holds session summaries (`sessionId`, `title`, `directory`). */
export function parseSessionList(text: string): LocalSession[] {
  const data = cliResult(text, "session.list", "the session list")
  if (!Array.isArray(data.sessions)) throw new SetupError("the session list had no sessions")
  return data.sessions.map((entry: { sessionId?: unknown; title?: unknown; directory?: unknown }) => {
    if (typeof entry?.sessionId !== "string" || typeof entry.directory !== "string" || typeof entry.title !== "string") throw new SetupError("the session list had an entry without sessionId, title and directory")
    return { id: entry.sessionId, title: entry.title || entry.sessionId, directory: entry.directory }
  })
}

/** `import FILE --from mendcode --json` on the host: `data.sessionId` is the session it made there. */
export function parseImportResult(text: string): string {
  const data = cliResult(text, "session.import", "the import on the host")
  if (typeof data.sessionId !== "string" || !/^[A-Za-z0-9_-]+$/.test(data.sessionId)) throw new SetupError("the import on the host returned no session ID")
  return data.sessionId
}

/** What raw `export ID --format json` writes to stderr when the transcript was cut to the export limits (session-transfer-automation.ts). */
export const EXPORT_TRUNCATED_NOTE = "Export truncated to transcript/frame limits"

export async function runSetupCommand(command: SetupCommand, out: { write(text: string): unknown }): Promise<number> {
  const { code } = await runSetup(command, { ssh: sshRunner, local: defaultLocalPort(command.dir), out })
  return code
}
