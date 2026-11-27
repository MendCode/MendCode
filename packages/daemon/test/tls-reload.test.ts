import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import type { FSWatcher } from "node:fs"
import { watchTlsFiles } from "../src/tls-reload"

/** Waits for the renewal to be seen, as long as it takes (a loaded runner is slow), instead of for a fixed time. */
async function seen(changed: () => number) {
  const deadline = Date.now() + 15_000
  while (changed() === 0 && Date.now() < deadline) await Bun.sleep(10)
}

function certFolder() {
  const dir = mkdtempSync(path.join(tmpdir(), "mendtest-tls-"))
  writeFileSync(path.join(dir, "cert.pem"), "one")
  writeFileSync(path.join(dir, "key.pem"), "one")
  return dir
}

test("a folder watcher error (Linux ENXIO from a unix socket beside the certificate) does not escape, and a replaced certificate is still seen", async () => {
  const dir = certFolder()
  const watcher = Object.assign(new EventEmitter(), { close() {} })
  let changed = 0
  const handle = watchTlsFiles({
    files: [path.join(dir, "cert.pem"), path.join(dir, "key.pem")], debounceMs: 1, pollMs: 20, changed: () => { changed++ },
    watchFolder: () => watcher as unknown as FSWatcher,
  })
  try {
    const enxio = Object.assign(new Error("ENXIO: no such device or address, open 'mendd.sock'"), { code: "ENXIO" })
    expect(() => watcher.emit("error", enxio)).not.toThrow()
    writeFileSync(path.join(dir, "cert.pem.new"), "renewed")
    renameSync(path.join(dir, "cert.pem.new"), path.join(dir, "cert.pem"))
    await seen(() => changed)
    expect(changed).toBeGreaterThan(0)
  } finally { handle.close(); rmSync(dir, { recursive: true, force: true }) }
})

test("a real unix socket in the certificate folder does not stop a renewal from being seen", async () => {
  const dir = certFolder()
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(path.join(dir, "mendd.sock"), resolve))
  let changed = 0
  const handle = watchTlsFiles({ files: [path.join(dir, "cert.pem"), path.join(dir, "key.pem")], debounceMs: 1, pollMs: 20, changed: () => { changed++ } })
  try {
    writeFileSync(path.join(dir, "cert.pem.new"), "renewed")
    renameSync(path.join(dir, "cert.pem.new"), path.join(dir, "cert.pem"))
    await seen(() => changed)
    expect(changed).toBeGreaterThan(0)
  } finally { handle.close(); server.close(); rmSync(dir, { recursive: true, force: true }) }
})
