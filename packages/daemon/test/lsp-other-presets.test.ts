import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createLspManager, OTHER_SERVERS, serverRoot } from "@mendcode/lsp"
import { otherFixture } from "../../lsp/test/other-fixtures"
import { startDaemon } from "../src"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

test.each(OTHER_SERVERS.map((spec) => spec.id))("B12 %s installed preset serves the typed client through daemon routing", async (id) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mendd-b12-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const { spec, filePath } = otherFixture(dir, id)
  const lsp = createLspManager({ which: () => null })
  cleanups.push(() => lsp.stop())
  const daemon = await startDaemon({ dir, socketPath: join(dir, "daemon.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), lsp })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "b12-test", reconnect: false })
  cleanups.push(() => client.close())
  await client.connect()
  expect(await client.lsp({ directory: dir, operation: "hover", filePath, line: 1, character: 1 })).toMatchObject({ ok: true, report: { result: [{ contents: { value: "function execute(): Promise<void>" } }] } })
  expect(lsp.running()).toMatchObject([{ server: id, root: await serverRoot({ file: join(dir, filePath), cwd: dir, spec }) }])
  expect(await client.lsp({ directory: dir, operation: "hover", filePath: "../outside", line: 1, character: 1 })).toMatchObject({ ok: true, report: { unavailable: "file is outside the project" } })
})
