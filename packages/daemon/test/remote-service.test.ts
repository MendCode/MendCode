import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import type { EnginePort } from "@mendcode/kernel"
import type { ModelInfo, SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { remoteEngineAllowed, remoteEngineRefusal } from "../src/remote-policy"
import { remoteListenerConfig, remoteTokens, tailscaleAddress, validateRemoteListener } from "../src/remote"
import { daemonServiceDefinition, daemonServicePlan } from "../src/user-service"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })
const tempDir = () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mendd-remote-service-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const NATIVE: ModelInfo[] = [{ id: "gpt-6-luna", name: "GPT-6-Luna", efforts: [] }]
const ENGINES: ModelInfo[] = [{ id: "acp:fake", name: "fake · ACP", efforts: [] }, { id: "acp:other", name: "other · ACP", efforts: [] }, { id: "pi:local", name: "pi", efforts: [], engine: "pi" } as ModelInfo, { id: "cursor:x", name: "cursor", efforts: [], engine: "cursor" } as ModelInfo]

test("remoteEngines: nothing is allowed by default; acp covers every agent, acp:<agent> one, pi only itself", () => {
  expect(remoteEngineAllowed(undefined, "acp:fake")).toBe(false)
  expect(remoteEngineAllowed([], "pi")).toBe(false)
  expect(remoteEngineAllowed(["acp"], "acp:fake")).toBe(true)
  expect(remoteEngineAllowed(["acp"], "pi")).toBe(false)
  expect(remoteEngineAllowed(["acp:fake"], "acp:fake")).toBe(true)
  expect(remoteEngineAllowed(["acp:fake"], "acp:other")).toBe(false)
  expect(remoteEngineAllowed(["pi"], "acp:fake")).toBe(false)
  expect(remoteEngineRefusal({ engine: undefined, model: "acp:fake/model-1", allowed: ["acp:fake"] })).toBeUndefined()
  expect(remoteEngineRefusal({ engine: undefined, model: "acp:fake/model-1", allowed: ["acp:other"] })).toContain("local only")
  expect(remoteEngineRefusal({ engine: "cursor", model: "cursor:x", allowed: ["acp", "pi"] })).toContain("local only")
  expect(remoteEngineRefusal({ engine: "opencode", model: "opencode:x", allowed: ["acp", "pi"] })).toContain("local only")
})

test("a full-token remote client runs a turn on a listed ACP agent; read-only and unlisted stay refused; a remote client cannot list engines", async () => {
  const dir = tempDir()
  const project = tempDir()
  mkdirSync(path.join(dir, "agents"))
  writeFileSync(path.join(dir, "agents", "viaacp.md"), "---\ndescription: Runs on an ACP agent\nmode: primary\nmodel: acp:fake\n---\nWork.")
  let ran = 0
  const daemon = await startDaemon({
    dir, socketPath: path.join(dir, "mendd.sock"), listen: "127.0.0.1:0", log: () => {},
    info: { engine: "native", model: "gpt-6-luna" },
    models: { selectable: true, defaults: { model: "gpt-6-luna" }, list: () => [...NATIVE, ...ENGINES] },
    engine: () => ({ async runTurn() { ran += 1; return { status: "ok" } }, needsCompaction: () => false, compact: async () => ({ status: "ok" }) }) as EnginePort,
  })
  cleanups.push(() => daemon.stop())
  const local = createClient({ socketPath: daemon.socketPath, name: "local", reconnect: false })
  await local.connect()
  cleanups.push(() => local.close())
  const tokens = remoteTokens(dir)
  const full = createClient({ name: "peer", remote: { hostname: "127.0.0.1", port: daemon.remotePort!, token: tokens.create({ name: "peer" }).token }, reconnect: false })
  const readOnly = createClient({ name: "watch", remote: { hostname: "127.0.0.1", port: daemon.remotePort!, token: tokens.create({ name: "watch", readOnly: true }).token }, reconnect: false })
  await full.connect()
  await readOnly.connect()
  cleanups.push(() => full.close(), () => readOnly.close())
  const created = await local.send({ type: "session.create", directory: project, choice: { model: "gpt-6-luna" } })
  if (!created.ok) throw new Error("session failed")
  const sessionId = created.result!.sessionId as SessionId
  const submit = (client: typeof full, selection: object) => client.send({ type: "user.submit", sessionId, text: "go", attachments: [], selection } as never)

  expect(await submit(full, { model: { model: "acp:fake" } })).toMatchObject({ ok: false, error: { code: "forbidden" } })
  expect(ran).toBe(0)
  // The channel bridges (Telegram, Discord) reach the daemon over this same local socket, so their ACP turns need no listing.
  expect(await submit(local, { model: { model: "acp:fake" } })).toMatchObject({ ok: true })

  // A remote client cannot list engines for itself.
  expect(await full.send({ type: "settings.set", patch: { remoteEngines: ["acp"] } } as never)).toMatchObject({ ok: false })
  expect(await submit(full, { model: { model: "acp:fake" } })).toMatchObject({ ok: false, error: { code: "forbidden" } })

  // The host lists one agent.
  expect(await local.send({ type: "settings.set", patch: { remoteEngines: ["acp:fake"] } } as never)).toMatchObject({ ok: true })
  expect(await submit(full, { model: { model: "acp:other" } })).toMatchObject({ ok: false, error: { code: "forbidden" } })
  expect(await submit(full, { model: { model: "pi:local" } })).toMatchObject({ ok: false, error: { code: "forbidden" } })
  expect(await submit(full, { model: { model: "cursor:x" } })).toMatchObject({ ok: false, error: { code: "forbidden" } })
  expect(await submit(readOnly, { model: { model: "acp:fake" } })).toMatchObject({ ok: false, error: { code: "forbidden" } })
  expect(await submit(full, { model: { model: "acp:fake" } })).toMatchObject({ ok: true })
  // An agent whose own model is the listed one runs; an unlisted agent model does not.
  expect(await submit(full, { agent: "viaacp" })).toMatchObject({ ok: true })
  await Bun.sleep(50)
  expect(ran).toBeGreaterThan(0)

  expect(await local.send({ type: "settings.set", patch: { remoteEngines: ["pi"] } } as never)).toMatchObject({ ok: true })
  expect(await submit(full, { agent: "viaacp" })).toMatchObject({ ok: false, error: { code: "forbidden" } })
})

test("tailscaleAddress: only the tailnet ranges", () => {
  for (const address of ["100.64.0.1", "100.127.255.254", "fd7a:115c:a1e0::1", "fd7a:115c:a1e0:ab12::7", "::ffff:100.100.1.1", "[fd7a:115c:a1e0::1]"]) expect(tailscaleAddress(address)).toBe(true)
  for (const address of ["100.63.255.255", "100.128.0.1", "127.0.0.1", "192.168.1.5", "10.0.0.1", "fd7b:115c:a1e0::1", "fd7a:115c:a1e1::1", "example.ts.net", "100.64.0.1.evil", "300.64.0.1", "::1"]) expect(tailscaleAddress(address)).toBe(false)
})

test("remote.json mode tailscale: the listener binds only a tailnet address, with TLS, and the mode is read from the file", () => {
  const dir = tempDir()
  writeFileSync(path.join(dir, "remote.json"), JSON.stringify({ mode: "tailscale", listen: "0.0.0.0:9876", tlsCert: "/x/c.pem", tlsKey: "/x/k.pem" }))
  const config = remoteListenerConfig(dir, {})
  expect(config.mode).toBe("tailscale")
  expect(() => validateRemoteListener(config)).toThrow("Tailscale address")
  expect(() => validateRemoteListener({ ...config, listen: "127.0.0.1:9876" })).toThrow("Tailscale address")
  expect(() => validateRemoteListener({ ...config, listen: "box.example.ts.net:9876" })).toThrow("Tailscale address")
  expect(() => validateRemoteListener({ mode: "tailscale", listen: "100.64.0.9:9876" })).toThrow("requires --tls-cert")
  writeFileSync(path.join(dir, "remote.json"), JSON.stringify({ mode: "anywhere", listen: "127.0.0.1:1" }))
  expect(() => remoteListenerConfig(dir, {})).toThrow("invalid remote.json")
})

test("the service plan is local-only unless it is installed with a listener; listener flags are validated and kept", () => {
  const base = { dir: "/data/mc", cwd: "/work", command: ["/bin/mendcode", "__daemon"], platform: "linux", home: "/home/u" }
  expect(daemonServicePlan(base).programArguments).toContain("--local-only")
  const open = daemonServicePlan({ ...base, remote: [] })
  expect(open.programArguments).not.toContain("--local-only")
  const tls = daemonServicePlan({ ...base, remote: ["--listen", "100.64.0.9:9876", "--tls-cert", "/c.pem", "--tls-key", "/k.pem"] })
  expect(tls.programArguments.slice(-6)).toEqual(["--listen", "100.64.0.9:9876", "--tls-cert", "/c.pem", "--tls-key", "/k.pem"])
  expect(daemonServiceDefinition(tls)).toContain("100.64.0.9:9876")
  for (const remote of [["--listen"], ["--listen", "--tls-cert"], ["--local-only", "x"], ["--listen", "a:1", "--listen", "b:2"], ["--dir", "/other"]]) expect(() => daemonServicePlan({ ...base, remote })).toThrow("listener arguments")
})

test("a renewed TLS certificate is served without a restart, and a broken one is rejected while the old one keeps serving", async () => {
  const dir = tempDir()
  const cert = path.join(dir, "cert.pem")
  const key = path.join(dir, "key.pem")
  const generate = (name: string) => {
    const result = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", path.join(dir, `${name}-key.pem`), "-out", path.join(dir, `${name}-cert.pem`)], { stdout: "pipe", stderr: "pipe" })
    expect(result.exitCode).toBe(0)
  }
  generate("a")
  generate("b")
  writeFileSync(cert, readFileSync(path.join(dir, "a-cert.pem")))
  writeFileSync(key, readFileSync(path.join(dir, "a-key.pem")))
  const logs: string[] = []
  const daemon = await startDaemon({ dir, listen: "0.0.0.0:0", tlsCert: cert, tlsKey: key, socketPath: path.join(dir, "mendd.sock"), log: (_level, message) => void logs.push(message), defaultDirectory: dir, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanups.push(() => daemon.stop())
  const token = remoteTokens(dir).create().token
  const connect = async (ca: string) => {
    const client = createClient({ name: "tls", remote: { hostname: "127.0.0.1", port: daemon.remotePort!, token, tls: true, ca }, reconnect: false, timeoutMs: 1000 })
    try { await client.connect(); return true } catch { return false } finally { client.close() }
  }
  const caA = readFileSync(path.join(dir, "a-cert.pem"), "utf8")
  const caB = readFileSync(path.join(dir, "b-cert.pem"), "utf8")
  expect(await connect(caA)).toBe(true)
  expect(await connect(caB)).toBe(false)
  // A mismatched pair (new cert, old key) is refused and the old certificate stays.
  writeFileSync(cert, caB)
  await Bun.sleep(1600)
  expect(await connect(caA)).toBe(true)
  // The renewal tool replaces both files.
  writeFileSync(`${key}.new`, readFileSync(path.join(dir, "b-key.pem")))
  renameSync(`${key}.new`, key)
  await Bun.sleep(1600)
  expect(await connect(caB)).toBe(true)
  expect(await connect(caA)).toBe(false)
  expect(logs.join("\n")).toContain("TLS certificate reloaded")
}, 20_000)
