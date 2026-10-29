import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { startDaemon, type DaemonOptions } from "../src"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function boot(extra: Partial<DaemonOptions> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "mendd-info-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), ...extra })
  const client = createClient({ socketPath: daemon.socketPath, name: "info" })
  await client.connect()
  cleanups.push(() => daemon.stop(), () => client.close())
  return { dir, client }
}

describe("daemon.info", () => {
  test("reports the engine, data directory, pid and build without a login check for engines that have none", async () => {
    const { dir, client } = await boot({ buildId: "abc123", info: { engine: "faux" } })
    const reply = await client.send({ type: "daemon.info" })
    expect(reply.ok).toBe(true)
    expect(reply.ok ? reply.result : undefined).toEqual({ engine: "faux", dataDir: dir, pid: process.pid, buildId: "abc123" })
  })
  test("includes model, effort and the login result, and never anything else", async () => {
    const { client } = await boot({ info: { engine: "native", model: "gpt-6-luna", effort: "low", login: async () => ({ ok: true }) } })
    const reply = await client.send({ type: "daemon.info" })
    const result = (reply.ok ? reply.result : {}) as Record<string, unknown>
    expect(result.engine).toBe("native")
    expect(result.model).toBe("gpt-6-luna")
    expect(result.effort).toBe("low")
    expect(result.login).toEqual({ ok: true })
    expect(Object.keys(result).sort()).toEqual(["dataDir", "effort", "engine", "login", "model", "pid"])
  })
  test("a failing login check reports its message; a throwing one is contained", async () => {
    const failing = await boot({ info: { engine: "native", login: async () => ({ ok: false, message: "[AUTH]: no Codex login found; run `codex login`" }) } })
    const a = await failing.client.send({ type: "daemon.info" })
    expect(a.ok ? a.result?.login : undefined).toEqual({ ok: false, message: "[AUTH]: no Codex login found; run `codex login`" })
    const throwing = await boot({
      info: {
        engine: "native",
        login: async () => {
          throw new Error("boom")
        },
      },
    })
    const b = await throwing.client.send({ type: "daemon.info" })
    expect(b.ok ? b.result?.login : undefined).toEqual({ ok: false, message: "boom" })
  })
  test("without info the engine is unknown", async () => {
    const { client } = await boot()
    const reply = await client.send({ type: "daemon.info" })
    expect(reply.ok ? reply.result?.engine : undefined).toBe("unknown")
  })
  test("onboarded is an accepted setting that persists", async () => {
    const { client } = await boot()
    const set = await client.send({ type: "settings.set", patch: { onboarded: true } })
    expect(set.ok).toBe(true)
    const got = await client.send({ type: "settings.get" })
    expect(got.ok ? (got.result?.settings as Record<string, unknown>).onboarded : undefined).toBe(true)
  })
})
