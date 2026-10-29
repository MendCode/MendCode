import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { isReadOnlyCommand, Settings } from "@mendcode/protocol"
import { createFauxEngine } from "@mendcode/engine-faux"
import { startDaemon, type DaemonOptions } from "../src"
import { remoteTokens } from "../src/remote"
import { sandboxStatus } from "../src/sandbox-status"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function boot(extra: Partial<DaemonOptions> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "mendd-sandbox-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), ...extra })
  const client = createClient({ socketPath: daemon.socketPath, name: "sandbox" })
  await client.connect()
  cleanups.push(() => daemon.stop(), () => client.close())
  return { client, daemon, dir }
}

const seatbelt = { name: "seatbelt", binary: "/usr/bin/sandbox-exec" } as const

describe("sandbox setting and status", () => {
  test("the setting is validated: modes, network and absolute-length paths only", () => {
    expect(Settings.safeParse({ sandbox: { mode: "workspace-write", network: "off", writableRoots: ["/opt/cache"] } }).success).toBe(true)
    expect(Settings.safeParse({ sandbox: { mode: "yolo" } }).success).toBe(false)
    expect(Settings.safeParse({ sandbox: { network: "allowlist" } }).success).toBe(false)
    expect(Settings.safeParse({ sandbox: { mode: "off", extra: true } }).success).toBe(false)
  })

  test("status says what is set and whether this system enforces it", () => {
    expect(sandboxStatus({ settings: {}, backend: seatbelt })).toMatchObject({ mode: "off", network: "off", enforced: false, backend: "seatbelt" })
    expect(sandboxStatus({ settings: { sandbox: { mode: "workspace-write", writableRoots: ["/opt/cache"] } }, backend: seatbelt })).toMatchObject({ mode: "workspace-write", enforced: true, writableRoots: ["/opt/cache"] })
    const missing = sandboxStatus({ settings: { sandbox: { mode: "read-only" } }, backend: null })
    expect(missing).toMatchObject({ mode: "read-only", enforced: false })
    expect(missing.backend).toBeUndefined()
    expect(missing.detail).toContain("refused")
  })

  test("a local client reads the status after changing the setting", async () => {
    const { client } = await boot()
    const before = await client.send({ type: "sandbox.status" })
    expect(before.ok ? before.result : undefined).toMatchObject({ mode: "off", network: "off", enforced: false })
    expect((await client.send({ type: "settings.set", patch: { sandbox: { mode: "read-only", network: "on" } } })).ok).toBe(true)
    const after = await client.send({ type: "sandbox.status" })
    expect(after.ok ? after.result : undefined).toMatchObject({ mode: "read-only", network: "on" })
  })

  test("it is not a read-only peer command and a remote client never gets the status", async () => {
    expect(isReadOnlyCommand("sandbox.status")).toBe(false)
    const { dir, daemon } = await boot({ listen: "127.0.0.1:0" })
    const token = remoteTokens(dir).create({ name: "full", readOnly: false }).token
    const remote = createClient({ name: "remote", remote: { hostname: "127.0.0.1", port: daemon.remotePort!, token } })
    await remote.connect()
    cleanups.push(() => remote.close())
    expect(await remote.send({ type: "sandbox.status" })).toMatchObject({ ok: false, error: { code: "forbidden" } })
  })
})
