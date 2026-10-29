import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createLspManager } from "@mendcode/lsp"
import { startDaemon } from "../src"
import { WEB_SERVERS } from "../../lsp/src/web-presets"
import { webFixture } from "../../lsp/test/web-fixtures"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function boot(enabled = true, presetId?: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mendd-lsp-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, "app.fake"), "function execute() {}")
  const fixture = presetId ? webFixture(dir, presetId) : undefined
  const lsp = createLspManager({ which: () => null, ...(!fixture ? { registryLoader: () => ({ servers: [{ id: "fake", command: [process.execPath, join(import.meta.dir, "../../lsp/test/fixtures/fake-lsp.ts")], extensions: [".fake"], rootMarkers: [] }], issues: [] }) } : {}) })
  cleanups.push(() => lsp.stop())
  const daemon = await startDaemon({ dir, socketPath: join(dir, "daemon.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), ...(enabled ? { lsp } : {}) })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "lsp-test", reconnect: false })
  await client.connect()
  cleanups.push(() => client.close())
  return { dir, lsp, client, filePath: fixture?.filePath ?? "app.fake" }
}

test("client → daemon → local server transports all nine semantic operations", async () => {
  const { dir, client, lsp } = await boot()
  for (const operation of ["goToDefinition", "findReferences", "hover", "documentSymbol", "workspaceSymbol", "goToImplementation", "prepareCallHierarchy", "incomingCalls", "outgoingCalls"] as const) {
    const reply = await client.lsp({ operation, directory: dir, filePath: "app.fake", line: 1, character: 10 })
    expect(reply.ok).toBe(true)
    if (reply.ok) {
      expect(reply.report.unavailable).toBeUndefined()
      expect(reply.report.result.length).toBeGreaterThan(0)
    }
  }
  expect(lsp.running()).toHaveLength(1)
})

test("LSP unavailable/errors pass through typed replies without crashing the daemon", async () => {
  const { dir, client } = await boot()
  expect(await client.lsp({ operation: "hover", directory: dir, filePath: "missing.fake", line: 1, character: 1 })).toMatchObject({ ok: true, report: { unavailable: expect.stringContaining("cannot read") } })
  expect(await client.lsp({ operation: "workspaceSymbol", directory: dir, filePath: "app.fake", line: 1, character: 1, query: "__error__" })).toMatchObject({ ok: true, report: { result: [], unavailable: "fake: Unsupported operation" } })
  expect(await client.send({ type: "daemon.info" })).toMatchObject({ ok: true })
})

test("a daemon without LSP support explicitly refuses the command", async () => {
  const { dir, client } = await boot(false)
  expect(await client.lsp({ operation: "hover", directory: dir, filePath: "app.fake", line: 1, character: 1 })).toMatchObject({ ok: false, error: { code: "invalid_command", message: "[DAEMON]: LSP is not available" } })
})

test.each(WEB_SERVERS.map((spec) => spec.id))("B11 %s preset is available through the existing typed client/daemon command", async (id) => {
  const { dir, client, lsp, filePath } = await boot(true, id)
  const reply = await client.lsp({ operation: "hover", directory: dir, filePath, line: 1, character: 1 })
  expect(reply).toMatchObject({ ok: true, report: { result: [{ contents: { value: "function execute(): Promise<void>" } }] } })
  expect(lsp.running()).toMatchObject([{ server: id, root: dir }])
})
