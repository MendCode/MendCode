import { expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createLspManager } from "../src"

test("B83 LSP status reports active roots and failures without probing or starting servers", async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "b83-lsp-")))
  writeFileSync(path.join(dir, "file.ts"), "const value = 1")
  let alive = true, starts = 0, loaded = 0
  const manager = createLspManager({ which: () => "/fixture/lsp", registryLoader: () => { loaded++; return { servers: [{ id: "local", command: ["fixture"], extensions: [".ts"], rootMarkers: [] }], issues: [], disableDownload: true } }, clientFactory: () => {
    starts++
    return { id: "local", pid: undefined, get alive() { return alive }, start: async () => {}, query: async () => [], sync: async () => ({ changed: false, after: 0 }), request: async () => [], current: () => undefined, waitForDiagnostics: async () => ({ diagnostics: [], settled: true }), stderr: () => "", close: async () => { alive = false } }
  } })
  try {
    expect(manager.status!(dir)).toEqual([])
    expect(loaded).toBe(0)
    await manager.query({ cwd: dir, filePath: "file.ts", operation: "hover", line: 1, character: 1 })
    expect(manager.status!(dir)).toEqual([{ id: "local", name: "local", root: dir, status: "connected" }])
    expect(manager.status!(path.join(dir, "nested"))).toHaveLength(1)
    expect(manager.status!(`${dir}-other`)).toEqual([])
    alive = false
    expect(manager.status!(dir)[0]?.status).toBe("error")
    expect(starts).toBe(1)
    await manager.stop()
    expect(manager.status!(dir)).toEqual([])
  } finally { await manager.stop(); rmSync(dir, { recursive: true, force: true }) }
})
