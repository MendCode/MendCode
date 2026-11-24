import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { runGatewayCli } from "../src/cli"
import { BINARY_TARGET, gatewaySetup, inviteAccount, setAccountStatus, type Host, type SetupOptions } from "../src/setup"
import { gatewayState } from "../src/state"
import { CADDY_IMPORT, CADDY_SITE_FILE, CADDYFILE } from "../src/units"

/**
 * `gateway setup` and the admin commands against a fake host: every command is recorded and answered from a small
 * simulated system (users, services, Caddy, ufw, Tailscale). Nothing real is created, started or contacted.
 */
function fakeHost(input: { root?: boolean; linux?: boolean; caddy?: boolean; tailscale?: boolean } = {}) {
  const files = new Map<string, { content: string; mode: number }>()
  const users = new Set<string>()
  const active = new Set<string>()
  const commands: string[][] = []
  let caddy = input.caddy ?? false
  let funnel = ""
  let ufw = { active: false, rules: [] as string[] }
  let tokens = 0
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" })
  const no = { code: 1, stdout: "", stderr: "no" }
  const host: Host = {
    async run(command) {
      commands.push(command)
      const [bin, ...args] = command
      // The simulated users map to the test's own uid/gid, so the real chown of state files is a no-op.
      if (bin === "id") return users.has(args[1]!) ? ok(`${args[0] === "-u" ? process.getuid!() : process.getgid!()}\n`) : no
      if (bin === "useradd") { users.add(args.at(-1)!); return ok() }
      if (bin === "install" && args[0] === "-d") { for (const dir of args.filter((arg) => arg.startsWith("/"))) files.set(dir, { content: "", mode: 0o700 }); return ok() }
      if (bin === "install" && args[0] === "-D") { files.set(args.at(-1)!, { content: "binary", mode: 0o755 }); return ok() }
      if (bin === "runuser") { tokens++; return ok(`account-daemon-token-${tokens}-abcdefghijklmnop\n`) }
      if (bin === "systemctl") {
        if (args[0] === "is-active") return active.has(args.at(-1)!) ? ok("active\n") : { code: 3, stdout: "inactive\n", stderr: "" }
        if (["restart", "reload-or-restart"].includes(args[0]!) || args.includes("--now") && args[0] === "enable") active.add(args.at(-1)!)
        if (args[0] === "disable") active.delete(args.at(-1)!)
        return ok()
      }
      if (bin === "caddy") return caddy || args[0] !== "version" ? ok("v2") : no
      if (bin === "apt-get") { if (args[0] === "install") caddy = true; return ok() }
      if (bin === "tailscale") {
        if (!input.tailscale) return no
        if (args[0] === "funnel" && args[1] === "status") return ok(funnel)
        if (args[0] === "funnel") { funnel = `https://box.example.ts.net (Funnel on)\n|-- / proxy ${args.at(-1)}\n`; return ok() }
        return ok("{}")
      }
      if (bin === "ufw") {
        if (args[0] === "status") return ok(`Status: ${ufw.active ? "active" : "inactive"}\n${ufw.rules.map((rule) => `${rule}  ALLOW  Anywhere`).join("\n")}\n`)
        if (args[0] === "allow") ufw.rules.push(args[1]!)
        if (args[0] === "--force") ufw.active = true
        return ok("ufw 0.36")
      }
      if (bin === "sshd") return ok("port 22\nprotocol 2\n")
      if (bin === "systemd-analyze") return ok("→ Overall exposure level for mendcode-gateway.service: 1.9 OK :-)\n")
      return ok()
    },
    read: (file) => files.get(file)?.content ?? (existsSync(file) ? readFileSync(file, "utf8") : undefined),
    sha256: (file) => files.has(file) || file.endsWith("mendcode-release") ? "same" : undefined,
    write(file, content, mode) { files.set(file, { content, mode }) },
    exists: (file) => files.has(file) || existsSync(file),
    isRoot: () => input.root ?? true,
    linux: () => input.linux ?? true,
  }
  return { host, files, users, active, commands, get ufw() { return ufw }, set ufw(value) { ufw = value } }
}

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function options(extra: Partial<SetupOptions> = {}): SetupOptions {
  const dir = mkdtempSync(path.join(tmpdir(), "mcgw-setup-"))
  dirs.push(dir)
  return { domain: "code.example.test", mode: "caddy", port: 7480, adminName: "admin", binary: "/opt/mendcode-release", firewall: true, dryRun: false, stateDir: path.join(dir, "state"), usersRoot: path.join(dir, "users"), runtimeRoot: "/run/mendcode", ...extra }
}
const output = () => { const lines: string[] = []; return { out: { write: (text: string) => lines.push(text) }, text: () => lines.join("") } }

describe("gateway setup", () => {
  test("--dry-run prints the plan and changes nothing, on any machine and without root", async () => {
    const fake = fakeHost({ root: false, linux: false })
    const log = output()
    expect(await gatewaySetup(options({ dryRun: true }), fake.host, log.out)).toBe(0)
    expect(log.text()).toContain("Plan (dry run, nothing changes)")
    expect(log.text()).toContain("would install Caddy")
    expect(log.text()).toContain("would create the admin account")
    expect(fake.files.size).toBe(0)
    const mutating = fake.commands.filter(([bin, ...args]) => !(bin === "id" || (bin === "systemctl" && args[0] === "is-active") || (bin === "caddy" && args[0] === "version") || (bin === "ufw" && args[0] === "status") || bin === "sshd" || bin === "tailscale"))
    expect(mutating).toEqual([])
  })
  test("one run sets everything up; a second run changes nothing", async () => {
    const fake = fakeHost()
    const setup = options()
    const first = output()
    await gatewaySetup(setup, fake.host, first.out)
    expect(fake.users.has("mendcode-gw")).toBe(true)
    expect(fake.active.has("mendcode-gateway.service")).toBe(true)
    expect(fake.files.get(BINARY_TARGET)).toBeDefined()
    expect(fake.files.get(CADDY_SITE_FILE)!.content).toContain("reverse_proxy unix//run/mendcode-gateway/gateway.sock")
    expect(fake.files.get(CADDYFILE)!.content.trim()).toBe(CADDY_IMPORT)
    expect(fake.ufw.rules.sort()).toEqual(["22/tcp", "443/tcp"])
    // The admin's one-time link is printed once; its code is stored only as a hash.
    const link = /https:\/\/code\.example\.test\/_gw\/#invite=([A-Za-z0-9_-]{43})/.exec(first.text())
    expect(link).not.toBeNull()
    const state = gatewayState(setup.stateDir!).read()
    expect(state.accounts).toHaveLength(1)
    expect(state.accounts[0]).toMatchObject({ role: "admin", status: "invited" })
    expect(JSON.stringify(state)).not.toContain(link![1]!)
    expect(first.text()).not.toContain("account-daemon-token")
    // Account daemon tokens went to 0600 files only.
    const tokenFiles = [...fake.files].filter(([file]) => file.includes("/backends/"))
    expect(tokenFiles.map(([, entry]) => entry.mode)).toEqual([0o600, 0o600])
    const count = fake.commands.length
    const second = output()
    await gatewaySetup(setup, fake.host, second.out)
    expect(second.text()).not.toContain("...   ")
    // The pending admin gets a fresh link (the old one stops working), and no second account is made.
    expect(gatewayState(setup.stateDir!).read().accounts).toHaveLength(1)
    expect(fake.commands.slice(count).filter(([bin, verb]) => bin === "useradd" || bin === "install" || (bin === "systemctl" && verb === "restart"))).toEqual([])
    expect(second.text()).toContain("Done (0 step(s) applied)")
  })
  test("a re-run after an active admin exists prints no link", async () => {
    const fake = fakeHost()
    const setup = options()
    await gatewaySetup(setup, fake.host, output().out)
    gatewayState(setup.stateDir!).update((state) => { state.accounts[0]!.status = "active" })
    const again = output()
    await gatewaySetup(setup, fake.host, again.out)
    expect(again.text()).toContain("ok    an admin account is active")
    expect(again.text()).not.toContain("#invite=")
  })
  test("the units carry the sandboxing directives; behind Caddy the gateway has no network at all", async () => {
    const fake = fakeHost()
    await gatewaySetup(options(), fake.host, output().out)
    const gateway = fake.files.get("/etc/systemd/system/mendcode-gateway.service")!.content
    const user = fake.files.get("/etc/systemd/system/mendcode-user@.service")!.content
    for (const directive of ["NoNewPrivileges=yes", "ProtectSystem=strict", "ProtectHome=yes", "PrivateTmp=yes", "PrivateDevices=yes", "RestrictSUIDSGID=yes", "CapabilityBoundingSet=", "ProtectProc=invisible", "UMask=0077", "SystemCallArchitectures=native"]) {
      expect(gateway).toContain(directive)
      expect(user).toContain(directive)
    }
    expect(gateway).toContain("RestrictAddressFamilies=AF_UNIX\nPrivateNetwork=yes\nIPAddressDeny=any")
    expect(gateway).toContain("User=mendcode-gw")
    expect(user).toContain("User=mc-%i")
    expect(user).toMatch(/TemporaryFileSystem=.*:ro\nBindPaths=.*\/%i/)
    expect(user).toMatch(/MemoryMax=2G\nCPUQuota=200%\nTasksMax=512/)
    expect(user).toContain("--unix-socket /run/mendcode/%i/http.sock")
  })
  test("Tailscale Funnel mode publishes a loopback port, needs a ts.net name and opens no web port in the firewall", async () => {
    const fake = fakeHost({ tailscale: true })
    await expect(gatewaySetup(options({ mode: "funnel" }), fake.host, output().out)).rejects.toThrow("Tailscale name")
    await gatewaySetup(options({ mode: "funnel", domain: "box.example.ts.net" }), fake.host, output().out)
    expect(fake.commands).toContainEqual(["tailscale", "funnel", "--bg", "--https=443", "http://127.0.0.1:7480"])
    expect(fake.ufw.rules).toEqual(["22/tcp"])
    expect(fake.files.get(CADDY_SITE_FILE)).toBeUndefined()
  })
  test("refuses without root or systemd, and refuses a name that is not a public DNS name", async () => {
    await expect(gatewaySetup(options(), fakeHost({ root: false }).host, output().out)).rejects.toThrow("as root")
    await expect(gatewaySetup(options(), fakeHost({ linux: false }).host, output().out)).rejects.toThrow("Linux")
    for (const domain of ["localhost", "10.0.0.1", "*.example.test", "bad_name.example.test", "-x.example.test"]) await expect(gatewaySetup(options({ domain }), fakeHost().host, output().out)).rejects.toThrow("public DNS name")
  })
})

describe("gateway admin commands", () => {
  test("invite provisions a separate Linux user, daemon and 0700 home, and prints a single-use link", async () => {
    const fake = fakeHost()
    const setup = options()
    await gatewaySetup(setup, fake.host, output().out)
    const link = await inviteAccount({ host: fake.host, stateDir: setup.stateDir!, usersRoot: setup.usersRoot!, origin: "https://code.example.test", expiresHours: 72, name: "second", role: "user" })
    const account = gatewayState(setup.stateDir!).read().accounts.find((entry) => entry.name === "second")!
    expect(link).toStartWith("https://code.example.test/_gw/#invite=")
    expect(fake.users.has(`mc-${account.id}`)).toBe(true)
    expect(fake.commands).toContainEqual(["chmod", "0700", path.join(setup.usersRoot!, account.id)])
    expect(fake.active.has(`mendcode-user@${account.id}.service`)).toBe(true)
    await expect(inviteAccount({ host: fake.host, stateDir: setup.stateDir!, usersRoot: setup.usersRoot!, origin: "https://code.example.test", expiresHours: 72, name: "second", role: "user" })).rejects.toThrow("exists")
    // A new link for the same account replaces the old one.
    await inviteAccount({ host: fake.host, stateDir: setup.stateDir!, usersRoot: setup.usersRoot!, origin: "https://code.example.test", expiresHours: 1, accountId: account.id })
    expect(gatewayState(setup.stateDir!).read().invites.filter((invite) => invite.accountId === account.id)).toHaveLength(1)
  })
  test("disable stops the account's daemon as well as its access", async () => {
    const fake = fakeHost()
    const setup = options()
    await gatewaySetup(setup, fake.host, output().out)
    const id = gatewayState(setup.stateDir!).read().accounts[0]!.id
    await expect(setAccountStatus({ host: fake.host, stateDir: setup.stateDir!, accountId: id, status: "disabled" })).rejects.toThrow("not created a passkey")
    gatewayState(setup.stateDir!).update((state) => { state.accounts[0]!.status = "active" })
    await setAccountStatus({ host: fake.host, stateDir: setup.stateDir!, accountId: id, status: "disabled" })
    expect(fake.active.has(`mendcode-user@${id}.service`)).toBe(false)
    expect(gatewayState(setup.stateDir!).read().accounts[0]!.status).toBe("disabled")
  })
  test("the CLI parses setup flags, refuses the bun runtime as the installed binary and prints usage", async () => {
    const log = output()
    const err = output()
    expect(await runGatewayCli([], { out: log.out, err: err.out })).toBe(64)
    expect(log.text()).toContain("setup --domain NAME")
    expect(await runGatewayCli(["setup", "--domain", "code.example.test", "--binary", "/usr/bin/bun"], { out: log.out, err: err.out, host: fakeHost().host })).toBe(1)
    expect(err.text()).toContain("compiled mendcode binary")
    const dir = mkdtempSync(path.join(tmpdir(), "mcgw-cli-"))
    dirs.push(dir)
    writeFileSync(path.join(dir, "release"), "x")
    const plan = output()
    expect(await runGatewayCli(["setup", "code.example.test", "--dry-run", "--state", path.join(dir, "state")], { out: plan.out, err: err.out, host: fakeHost({ root: false }).host })).toBe(0)
    expect(plan.text()).toContain("would write the hardened systemd units")
  })
})
