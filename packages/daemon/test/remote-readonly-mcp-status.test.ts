import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { startDaemon } from "../src"
import { remoteTokens } from "../src/remote"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const credential = `sk-proj-${"a1B2c3D4".repeat(5)}`

test("mcp.status never hands a server's credentials, from its command line or stderr tail, to a read-only peer", async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-readonly-mcp-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const project = path.join(dir, "project")
  mkdirSync(project)
  const daemon = await startDaemon({
    dir, socketPath: path.join(dir, "mendd.sock"), listen: "127.0.0.1:0",
    mcp: {
      status: async () => ({ servers: [{ name: "docs", command: `docs-server --api-key ${credential}`, enabled: true, state: "failed", tools: 0, lastError: `401 for Bearer ${credential}`, stderr: [`using token ${credential}`, `API_KEY=${credential}`] }], issues: [{ source: "project", server: "docs", message: `bad key ${credential}` }] }),
      restart: async () => { throw new Error("unused") },
    },
    engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }),
  })
  cleanups.push(() => daemon.stop())
  const writer = createClient({ socketPath: daemon.socketPath, name: "local" })
  await writer.connect()
  cleanups.push(() => writer.close())
  expect((await writer.send({ type: "session.create", directory: project })).ok).toBe(true)
  const token = remoteTokens(dir).create({ name: "observer", readOnly: true }).token
  const reader = createClient({ name: "observer", remote: { hostname: "127.0.0.1", port: daemon.remotePort!, token } })
  await reader.connect()
  cleanups.push(() => reader.close())
  const reply = await reader.send({ type: "mcp.status", directory: project })
  expect(reply.ok).toBe(true)
  expect(JSON.stringify(reply)).not.toContain(credential)
  expect(JSON.stringify(reply)).toContain("docs-server")
})
