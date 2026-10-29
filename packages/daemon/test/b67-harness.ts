import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createLspManager } from "@mendcode/lsp"
import { read, write } from "@mendcode/tools"
import { startDaemon } from "../src"

export async function b67Harness() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "mend-b67-")))
  const dir = path.join(root, "data"), project = path.join(root, "project")
  mkdirSync(dir); mkdirSync(project)
  const put = (file: string, text: string) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text) }
  put(path.join(project, "src", "app.fake"), "function execute() {}\nERROR\n")
  put(path.join(project, "README.md"), "Project notes\n")
  const lsp = createLspManager({ settleMs: 10, registryLoader: () => ({ servers: [{ id: "fake", command: [process.execPath, path.join(import.meta.dir, "../../lsp/test/fixtures/fake-lsp.ts")], extensions: [".fake"], rootMarkers: [] }], issues: [], disableDownload: true }) })
  const daemon = await startDaemon({ dir, defaultDirectory: project, socketPath: path.join(dir, "mendd.sock"), lsp, info: { engine: "faux" }, log: () => {}, engine: ({ clock, extensions }) => { extensions.setBuiltinTools([read, write]); return createFauxEngine({ clock }) } })
  const client = createClient({ socketPath: daemon.socketPath, name: "b67", reconnect: false })
  await client.connect()
  return { dir, project, root, client, put, lsp, async cleanup() { client.close(); await daemon.stop(); await lsp.stop(); rmSync(root, { recursive: true, force: true }) } }
}
export type B67Harness = Awaited<ReturnType<typeof b67Harness>>
