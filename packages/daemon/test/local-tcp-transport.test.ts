import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { localEndpointPath, readLocalEndpoint } from "@mendcode/client/local-endpoint"
import { createIdFactory, encodeFrame, PROTOCOL_VERSION } from "@mendcode/protocol"
import { startDaemon } from "../src"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "mendd-tcp-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function boot(dir: string, localTransport: "tcp" | "unix") {
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), localTransport, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanups.push(() => daemon.stop())
  return daemon
}

/** Sends raw lines and collects what comes back until the daemon closes the socket or the wait ends. */
async function rawExchange(port: number, lines: string[], waitMs = 300) {
  let received = ""
  let closed = false
  const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data(_s, data) { received += Buffer.from(data).toString() }, close() { closed = true } } })
  for (const line of lines) socket.write(line)
  await new Promise((resolve) => setTimeout(resolve, waitMs))
  socket.end()
  return { received, closed }
}

describe("local loopback TCP transport", () => {
  test("publishes a 0600 endpoint file, serves a client that presents the secret and removes the file on stop", async () => {
    const dir = tempDir()
    const daemon = await boot(dir, "tcp")
    const endpoint = readLocalEndpoint(dir)
    expect(endpoint).toMatchObject({ transport: "tcp", hostname: "127.0.0.1", pid: process.pid, port: daemon.localEndpoint!.port })
    if (process.platform !== "win32") expect(statSync(localEndpointPath(dir)).mode & 0o777).toBe(0o600)
    expect(existsSync(path.join(dir, "mendd.sock"))).toBe(false)

    const client = createClient({ localTcp: () => readLocalEndpoint(dir), name: "tcp-test", reconnect: false })
    await client.connect()
    cleanups.push(() => client.close())
    const created = await client.send({ type: "session.create", directory: "/repo", title: "t" })
    expect(created.ok).toBe(true)
    // A local connection is not a remote peer: no token name, no read-only restriction.
    expect(client.remoteInfo).toBeUndefined()

    await daemon.stop()
    expect(existsSync(localEndpointPath(dir))).toBe(false)
  })

  test("refuses a connection that sends commands without the secret or with a wrong one", async () => {
    const dir = tempDir()
    const daemon = await boot(dir, "tcp")
    const ids = createIdFactory()
    const port = daemon.localEndpoint!.port
    const hello = encodeFrame({ v: PROTOCOL_VERSION, kind: "command", body: { id: ids("command"), clientId: ids("client"), type: "hello", protocolVersion: PROTOCOL_VERSION, client: { name: "intruder", version: "0" }, capabilities: [] } } as never)
    const noSecret = await rawExchange(port, [hello])
    expect(noSecret.received).toContain("unauthorized")
    expect(noSecret.received).not.toContain("\"ack\"")
    const wrong = await rawExchange(port, [encodeFrame({ v: PROTOCOL_VERSION, kind: "auth", id: ids("command"), token: "x".repeat(43) }), hello])
    expect(wrong.received).toContain("unauthorized")
    expect(wrong.received).not.toContain("intruder")
    expect(wrong.received).not.toContain("x".repeat(43))
  })

  test("a client keeps working across a daemon restart because the endpoint is read again on every connect", async () => {
    const dir = tempDir()
    const first = await boot(dir, "tcp")
    const states: string[] = []
    const client = createClient({ localTcp: () => readLocalEndpoint(dir), name: "restart-test", onConnection: (state) => states.push(state) })
    await client.connect()
    cleanups.push(() => client.close())
    const firstToken = readLocalEndpoint(dir)!.token
    await first.stop()
    const second = await boot(dir, "tcp")
    expect(readLocalEndpoint(dir)!.token).not.toBe(firstToken)
    const deadline = Date.now() + 5_000
    while (!states.includes("connected") || states.filter((state) => state === "connected").length < 2) {
      if (Date.now() > deadline) throw new Error("client did not reconnect")
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect((await client.send({ type: "session.create", directory: "/repo", title: "again" })).ok).toBe(true)
    expect(second.localEndpoint).toBeDefined()
  })

  test("the unix transport leaves no endpoint file and clears a stale one", async () => {
    const dir = tempDir()
    const tcp = await boot(dir, "tcp")
    await tcp.stop()
    await Bun.write(localEndpointPath(dir), "{}")
    const daemon = await boot(dir, "unix")
    expect(daemon.localEndpoint).toBeUndefined()
    expect(existsSync(localEndpointPath(dir))).toBe(false)
    const client = createClient({ socketPath: daemon.socketPath, name: "unix-test", reconnect: false })
    await client.connect()
    cleanups.push(() => client.close())
  })
})
