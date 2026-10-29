import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import type { SessionEvent, SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function until(check: () => boolean, ms = 3_000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition")
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe("settings", () => {
  test("settings.set pushes settings.changed to every terminal and new sessions start in the default permission mode", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-settings-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
    cleanups.push(() => daemon.stop())
    const seen: unknown[] = []
    const events: SessionEvent[] = []
    const other = createClient({ socketPath: daemon.socketPath, name: "B", onGlobal: (e) => void (e.type === "settings.changed" && seen.push(e.settings)) })
    const client = createClient({ socketPath: daemon.socketPath, name: "A", onEvent: (e) => void events.push(e) })
    await other.connect()
    await client.connect()
    cleanups.push(() => other.close(), () => client.close())
    expect(await client.send({ type: "settings.set", patch: { theme: "mint", defaultPermission: "edits" } })).toMatchObject({ ok: true })
    expect(await client.send({ type: "settings.set", patch: { view: "gigantic" } })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    await until(() => seen.length === 1)
    expect(seen[0]).toEqual({ theme: "mint", defaultPermission: "edits" })
    const created = await client.send({ type: "session.create", directory: "/repo", title: "" })
    const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
    await client.subscribe(sessionId, 0)
    await until(() => events.some((e) => e.type === "session.permission"))
    expect(events.find((e) => e.type === "session.permission")).toMatchObject({ mode: "edits" })
    expect(await client.send({ type: "settings.get" })).toMatchObject({ ok: true, result: { settings: { theme: "mint", defaultPermission: "edits" } } })
  })
})

test("ACP settings bridge persists config, merges entries and never returns env values", async () => {
  const { readFileSync, writeFileSync, statSync } = await import("node:fs")
  const { createAcpAgents } = await import("@mendcode/engine-acp")
  const dir = mkdtempSync(path.join(tmpdir(), "mendd-acp-settings-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, "acp-agents.json")
  writeFileSync(file, JSON.stringify({ old: { command: "old", env: { TOKEN: "private-value" } }, keep: { command: "keep" } }))
  const agents = createAcpAgents({ dir })
  expect(agents.get("old")?.command).toBe("old")
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanups.push(() => daemon.stop())
  const seen: unknown[] = []
  const client = createClient({ socketPath: daemon.socketPath, name: "ACP", onGlobal: (e) => { if (e.type === "settings.changed") seen.push(e.settings) } })
  await client.connect()
  cleanups.push(() => client.close())
  const initial = await client.send({ type: "settings.get" })
  expect(initial).toMatchObject({ ok: true, result: { settings: { acpAgents: { old: { envKeys: ["TOKEN"] } } } } })
  expect(JSON.stringify(initial)).not.toContain("private-value")
  const updated = await client.send({ type: "settings.set", patch: { acpAgents: { old: { command: "edited", args: ["--acp"], envKeys: ["TOKEN", "MENDCODE_TEST_MISSING_ENV"] }, added: { command: "new", args: [] } } } })
  expect(updated.ok).toBe(true)
  expect(JSON.stringify(updated)).not.toContain("private-value")
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ old: { command: "edited", args: ["--acp"], env: { TOKEN: "private-value", MENDCODE_TEST_MISSING_ENV: "${MENDCODE_TEST_MISSING_ENV}" } }, keep: { command: "keep" }, added: { command: "new", args: [] } })
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(agents.get("old")).toMatchObject({ command: "edited", env: { TOKEN: "private-value", MENDCODE_TEST_MISSING_ENV: "" } })
  expect(agents.models().some((m) => m.id === "acp:added")).toBe(true)
  const before = readFileSync(file, "utf8")
  expect(await client.send({ type: "settings.set", patch: { acpAgents: { bad: { command: "oops", env: { TOKEN: "secret" } } } } })).toMatchObject({ ok: false })
  expect(readFileSync(file, "utf8")).toBe(before)
  expect(await client.send({ type: "settings.set", patch: { acpAgents: { added: null } } })).toMatchObject({ ok: true })
  expect(agents.get("added")).toBeUndefined()
  await until(() => seen.length === 2)
  expect(JSON.stringify(seen)).not.toContain("private-value")
})
