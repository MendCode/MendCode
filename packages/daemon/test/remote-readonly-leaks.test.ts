import { afterEach, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { isReadOnlyCommand, type GlobalEvent } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { createProviderService } from "../src/providers"
import { remoteTokens } from "../src/remote"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const credential = `sk-proj-${"a1B2c3D4".repeat(5)}`

async function boot() {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-readonly-leaks-")), project = path.join(dir, "project")
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(project)
  const providerFile = path.join(dir, "providers.json")
  writeFileSync(providerFile, JSON.stringify({ providers: { openai: { apiKey: credential } } }))
  chmodSync(providerFile, 0o644)
  const initialized = Bun.spawnSync(["git", "init", "-q", project])
  if (initialized.exitCode) throw new Error(initialized.stderr.toString())
  writeFileSync(path.join(project, "untracked-credential.txt"), `API_KEY=${credential}\n`)
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), listen: "127.0.0.1:0", providers: createProviderService({ dir, env: {} }), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanups.push(() => daemon.stop())
  const written: GlobalEvent[] = [], observed: GlobalEvent[] = []
  const writer = createClient({ socketPath: daemon.socketPath, name: "local-leaks", onGlobal: (event) => { written.push(event) } })
  cleanups.push(() => writer.close())
  await writer.connect()
  const token = remoteTokens(dir).create({ name: "observer", readOnly: true }).token
  const reader = createClient({ name: "observer", remote: { hostname: "127.0.0.1", port: daemon.remotePort!, token }, onGlobal: (event) => { observed.push(event) } })
  cleanups.push(() => reader.close())
  await reader.connect()
  return { writer, reader, project, written, observed, providerFile }
}

test("providers.list for a read-only peer leaves the provider file alone and shows no part of a key", async () => {
  const h = await boot()
  const denied = await h.reader.send({ type: "providers.list" })
  expect(denied.ok).toBe(true)
  expect(JSON.stringify(denied)).not.toContain("keyTail")
  expect(JSON.stringify(denied)).not.toContain(credential.slice(-4))
  expect(statSync(h.providerFile).mode & 0o777).toBe(0o644)
  const local = await h.writer.send({ type: "providers.list" })
  expect(JSON.stringify(local)).toContain("keyTail")
})

test("a read-only peer is not sent the full settings, which can carry proxy credentials and provider parameters", async () => {
  const h = await boot()
  const set = await h.writer.send({ type: "settings.set", patch: { proxy: { url: `http://user:${credential}@proxy.example.test:8080` }, models: { main: { model: "scripted", parameters: { metadata: { apiKey: credential } } } } } })
  expect(set.ok).toBe(true)
  for (let wait = 0; wait < 50 && !h.written.some((event) => event.type === "settings.changed"); wait++) await Bun.sleep(20)
  expect(h.written.some((event) => event.type === "settings.changed" && JSON.stringify(event).includes(credential))).toBe(true)
  await Bun.sleep(100)
  expect(h.observed.some((event) => event.type === "settings.changed")).toBe(false)
  expect(JSON.stringify(h.observed)).not.toContain(credential)
})

test("working-tree contents and scratchpad notes of any directory require a full-access peer", async () => {
  const h = await boot()
  expect((await h.writer.send({ type: "scratchpad.set", directory: h.project, text: `note ${credential}` })).ok).toBe(true)
  const commands = [
    { type: "changes.query", directory: h.project },
    { type: "changes.file", directory: h.project, path: "untracked-credential.txt" },
    { type: "scratchpad.get", directory: h.project },
  ] as const
  for (const command of commands) {
    const local = await h.writer.send(command)
    expect(local.ok).toBe(true)
    expect(JSON.stringify(local)).toContain(credential)
    expect(isReadOnlyCommand(command.type)).toBe(false)
    const denied = await h.reader.send(command)
    expect(denied).toMatchObject({ ok: false, error: { code: "forbidden" } })
    expect(JSON.stringify(denied)).not.toContain(credential)
  }
})
