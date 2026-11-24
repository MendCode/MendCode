import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseSessionList, parseSetupCommand, runSetup, setupPlan, type LocalPort, type SetupCommand, type SshRunner } from "../src/remote-setup"
import { applyPathRule, mapProject, normalizeGitRemote, parsePathRule } from "../src/remote-setup-projects"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-setup-")); dirs.push(dir); return dir }
const HOST = "vps.example.ts.net"
const TOKEN = "T".repeat(8) + "0123456789abcdefghijklmnopqrstuvwxyz"

/** A pretend Linux host: it answers the scripts of a setup run from its own small state and records what ran. */
function fakeHost(options: { tailscale?: boolean; os?: string; dns?: string; certFails?: string; repos?: string; missing?: string[] } = {}) {
  const state = { version: undefined as string | undefined, tokens: new Set<string>(), remoteJson: "", installed: false, loaded: false, acp: "", calls: [] as string[], imports: [] as string[], inputs: [] as Array<string | Uint8Array | undefined> }
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" })
  const run: SshRunner = async ({ script, input }) => {
    state.inputs.push(input)
    if (script.includes('echo "os=')) { state.calls.push("probe"); return ok(`os=${options.os ?? "Linux"}\narch=x86_64\nhome=/home/u\nsystemd=yes\ntailscale=${options.tailscale === false ? "no" : "yes"}\nmendcode=${state.version ?? "none"}\n`) }
    if (script.includes("tailscale status --json")) return ok(JSON.stringify({ BackendState: "Running", Self: { DNSName: `${options.dns ?? HOST}.`, TailscaleIPs: ["100.64.0.9", "fd7a:115c:a1e0::9"] } }))
    if (script.includes("curl -fsSL")) { state.calls.push("install"); state.version = "1.2.3 (stable)"; return ok() }
    if (script.endsWith('"$MC" --version')) return ok(`${state.version}\n`)
    if (script.includes("tailscale cert")) {
      state.calls.push("cert")
      return options.certFails ? { code: 1, stdout: "", stderr: options.certFails } : ok("abs=/home/u/.mendcode\n")
    }
    if (script.includes('cat "$D/remote.json" 2>/dev/null')) return ok(state.remoteJson)
    if (script.includes("remote.json.tmp")) { state.calls.push("write-remote-json"); state.remoteJson = String(input); return ok() }
    if (script.includes("remote token list")) return ok([...state.tokens].map((name) => `${name}\tfull\t2026-01-01T00:00:00.000Z\tnever`).join("\n"))
    if (script.includes("remote token revoke")) { state.calls.push("revoke"); state.tokens.delete(/revoke '([^']+)'/.exec(script)![1]!); return ok("revoked\n") }
    if (script.includes("remote token create")) { state.calls.push("token"); state.tokens.add(/--name '([^']+)'/.exec(script)![1]!); return ok(`${TOKEN}\n`) }
    if (script.includes("daemon service status")) return ok(`Service: systemd-user · ${state.installed ? "installed" : "not installed"} · ${state.loaded ? "loaded" : "stopped"}\n`)
    if (script.includes("daemon service stop")) { state.calls.push("service-stop"); state.loaded = false; return ok() }
    if (script.includes("daemon service install")) { state.calls.push("service-install"); state.installed = true; return ok() }
    if (script.includes("daemon service start")) { state.calls.push("service-start"); state.loaded = true; return ok() }
    if (script.includes("config-bundle import")) { state.calls.push("bundle"); return ok("import imp_1 applied\ncomparison with the bundle: 3 match\n") }
    if (script.includes('cat "$D/acp-agents.json"')) return ok(state.acp || "{}")
    if (script.includes("acp-agents.json.tmp")) { state.calls.push("acp-write"); state.acp = String(input); return ok() }
    if (script.startsWith("set -eu\nMC=") && script.includes("command -v 'hermes'")) return { code: 0, stdout: "", stderr: "" }
    if (script.includes("command -v 'missing-agent'")) return { code: 1, stdout: "", stderr: "" }
    if (script.includes("find ")) return ok(options.repos ?? "")
    if (script.includes("[ -d ")) return ok((options.missing ?? []).join("\n"))
    if (script.includes('"$MC" import ')) {
      state.calls.push("session-import")
      state.imports.push(script)
      return ok(`{"sessionId":"ses_remote${state.imports.length}"}`)
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
  const file = path.join(dir, "remote", "my-mac.token")
  expect(readFileSync(file, "utf8").trim()).toBe(TOKEN)
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
  expect(JSON.parse(readFileSync(path.join(dir, "remotes.json"), "utf8"))).toEqual({ defaultRemote: "vps", remotes: { vps: { connect: `${HOST}:9876`, tokenFile: file, tls: true } } })
  expect(out.text()).not.toContain(TOKEN)
  expect(JSON.stringify(host.state.calls)).not.toContain(TOKEN)
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
  rmSync(path.join(dir, "remote", "my-mac.token"))
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
  expect(statSync(path.join(second, "remote", "phone-pad.token")).mode & 0o777).toBe(0o600)
  expect(JSON.parse(readFileSync(path.join(second, "remotes.json"), "utf8")).remotes.vps.connect).toBe(`${HOST}:9876`)
  const bare = fakeHost()
  const out = output()
  await runSetup(parseSetupCommand(["remote", "pair", HOST, "--dir", temp()], second)!, { ssh: () => bare.run, local: fakeLocal(second), out })
  expect(out.text()).toContain("run `remote setup` from the first device")
})

test("unpair revokes on the host and removes the local token file and remote", async () => {
  const dir = temp()
  const host = fakeHost()
  await runSetup(command(dir), { ssh: () => host.run, local: fakeLocal(dir), out: output() })
  const out = output()
  const result = await runSetup(parseSetupCommand(["remote", "unpair", "my-mac", "--dir", dir], dir)!, { ssh: () => host.run, local: fakeLocal(dir), out })
  expect(result.code).toBe(0)
  expect(host.state.tokens.has("my-mac")).toBe(false)
  expect(existsSync(path.join(dir, "remote", "my-mac.token"))).toBe(false)
  expect(JSON.parse(readFileSync(path.join(dir, "remotes.json"), "utf8"))).toEqual({ remotes: {} })
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

test("the local session list is read from the top level or the result envelope", () => {
  const entry = { sessionId: "ses_1", title: "t", directory: "/p" }
  expect(parseSessionList(JSON.stringify({ sessions: [entry] }))).toEqual([{ id: "ses_1", title: "t", directory: "/p" }])
  expect(parseSessionList(JSON.stringify({ data: { sessions: [entry, { title: "no id" }] } }))).toHaveLength(1)
  expect(() => parseSessionList("nope")).toThrow()
})
