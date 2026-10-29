import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createIdFactory, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { remoteTokens } from "../src/remote"
import { remoteExecutionCommand, remoteExecutionSettings } from "../src/remote-policy"

const ids = createIdFactory()

test("remote execution installers cannot bypass the settings gate", () => {
  for (const type of ["packages.install", "packages.enable", "packages.resource", "packages.install-catalog", "packages.install-source", "packages.add-source", "mcp.decide", "tools.trust"]) {
    expect(remoteExecutionCommand(type)).toBe(true)
  }
  expect(remoteExecutionCommand("session.list")).toBe(false)
})

test("remote feature aliases cannot re-enable host execution", () => {
  for (const patch of [
    { experimental: { thread_tools: true, pr_watch: true } },
    { tools: { "mcp__*": true } },
    { disabledExtensions: null }, { disabledPackages: null }, { disabledPackageResources: null },
  ]) expect(remoteExecutionSettings(patch)).toBe(true)
  expect(remoteExecutionSettings({ theme: "dark" })).toBe(false)
})

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
  const dir = temp("mendd-remote-policy-")
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), listen: "127.0.0.1:0", models: { selectable: true, defaults: { model: "faux" }, list: () => [{ id: "faux", name: "Faux", efforts: [] }, { id: "pi:fake", name: "Pi fake", engine: "pi", efforts: [] }] }, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanups.push(() => daemon.stop())
  const local = createClient({ socketPath: daemon.socketPath, name: "local" })
  await local.connect()
  cleanups.push(() => local.close())
  const token = remoteTokens(dir).create({ name: "full", readOnly: false }).token
  const remote = createClient({ name: "remote", remote: { hostname: "127.0.0.1", port: daemon.remotePort!, token } })
  await remote.connect()
  cleanups.push(() => remote.close())
  return { daemon, local, remote, project: temp("mendd-remote-policy-project-") }
}

test("a full-access remote peer cannot weaken the sandbox, trust a project, allow hook URLs or save permission rules through settings", async () => {
  const { daemon, local, remote, project } = await boot()
  const patches = [
    { sandbox: { mode: "off" as const } },
    { trustedToolDirs: [project] },
    { allowedHttpHookUrls: ["http://127.0.0.1:1/*"] },
    { permission: { bash: { "*": "allow" as const } } },
    { permissionAllow: ["curl"] },
    { smartSandboxTrust: true },
    { engineSafetyPrompts: false },
    { experimental: { thread_tools: true, pr_watch: true, reasoning_auto: true } },
    { tools: { "mcp__*": true, threads: true } },
    { disabledExtensions: null },
    { disabledPackages: null },
    { disabledPackageResources: null },
    { projectConfig: { [project]: { permission: { bash: { "*": "allow" as const } } } } },
  ]
  const before = JSON.stringify(daemon.store.settings.get())
  for (const patch of patches) expect(await remote.send({ type: "settings.set", patch })).toMatchObject({ ok: false, error: { code: "forbidden" } })
  for (const command of [
    { type: "packages.enable" as const, directory: project, key: "project:evil", enabled: true },
    { type: "packages.resource" as const, directory: project, key: "project:evil", resource: "extensions/x.ts", enabled: true },
    { type: "packages.install-source" as const, directory: project, sourceId: "evil", scope: "project" as const },
    { type: "mcp.decide" as const, directory: project, server: "evil", scope: "project" as const, revision: "fake", approve: true },
  ]) expect(await remote.send(command)).toMatchObject({ ok: false, error: { code: "forbidden" } })
  expect(await remote.send({ type: "tools.trust", directory: project, trusted: true })).toMatchObject({ ok: false, error: { code: "forbidden" } })
  expect(JSON.stringify(daemon.store.settings.get())).toBe(before)
  expect(await remote.send({ type: "settings.set", patch: { theme: "dark" } })).toMatchObject({ ok: true })
  expect(await local.send({ type: "tools.trust", directory: project, trusted: true })).toMatchObject({ ok: true })
  expect(await local.send({ type: "settings.set", patch: { sandbox: { mode: "read-only" } } })).toMatchObject({ ok: true })
})

test("full peers cannot inspect or steer the host queue, arm resumes or run pi turns", async () => {
  const { local, remote, project } = await boot()
  const created = await local.send({ type: "session.create", directory: project })
  expect(created.ok).toBe(true)
  const sessionId = created.ok ? created.result!.sessionId as SessionId : ids("session")
  const queueId = ids("queue")
  for (const command of [
    { type: "queue.list" as const, sessionId },
    { type: "queue.edit" as const, sessionId, queueId, text: "injected" },
    { type: "queue.reorder" as const, sessionId, queueId, to: "top" as const },
    { type: "queue.steer" as const, sessionId, queueId },
    { type: "usage.limit" as const, sessionId, action: "resume" as const },
    { type: "usage.limit" as const, sessionId, action: "schedule" as const },
    { type: "session.model.set" as const, sessionId, choice: { model: "pi:fake" } },
    { type: "user.submit" as const, sessionId, text: "injected", attachments: [], selection: { model: { model: "pi:fake" } } },
    { type: "session.compact" as const, sessionId, model: { model: "pi:fake" } },
  ]) expect(await remote.send(command)).toMatchObject({ ok: false, error: { code: "forbidden" } })
  expect(await local.send({ type: "session.model.set", sessionId, choice: { model: "pi:fake" } })).toMatchObject({ ok: true })
  expect(await remote.send({ type: "user.submit", sessionId, text: "injected", attachments: [] })).toMatchObject({ ok: false, error: { code: "forbidden" } })
  expect(await remote.send({ type: "session.compact", sessionId })).toMatchObject({ ok: false, error: { code: "forbidden" } })
  expect(await local.send({ type: "queue.list", sessionId })).toMatchObject({ ok: true })
})
