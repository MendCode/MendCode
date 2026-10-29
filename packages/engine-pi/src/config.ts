import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { sandboxCommand, type SandboxBackend, type SandboxPolicy } from "@mendcode/tools"
import type { ModelInfo } from "@mendcode/protocol"
import { z } from "zod"

export const PI_CONFIG_FILE = "pi.json"
/** The catalog id of "whatever model pi is set to use"; other models are `pi:<pattern>`. */
export const PI_DEFAULT_MODEL = "pi"
export const PI_MODEL_PREFIX = "pi:"

const EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const

export const piConfigSchema = z.object({
  /** The pi executable, looked up in PATH. */
  command: z.string().min(1).optional(),
  /** Extra arguments after `--mode rpc` (for example `--no-skills`), before MendCode's safety flags. */
  args: z.array(z.string()).optional(),
  /** Extra environment for the process. A value of the form `${NAME}` is read from the daemon's environment. */
  env: z.record(z.string(), z.string()).optional(),
  /** Models offered in /model as `pi:<pattern>`, each a `--model` pattern of pi (`provider/id`, optional `:thinking`). */
  models: z.array(z.string().min(1).max(80)).optional(),
  /** `--session-dir`: where pi keeps its session files. pi's own default when absent. */
  sessionDir: z.string().min(1).optional(),
})
export type PiConfig = z.infer<typeof piConfigSchema>
export type ResolvedPiConfig = { command: string; args: string[]; env: Record<string, string>; sessionDir?: string }

export type LoadedPiConfig = { present: boolean; config: PiConfig; issues: string[] }

/** Parses the text of `pi.json`. Opting in is the file's existence: `{}` is enough. */
export function parsePiConfig(text: string): LoadedPiConfig {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    return { present: true, config: {}, issues: [`${PI_CONFIG_FILE}: invalid JSON: ${(error as Error).message}`] }
  }
  const parsed = piConfigSchema.safeParse(json)
  if (!parsed.success) return { present: true, config: {}, issues: [`${PI_CONFIG_FILE}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}`] }
  return { present: true, config: parsed.data, issues: [] }
}

export interface PiConfigSource {
  /** The file's content, re-read when it changes. `present` is false when there is no `pi.json`. */
  load(): LoadedPiConfig
  /** The command, arguments and environment to start pi with. */
  resolved(): ResolvedPiConfig
  /** Catalog entries: pi's own model plus one per configured pattern. Empty when the file is absent or invalid. */
  models(): ModelInfo[]
  /** The `--model` pattern of a catalog id; undefined for pi's own model and for ids that are not pi's. */
  patternOf(modelId: string | undefined): string | undefined
  /** True for `pi` and `pi:<pattern>` of a configured pattern. */
  owns(modelId: string | undefined): boolean
}

/**
 * `<dataDir>/pi.json`, cached by modification time so an edit applies to the next turn without a restart. Opting in is the
 * file's existence, or `optedIn()` (the `features.pi` setting) for the defaults with no file. Without either, pi is not offered.
 */
export function createPiConfig({ dir, optedIn }: { dir: string; optedIn?(): boolean }): PiConfigSource {
  const file = join(dir, PI_CONFIG_FILE)
  let cached: { stamp: string; loaded: LoadedPiConfig } | undefined
  const absent: LoadedPiConfig = { present: false, config: {}, issues: [] }

  function load(): LoadedPiConfig {
    let stamp: string
    try {
      const info = statSync(file)
      stamp = `${info.mtimeMs}:${info.size}`
    } catch {
      cached = undefined
      return absent
    }
    if (cached?.stamp === stamp) return cached.loaded
    let loaded: LoadedPiConfig
    try {
      loaded = parsePiConfig(readFileSync(file, "utf8"))
    } catch (error) {
      loaded = { present: true, config: {}, issues: [`${PI_CONFIG_FILE}: cannot read file: ${(error as Error).message}`] }
    }
    cached = { stamp, loaded }
    return loaded
  }

  const usable = (): PiConfig | undefined => {
    const loaded = load()
    if (!loaded.present) return optedIn?.() === true ? {} : undefined
    return loaded.issues.length === 0 ? loaded.config : undefined
  }

  function patternOf(modelId: string | undefined): string | undefined {
    if (!modelId?.startsWith(PI_MODEL_PREFIX)) return undefined
    const pattern = modelId.slice(PI_MODEL_PREFIX.length)
    return usable()?.models?.includes(pattern) ? pattern : undefined
  }

  return {
    load,
    resolved() {
      const config = usable() ?? {}
      const env = Object.fromEntries(Object.entries(config.env ?? {}).map(([key, value]) => {
        const reference = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)
        return [key, reference ? process.env[reference[1]!] ?? "" : value]
      }))
      return { command: config.command ?? "pi", args: config.args ?? [], env, ...(config.sessionDir ? { sessionDir: config.sessionDir } : {}) }
    },
    models() {
      const config = usable()
      if (!config) return []
      const models: ModelInfo[] = [{ id: PI_DEFAULT_MODEL, name: "pi · its own model", efforts: [...EFFORTS], engine: "pi" }]
      for (const pattern of new Set(config.models ?? [])) models.push({ id: `${PI_MODEL_PREFIX}${pattern}`, name: `${pattern} · pi`, efforts: [...EFFORTS], engine: "pi" })
      return models
    },
    patternOf,
    owns: (modelId) => (modelId === PI_DEFAULT_MODEL ? usable() !== undefined : patternOf(modelId) !== undefined),
  }
}

export type PiVersion = readonly [number, number, number]

export function parsePiVersion(text: string): PiVersion | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

const atLeast = (version: PiVersion, needs: PiVersion) => version[0] !== needs[0] ? version[0] > needs[0] : version[1] !== needs[1] ? version[1] > needs[1] : version[2] >= needs[2]

/**
 * What the installed pi supports, decided by its version (docs/rpc.md and CHANGELOG of pi): the `agent_settled` event exists
 * since 0.80.4. An unknown version claims none, and the engine then falls back to `agent_end` plus a quiet period; an
 * `agent_settled` event seen at run time is trusted over the version. Commands a pi does not know (`clear_queue` before
 * 0.84.4) answer with an error that carries the request id, which the engine ignores where the command is only a courtesy.
 */
export type PiCapabilities = { settled: boolean; disableExtensions?: boolean }
export function piCapabilities(version: PiVersion | undefined): PiCapabilities {
  return { settled: version !== undefined && atLeast(version, [0, 80, 4]) }
}

/** Probe in an empty temp cwd so even help cannot discover repository extensions. Never throws. */
export async function probePi(options: { command?: string; args?: string[]; env?: Record<string, string>; sandbox?: SandboxPolicy; /** Tests only. */ sandboxBackend?: SandboxBackend | null } = {}): Promise<{ ok: true; version: string; capabilities: PiCapabilities } | { ok: false }> {
  let cwd: string | undefined
  try {
    const directory = mkdtempSync(join(tmpdir(), "mendcode-pi-probe-"))
    cwd = directory
    const read = async (args: string[]) => {
      const wrapped = sandboxCommand({ argv: [options.command ?? "pi", ...(options.args ?? []), ...args], policy: options.sandbox, ...(options.sandboxBackend !== undefined ? { backend: options.sandboxBackend } : {}) })
      if (!wrapped.ok) throw new Error(wrapped.error)
      const proc = Bun.spawn(wrapped.argv, { cwd: directory, env: { ...process.env, ...options.env }, stdout: "pipe", stderr: "pipe", stdin: "ignore" })
      const timer = setTimeout(() => proc.kill(), 2_000)
      let bytes = 0
      const collect = async (stream: ReadableStream<Uint8Array>) => {
        const decoder = new TextDecoder()
        let text = ""
        for await (const chunk of stream) {
          bytes += chunk.byteLength
          if (bytes > 64 * 1024) {
            proc.kill()
            return ""
          }
          text += decoder.decode(chunk, { stream: true })
        }
        return text + decoder.decode()
      }
      try {
        const [stdout, stderr, code] = await Promise.all([collect(proc.stdout), collect(proc.stderr), proc.exited])
        return { text: `${stdout}\n${stderr}`.trim(), code: bytes > 64 * 1024 ? 1 : code }
      } finally {
        clearTimeout(timer)
      }
    }
    // Some CLIs print the version on stderr.
    const { text, code } = await read(["--version"])
    const version = parsePiVersion(text)
    if (code !== 0 || !version || text.length >= 400) return { ok: false }
    const help = await read(["--no-extensions", "--help"]).catch(() => undefined)
    const disableExtensions = help?.code === 0 && help.text.length < 64 * 1024 && /^\s*--no-extensions\b[^\n]*disable[^\n]*extension/im.test(help.text)
    return { ok: true, version: version.join("."), capabilities: { ...piCapabilities(version), disableExtensions } }
  } catch {
    return { ok: false }
  } finally {
    if (cwd) rmSync(cwd, { recursive: true, force: true })
  }
}
