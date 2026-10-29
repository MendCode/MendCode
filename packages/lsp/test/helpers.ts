import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach } from "bun:test"
import type { LspServerSpec } from "../src"

const dirs: string[] = []
export function setupLspTestCleanup() {
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
    for (const name of FAKE_VARS) delete process.env[name]
  })
}

export function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mendcode-lsp-")))
  dirs.push(dir)
  return dir
}

export function put({ root, path, content }: { root: string; path: string; content: string }): string {
  const full = join(root, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
  return full
}

export const FAKE_LSP = join(import.meta.dir, "fixtures", "fake-lsp.ts")

/** A registry entry whose server is the fake script, for the ".fake" extension. Configure it with FAKE_* env vars. */
export function fakeSpec(): LspServerSpec {
  return { id: "fake", command: [process.execPath, FAKE_LSP], extensions: [".fake"], rootMarkers: ["fake.marker"] }
}

const FAKE_VARS = ["FAKE_LOG", "FAKE_DOUBLE", "FAKE_CHUNKY", "FAKE_DELAY"]

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function until({ check, ms = 3000 }: { check: () => boolean; ms?: number }): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time")
    await Bun.sleep(20)
  }
}
