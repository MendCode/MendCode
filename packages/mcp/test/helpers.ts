import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach } from "bun:test"
import type { McpServerConfig } from "../src"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mendcode-mcp-"))
  dirs.push(dir)
  return dir
}

export function put({ root, path, content }: { root: string; path: string; content: string }): string {
  const full = join(root, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
  return full
}

export const FAKE_SERVER = join(import.meta.dir, "fixtures", "fake-server.ts")

export function fakeConfig(extra: Partial<McpServerConfig> = {}): McpServerConfig {
  return { command: process.execPath, args: [FAKE_SERVER], ...extra }
}

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
