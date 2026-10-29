import { DEFAULT_SERVERS } from "../src/registry"
import { WEB_SERVERS } from "../src/web-presets"
import { FAKE_LSP, put } from "./helpers"

export function webFixture(directory: string, id: string) {
  const spec = WEB_SERVERS.find((server) => server.id === id)!
  const filePath = `src/${id}${spec.extensions[0]}`
  put({ root: directory, path: filePath, content: "function execute() {}\n" })
  if (spec.rootMarkers[0]) put({ root: directory, path: spec.rootMarkers[0], content: "{}" })
  put({ root: directory, path: ".mendcode/lsp.json", content: JSON.stringify({ servers: Object.fromEntries(DEFAULT_SERVERS.map((server) => [server.id, server.id === id ? { command: [process.execPath, FAKE_LSP] } : { disabled: true }])) }) })
  return { spec, filePath }
}
