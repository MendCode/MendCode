import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { Command, createIdFactory, type SessionId } from "@mendcode/protocol"
import { isReadOnlyCommand } from "@mendcode/protocol/wire"
import { startDaemon } from "../src"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
async function boot(pure = false) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "b38-wire-")))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, "data")
  const project = path.join(root, "project")
  mkdirSync(dir)
  mkdirSync(project)
  const file = path.join(root, "plugin.ts")
  writeFileSync(file, 'export default async () => ({ auth: { provider: "fake", methods: [{ type: "api", label: "Key" }] } })')
  writeFileSync(path.join(dir, "mendcode.json"), JSON.stringify({ pluginCompatibility: true, plugin: [pathToFileURL(file).href] }))
  const daemon = await startDaemon({ dir, socketPath: path.join(root, "m.sock"), extensionsEnabled: !pure, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanup.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "b38-test" })
  await client.connect()
  cleanup.push(() => client.close())
  return { dir, root, project, file, client }
}

test("plugin commands are additive, strict and excluded from read-only authority", () => {
  const ids = createIdFactory()
  const base = { id: ids("command"), clientId: ids("client"), directory: "/work" }
  for (const input of [
    { type: "plugins.install", spec: "demo@1.0.0", global: true, force: true },
    { type: "plugins.auth-methods" },
    { type: "plugins.auth-start", provider: "demo", method: 0, inputs: { key: "test" } },
    { type: "plugins.auth-complete", flowId: crypto.randomUUID() },
    { type: "plugins.metadata", plugin: "demo", operation: "patch", sessionId: ids("session"), patch: { state: "review" } },
  ]) {
    const command = Command.parse({ ...base, ...input })
    expect(isReadOnlyCommand(command.type)).toBe(false)
    expect(Command.safeParse({ ...base, ...input, arbitrary: true }).success).toBe(false)
  }
})

test("client/daemon installation, auth and project-bound metadata work over the socket", async () => {
  const s = await boot()
  const installed = await s.client.installPlugin(s.project, pathToFileURL(s.file).href)
  expect(installed).toMatchObject({ ok: true, result: { mode: "add", scope: "project" } })
  const listed = await s.client.pluginAuthMethods(s.project)
  expect(listed).toMatchObject({ ok: true, result: { providers: [{ provider: "fake", authenticated: false }] } })
  const authed = await s.client.startPluginAuth(s.project, "fake", 0, { key: "do-not-return-this" })
  expect(authed).toMatchObject({ ok: true, result: { authenticated: true } })
  expect(JSON.stringify(authed)).not.toContain("do-not-return-this")
  expect(JSON.stringify(await s.client.pluginAuthMethods(s.project))).not.toContain("do-not-return-this")
  const created = await s.client.send({ type: "session.create", directory: s.project })
  if (!created.ok) throw new Error("session create failed")
  const sessionId = created.result!.sessionId as SessionId
  const request = { type: "plugins.metadata" as const, directory: s.project, plugin: "review", sessionId }
  expect(await s.client.send({ ...request, operation: "patch", patch: { state: "review" } })).toMatchObject({ ok: true, result: { metadata: { state: "review" } } })
  expect(await s.client.send({ ...request, operation: "get" })).toMatchObject({ ok: true, result: { metadata: { state: "review" } } })
  expect(await s.client.send({ ...request, directory: s.root, operation: "get" })).toMatchObject({ ok: false })
}, 10_000)

test("pure daemon exposes no external auth methods or plugin imports", async () => {
  const s = await boot(true)
  expect(await s.client.send({ type: "daemon.info" })).toMatchObject({ ok: true, result: { extensionsEnabled: false } })
  expect(await s.client.pluginAuthMethods(s.project)).toMatchObject({ ok: true, result: { providers: [] } })
  expect(await s.client.startPluginAuth(s.project, "fake", 0, { key: "never-stored" })).toMatchObject({ ok: false })
  expect(await s.client.send({ type: "extensions.list", directory: s.project })).toMatchObject({ ok: true, result: { extensions: [] } })
}, 10_000)
