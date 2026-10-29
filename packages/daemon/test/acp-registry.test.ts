import { afterEach, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { Command, createIdFactory, isReadOnlyCommand, type SessionId } from "@mendcode/protocol"
import { featureOn } from "@mendcode/protocol/wire"
import { createAcpSettings } from "../../store/src/acp-settings"
import { createAcpRegistry } from "../src/acp-registry"
import { startDaemon } from "../src"
import { remoteTokens } from "../src/remote"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function temp() {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-acp-registry-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test("offline catalog checks actual executables without running them and preserves config/env", () => {
  const dir = temp()
  const marker = path.join(dir, "executed")
  const binary = path.join(dir, "gemini")
  writeFileSync(binary, `#!/bin/sh\ntouch '${marker}'\n`)
  chmodSync(binary, 0o700)
  const file = path.join(dir, "acp-agents.json")
  const original = { custom: { command: "custom", args: ["--stdio"], env: { TOKEN: "private-value" } } }
  writeFileSync(file, JSON.stringify(original))
  const bridge = createAcpSettings(dir)
  const checked: string[] = []
  const registry = createAcpRegistry({ settings: () => ({ acpAgents: bridge.get() }), save: (patch) => { bridge.prepare(patch.acpAgents)(); return { acpAgents: bridge.get() } }, which: (command) => { checked.push(command); return Bun.which(command, { PATH: dir }) } })
  const agents = registry.list().agents
  expect(agents.map((entry) => entry.id)).toEqual(["gemini", "devin", "cline", "kimi", "droid", "codex-acp", "opencode", "claude-code-acp"])
  expect(checked).toHaveLength(8)
  expect(agents.filter((entry) => entry.installed).map((entry) => entry.id)).toEqual(["gemini"])
  expect(existsSync(marker)).toBe(false)
  expect(agents.every((entry) => entry.install && entry.website.startsWith("https://"))).toBe(true)
  registry.add("droid") // missing binaries can be configured before manual installation
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ...original, droid: { command: "droid", args: ["exec", "--output-format", "acp-daemon"] } })
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(JSON.stringify(registry.list())).not.toContain("private-value")
  const before = readFileSync(file, "utf8")
  expect(() => registry.add("droid")).toThrow("already configured")
  expect(() => registry.add("evil; sh")).toThrow("Unknown")
  expect(readFileSync(file, "utf8")).toBe(before)
  writeFileSync(file, "invalid json")
  expect(() => registry.add("gemini")).toThrow("repair")
  expect(readFileSync(file, "utf8")).toBe("invalid json")
})

test("protocol is strict, full-tier, opt-in without a tier, and not read-only remote", () => {
  const ids = createIdFactory()
  const base = { type: "acp.registry", id: ids("command"), clientId: ids("client") }
  expect(Command.safeParse({ ...base, operation: "list" }).success).toBe(true)
  expect(Command.safeParse({ ...base, operation: "add" }).success).toBe(false)
  expect(Command.safeParse({ ...base, operation: "add", agentId: "gemini", command: "sh" }).success).toBe(false)
  expect(isReadOnlyCommand("acp.registry")).toBe(false)
  for (const tier of [undefined, "minimalist", "balanced"] as const) expect(featureOn({ tier }, "acp_registry")).toBe(false)
  expect(featureOn({ tier: "full" }, "acp_registry")).toBe(true)
  expect(featureOn({ features: { acp_registry: true } }, "acp_registry")).toBe(true)
  expect(featureOn({ tier: "full" }, "acp_registry", { safeMode: true })).toBe(false)
})

test("daemon lists/adds locally, persists across restart and refuses remote PATH/config/turns", async () => {
  const dir = temp()
  const boot = async () => {
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), listen: "127.0.0.1:0", engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
    cleanups.push(() => daemon.stop())
    const local = createClient({ name: "registry-test", socketPath: daemon.socketPath, reconnect: false })
    cleanups.push(() => local.close())
    await local.connect()
    return { daemon, local }
  }
  const { daemon, local } = await boot()
  expect(await local.send({ type: "acp.registry", operation: "list" })).toMatchObject({ ok: false, error: { code: "forbidden" } })
  expect((await local.send({ type: "settings.set", patch: { tier: "full" } })).ok).toBe(true)
  expect(await local.send({ type: "acp.registry", operation: "list" })).toMatchObject({ ok: true, result: { agents: expect.any(Array) } })
  const added = await local.send({ type: "acp.registry", operation: "add", agentId: "gemini" })
  expect(added).toMatchObject({ ok: true, result: { settings: { acpAgents: { gemini: { command: "gemini", args: ["--acp"] } } } } })
  expect(await local.send({ type: "acp.registry", operation: "add", agentId: "gemini" })).toMatchObject({ ok: false })
  const token = remoteTokens(dir).create({ name: "peer" }).token
  const remote = createClient({ name: "registry-peer", remote: { hostname: "127.0.0.1", port: daemon.remotePort!, token }, reconnect: false })
  cleanups.push(() => remote.close())
  await remote.connect()
  for (const operation of ["list", "add"] as const) expect(await remote.send({ type: "acp.registry", operation, agentId: "cline" })).toMatchObject({ ok: false, error: { code: "forbidden" } })
  expect(await remote.send({ type: "settings.set", patch: { acpAgents: { evil: { command: "sh" } } } })).toMatchObject({ ok: false, error: { code: "forbidden" } })
  const created = await local.send({ type: "session.create", directory: dir })
  if (!created.ok) throw new Error("session failed")
  const sessionId = created.result!.sessionId as SessionId
  expect(await remote.send({ type: "user.submit", sessionId, text: "no execution", attachments: [], selection: { model: { model: "acp:gemini" } } })).toMatchObject({ ok: false, error: { code: "forbidden" } })
  local.close()
  remote.close()
  await daemon.stop()
  const restarted = await boot()
  const settings = await restarted.local.send({ type: "settings.get" })
  expect(settings).toMatchObject({ ok: true, result: { settings: { acpAgents: { gemini: { command: "gemini", args: ["--acp"] } } } } })
})
