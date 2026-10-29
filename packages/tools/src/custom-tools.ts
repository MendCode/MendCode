import { realpathSync } from "node:fs"
import { readdir, readFile, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { defaultLayers, layerAllows, type ExtensionLayer } from "@mendcode/packages"
import { z } from "zod"
import { compileArgsSchema, SchemaError } from "./json-schema"
import { runManaged } from "./process"
import { bindRenderTemplate } from "./render-bind"
import type { Tool, ToolResult } from "./tool"

/**
 * Custom tools: a JSON manifest in `.mendcode/tools/<name>.json` (project) or `<userDir>/tools/<name>.json` (user)
 * declares a command that runs as a subprocess with the arguments as JSON. Project code is never imported into the
 * daemon; project tools load only for trusted directories.
 */

export const CUSTOM_TOOL_PREFIX = "custom__"
export const DEFAULT_CUSTOM_TIMEOUT_MS = 120_000
export const MAX_CUSTOM_TIMEOUT_MS = 600_000
const NAME = /^[A-Za-z0-9_-]{1,40}$/
const MAX_MANIFEST_BYTES = 64 * 1024

const manifestSchema = z.strictObject({
  description: z.string().min(1).max(2_000),
  command: z.array(z.string().min(1)).min(1).max(50),
  input: z.enum(["stdin", "argv"]).optional(),
  args: z.unknown().optional(),
  timeoutMs: z.number().int().min(1).max(MAX_CUSTOM_TIMEOUT_MS).optional(),
  cwd: z.enum(["project", "tool"]).optional(),
  /** A renderSpec@1 template with {{args.…}} / {{result.…}} bindings; `result` is the tool's stdout parsed as JSON (or the raw text). */
  render: z.unknown().optional(),
})

/** A directory with symlinks resolved (macOS /tmp → /private/tmp), so trust matches however the path was spelled. */
export function canonicalDir(directory: string): string {
  const absolute = resolve(directory)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

export type CustomToolSource = "project" | "user"
export type CustomToolIssue = { file: string; message: string }

/** What `/tools` shows: enough to decide whether to trust a project's tools. */
export type CustomToolInfo = {
  name: string
  toolName: string
  description: string
  source: CustomToolSource
  file: string
  command: string[]
  /** User tools are always trusted; project tools follow the directory's trust. */
  trusted: boolean
  /** The package that ships the tool, if any. */
  pkg?: string
}

/** A Tool plus the manifest's cleaned JSON Schema, so the engine can send the real argument shape to the model. */
export interface CustomTool extends Tool {
  jsonSchema?: Record<string, unknown>
}

type Parsed = {
  info: Omit<CustomToolInfo, "trusted">
  manifestDir: string
  input: "stdin" | "argv"
  timeoutMs: number
  toolCwd: boolean
  zod: z.ZodType
  json: Record<string, unknown>
  render?: unknown
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

async function parseManifest({ file, name, source, pkg }: { file: string; name: string; source: CustomToolSource; pkg?: string | undefined }): Promise<Parsed | CustomToolIssue> {
  const issue = (message: string): CustomToolIssue => ({ file, message })
  let text: string
  try {
    if ((await stat(file)).size > MAX_MANIFEST_BYTES) return issue(`manifest is larger than ${MAX_MANIFEST_BYTES / 1024} KB`)
    text = await readFile(file, "utf8")
  } catch (error) {
    return issue(`cannot read manifest: ${(error as Error).message}`)
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    return issue(`invalid JSON: ${(error as Error).message}`)
  }
  const parsed = manifestSchema.safeParse(json)
  if (!parsed.success) return issue(`invalid manifest: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`)
  let compiled
  try {
    compiled = compileArgsSchema(parsed.data.args)
  } catch (error) {
    if (error instanceof SchemaError) return issue(`invalid args schema: ${error.message}`)
    throw error
  }
  const manifestDir = dirname(file)
  return {
    info: { name, toolName: `${CUSTOM_TOOL_PREFIX}${name}`, description: parsed.data.description, source, file, command: parsed.data.command, ...(pkg ? { pkg } : {}) },
    manifestDir,
    input: parsed.data.input ?? "stdin",
    timeoutMs: parsed.data.timeoutMs ?? DEFAULT_CUSTOM_TIMEOUT_MS,
    toolCwd: parsed.data.cwd === "tool",
    zod: compiled.zod,
    json: compiled.json,
    ...(parsed.data.render !== undefined ? { render: parsed.data.render } : {}),
  }
}

/** The tool's stdout as JSON when it is JSON, else the text itself (bound as `result`). */
function resultValue(output: string): unknown {
  const trimmed = output.trim()
  if (!/^[[{]/.test(trimmed)) return trimmed
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return trimmed
  }
}

/** Builds the runnable Tool; always `execute` permission (approval in ask/edits modes, denied in plan mode). */
function buildTool({ parsed, directory }: { parsed: Parsed; directory: string }): CustomTool {
  const { info } = parsed
  return {
    name: info.toolName,
    description: `[custom:${info.source}] ${info.description}`,
    permission: "execute",
    args: parsed.zod,
    jsonSchema: parsed.json,
    async execute(args, context): Promise<ToolResult> {
      const title = clip(`${info.name}`, 60)
      if (context.signal.aborted) return { output: "cancelled", truncated: false, title, isError: true }
      const payload = JSON.stringify(args ?? {})
      // "./x" anywhere in the command means the tool's own folder (["bun", "./run.ts"] as much as ["./run.sh"]).
      const argv = [...info.command.map((part) => (/^\.{1,2}[\\/]/.test(part) ? resolve(parsed.manifestDir, part) : part)), ...(parsed.input === "argv" ? [payload] : [])]
      const result = await runManaged({
        argv,
        cwd: parsed.toolCwd ? parsed.manifestDir : directory,
        env: { ...process.env, PAGER: "cat", GIT_PAGER: "cat", TERM: "dumb", MENDCODE_PROJECT_DIR: directory, MENDCODE_TOOL_DIR: parsed.manifestDir, MENDCODE_TOOL_NAME: info.name },
        ...(parsed.input === "stdin" ? { stdin: `${payload}\n` } : {}),
        timeoutMs: parsed.timeoutMs,
        signal: context.signal,
        ...(context.onOutput ? { onOutput: context.onOutput } : {}),
      })
      const meta = { tool: info.name, exitCode: result.exitCode, timedOut: result.timedOut, cancelled: result.cancelled, durationMs: result.durationMs }
      if (result.spawnError) return { output: result.spawnError, truncated: false, title, isError: true, meta }
      const note = result.timedOut ? `[timed out after ${parsed.timeoutMs} ms]` : result.cancelled ? "[cancelled]" : ""
      const output = note ? `${result.output}${result.output ? "\n" : ""}${note}` : result.output
      const isError = result.exitCode !== 0 || result.timedOut || result.cancelled
      const render = parsed.render !== undefined && !isError ? bindRenderTemplate(parsed.render, { args: args ?? {}, result: resultValue(result.output) }) : undefined
      return { output, truncated: result.truncated, title, isError, meta, ...(render !== undefined ? { render } : {}) }
    },
  }
}

/** One manifest file as a runnable tool (tool_define's test run), or the problem that makes it invalid. */
export async function loadCustomToolFile(input: { file: string; name: string; source: CustomToolSource; directory: string }): Promise<CustomTool | CustomToolIssue> {
  if (!NAME.test(input.name)) return { file: input.file, message: "tool names use letters, digits, _ and - (max 40)" }
  const parsed = await parseManifest(input)
  return "message" in parsed ? parsed : buildTool({ parsed, directory: resolve(input.directory) })
}

export const CUSTOM_TOOL_NAME = NAME

async function manifestFiles(directory: string): Promise<Array<{ file: string; name: string; signature: string }>> {
  let names: string[]
  try {
    names = (await readdir(directory)).filter((entry) => entry.endsWith(".json")).sort()
  } catch {
    return []
  }
  const found: Array<{ file: string; name: string; signature: string }> = []
  for (const entry of names) {
    const file = join(directory, entry)
    const info = await stat(file).catch(() => undefined)
    if (info?.isFile()) found.push({ file, name: entry.slice(0, -".json".length), signature: `${file}:${info.mtimeMs}:${info.size}` })
  }
  return found
}

export type CustomToolRegistry = {
  /** Every discovered tool (untrusted project tools included, flagged) and every problem found. */
  list(directory: string): Promise<{ tools: CustomToolInfo[]; issues: CustomToolIssue[] }>
  /** The runnable tools for a project root: user tools plus the project's when its directory is trusted. */
  tools(directory: string): Promise<CustomTool[]>
}

/**
 * Discovery per project root, cached by the manifests' mtimes so a turn costs a directory listing when nothing changed.
 * Each extension layer's `tools/` is read in order and a later layer wins on the same name (project `.mendcode/tools`
 * last). Failures are reported as issues, never thrown.
 */
export function createCustomToolRegistry({ userDir, trustedDirs, layers }: { userDir: string; trustedDirs: () => readonly string[]; layers?: (directory: string) => ExtensionLayer[] }): CustomToolRegistry {
  const cache = new Map<string, { signature: string; parsed: Parsed[]; issues: CustomToolIssue[] }>()
  const layersFor = layers ?? ((directory: string) => defaultLayers({ userDir, directory }))

  async function scan(directory: string) {
    const root = resolve(directory)
    const found = await Promise.all(layersFor(root).map(async (layer) => ({ layer, files: (await manifestFiles(join(layer.dir, "tools"))).filter((file) => layerAllows(layer, "tools", file.name)) })))
    const signature = found.flatMap(({ files }) => files.map((f) => f.signature)).join("\n")
    const cached = cache.get(root)
    if (cached?.signature === signature) return cached
    const parsed = new Map<string, Parsed>()
    const issues: CustomToolIssue[] = []
    for (const { layer, files } of found) {
      for (const { file, name } of files) {
        if (!NAME.test(name)) {
          issues.push({ file, message: "tool names use letters, digits, _ and - (max 40)" })
          continue
        }
        const result = await parseManifest({ file, name, source: layer.source, pkg: layer.pkg }).catch((error): CustomToolIssue => ({ file, message: errorText(error) }))
        if ("message" in result) issues.push(result)
        else parsed.set(name, result)
      }
    }
    const entry = { signature, parsed: [...parsed.values()], issues }
    cache.set(root, entry)
    return entry
  }

  const isTrusted = (directory: string) => {
    const canonical = canonicalDir(directory)
    return trustedDirs().some((trusted) => trusted === canonical || canonicalDir(trusted) === canonical)
  }
  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

  return {
    async list(directory) {
      const { parsed, issues } = await scan(directory)
      const trusted = isTrusted(directory)
      return { tools: parsed.map((p) => ({ ...p.info, trusted: p.info.source === "user" || trusted })), issues }
    },
    async tools(directory) {
      const { parsed } = await scan(directory)
      const trusted = isTrusted(directory)
      return parsed.filter((p) => p.info.source === "user" || trusted).map((p) => buildTool({ parsed: p, directory: resolve(directory) }))
    },
  }
}

