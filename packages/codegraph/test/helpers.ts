import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach } from "bun:test"
import { parseRenderSpec } from "@mendcode/protocol"
import type { Tool, ToolResult } from "@mendcode/tools"
import { createCodeGraphTools, type CodeGraphOptions } from "../src"

const dirs: string[] = []

export function useTempDirs(): () => string {
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  return () => {
    const dir = mkdtempSync(join(tmpdir(), "mendcode-codegraph-"))
    dirs.push(dir)
    return dir
  }
}

/** Writes files (path -> content) under root and returns root. */
export function project({ root, files }: { root: string; files: Record<string, string> }): string {
  for (const [path, content] of Object.entries(files)) put({ root, path, content })
  return root
}

export function put({ root, path, content, mtime }: { root: string; path: string; content: string; mtime?: number }): string {
  const full = join(root, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
  if (mtime !== undefined) utimesSync(full, mtime / 1000, mtime / 1000)
  return full
}

export type Harness = {
  root: string
  cacheDir: string
  scans: string[]
  tools: Record<string, Tool>
  call(name: string, args: unknown, signal?: AbortSignal): Promise<ToolResult>
  /** A second tool set over the same cache dir, as after a restart. */
  restart(): Harness
}

export function harness({ root, cacheDir, options = {} }: { root: string; cacheDir: string; options?: Partial<CodeGraphOptions> }): Harness {
  const scans: string[] = []
  const list = createCodeGraphTools({ cacheDir, now: () => 1_700_000_000_000, onScan: (path) => scans.push(path), ...options })
  const tools = Object.fromEntries(list.map((tool) => [tool.name, tool]))
  return {
    root,
    cacheDir,
    scans,
    tools,
    async call(name, args, signal) {
      const tool = tools[name] as Tool
      const parsed = tool.args.parse(args)
      return tool.execute(parsed, { cwd: root, signal: signal ?? new AbortController().signal })
    },
    restart: () => harness({ root, cacheDir, options }),
  }
}

/** The result's render spec must be accepted by the protocol's validator. */
export function expectValidRender(result: ToolResult): unknown {
  const parsed = parseRenderSpec(result.render)
  if (!parsed.ok) throw new Error(`invalid render spec: ${parsed.error}`)
  return parsed.spec
}
