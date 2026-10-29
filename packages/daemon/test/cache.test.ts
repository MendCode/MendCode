import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { Command, Settings, createIdFactory, isReadOnlyCommand, type GlobalEvent } from "@mendcode/protocol"
import { startDaemon } from "../src"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })
function temp() { const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "mendd-b49-"))); cleanups.push(() => rmSync(directory, { recursive: true, force: true })); return directory }
async function boot(directory = temp()) {
  const events: GlobalEvent[] = []
  const daemon = await startDaemon({ dir: directory, socketPath: path.join(directory, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock }) })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "B49", onGlobal: (event) => events.push(event) })
  await client.connect()
  cleanups.push(() => client.close())
  return { daemon, client, directory, events }
}

test("B49 additive protocol validates targets; no cache config reads or mutations granted to read-only peers", () => {
  const ids = createIdFactory(), base = { id: ids("command"), clientId: ids("client") }
  const input = { action: "enable", directory: "/tmp/project" }
  expect(Command.safeParse({ ...base, type: "cache.set", input }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "cache.status", directory: "/tmp/project" }).success).toBe(true)
  for (const change of [{ model: "m" }, { projectPath: "/tmp/other" }, { session: "s", provider: "p" }, { scope: "unknown" }, { action: "reset" }, { unexpected: true }]) expect(Command.safeParse({ ...base, type: "cache.set", input: { ...input, ...change } }).success).toBe(false)
  expect(Settings.safeParse({ promptCache: "smart", cache: { mode: "off", providers: { openai: { models: ["exact"], exclude_models: ["other"] } } }, cacheProjects: { "/tmp/project": { sessions: { mode: "selected", include: ["s"] } } } }).success).toBe(true)
  expect(Settings.safeParse({ cache: { scope: "global" } }).success).toBe(false)
  expect(isReadOnlyCommand("cache.status")).toBe(false)
  expect(isReadOnlyCommand("cache.set")).toBe(false)
})

test("B49 client/daemon global and local controls persist, isolate projects and broadcast settings", async () => {
  const h = await boot(), a = path.join(h.directory, "a"), b = path.join(h.directory, "b")
  mkdirSync(a); mkdirSync(b)
  expect(await h.client.cacheStatus({ directory: a })).toMatchObject({ ok: true, report: { mode: "legacy", scope: "session", configured: null, activeKeeper: false } })
  expect(await h.client.setCache({ directory: a, global: true, action: "enable", provider: "openai", model: "m", scope: "project" })).toMatchObject({ ok: true, report: { global: { providers: { openai: { mode: "smart", scope: "project", models: ["m"] } } } } })
  expect(await h.client.cacheStatus({ directory: b, provider: "openai", model: "other" })).toMatchObject({ ok: true, report: { mode: "off", source: "model" } })
  expect(await h.client.setCache({ directory: a, action: "disable" })).toMatchObject({ ok: true, report: { mode: "off", local: { mode: "off" } } })
  expect(await h.client.cacheStatus({ directory: b, provider: "openai", model: "m" })).toMatchObject({ ok: true, report: { mode: "smart", scope: "project", local: null } })
  await h.client.setCache({ directory: b, global: true, action: "disable", projectPath: a })
  expect(await h.client.cacheStatus({ directory: a, global: true, provider: "openai", model: "m" })).toMatchObject({ ok: true, report: { mode: "off", source: "project" } })
  await h.client.setCache({ directory: b, action: "disable", session: "s1" })
  expect(await h.client.cacheStatus({ directory: b, session: "s1", provider: "openai", model: "m" })).toMatchObject({ ok: true, report: { mode: "off", source: "session" } })
  await h.client.setCache({ directory: b, action: "enable", session: "s1" })
  expect(await h.client.cacheStatus({ directory: b, session: "s2", provider: "openai", model: "m" })).toMatchObject({ ok: true, report: { mode: "off", source: "session" } })
  expect(await h.client.cacheStatus({ directory: b, session: "s1", provider: "openai", model: "m" })).toMatchObject({ ok: true, report: { mode: "smart" } })
  const invalid = await h.client.send({ type: "settings.set", patch: { cache: { mode: "typo" } } })
  expect(invalid).toMatchObject({ ok: false, error: { code: "invalid_command" } })
  expect(h.events.some((event) => event.type === "settings.changed" && (event.settings as Settings).cacheProjects?.[b]?.sessions?.include?.includes("s1"))).toBe(true)
  const before = await h.client.cacheStatus({ directory: b, session: "s1", provider: "openai", model: "m" })
  h.client.close(); await h.daemon.stop()
  const restarted = await boot(h.directory)
  expect(await restarted.client.cacheStatus({ directory: b, session: "s1", provider: "openai", model: "m" })).toEqual(before)
})

test("B49 unset structured policy preserves legacy promptCache controls and reset", async () => {
  const { client, directory } = await boot()
  await client.send({ type: "settings.set", patch: { promptCache: "off" } })
  expect(await client.cacheStatus({ directory })).toMatchObject({ ok: true, report: { mode: "off", reason: "promptCache compatibility setting" } })
  await client.send({ type: "settings.set", patch: { promptCache: null } })
  expect(await client.cacheStatus({ directory })).toMatchObject({ ok: true, report: { mode: "legacy" } })
})
