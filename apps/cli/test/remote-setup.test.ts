import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { startDaemon } from "@mendcode/daemon"
import { createFauxEngine } from "@mendcode/engine-faux"
import { parseAutomation, runAutomation, type AutomationDeps } from "../src/automation"
import { argsCarryCredential, EXPORT_TRUNCATED_NOTE, parseImportResult, parseSessionList, parseSetupCommand, runSetup, setupPlan, type LocalPort, type SetupCommand, type SshRunner } from "../src/remote-setup"
import { applyPathRule, mapProject, normalizeGitRemote, parsePathRule } from "../src/remote-setup-projects"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-setup-")); dirs.push(dir); return dir }
const HOST = "vps.example.ts.net"
const TOKEN = "T".repeat(8) + "0123456789abcdefghijklmnopqrstuvwxyz"

/** A pretend Linux host: it answers the scripts of a setup run from its own small state and records what ran. */
function fakeHost(options: { tailscale?: boolean; os?: string; dns?: string; userspace?: boolean; noHttps?: boolean; noOpenssl?: boolean; tsPath?: string; tsSocket?: string; certFails?: string; repos?: string; missing?: string[] } = {}) {
  const state = { version: undefined as string | undefined, tokens: new Set<string>(), remoteJson: "", installed: false, loaded: false, localOnly: false, acp: "", calls: [] as string[], timers: 0, lingers: 0, privateCa: false, scripts: [] as string[], imports: [] as string[], inputs: [] as Array<string | Uint8Array | undefined> }
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" })
  const run: SshRunner = async ({ script, input }) => {
    state.inputs.push(input)
    state.scripts.push(script)
    if (script.includes('echo "os=')) { state.calls.push("probe"); return ok(`os=${options.os ?? "Linux"}\narch=x86_64\nhome=/home/u\nsystemd=yes\ntailscale=${options.tailscale === false ? "no" : "yes"}\ntailscale_path=${options.tsPath ?? "/usr/bin/tailscale"}\ntailscale_socket=${options.tsSocket ?? ""}\nmendcode=${state.version ?? "none"}\n`) }
    if (script.includes("iface=yes")) return ok(`iface=${options.userspace ? "no" : "yes"}\n`)
    if (script.includes("ts status --json")) return ok(JSON.stringify({ BackendState: "Running", Self: { DNSName: `${options.dns ?? HOST}.`, TailscaleIPs: ["100.64.0.9", "fd7a:115c:a1e0::9"] } }))
    if (script.includes("curl -fsSL")) { state.calls.push("install"); state.version = "1.2.3 (stable)"; return ok() }
    if (script.endsWith('"$MC" --version')) return ok(`${state.version}\n`)
    if (script.includes("mendcode-cert.service")) { state.timers++; return ok() }
    if (script.includes("enable-linger")) { state.lingers++; return ok() }
    if (script.includes("openssl verify")) return ok(state.privateCa ? "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n" : "")
    if (script.includes("openssl genpkey")) { state.calls.push("private-ca"); state.privateCa = !options.noOpenssl; return options.noOpenssl ? { code: 127, stdout: "", stderr: "openssl is not installed on the host" } : ok("abs=/home/u/.mendcode\nexpires=Feb  3 10:00:00 2029 GMT\n") }
    if (script.includes("openssl is not installed")) { state.calls.push("private-ca"); return { code: 127, stdout: "", stderr: "openssl is not installed on the host" } }
    if (script.includes('cat "$D/tls/ca.pem"')) return ok("-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n")
    if (script.includes("ts cert")) {
      state.calls.push("cert")
      if (options.noHttps) return { code: 1, stdout: "", stderr: "500 Internal Server Error: your Tailscale account does not support getting TLS certs" }
      return options.certFails ? { code: 1, stdout: "", stderr: options.certFails } : ok("abs=/home/u/.mendcode\n")
    }
    if (script.includes('cat "$D/remote.json" 2>/dev/null')) return ok(state.remoteJson)
    if (script.includes("remote.json.tmp")) { state.calls.push("write-remote-json"); state.remoteJson = String(input); return ok() }
    if (script.includes("remote token list")) return ok([...state.tokens].map((name) => `${name}\tfull\t2026-01-01T00:00:00.000Z\tnever`).join("\n"))
    if (script.includes("remote token revoke")) { state.calls.push("revoke"); state.tokens.delete(/revoke '([^']+)'/.exec(script)![1]!); return ok("revoked\n") }
    if (script.includes("remote token create")) { state.calls.push("token"); state.tokens.add(/--name '([^']+)'/.exec(script)![1]!); return ok(`${TOKEN}\n`) }
    if (script.includes("daemon service status")) return ok(`Service: systemd-user · ${state.installed ? "installed" : "not installed"} · ${state.loaded ? "loaded" : "stopped"}\nDefinition: /home/u/.config/systemd/user/mendcode.service\n`)
    if (script.includes("grep -q -e '--local-only'")) return { code: state.localOnly ? 0 : 1, stdout: "", stderr: "" }
    if (script.includes("daemon service stop")) { state.calls.push("service-stop"); state.loaded = false; return ok() }
    if (script.includes("daemon service install")) { state.calls.push("service-install"); state.installed = true; state.localOnly = false; return ok() }
    if (script.includes("daemon service start")) { state.calls.push("service-start"); state.loaded = true; return ok() }
    if (script.includes("config-bundle import")) { state.calls.push("bundle"); return ok("import imp_1 applied\ncomparison with the bundle: 3 match\n") }
    if (script.includes('cat "$D/acp-agents.json"')) return ok(state.acp || "{}")
    if (script.includes("acp-agents.json.tmp")) { state.calls.push("acp-write"); state.acp = String(input); return ok() }
    if (script.startsWith("set -eu\n") && script.includes("command -v 'hermes'")) return { code: 0, stdout: "", stderr: "" }
    if (script.includes("command -v 'missing-agent'")) return { code: 1, stdout: "", stderr: "" }
    if (script.includes("find ")) return ok(options.repos ?? "")
    if (script.includes("[ -d ")) return ok((options.missing ?? []).join("\n"))
    if (script.includes('"$MC" import ')) {
      state.calls.push("session-import")
      state.imports.push(script)
      return ok(`${JSON.stringify({ schema: "mendcode.cli", kind: "result", command: "session.import", data: { sessionId: `ses_remote${state.imports.length}`, from: "mendcode" } })}\n`)
    }
    return { code: 1, stdout: "", stderr: `unexpected script: ${script.slice(0, 80)}` }
  }
  return { state, run }
}

function fakeLocal(dataDir: string, extra: Partial<LocalPort> = {}): LocalPort & { exported: string[] } {
  const exported: string[] = []
  return {
    dataDir, exported,
    exportBundle: async (file) => { writeFileSync(file, '{"bundle":true}') },
    listSessions: async () => [],
    exportSession: async (id) => { exported.push(id); return { text: `{"session":"${id}"}`, truncated: false } },
    identity: async (directory) => ({ directory, rel: "" }),
    reachable: async () => true,
    sleep: async () => {},
    ...extra,
  }
}

const command = (dir: string, argv: string[] = []) => parseSetupCommand(["remote", "setup", HOST, "--ssh", "user@vps", "--dir", dir, ...argv], dir, () => "My-Mac.local") as Extract<SetupCommand, { action: "setup" | "pair" }>
const output = () => { const lines: string[] = []; return { write: (text: string) => void lines.push(text), text: () => lines.join("") } }

test("setup arguments are validated before anything runs", () => {
  const dir = temp()
  const parsed = command(dir)
  expect(parsed).toMatchObject({ action: "setup", host: HOST, ssh: "user@vps", name: "vps", device: "my-mac", remoteDir: "~/.mendcode", makeDefault: true, upgrade: false })
  for (const bad of [["--ssh", "-oProxyCommand=x"], ["--ssh", "a b"], ["--port", "0"], ["--port", "70000"], ["--expires-days", "0"], ["--channel", "weekly"], ["--installer-url", "http://example.com/i.sh"], ["--remote-dir", "~/a;rm"], ["--remote-dir", "/srv/../etc"], ["--path-map", "x=/y"], ["--device", "a b"], ["--clone-missing"], ["--session-limit", "5"]]) {
    expect(() => parseSetupCommand(["remote", "setup", HOST, ...bad], dir)).toThrow()
  }
  expect(() => parseSetupCommand(["remote", "setup", "a b"], dir)).toThrow("Tailscale name")
  expect(() => parseSetupCommand(["remote", "pair", HOST, "--migrate-sessions"], dir)).toThrow("only adds this device")
  expect(parseSetupCommand(["remote", "add", "x", "h:1"], dir)).toBeUndefined()
  expect(parseSetupCommand(["remote", "unpair", "phone", "--remote", "vps"], dir)).toMatchObject({ action: "unpair", device: "phone", remote: "vps" })
})

test("--dry-run prints the plan, opens no SSH connection and writes nothing", async () => {
  const dir = temp()
  const out = output()
  const parsed = command(dir, ["--dry-run", "--migrate-settings", "--migrate-sessions", "--acp-agents", "--expires-days", "30"])
  const result = await runSetup(parsed, { ssh: () => { throw new Error("ssh must not be used") }, local: fakeLocal(dir), out })
  expect(result.code).toBe(0)
  expect(out.text()).toContain("nothing is run")
  expect(out.text()).toContain("tailscale cert")
  expect(out.text()).toContain("expires in 30 days")
  expect(setupPlan(parsed).length).toBe(out.text().split("\n").filter((line) => /^ {2}\d+\./.test(line)).length)
  expect(readdirSync(dir)).toEqual([])
})

test("setup installs, certifies, writes the listener, creates a private token, starts the service and saves the default remote", async () => {
  const dir = temp()
  const host = fakeHost()
  const out = output()
  const result = await runSetup(command(dir), { ssh: () => host.run, local: fakeLocal(dir), out })
  expect(result.code).toBe(0)
  expect(host.state.calls).toEqual(["probe", "install", "cert", "write-remote-json", "token", "service-install", "service-start"])
  expect(JSON.parse(host.state.remoteJson)).toEqual({ listen: "100.64.0.9:9876", tlsCert: "/home/u/.mendcode/tls/cert.pem", tlsKey: "/home/u/.mendcode/tls/key.pem", mode: "tailscale" })
  const file = path.join(dir, "remote", "vps.my-mac.token")
  expect(readFileSync(file, "utf8").trim()).toBe(TOKEN)
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
  expect(JSON.parse(readFileSync(path.join(dir, "remotes.json"), "utf8"))).toEqual({ defaultRemote: "vps", remotes: { vps: { connect: `${HOST}:9876`, tokenFile: file, tls: true } } })
  expect(out.text()).not.toContain(TOKEN)
  expect(JSON.stringify(host.state.calls)).not.toContain(TOKEN)
})

test("system Tailscale keeps the tailnet listener and a PATH prelude with ~/.local/bin on every script", async () => {
  const dir = temp()
  const host = fakeHost()
  await runSetup(command(dir), { ssh: () => host.run, local: fakeLocal(dir), out: output() })
  expect(host.state.scripts.every((script) => script.includes('$HOME/.local/bin'))).toBe(true)
  expect(host.state.scripts.some((script) => script.includes("--socket \"$SOCK\""))).toBe(true)
  expect(host.state.scripts.find((script) => script.includes("ts cert"))).toContain("TS='/usr/bin/tailscale'; SOCK=''")
  expect(JSON.parse(host.state.remoteJson).mode).toBe("tailscale")
})

test("userspace Tailscale from ~/.local/bin listens on 127.0.0.1 with TLS, without mode tailscale, and the remote keeps the tailnet name", async () => {
  const dir = temp()
  const host = fakeHost({ userspace: true, tsPath: "/home/u/.local/bin/tailscale", tsSocket: "/home/u/.local/state/tailscale/tailscaled.sock" })
  const out = output()
  const result = await runSetup(command(dir), { ssh: () => host.run, local: fakeLocal(dir), out })
  expect(result.code).toBe(0)
  expect(JSON.parse(host.state.remoteJson)).toEqual({ listen: "127.0.0.1:9876", tlsCert: "/home/u/.mendcode/tls/cert.pem", tlsKey: "/home/u/.mendcode/tls/key.pem" })
  expect(out.text()).toContain("userspace networking")
  const cert = host.state.scripts.find((script) => script.includes("ts cert"))!
  expect(cert).toContain("TS='/home/u/.local/bin/tailscale'; SOCK='/home/u/.local/state/tailscale/tailscaled.sock'")
  const timer = host.state.scripts.find((script) => script.includes("mendcode-cert.service"))!
  expect(timer).toContain("TS='/home/u/.local/bin/tailscale'; SOCK='/home/u/.local/state/tailscale/tailscaled.sock'")
  expect(timer).toContain('ExecStart=$TSX cert --cert-file')
  expect(JSON.parse(readFileSync(path.join(dir, "remotes.json"), "utf8")).remotes.vps).toMatchObject({ connect: `${HOST}:9876`, tls: true })
  // switching an earlier system-mode file drops the mode
  host.state.remoteJson = JSON.stringify({ listen: "100.64.0.9:9876", tlsCert: "/home/u/.mendcode/tls/cert.pem", tlsKey: "/home/u/.mendcode/tls/key.pem", mode: "tailscale" })
  await runSetup(command(dir), { ssh: () => host.run, local: fakeLocal(dir), out: output() })
  expect(JSON.parse(host.state.remoteJson).mode).toBeUndefined()
})

test("--tailscale and --tailscale-socket reach the probe, and bad values are refused", async () => {
  const dir = temp()
  const parsed = command(dir, ["--tailscale", "~/bin/tailscale", "--tailscale-socket", "/run/ts/sock"])
  expect(parsed).toMatchObject({ tailscale: "~/bin/tailscale", tailscaleSocket: "/run/ts/sock" })
  const host = fakeHost({ tsPath: "/home/u/bin/tailscale", tsSocket: "/run/ts/sock" })
  await runSetup(parsed, { ssh: () => host.run, local: fakeLocal(dir), out: output() })
  const probe = host.state.scripts.find((script) => script.includes('echo "os='))!
  expect(probe).toContain('TS="$HOME"/bin/tailscale')
  expect(probe).toContain('SOCK="/run/ts/sock"')
  expect(setupPlan(parsed).join("\n")).toContain("userspace")
  for (const bad of [["--tailscale", "a;b"], ["--tailscale-socket", "../x"]]) expect(() => parseSetupCommand(["remote", "setup", HOST, ...bad], dir)).toThrow()
  expect(() => parseSetupCommand(["remote", "unpair", "phone", "--tailscale", "/x"], dir)).toThrow("does not apply")
})

test("a tailnet without HTTPS certificates falls back to a private CA made on the host, saved as the remote's ca, with no renewal timer", async () => {
  const dir = temp()
  const host = fakeHost({ noHttps: true })
  const out = output()
  const result = await runSetup(command(dir), { ssh: () => host.run, local: fakeLocal(dir), out })
  expect(result.code).toBe(0)
  expect(host.state.calls).toContain("private-ca")
  expect(host.state.timers).toBe(0)
  expect(host.state.lingers).toBe(1)
  const script = host.state.scripts.find((entry) => entry.includes("openssl genpkey"))!
  expect(script).toContain("ec_paramgen_curve:P-256")
  expect(script).toContain("DNS:vps.example.ts.net,DNS:vps,IP:100.64.0.9,IP:127.0.0.1")
  expect(script).toContain("-days 825")
  expect(script).toContain("chmod 600 ca.key")
  const caFile = path.join(dir, "remote", "vps.ca.pem")
  expect(readFileSync(caFile, "utf8")).toContain("BEGIN CERTIFICATE")
  expect(statSync(caFile).mode & 0o777).toBe(0o600)
  expect(JSON.parse(readFileSync(path.join(dir, "remotes.json"), "utf8")).remotes.vps).toMatchObject({ connect: `${HOST}:9876`, ca: caFile, tls: true })
  expect(out.text()).toContain("valid until Feb  3 10:00:00 2029 GMT")
  expect(out.text()).toContain("run the same `remote setup` command again")
  expect(out.text()).toContain("enable HTTPS certificates in the Tailscale admin console")
})

test("pairing with a host that uses a private CA saves the CA with the remote; a host with real certificates saves none", async () => {
  const hostDir = temp()
  const host = fakeHost({ noHttps: true })
  await runSetup(command(hostDir), { ssh: () => host.run, local: fakeLocal(hostDir), out: output() })
  const second = temp()
  const pair = parseSetupCommand(["remote", "pair", HOST, "--ssh", "user@vps", "--dir", second, "--device", "phone-pad"], second)!
  expect((await runSetup(pair, { ssh: () => host.run, local: fakeLocal(second), out: output() })).code).toBe(0)
  const caFile = path.join(second, "remote", "vps.ca.pem")
  expect(readFileSync(caFile, "utf8")).toContain("BEGIN CERTIFICATE")
  expect(JSON.parse(readFileSync(path.join(second, "remotes.json"), "utf8")).remotes.vps).toMatchObject({ ca: caFile, tls: true })
  const plain = fakeHost()
  const third = temp()
  await runSetup(command(temp()), { ssh: () => plain.run, local: fakeLocal(temp()), out: output() })
  await runSetup(parseSetupCommand(["remote", "pair", HOST, "--ssh", "user@vps", "--dir", third, "--device", "tablet"], third)!, { ssh: () => plain.run, local: fakeLocal(third), out: output() })
  expect(JSON.parse(readFileSync(path.join(third, "remotes.json"), "utf8")).remotes.vps.ca).toBeUndefined()
})

test("without HTTPS certificates and without openssl, setup stops and says to enable HTTPS certificates", async () => {
  const dir = temp()
  const out = output()
  const result = await runSetup(command(dir), { ssh: () => fakeHost({ noHttps: true, noOpenssl: true }).run, local: fakeLocal(dir), out })
  expect(result.code).toBe(1)
  expect(out.text()).toContain("Enable HTTPS certificates for the tailnet in the Tailscale admin console")
  expect(existsSync(path.join(dir, "remotes.json"))).toBe(false)
})

test("a repeated setup changes nothing on the host", async () => {
  const dir = temp()
  const host = fakeHost()
  await runSetup(command(dir), { ssh: () => host.run, local: fakeLocal(dir), out: output() })
  host.state.calls.length = 0
  const out = output()
  const result = await runSetup(command(dir), { ssh: () => host.run, local: fakeLocal(dir), out })
  expect(result.code).toBe(0)
  expect(host.state.calls).toEqual(["probe", "cert"])
  expect(out.text()).toContain("already installed")
  expect(out.text()).toContain("already exists")
  expect(out.text()).toContain("service already running")
})

test("a lost token file is replaced by a fresh token, and --rotate replaces a kept one", async () => {
  const dir = temp()
  const host = fakeHost()
  await runSetup(command(dir), { ssh: () => host.run, local: fakeLocal(dir), out: output() })
  rmSync(path.join(dir, "remote", "vps.my-mac.token"))
  host.state.calls.length = 0
  await runSetup(command(dir), { ssh: () => host.run, local: fakeLocal(dir), out: output() })
  expect(host.state.calls).toContain("revoke")
  expect(host.state.calls).toContain("token")
  host.state.calls.length = 0
  await runSetup(command(dir, ["--rotate"]), { ssh: () => host.run, local: fakeLocal(dir), out: output() })
  expect(host.state.calls.filter((call) => call === "revoke" || call === "token")).toEqual(["revoke", "token"])
})

test("clear errors: no Tailscale, a wrong name, a certificate the user cannot issue, an unreachable host, no SSH", async () => {
  const attempt = async (options: Parameters<typeof fakeHost>[0], local: Partial<LocalPort> = {}) => {
    const dir = temp()
    const out = output()
    const result = await runSetup(command(dir), { ssh: () => fakeHost(options).run, local: fakeLocal(dir, local), out })
    return { code: result.code, text: out.text() }
  }
  expect((await attempt({ tailscale: false })).text).toContain("Tailscale is not installed on the host")
  expect((await attempt({ os: "Darwin" })).text).toContain("supports Linux")
  expect((await attempt({ dns: "other.example.ts.net" })).text).toContain("is other.example.ts.net, not vps.example.ts.net")
  const cert = await attempt({ certFails: "Access denied: cert access denied" })
  expect(cert.code).toBe(1)
  expect(cert.text).toContain("sudo tailscale set --operator=$USER")
  const down = await attempt({}, { reachable: async () => false })
  expect(down.text).toContain("does not answer from this machine")
  expect(down.text).toContain("run the same command again")
  const dir = temp()
  const out = output()
  await runSetup(command(dir), { ssh: () => async () => ({ code: 255, stdout: "", stderr: "Permission denied (publickey)." }), local: fakeLocal(dir), out })
  expect(out.text()).toContain("cannot run commands on user@vps")
})

test("pair adds a device to a set-up host without touching its listener or service", async () => {
  const dir = temp()
  const host = fakeHost()
  await runSetup(command(dir), { ssh: () => host.run, local: fakeLocal(dir), out: output() })
  const second = temp()
  host.state.calls.length = 0
  const pair = parseSetupCommand(["remote", "pair", HOST, "--ssh", "user@vps", "--dir", second, "--device", "phone-pad", "--expires-days", "7"], second)!
  const result = await runSetup(pair, { ssh: () => host.run, local: fakeLocal(second), out: output() })
  expect(result.code).toBe(0)
  expect(host.state.calls).toEqual(["probe", "token"])
  expect(host.state.tokens.has("phone-pad")).toBe(true)
  expect(statSync(path.join(second, "remote", "vps.phone-pad.token")).mode & 0o777).toBe(0o600)
  expect(JSON.parse(readFileSync(path.join(second, "remotes.json"), "utf8")).remotes.vps.connect).toBe(`${HOST}:9876`)
  const bare = fakeHost()
  const out = output()
  await runSetup(parseSetupCommand(["remote", "pair", HOST, "--dir", temp()], second)!, { ssh: () => bare.run, local: fakeLocal(second), out })
  expect(out.text()).toContain("run `remote setup` from the first device")
})

test("pair --sync adds a sync-only token beside the device token and turns sync on here, with the path rules", async () => {
  const dir = temp()
  const host = fakeHost()
  await runSetup(command(dir), { ssh: () => host.run, local: fakeLocal(dir), out: output() })
  const second = temp()
  const scripts: string[] = []
  const pair = parseSetupCommand(["remote", "pair", HOST, "--ssh", "user@vps", "--dir", second, "--device", "laptop", "--sync", "--path-map", "/Users/me/code=/home/u/code"], second)!
  expect(setupPlan(pair).join("\n")).toContain("sync token laptop-sync")
  const result = await runSetup(pair, { ssh: () => async (call) => { scripts.push(call.script); return host.run(call) }, local: fakeLocal(second), out: output() })
  expect(result.code).toBe(0)
  expect(scripts.some((script) => script.includes("remote token create --sync") && script.includes("'laptop-sync'"))).toBe(true)
  expect(host.state.tokens.has("laptop-sync")).toBe(true)
  const tokenFile = path.join(second, "remote", "vps.sync-token")
  expect(statSync(tokenFile).mode & 0o777).toBe(0o600)
  const sync = JSON.parse(readFileSync(path.join(second, "sync.json"), "utf8"))
  expect(sync).toMatchObject({ remote: "vps", tokenFile, pathMap: [expect.anything()] })
  expect(() => parseSetupCommand(["remote", "pair", HOST, "--path-map", "/a=/b"], second)).toThrow("--sync")
  expect(parseSetupCommand(["remote", "pair", HOST, "--dir", second, "--sync", "--run"], second)).toMatchObject({ sync: true, syncRun: true })
  expect(() => parseSetupCommand(["remote", "pair", HOST, "--dir", second, "--run"], second)).toThrow("--run needs --sync")
})

test("unpair revokes on the host and removes the local token file and remote", async () => {
  const dir = temp()
  const host = fakeHost()
  await runSetup(command(dir), { ssh: () => host.run, local: fakeLocal(dir), out: output() })
  const out = output()
  const result = await runSetup(parseSetupCommand(["remote", "unpair", "my-mac", "--dir", dir], dir)!, { ssh: () => host.run, local: fakeLocal(dir), out })
  expect(result.code).toBe(0)
  expect(host.state.tokens.has("my-mac")).toBe(false)
  expect(existsSync(path.join(dir, "remote", "vps.my-mac.token"))).toBe(false)
  expect(JSON.parse(readFileSync(path.join(dir, "remotes.json"), "utf8"))).toEqual({ remotes: {} })
})

test("unpair still cleans up a profile whose token file uses the earlier <device>.token name", async () => {
  const dir = temp()
  const host = fakeHost()
  await runSetup(command(dir, ["--sync"]), { ssh: () => host.run, local: fakeLocal(dir), out: output() })
  const current = path.join(dir, "remote", "vps.my-mac.token")
  const legacy = path.join(dir, "remote", "my-mac.token")
  renameSync(current, legacy)
  const profiles = JSON.parse(readFileSync(path.join(dir, "remotes.json"), "utf8"))
  profiles.remotes.vps.tokenFile = legacy
  writeFileSync(path.join(dir, "remotes.json"), JSON.stringify(profiles))
  const result = await runSetup(parseSetupCommand(["remote", "unpair", "my-mac", "--dir", dir], dir)!, { ssh: () => host.run, local: fakeLocal(dir), out: output() })
  expect(result.code).toBe(0)
  expect(host.state.tokens.has("my-mac")).toBe(false)
  expect(existsSync(legacy)).toBe(false)
  expect(existsSync(path.join(dir, "remote", "vps.sync-token"))).toBe(false)
  expect(existsSync(path.join(dir, "sync.json"))).toBe(false)
  expect(JSON.parse(readFileSync(path.join(dir, "remotes.json"), "utf8"))).toEqual({ remotes: {} })
})

test("unpair keeps an earlier-named token file that another saved remote still uses", async () => {
  const dir = temp()
  const host = fakeHost()
  await runSetup(command(dir), { ssh: () => host.run, local: fakeLocal(dir), out: output() })
  const legacy = path.join(dir, "remote", "my-mac.token")
  renameSync(path.join(dir, "remote", "vps.my-mac.token"), legacy)
  const profiles = JSON.parse(readFileSync(path.join(dir, "remotes.json"), "utf8"))
  profiles.remotes.vps.tokenFile = legacy
  profiles.remotes.other = { ...profiles.remotes.vps }
  writeFileSync(path.join(dir, "remotes.json"), JSON.stringify(profiles))
  const result = await runSetup(parseSetupCommand(["remote", "unpair", "my-mac", "--remote", "vps", "--dir", dir], dir)!, { ssh: () => host.run, local: fakeLocal(dir), out: output() })
  expect(result.code).toBe(0)
  expect(existsSync(legacy)).toBe(true)
  const after = JSON.parse(readFileSync(path.join(dir, "remotes.json"), "utf8"))
  expect(after.remotes.vps).toBeUndefined()
  expect(after.remotes.other.tokenFile).toBe(legacy)
})

test("setting up a second host keeps the first host's token: token files are per remote", async () => {
  const dir = temp()
  const a = fakeHost()
  const b = fakeHost({ dns: "other.example.ts.net" })
  await runSetup(command(dir), { ssh: () => a.run, local: fakeLocal(dir), out: output() })
  const first = readFileSync(path.join(dir, "remote", "vps.my-mac.token"), "utf8")
  const second = parseSetupCommand(["remote", "setup", "other.example.ts.net", "--ssh", "user@other", "--dir", dir, "--no-default"], dir, () => "My-Mac.local")!
  const result = await runSetup(second, { ssh: () => b.run, local: fakeLocal(dir), out: output() })
  expect(result.code).toBe(0)
  const profiles = JSON.parse(readFileSync(path.join(dir, "remotes.json"), "utf8")).remotes
  expect(profiles.vps.tokenFile).not.toBe(profiles.other.tokenFile)
  expect(readFileSync(profiles.vps.tokenFile, "utf8")).toBe(first)
  expect(existsSync(profiles.other.tokenFile)).toBe(true)
  // Unpairing this machine from the second host leaves the first one's token and remote alone.
  await runSetup(parseSetupCommand(["remote", "unpair", "my-mac", "--remote", "other", "--dir", dir], dir)!, { ssh: () => b.run, local: fakeLocal(dir), out: output() })
  expect(existsSync(profiles.vps.tokenFile)).toBe(true)
  expect(JSON.parse(readFileSync(path.join(dir, "remotes.json"), "utf8")).remotes.vps).toBeDefined()
})

test("unpair also revokes the sync token on the host and turns off this machine's sync with it", async () => {
  const dir = temp()
  const host = fakeHost()
  await runSetup(command(dir, ["--sync"]), { ssh: () => host.run, local: fakeLocal(dir), out: output() })
  expect(host.state.tokens.has("my-mac-sync")).toBe(true)
  const syncFile = path.join(dir, "remote", "vps.sync-token")
  expect(existsSync(syncFile)).toBe(true)
  expect(existsSync(path.join(dir, "sync.json"))).toBe(true)
  await runSetup(parseSetupCommand(["remote", "unpair", "my-mac", "--dir", dir], dir)!, { ssh: () => host.run, local: fakeLocal(dir), out: output() })
  expect(host.state.tokens.has("my-mac")).toBe(false)
  expect(host.state.tokens.has("my-mac-sync")).toBe(false)
  expect(existsSync(syncFile)).toBe(false)
  expect(existsSync(path.join(dir, "sync.json"))).toBe(false)
})

test("a service that was installed without the listener is reinstalled with it, even when remote.json is already right", async () => {
  const dir = temp()
  const host = fakeHost()
  await runSetup(command(dir), { ssh: () => host.run, local: fakeLocal(dir), out: output() })
  host.state.localOnly = true
  host.state.calls.length = 0
  await runSetup(command(dir), { ssh: () => host.run, local: fakeLocal(dir), out: output() })
  expect(host.state.calls).toEqual(["probe", "cert", "service-stop", "service-install", "service-start"])
  host.state.calls.length = 0
  await runSetup(command(dir), { ssh: () => host.run, local: fakeLocal(dir), out: output() })
  expect(host.state.calls).toEqual(["probe", "cert"])
})

test("ACP agents whose arguments carry a credential are not copied", async () => {
  expect(argsCarryCredential(["acp"])).toBe(false)
  expect(argsCarryCredential(["acp", "--model", "fast", "--port=8080", "-v"])).toBe(false)
  for (const args of [["--api-key=abcd"], ["--api-key", "abcd"], ["--token", "x"], ["https://user:pw@example.com/mcp"], ["https://example.com/mcp?api_key=1"], ["Authorization: Bearer abc"], ["--header=x-api-key: 1"], ["a".repeat(40)], ["sk-ant-api03-" + "x".repeat(40)]]) expect(argsCarryCredential(args)).toBe(true)
  const dir = temp()
  writeFileSync(path.join(dir, "acp-agents.json"), JSON.stringify({ keyed: { command: "hermes", args: ["acp", "--api-key=sk-secret-value"] }, plain: { command: "hermes", args: ["acp"] } }))
  const host = fakeHost()
  const out = output()
  await runSetup(command(dir, ["--acp-agents"]), { ssh: () => host.run, local: fakeLocal(dir), out })
  expect(JSON.parse(host.state.acp)).toEqual({ plain: { command: "hermes", args: ["acp"] } })
  expect(host.state.acp).not.toContain("secret")
  expect(out.text()).toContain("skipped keyed: its arguments look like they carry a credential")
})

test("--clone-missing does not take a same-named repository of another project for the clone, nor two missing projects of one name for each other", async () => {
  const dir = temp()
  const host = fakeHost()
  const cloneRuns: string[] = []
  const existing: Record<string, string> = { "/code/app": "git@github.com:org-a/app.git" }
  const run: SshRunner = async (call) => {
    if (call.script.includes("git clone")) {
      const target = /\[ -d "\$HOME"(\/code\/[^/]+)\/\.git \]/.exec(call.script)?.[1]
      const origin = target ? existing[target] : undefined
      if (origin) return { code: 0, stdout: `origin=${origin}\n`, stderr: "" }
      cloneRuns.push(call.script)
      if (target) existing[target] = /git clone -- '([^']+)'/.exec(call.script)![1]!
      return { code: 0, stdout: "", stderr: "" }
    }
    return host.run(call)
  }
  const sessions = [
    { id: "s1", title: "b-app", directory: "/Users/me/b/app" },
    { id: "s2", title: "c-app", directory: "/Users/me/c/app" },
    { id: "s3", title: "d-lib", directory: "/Users/me/d/lib" },
  ]
  const identities: Record<string, { id: string; url: string }> = {
    "/Users/me/b/app": { id: "github.com/org-b/app", url: "https://github.com/org-b/app.git" },
    "/Users/me/c/app": { id: "github.com/org-c/app", url: "https://github.com/org-c/app.git" },
    "/Users/me/d/lib": { id: "github.com/org-d/lib", url: "https://github.com/org-d/lib.git" },
  }
  const local = fakeLocal(dir, { listSessions: async () => sessions, identity: async (directory) => ({ directory, ...identities[directory]!, rel: "" }) })
  const out = output()
  await runSetup(command(dir, ["--migrate-sessions", "--clone-missing"]), { ssh: () => run, local, out })
  expect(local.exported).toEqual(["s3"])
  expect(out.text()).toContain('skipped "b-app": ~/code/app on the host is a different repository')
  expect(out.text()).toContain('skipped "c-app": ~/code/app on the host is a different repository')
  expect(cloneRuns).toHaveLength(1)
})

test("settings travel as one bundle on stdin, once", async () => {
  const dir = temp()
  const host = fakeHost()
  await runSetup(command(dir, ["--migrate-settings"]), { ssh: () => host.run, local: fakeLocal(dir), out: output() })
  expect(host.state.calls).toContain("bundle")
  expect(Buffer.from(host.state.inputs.find((input) => input instanceof Uint8Array) as Uint8Array).toString()).toBe('{"bundle":true}')
  host.state.calls.length = 0
  await runSetup(command(dir, ["--migrate-settings"]), { ssh: () => host.run, local: fakeLocal(dir), out: output() })
  expect(host.state.calls).not.toContain("bundle")
})

test("ACP agents move only when asked, as command and args, only when found on the host, never env values", async () => {
  const dir = temp()
  writeFileSync(path.join(dir, "acp-agents.json"), JSON.stringify({ hermes: { command: "hermes", args: ["acp"], env: { API_KEY: "sk-secret-value" } }, "missing-agent": { command: "missing-agent", args: [] }, mac: { command: "/Applications/App/bin/agent", args: [] } }))
  const host = fakeHost()
  const out = output()
  await runSetup(command(dir), { ssh: () => host.run, local: fakeLocal(dir), out })
  expect(host.state.acp).toBe("")
  const again = output()
  await runSetup(command(dir, ["--acp-agents"]), { ssh: () => host.run, local: fakeLocal(dir), out: again })
  expect(JSON.parse(host.state.acp)).toEqual({ hermes: { command: "hermes", args: ["acp"] } })
  expect(host.state.acp).not.toContain("secret")
  expect(again.text()).toContain("missing-agent: missing-agent is not on the host's PATH")
  expect(again.text()).toContain("machine-specific")
})

test("sessions move with the project matched by git remote, a path rule or a clone; unmatched ones are skipped and the rest resume", async () => {
  const dir = temp()
  const host = fakeHost({ repos: "/home/u/code/app\tgit@github.com:Org/App.git\n", missing: ["/home/u/gone"] })
  const sessions = [
    { id: "s1", title: "feature", directory: "/Users/me/code/app/packages/x" },
    { id: "s2", title: "scratch", directory: "/Users/me/tmp/scratch" },
    { id: "s3", title: "notes", directory: "/Users/me/notes" },
    { id: "s4", title: "old", directory: "/Users/me/old" },
  ]
  const identities: Record<string, { id?: string; rel: string }> = { "/Users/me/code/app/packages/x": { id: "github.com/org/app", rel: "packages/x" } }
  const local = fakeLocal(dir, { listSessions: async () => sessions, identity: async (directory) => ({ directory, ...(identities[directory] ?? { rel: "" }) }) })
  const options = ["--migrate-sessions", "--path-map", "/Users/me/notes=/home/u/notes", "--path-map", "/Users/me/old=/home/u/gone"]
  const out = output()
  await runSetup(command(dir, options), { ssh: () => host.run, local, out })
  expect(local.exported).toEqual(["s1", "s3"])
  expect(host.state.imports[0]).toContain('cd "/home/u/code/app/packages/x"')
  expect(host.state.imports[1]).toContain('cd "/home/u/notes"')
  expect(out.text()).toContain('skipped "scratch"')
  expect(out.text()).toContain('skipped "old": /home/u/gone does not exist on the host')
  const ledger = JSON.parse(readFileSync(path.join(dir, "remote-setup", "vps.json"), "utf8"))
  expect(Object.keys(ledger.sessions)).toEqual(["s1", "s3"])
  expect(statSync(path.join(dir, "remote-setup", "vps.json")).mode & 0o777).toBe(0o600)
  local.exported.length = 0
  host.state.imports.length = 0
  await runSetup(command(dir, options), { ssh: () => host.run, local, out: output() })
  expect(local.exported).toEqual([])
  expect(host.state.imports).toEqual([])
})

test("--clone-missing clones a project the host lacks, then maps the path inside the repo", async () => {
  const dir = temp()
  const host = fakeHost()
  const cloneRuns: string[] = []
  const run: SshRunner = async (call) => {
    if (call.script.includes("git clone")) { cloneRuns.push(call.script); return { code: 0, stdout: "", stderr: "" } }
    return host.run(call)
  }
  const local = fakeLocal(dir, { listSessions: async () => [{ id: "s1", title: "t", directory: "/Users/me/code/lib/src" }], identity: async (directory) => ({ directory, id: "github.com/org/lib", url: "https://github.com/Org/Lib.git", rel: "src" }) })
  await runSetup(command(dir, ["--migrate-sessions", "--clone-missing"]), { ssh: () => run, local, out: output() })
  expect(cloneRuns[0]).toContain("git clone -- 'https://github.com/Org/Lib.git'")
  expect(host.state.imports[0]).toContain('cd "$HOME"/code/lib/src')
})

test("project matching helpers", () => {
  expect(["git@github.com:Org/Repo.git", "https://user@GitHub.com/org/repo/", "ssh://git@github.com:22/org/repo", "https://github.com/org/repo.git"].map(normalizeGitRemote)).toEqual(Array(4).fill("github.com/org/repo"))
  expect(normalizeGitRemote("")).toBeUndefined()
  expect(normalizeGitRemote("/local/path")).toBeUndefined()
  const rules = [parsePathRule("/Users/x/Code=/home/x/code"), parsePathRule("/Users/x/Code/special=/srv/special")]
  expect(applyPathRule("/Users/x/Code/special/app", rules)).toBe("/srv/special/app")
  expect(applyPathRule("/Users/x/Code/other", rules)).toBe("/home/x/code/other")
  expect(applyPathRule("/Users/x/CodeBase", rules)).toBeUndefined()
  const project = { id: "github.com/o/r", url: "git@github.com:o/r.git", rel: "pkg", directory: "/Users/x/z/pkg" }
  expect(mapProject({ project, rules: [], repos: [{ top: "/h/r", url: "https://github.com/O/R" }], cloneMissing: false, cloneRoot: "~/code" })).toEqual({ directory: "/h/r/pkg", how: "git" })
  expect(mapProject({ project, rules: [], repos: [], cloneMissing: false, cloneRoot: "~/code" })).toMatchObject({ reason: expect.stringContaining("--clone-missing") })
  expect(mapProject({ project: { directory: "/p", rel: "" }, rules: [], repos: [], cloneMissing: true, cloneRoot: "~/code" })).toMatchObject({ reason: expect.stringContaining("--path-map") })
})

test("the session list and the import result are read only from the CLI's own --json line", () => {
  const entry = { sessionId: "ses_1", title: "t", directory: "/p" }
  const line = (command: string, data: unknown) => JSON.stringify({ schema: "mendcode.cli", kind: "result", command, data })
  expect(parseSessionList(line("session.list", { sessions: [entry] }))).toEqual([{ id: "ses_1", title: "t", directory: "/p" }])
  // Other shapes are refused, not guessed at.
  expect(() => parseSessionList(JSON.stringify({ sessions: [entry] }))).toThrow()
  expect(() => parseSessionList(line("session.get", { sessions: [entry] }))).toThrow()
  expect(() => parseSessionList(line("session.list", { sessions: [{ title: "no id", directory: "/p" }] }))).toThrow()
  expect(() => parseSessionList("nope")).toThrow()
  expect(() => parseSessionList(JSON.stringify({ schema: "mendcode.cli", kind: "error", command: "session.list", error: { code: "failed", message: "daemon down" } }))).toThrow("daemon down")
  expect(parseImportResult(line("session.import", { sessionId: "ses_9" }))).toBe("ses_9")
  expect(() => parseImportResult(`{"sessionId":"ses_9"}`)).toThrow()
})

test("against the real commands in process: session list --json parses, and raw export --format json imports on another machine", async () => {
  const machine = async (label: string) => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `mendcode-setup-${label}-`)))
    dirs.push(dir)
    const project = path.join(dir, "project")
    mkdirSync(project)
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "d.sock"), log: () => {}, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
    const client = createClient({ socketPath: daemon.socketPath, name: `setup-${label}`, reconnect: false })
    await client.connect()
    const out: string[] = [], err: string[] = []
    const deps: AutomationDeps = { cwd: project, client, listen() {}, out: { write: (text) => out.push(text) }, err: { write: (text) => err.push(text) }, now: () => Date.now(), onInterrupt() {}, env: {} }
    const run = async (...argv: string[]) => {
      out.length = 0; err.length = 0
      const parsed = parseAutomation(argv)
      if (parsed.ok !== true) throw new Error(JSON.stringify(parsed))
      return { code: await runAutomation(parsed.command, deps), out: out.join(""), err: err.join("") }
    }
    return { project, client, daemon, run, stop: async () => { client.close(); await daemon.stop() } }
  }
  const local = await machine("local")
  const host = await machine("host")
  try {
    const created = await local.client.send({ type: "session.create", directory: local.project, title: "moved" })
    if (!created.ok) throw new Error("session.create failed")
    const id = created.result!.sessionId as string
    expect((await local.client.send({ type: "user.submit", sessionId: id as never, text: "hello", attachments: [] })).ok).toBe(true)
    const deadline = Date.now() + 5_000
    const ended = () => local.daemon.store.readExactAfter(id as never, 0, 1000).some((event) => event.type === "turn.completed") && local.daemon.store.lastTurnStatus(id as never) !== "running"
    while (!ended() && Date.now() < deadline) await Bun.sleep(10)
    expect(ended()).toBe(true)

    // The same arguments `remote setup` passes (defaultLocalPort), minus --dir: this test's client already names the daemon.
    const listed = await local.run("session", "list", "--all-projects", "--limit", "100", "--json")
    expect(listed.code).toBe(0)
    expect(parseSessionList(listed.out)).toEqual([{ id, title: "moved", directory: local.project }])

    const exported = await local.run("export", id, "--format", "json")
    expect(exported.code).toBe(0)
    expect(exported.err.includes(EXPORT_TRUNCATED_NOTE)).toBe(false)
    const file = path.join(host.project, "session.json")
    writeFileSync(file, exported.out)
    const imported = await host.run("import", file, "--from", "mendcode", "--json")
    expect(imported.code).toBe(0)
    const remoteId = parseImportResult(imported.out)
    expect(host.daemon.store.sessionInfo(remoteId as never)).toMatchObject({ directory: host.project })
  } finally {
    await local.stop()
    await host.stop()
  }
}, 30_000)
