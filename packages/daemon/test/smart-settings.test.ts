import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { MODEL_ROLES, PermissionMode, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function boot(dir?: string) {
  const data = dir ?? realpathSync(mkdtempSync(path.join(tmpdir(), "mendd-smart-")))
  if (!dir) cleanups.push(() => rmSync(data, { recursive: true, force: true }))
  const daemon = await startDaemon({ dir: data, socketPath: path.join(data, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  const client = createClient({ socketPath: daemon.socketPath, name: "smart" })
  await client.connect()
  return { data, daemon, client }
}

describe("smart mode settings", () => {
  test("smart is a permission mode, a valid default, and survives restarts and forks; the reviewer is a model role", async () => {
    expect(PermissionMode.options).toEqual(["ask", "edits", "full", "plan", "smart"])
    expect(MODEL_ROLES).toContain("permissionReviewer")
    const first = await boot()
    expect(await first.client.send({ type: "settings.set", patch: { defaultPermission: "smart", permissionAllow: ["make test", "git commit"], smartSandboxTrust: true, models: { permissionReviewer: { model: "gpt-5.4-mini" } } } })).toMatchObject({ ok: true })
    expect(await first.client.send({ type: "settings.set", patch: { permissionAllow: [""] } })).toMatchObject({ ok: false, error: { code: "invalid_command" } })

    const created = await first.client.send({ type: "session.create", directory: first.data })
    const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
    expect(first.daemon.store.permissionModeOf(sessionId)).toBe("smart")
    expect(first.daemon.store.readAfter(sessionId, 0).find((event) => event.type === "session.permission")).toMatchObject({ mode: "smart" })
    const forked = await first.client.send({ type: "session.fork", sessionId })
    const forkId = (forked.ok ? forked.result?.sessionId : undefined) as SessionId
    expect(first.daemon.store.permissionModeOf(forkId)).toBe("smart")
    const settings = await first.client.send({ type: "settings.get" })
    expect(settings).toMatchObject({ ok: true, result: { settings: { defaultPermission: "smart", permissionAllow: ["make test", "git commit"], smartSandboxTrust: true, models: { permissionReviewer: { model: "gpt-5.4-mini" } } } } })

    first.client.close()
    await first.daemon.stop()
    const second = await boot(first.data)
    cleanups.push(() => second.daemon.stop(), () => second.client.close())
    expect(second.daemon.store.permissionModeOf(sessionId)).toBe("smart")
    expect(await second.client.send({ type: "session.permission.set", sessionId, mode: "smart" })).toMatchObject({ ok: true })
  })
})
