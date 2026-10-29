import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach } from "bun:test"
import type { ToolContext } from "../src/tool"

const dirs: string[] = []

export function useTempDir(): () => string {
  let current = ""
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  return () => {
    current = mkdtempSync(join(tmpdir(), "mendcode-tools-"))
    dirs.push(current)
    return current
  }
}

export function makeContext({ cwd, signal, onOutput }: { cwd: string; signal?: AbortSignal; onOutput?: (chunk: string) => void }): ToolContext {
  const context: ToolContext = { cwd, signal: signal ?? new AbortController().signal }
  if (onOutput) context.onOutput = onOutput
  return context
}

export function put({ root, path, content }: { root: string; path: string; content: string | Uint8Array }): string {
  const full = join(root, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
  return full
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
