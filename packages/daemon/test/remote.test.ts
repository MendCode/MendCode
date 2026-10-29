import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient, type Client } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { Command, createIdFactory, encodeFrame, isReadOnlyCommand, READ_ONLY_COMMANDS, type SessionEvent, type SessionId } from "@mendcode/protocol"
import { startDaemon, type Daemon } from "../src"
import { remoteBackoff, remoteListenerConfig, remoteTokens, REMOTE_TOKENS_FILE } from "../src/remote"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-remote-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
async function boot(options: { dir?: string; listen?: string; tlsCert?: string; tlsKey?: string } = {}) {
  const dir = options.dir ?? tempDir()
  const daemon = await startDaemon({ ...options, dir, listen: options.listen ?? "127.0.0.1:0", socketPath: path.join(dir, "mendd.sock"), defaultDirectory: "/remote/project", engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanups.push(() => daemon.stop())
  return daemon
}
async function attach(daemon: Daemon, token: string, extra: { tls?: boolean; ca?: string; hostname?: string; onEvent?(event: SessionEvent): void; reconnect?: boolean } = {}) {
  const { onEvent, reconnect, ...tls } = extra
  const client = createClient({ name: "remote-test", remote: { hostname: "127.0.0.1", port: daemon.remotePort!, token, ...tls }, ...(onEvent ? { onEvent } : {}), ...(reconnect === undefined ? {} : { reconnect }), timeoutMs: 1000 })
  cleanups.push(() => client.close())
  await client.connect()
  return client
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("remote test timed out")
    await Bun.sleep(5)
  }
}
async function session(client: Client) {
  const reply = await client.send({ type: "session.create", directory: "/remote/project", title: "Remote" })
  if (!reply.ok) throw new Error(reply.error.message)
  return reply.result?.sessionId as SessionId
}

test("tokens: create, list, authenticate, revoke, private hash-only storage", () => {
  const dir = tempDir()
  const tokens = remoteTokens(dir)
  const full = tokens.create({ name: "laptop" })
  const ro = tokens.create({ name: "observer", readOnly: true })
  expect(full.token.length).toBeGreaterThan(32)
  expect(tokens.list()).toEqual([{ name: "laptop", readOnly: false, createdAt: full.createdAt }, { name: "observer", readOnly: true, createdAt: ro.createdAt }])
  expect(() => tokens.create({ name: "laptop" })).toThrow("already exists")
  expect(() => tokens.create({ name: "../escape" })).toThrow("token name")
  const file = path.join(dir, REMOTE_TOKENS_FILE)
  expect(statSync(file).mode & 0o777).toBe(0o600)
  const disk = readFileSync(file, "utf8")
  expect(disk).not.toContain(full.token)
  expect(disk).not.toContain(ro.token)
  expect(JSON.parse(disk)[0].hash).toMatch(/^[a-f0-9]{64}$/)
  expect(tokens.authenticate("wrong")).toBeUndefined()
  expect(tokens.authenticate(ro.token)?.name).toBe("observer")
  expect(tokens.list()[1]?.lastUsedAt).toBeNumber()
  tokens.revoke("observer")
  expect(tokens.authenticate(ro.token)).toBeUndefined()
  expect(tokens.list()).toHaveLength(1)
  expect(() => tokens.revoke("absent")).toThrow("unknown token")
})

test("loopback token attach reuses commands, subscriptions, presence and reconnect", async () => {
  const daemon = await boot()
  const token = remoteTokens(path.dirname(daemon.socketPath)).create({ name: "laptop" }).token
  const events: SessionEvent[] = []
  const a = await attach(daemon, token, { onEvent: (event) => events.push(event) })
  expect(a.remoteInfo).toEqual({ tokenName: "laptop", readOnly: false })
  expect(a.daemonDirectory).toBe("/remote/project")
  expect(daemon.remotePeers()).toEqual([{ address: "127.0.0.1", tokenName: "laptop", readOnly: false }])
  const id = await session(a)
  expect((await a.subscribe(id)).ok).toBe(true)
  expect((await a.send({ type: "user.submit", sessionId: id, text: "first", attachments: [] })).ok).toBe(true)
  await until(() => events.some((e) => e.type === "turn.completed"))
  const b = await attach(daemon, token)
  a.dropConnection()
  expect((await b.send({ type: "user.submit", sessionId: id, text: "second", attachments: [] })).ok).toBe(true)
  await until(() => events.filter((e) => e.type === "turn.completed").length === 2)
  expect(new Set(events.map((e) => e.seq)).size).toBe(events.length)
})

test("wrong token is refused and address backoff rejects even a valid token", async () => {
  const daemon = await boot()
  const token = remoteTokens(path.dirname(daemon.socketPath)).create().token
  await expect(attach(daemon, "wrong", { reconnect: false })).rejects.toThrow("auth failed")
  await expect(attach(daemon, token, { reconnect: false })).rejects.toThrow("rate limited")
  await Bun.sleep(270)
  expect((await attach(daemon, token)).remoteInfo?.readOnly).toBe(false)
})

test("TCP requires auth as the first frame and never echoes malformed token data", async () => {
  const daemon = await boot()
  let data = ""
  let closed = false
  const socket = await Bun.connect({ hostname: "127.0.0.1", port: daemon.remotePort!, socket: { data: (_socket, bytes) => { data += bytes.toString() }, close: () => { closed = true } } })
  cleanups.push(() => { socket.end() })
  socket.write(JSON.stringify({ v: 1, kind: "auth", token: "do-not-echo-this-token", extra: "invalid" }) + "\n")
  await until(() => closed)
  expect(data).toContain("unauthorized")
  expect(data).not.toContain("do-not-echo-this-token")
})

test("read-only allows reads/subscriptions, denies every mutating type before cache, revoke stops streams", async () => {
  const daemon = await boot()
  const tokens = remoteTokens(path.dirname(daemon.socketPath))
  const full = tokens.create({ name: "full" })
  const ro = tokens.create({ name: "observer", readOnly: true })
  const writer = await attach(daemon, full.token)
  const id = await session(writer)
  const reader = await attach(daemon, ro.token)
  expect((await reader.subscribe(id)).ok).toBe(true)
  expect((await reader.send({ type: "session.list" })).ok).toBe(true)
  expect((await reader.loadWindow(id)).ok).toBe(true)
  for (const command of [
    { type: "user.submit", sessionId: id, text: "denied", attachments: [] },
    { type: "session.delete", sessionId: id },
    { type: "draft.set", sessionId: id, text: "denied" },
    { type: "settings.set", patch: { theme: "mend" } },
    { type: "daemon.shutdown" },
  ] as const) expect(await reader.send(command as never)).toMatchObject({ ok: false, error: { code: "forbidden" } })
  // A captured writer command id must not bypass the reader's scope through the retry cache.
  const ids = createIdFactory()
  const clientId = ids("client")
  const commandId = ids("command")
  let frames = ""
  const raw = await Bun.connect({ hostname: "127.0.0.1", port: daemon.remotePort!, socket: { data: (_s, d) => { frames += d.toString() } } })
  cleanups.push(() => { raw.end() })
  raw.write(encodeFrame({ v: 1, kind: "auth", id: ids("command"), token: full.token }))
  raw.write(encodeFrame({ v: 1, kind: "command", body: { type: "hello", id: ids("command"), clientId, protocolVersion: 1, client: { name: "raw", version: "0" }, capabilities: [] } }))
  raw.write(encodeFrame({ v: 1, kind: "command", body: { type: "session.rename", id: commandId, clientId, sessionId: id, title: "Renamed" } }))
  await until(() => frames.includes(commandId))
  let deniedFrames = ""
  const denied = await Bun.connect({ hostname: "127.0.0.1", port: daemon.remotePort!, socket: { data: (_s, d) => { deniedFrames += d.toString() } } })
  cleanups.push(() => { denied.end() })
  denied.write(encodeFrame({ v: 1, kind: "auth", id: ids("command"), token: ro.token }))
  denied.write(encodeFrame({ v: 1, kind: "command", body: { type: "hello", id: ids("command"), clientId, protocolVersion: 1, client: { name: "replay", version: "0" }, capabilities: [] } }))
  denied.write(encodeFrame({ v: 1, kind: "command", body: { type: "session.rename", id: commandId, clientId, sessionId: id, title: "Denied rename" } }))
  await until(() => deniedFrames.includes(commandId))
  expect(deniedFrames).toContain('"code":"forbidden"')
  const listed = await writer.send({ type: "session.list" })
  expect(listed.ok && (listed.result?.sessions as Array<{ title: string }>)[0]?.title).toBe("Renamed")
  tokens.revoke("observer")
  expect(await reader.send({ type: "session.list" })).toMatchObject({ ok: false, error: { code: "unauthorized" } })
  await until(() => !daemon.remotePeers().some((peer) => peer.tokenName === "observer"))
})

test("protocol read classification is explicit and mutation types fail closed", () => {
  for (const type of READ_ONLY_COMMANDS) expect(isReadOnlyCommand(type)).toBe(true)
  for (const schema of Command.options) {
    const type = schema.shape.type.value
    if (type !== "session.agent-command.policy" && /\.(create|set|update|delete|remove|install|enable|control|submit|shutdown|restart|auth|trust|resolve|cancel|fire|apply|undo|redo|fork|compact|policy|link|unlink|revoke|forget|test|refresh|start)$/.test(type)) expect(isReadOnlyCommand(type)).toBe(false)
  }
  expect(isReadOnlyCommand("status.watch")).toBe(false)
  expect(isReadOnlyCommand("extensions.list")).toBe(false)
  expect(isReadOnlyCommand("secrets.reveal")).toBe(false)
})

test("listener refuses non-loopback without TLS before opening the store; config is opt-in", async () => {
  const dir = tempDir()
  await expect(boot({ dir, listen: "0.0.0.0:0" })).rejects.toThrow("requires --tls-cert and --tls-key")
  expect(remoteListenerConfig(dir, {})).toEqual({})
  writeFileSync(path.join(dir, "remote.json"), JSON.stringify({ listen: "127.0.0.1:9876" }))
  expect(remoteListenerConfig(dir, {})).toEqual({ listen: "127.0.0.1:9876" })
  expect(remoteListenerConfig(dir, { listen: "[::1]:0" })).toEqual({ listen: "[::1]:0" })
})

test("address backoff grows, expires and is per peer", () => {
  let now = 1000
  const backoff = remoteBackoff(() => now)
  backoff.fail("a")
  expect(backoff.blocked("a")).toBe(true)
  expect(backoff.blocked("b")).toBe(false)
  now += 250
  expect(backoff.blocked("a")).toBe(false)
  backoff.fail("a")
  now += 499
  expect(backoff.blocked("a")).toBe(true)
  now += 1
  expect(backoff.blocked("a")).toBe(false)
  now += 300_000
  backoff.fail("a")
  now += 250
  expect(backoff.blocked("a")).toBe(false)
})

test("TLS listener accepts a custom CA and rejects untrusted or wrong-host certificates", async () => {
  const dir = tempDir()
  const cert = path.join(dir, "cert.pem")
  const key = path.join(dir, "key.pem")
  const generated = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", cert], { stdout: "pipe", stderr: "pipe" })
  expect(generated.exitCode).toBe(0)
  const daemon = await boot({ dir, listen: "0.0.0.0:0", tlsCert: cert, tlsKey: key })
  const token = remoteTokens(dir).create().token
  const ca = readFileSync(cert, "utf8")
  expect((await attach(daemon, token, { tls: true, ca })).remoteInfo?.readOnly).toBe(false)
  await expect(attach(daemon, token, { tls: true, reconnect: false })).rejects.toThrow()
  const wrongDir = tempDir()
  const wrongCert = path.join(wrongDir, "cert.pem")
  const wrongKey = path.join(wrongDir, "key.pem")
  const wrong = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=wrong.test", "-addext", "subjectAltName=DNS:wrong.test", "-keyout", wrongKey, "-out", wrongCert], { stdout: "pipe", stderr: "pipe" })
  expect(wrong.exitCode).toBe(0)
  const wrongDaemon = await boot({ dir: wrongDir, tlsCert: wrongCert, tlsKey: wrongKey })
  const wrongToken = remoteTokens(wrongDir).create().token
  await expect(attach(wrongDaemon, wrongToken, { tls: true, ca: readFileSync(wrongCert, "utf8"), reconnect: false })).rejects.toThrow()
})


test("real CLI uses remote project paths, --ca and --socket without launching a local daemon", async () => {
  const dir = tempDir()
  const cert = path.join(dir, "cert.pem")
  const key = path.join(dir, "key.pem")
  const generated = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert], { stdout: "pipe", stderr: "pipe" })
  expect(generated.exitCode).toBe(0)
  const daemon = await boot({ dir, tlsCert: cert, tlsKey: key })
  const token = remoteTokens(dir).create({ name: "cli", readOnly: true }).token
  const localDir = tempDir()
  const ids = createIdFactory()
  daemon.store.createSession({ id: ids("session"), directory: "/remote/project", title: "Remote project" })
  const main = path.join(import.meta.dir, "../../../apps/cli/src/main.ts")
  for (const transport of [["--connect", `127.0.0.1:${daemon.remotePort}`, "--ca", cert], ["--socket", daemon.socketPath]]) {
    const child = Bun.spawn(["bun", main, ...transport, "--dir", localDir, "session", "list", "--json"], { cwd: localDir, env: { ...process.env, MENDCODE_TOKEN: token }, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(code).toBe(0)
    expect(stderr).toBe("")
    expect(stdout).toContain("Remote project")
    expect(stdout).toContain("/remote/project")
    expect(stdout).not.toContain(token)
    expect(readFileSync(path.join(dir, REMOTE_TOKENS_FILE), "utf8")).not.toContain(token)
  }
  const { existsSync } = await import("node:fs")
  expect(existsSync(path.join(localDir, "mendd.sock"))).toBe(false)
  expect(existsSync(path.join(localDir, "mendcode.db"))).toBe(false)
})
