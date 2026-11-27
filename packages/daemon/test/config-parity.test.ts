import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { createClient } from "@mendcode/client"
import type { EnginePort } from "@mendcode/kernel"
import { startDaemon } from "../src"
import { remoteTokens } from "../src/remote"

/**
 * Configuration parity between two daemons in this process, each on its own temp data dir: a hub with a loopback listener and a
 * device whose saved remote carries the owner's full token. No real host, model, login or user daemon is touched.
 */
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })
const tempDir = (label: string) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `mend-parity-${label}-`)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const write = (root: string, relative: string, text: string) => {
  mkdirSync(path.dirname(path.join(root, relative)), { recursive: true })
  writeFileSync(path.join(root, relative), text)
}
const read = (root: string, relative: string) => readFileSync(path.join(root, relative), "utf8")
const skill = (name: string, body = name) => `---\nname: ${name}\ndescription: ${name}\n---\n${body}\n`
const idle = () => ({ runTurn: async () => ({ status: "ok" }), needsCompaction: () => false, compact: async () => ({ status: "ok" }) }) as unknown as EnginePort

type Client = ReturnType<typeof createClient>
async function boot(dir: string, extra: Partial<Parameters<typeof startDaemon>[0]> = {}) {
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "d.sock"), log: () => {}, engine: idle, ...extra })
  const client = createClient({ socketPath: daemon.socketPath, name: "test", reconnect: false, timeoutMs: 20_000 })
  await client.connect()
  let stopped = false
  cleanups.push(async () => { if (stopped) return; stopped = true; client.close(); await daemon.stop() })
  return { dir, daemon, client }
}

/** The owner's side: a configuration worth carrying, in the data dir of a device that is about to start. */
function ownerConfiguration(dir: string) {
  write(dir, "skills/alpha/SKILL.md", skill("alpha"))
  write(dir, "agents/helper.md", "---\ndescription: helper\n---\nHelp.\n")
  write(dir, "themes/dusk.json", JSON.stringify({ name: "dusk" }))
  write(dir, "extensions/footer.ts", "export default {}\n")
  write(dir, "packages/plain/mendcode-profile.json", JSON.stringify({ name: "plain", version: "1.0.0", description: "p", extensions: false }))
  write(dir, "packages/plain/skills/plain-skill/SKILL.md", skill("plain-skill"))
  write(dir, "packages/runs/mendcode-profile.json", JSON.stringify({ name: "runs", version: "1.0.0", description: "r", extensions: false }))
  write(dir, "packages/runs/skills/runs-skill/SKILL.md", skill("runs-skill"))
  write(dir, "packages/runs/tools/hello.ts", "export default {}\n")
  write(dir, "mcp.json", JSON.stringify({ servers: { docs: { command: "docs-server", args: ["--stdio"] } } }))
}

async function pair(options: { configure?: (dir: string) => void; hub?: (dir: string) => void } = {}) {
  const hubDir = tempDir("hub")
  options.hub?.(hubDir)
  const hub = await boot(hubDir, { listen: "127.0.0.1:0" })
  const tokens = remoteTokens(hubDir)
  const owner = tokens.create({ name: "owner" }).token
  const syncToken = tokens.create({ name: "owner-sync", sync: true }).token
  const deviceDir = tempDir("device")
  ownerConfiguration(deviceDir)
  options.configure?.(deviceDir)
  mkdirSync(path.join(deviceDir, "remote"), { recursive: true })
  writeFileSync(path.join(deviceDir, "remote", "hub.token"), `${owner}\n`, { mode: 0o600 })
  writeFileSync(path.join(deviceDir, "remote", "hub.sync-token"), `${syncToken}\n`, { mode: 0o600 })
  writeFileSync(path.join(deviceDir, "remotes.json"), JSON.stringify({ remotes: { hub: { connect: `127.0.0.1:${hub.daemon.remotePort}`, tokenFile: path.join(deviceDir, "remote", "hub.token") } } }), { mode: 0o600 })
  const device = await boot(deviceDir, { sync: { tickMs: 600_000, followMs: 600_000 } })
  const parity = async (input: Record<string, unknown> = {}) => {
    const reply = await device.client.send({ type: "config.parity", input: { op: "run", remote: "hub", ...input } } as never)
    if (!reply.ok) throw new Error(`parity failed: ${JSON.stringify(reply)}`)
    return reply.result as { remote: string; applied: boolean; before: Row[]; after?: Row[]; counts: Record<string, number>; import?: { importId: string; blocked: string[]; notes: string[] } }
  }
  return { hub, hubDir, device, deviceDir, owner, syncToken, tokens, parity }
}
type Row = { kind: string; item: string; state: string; note?: string }
const state = (rows: Row[] | undefined, kind: string, item: string) => rows?.find((row) => row.kind === kind && row.item.startsWith(item))?.state

test("a comparison says what the hub lacks and changes nothing there", async () => {
  const node = await pair()
  const result = await node.parity()
  expect(result.applied).toBe(false)
  expect(state(result.before, "skill", "skills/alpha")).toBe("missing")
  expect(state(result.before, "agent", "agents/helper.md")).toBe("missing")
  expect(state(result.before, "theme", "themes/dusk.json")).toBe("missing")
  expect(state(result.before, "profile", "plain")).toBe("missing")
  expect(state(result.before, "mcp", "docs")).toBe("missing")
  // Code that runs on its own is listed and held back.
  expect(state(result.before, "extension", "extensions/footer.ts")).toBe("code")
  expect(state(result.before, "profile", "runs")).toBe("code")
  expect(existsSync(path.join(node.hubDir, "skills"))).toBe(false)
  expect(existsSync(path.join(node.hubDir, "packages"))).toBe(false)
  expect(existsSync(path.join(node.hubDir, "config-imports"))).toBe(false)
})

test("applying brings the hub level: files, a profile that is on, an MCP server that arrives pending, and never code", async () => {
  const node = await pair()
  const applied = await node.parity({ apply: true })
  expect(applied.applied).toBe(true)
  expect(read(node.hubDir, "skills/alpha/SKILL.md")).toBe(read(node.deviceDir, "skills/alpha/SKILL.md"))
  expect(read(node.hubDir, "agents/helper.md")).toBe(read(node.deviceDir, "agents/helper.md"))
  expect(read(node.hubDir, "themes/dusk.json")).toBe(read(node.deviceDir, "themes/dusk.json"))
  expect(read(node.hubDir, "packages/plain/skills/plain-skill/SKILL.md")).toBe(skill("plain-skill"))
  const hubSettings = (await node.hub.client.send({ type: "settings.get" } as never) as { result?: { settings: { disabledProfiles?: string[] } } }).result!.settings
  expect(hubSettings.disabledProfiles ?? []).not.toContain("user:plain")
  const servers = JSON.parse(read(node.hubDir, "mcp.json")).servers
  expect(servers.docs.command).toBe("docs-server")
  expect(JSON.stringify(servers.docs)).toContain("pendingApproval")
  expect(existsSync(path.join(node.hubDir, "extensions", "footer.ts"))).toBe(false)
  expect(existsSync(path.join(node.hubDir, "packages", "runs"))).toBe(false)
  expect(state(applied.after, "skill", "skills/alpha")).toBe("same")
  expect(state(applied.after, "profile", "plain")).toBe("same")
  expect(state(applied.after, "mcp", "docs")).toBe("same")
  expect(state(applied.after, "extension", "extensions/footer.ts")).toBe("code")
  expect(applied.import?.importId).toMatch(/^imp-/)
  // A second run has nothing to send.
  const again = await node.parity({ apply: true })
  expect(again.import).toBeUndefined()
  expect((again.counts.missing ?? 0) + (again.counts.differs ?? 0) + (again.counts.state ?? 0)).toBe(0)
})

test("with code allowed, an extension and a profile that runs code are installed too", async () => {
  const node = await pair()
  const applied = await node.parity({ apply: true, allowCode: true })
  expect(read(node.hubDir, "extensions/footer.ts")).toBe("export default {}\n")
  expect(existsSync(path.join(node.hubDir, "packages", "runs", "tools", "hello.ts"))).toBe(true)
  expect(state(applied.after, "extension", "extensions/footer.ts")).toBe("same")
  expect(state(applied.after, "profile", "runs")).toBe("same")
})

test("a changed or switched-off profile and a changed file replace what the hub has, with a backup to undo from", async () => {
  const node = await pair()
  await node.parity({ apply: true })
  write(node.deviceDir, "skills/alpha/SKILL.md", skill("alpha", "second"))
  const off = await node.device.client.send({ type: "profiles.enable", directory: node.deviceDir, key: "user:plain", enabled: false } as never)
  expect(off.ok).toBe(true)
  const compared = await node.parity()
  expect(state(compared.before, "skill", "skills/alpha")).toBe("differs")
  expect(state(compared.before, "profile", "plain")).toBe("state")
  const applied = await node.parity({ apply: true })
  expect(read(node.hubDir, "skills/alpha/SKILL.md")).toContain("second")
  const hubSettings = (await node.hub.client.send({ type: "settings.get" } as never) as { result?: { settings: { disabledProfiles?: string[] } } }).result!.settings
  expect(hubSettings.disabledProfiles).toContain("user:plain")
  expect(state(applied.after, "profile", "plain")).toBe("same")
  const journal = JSON.parse(read(node.hubDir, `config-imports/${applied.import!.importId}/journal.json`))
  expect(journal.state).toBe("applied")
  expect(existsSync(path.join(node.hubDir, "config-imports", applied.import!.importId, "backup", "skills", "alpha", "SKILL.md"))).toBe(true)
})

test("what the hub holds on its own is left alone and listed as only there", async () => {
  const node = await pair({ hub: (dir) => write(dir, "skills/hub-own/SKILL.md", skill("hub-own")) })
  const applied = await node.parity({ apply: true })
  expect(state(applied.after, "skill", "skills/hub-own")).toBe("hub-only")
  expect(existsSync(path.join(node.hubDir, "skills", "hub-own", "SKILL.md"))).toBe(true)
})

test("a unit the hub keeps behind a link is blocked, never written through", async () => {
  const outside = tempDir("checkout")
  const node = await pair({ hub: (dir) => symlinkSync(outside, path.join(dir, "skills")) })
  const applied = await node.parity({ apply: true })
  expect(state(applied.after, "skill", "skills/alpha")).toBe("blocked")
  expect(readdirSync(outside)).toEqual([])
})

test("a profile with credential-like text is held back until it is named, and then it travels", async () => {
  const node = await pair({ configure: (dir) => {
    write(dir, "packages/flagged/mendcode-profile.json", JSON.stringify({ name: "flagged", version: "1.0.0", description: "f", extensions: false }))
    write(dir, "packages/flagged/skills/fixture/SKILL.md", `---\nname: fixture\ndescription: f\n---\nANTHROPIC_API_KEY=sk-ant-api03-${"x".repeat(80)}\n`)
  } })
  const held = await node.parity({ apply: true })
  expect(state(held.after, "profile", "flagged")).toBe("blocked")
  expect(existsSync(path.join(node.hubDir, "packages", "flagged"))).toBe(false)
  const sent = await node.parity({ apply: true, allowFlagged: ["packages/flagged"] })
  expect(state(sent.after, "profile", "flagged")).toBe("same")
  expect(existsSync(path.join(node.hubDir, "packages", "flagged", "skills", "fixture", "SKILL.md"))).toBe(true)
})

test("sending one MCP server leaves the hub's other, approved servers as they are", async () => {
  const node = await pair({
    hub: (dir) => write(dir, "mcp.json", JSON.stringify({ servers: { docs: { command: "docs-server", args: ["--stdio"], disabled: true } } })),
    configure: (dir) => write(dir, "mcp.json", JSON.stringify({ servers: { docs: { command: "docs-server", args: ["--stdio"] }, extra: { command: "extra-server" } } })),
  })
  await node.parity({ apply: true })
  const servers = JSON.parse(read(node.hubDir, "mcp.json")).servers
  expect(servers.extra.command).toBe("extra-server")
  expect(JSON.stringify(servers.extra)).toContain("pendingApproval")
  expect(servers.docs).toMatchObject({ disabled: true })
  expect(JSON.stringify(servers.docs)).not.toContain("pendingApproval")
})

test("a standalone resource the credential scan withholds is listed as withheld, and travels once it is named", async () => {
  const node = await pair({ configure: (dir) => write(dir, "skills/flagged/SKILL.md", `---\nname: flagged\ndescription: f\n---\nANTHROPIC_API_KEY=sk-ant-api03-${"x".repeat(80)}\n`) })
  const held = await node.parity({ apply: true })
  expect(state(held.before, "skill", "skills/flagged")).toBe("blocked")
  expect(existsSync(path.join(node.hubDir, "skills", "flagged"))).toBe(false)
  const sent = await node.parity({ apply: true, allowFlagged: ["skills/flagged"] })
  expect(existsSync(path.join(node.hubDir, "skills", "flagged", "SKILL.md"))).toBe(true)
  expect(state(sent.after, "skill", "skills/flagged")).toBe("same")
})

test("overlapping parity requests each run: an apply that arrives during a comparison still applies", async () => {
  const node = await pair()
  const [comparison, applied] = await Promise.all([node.parity(), node.parity({ apply: true })])
  expect(comparison.applied).toBe(false)
  expect(applied.applied).toBe(true)
  expect(read(node.hubDir, "skills/alpha/SKILL.md")).toBe(read(node.deviceDir, "skills/alpha/SKILL.md"))
})

test("only a full token reaches the hub side, and only a local client runs a comparison", async () => {
  const node = await pair()
  const port = node.hub.daemon.remotePort!
  const connect = async (token: string) => {
    const client = createClient({ name: "t", remote: { hostname: "127.0.0.1", port, token }, reconnect: false })
    await client.connect()
    cleanups.push(() => client.close())
    return client
  }
  const forbidden = { ok: false, error: { code: "forbidden" } }
  const manifest = { type: "config.parity", input: { op: "manifest" } } as never
  const sync = await connect(node.syncToken)
  const run = await connect(node.tokens.create({ name: "owner-run", sync: true, run: true }).token)
  const watch = await connect(node.tokens.create({ name: "watch", readOnly: true }).token)
  const bot = await connect(node.tokens.create({ name: "bot", botRoot: node.hubDir }).token)
  for (const client of [sync, run, watch, bot]) expect(await client.send(manifest)).toMatchObject(forbidden)
  expect(await sync.send({ type: "config.parity", input: { op: "stage", id: "a".repeat(16), offset: 0, total: 1, data: "AA==" } } as never)).toMatchObject(forbidden)
  const full = await connect(node.owner)
  expect(await full.send(manifest)).toMatchObject({ ok: true, result: { manifest: { units: {}, packages: [] } } })
  expect(await full.send({ type: "config.parity", input: { op: "run", remote: "hub" } } as never)).toMatchObject(forbidden)
  // Nothing of the hub's changed by any of it.
  expect(existsSync(path.join(node.hubDir, "config-imports"))).toBe(false)
})

test("a staged bundle must arrive in order, whole and under the hash it was announced with", async () => {
  const node = await pair()
  const full = createClient({ name: "t", remote: { hostname: "127.0.0.1", port: node.hub.daemon.remotePort!, token: node.owner }, reconnect: false })
  await full.connect()
  cleanups.push(() => full.close())
  const id = "b".repeat(24)
  const send = (input: Record<string, unknown>) => full.send({ type: "config.parity", input } as never)
  expect(await send({ op: "stage", id, offset: 5, total: 10, data: "AAAAAAAAAA==" })).toMatchObject({ ok: false })
  expect(await send({ op: "stage", id, offset: 0, total: 3, data: Buffer.from("abcdef").toString("base64") })).toMatchObject({ ok: false })
  expect(await send({ op: "stage", id, offset: 0, total: 3, data: Buffer.from("{}\n").toString("base64") })).toMatchObject({ ok: true, result: { done: true } })
  expect(await send({ op: "apply", id, sha256: "0".repeat(64) })).toMatchObject({ ok: false, error: { message: expect.stringContaining("does not match") } })
  const text = Buffer.from("{}\n")
  expect(await send({ op: "stage", id, offset: 0, total: 3, data: text.toString("base64") })).toMatchObject({ ok: true })
  expect(await send({ op: "apply", id, sha256: createHash("sha256").update(text).digest("hex") })).toMatchObject({ ok: false, error: { message: expect.stringContaining("not a MendCode configuration bundle") } })
  expect(await send({ op: "apply", id: "c".repeat(24), sha256: "0".repeat(64) })).toMatchObject({ ok: false })
  expect(existsSync(path.join(node.hubDir, "skills"))).toBe(false)
})

test("without follow, a sync round never touches the hub's configuration; with it, the hub is brought level and the status says so", async () => {
  const node = await pair()
  const enable = (follow: boolean) => {
    writeFileSync(path.join(node.deviceDir, "sync.json"), JSON.stringify({ remote: "hub", tokenFile: path.join(node.deviceDir, "remote", "hub.sync-token"), ...(follow ? { follow: true } : {}) }), { mode: 0o600 })
    return node.device.client.send({ type: "sync.control", input: { action: "reload" } } as never)
  }
  expect((await enable(false)).ok).toBe(true)
  const plain = await node.device.client.send({ type: "sync.control", input: { action: "now" } } as never) as { ok: true; result: { follow?: unknown } }
  expect(plain.result.follow).toBeUndefined()
  expect(existsSync(path.join(node.hubDir, "skills"))).toBe(false)
  expect((await enable(true)).ok).toBe(true)
  const followed = await node.device.client.send({ type: "sync.control", input: { action: "now" } } as never) as { ok: true; result: { follow: { ok: boolean; summary: string } } }
  expect(followed.result.follow.ok).toBe(true)
  expect(followed.result.follow.summary).toContain("code")
  expect(read(node.hubDir, "skills/alpha/SKILL.md")).toBe(skill("alpha"))
  expect(existsSync(path.join(node.hubDir, "extensions", "footer.ts"))).toBe(false)
  // The sync token itself still cannot change configuration.
  const sync = createClient({ name: "t", remote: { hostname: "127.0.0.1", port: node.hub.daemon.remotePort!, token: node.syncToken }, reconnect: false })
  await sync.connect()
  cleanups.push(() => sync.close())
  expect(await sync.send({ type: "config.parity", input: { op: "manifest" } } as never)).toMatchObject({ ok: false, error: { code: "forbidden" } })
})

test("across systems, a unit written for the sender's system is held back until it is named", async () => {
  const { holdForPlatform, compareManifests, manifestOf } = await import("../src/parity")
  const { exportBundle } = await import("../src/config-bundle")
  const dir = tempDir("os")
  write(dir, "skills/mac-only/SKILL.md", skill("mac-only", "run `osascript -e beep` then open /opt/homebrew/bin/tool"))
  write(dir, "skills/plain/SKILL.md", skill("plain"))
  const here = manifestOf(exportBundle({ dataDir: dir, settings: {}, home: "/Users/a", platform: "darwin", arch: "arm64", now: 1 }).bundle)
  expect(here.units["skills/mac-only"]!.os).toEqual(["Homebrew path", "macOS-only command"])
  expect(here.units["skills/plain"]!.os).toBeUndefined()
  const hub = { ...manifestOf(exportBundle({ dataDir: tempDir("empty"), settings: {}, home: "/home/a", platform: "linux", arch: "x64", now: 1 }).bundle) }
  const rows = compareManifests({ here, hub, allowCode: false })
  holdForPlatform({ rows, here, hub, allowFlagged: [] })
  expect(rows.find((row) => row.item === "skills/mac-only")).toMatchObject({ state: "blocked", note: expect.stringContaining("written for darwin") })
  expect(rows.find((row) => row.item === "skills/plain")!.state).toBe("missing")
  const named = compareManifests({ here, hub, allowCode: false })
  holdForPlatform({ rows: named, here, hub, allowFlagged: ["skills/mac-only"] })
  expect(named.find((row) => row.item === "skills/mac-only")!.state).toBe("missing")
  const same = compareManifests({ here, hub: { ...hub, mendcode: { platform: "darwin" } }, allowCode: false })
  holdForPlatform({ rows: same, here, hub: { ...hub, mendcode: { platform: "darwin" } }, allowFlagged: [] })
  expect(same.find((row) => row.item === "skills/mac-only")!.state).toBe("missing")
})
