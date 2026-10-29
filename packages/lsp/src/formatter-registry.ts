import { access, readFile } from "node:fs/promises"
import { constants } from "node:fs"
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path"
import { FormatterConfig, FormatterEntry, type FormatterIssue } from "../../protocol/src/formatter"
import { runManaged } from "@mendcode/tools"
import { STACK_FORMATTERS, stackFormatterConfigured } from "./stack-formatters"

export type FormatterSpec = {
  name: string
  command: string[]
  extensions: string[]
  environment?: Record<string, string>
  project?: "dependency" | "biome" | "clang" | "ruff" | "ocaml" | "pint"
  experimental?: boolean
  probe?: "air" | "uv"
}
export type FormatterRegistry = { formatters: FormatterSpec[]; issues: FormatterIssue[] }

const JS_EXTENSIONS = [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]
const WEB_EXTENSIONS = [...JS_EXTENSIONS, ".html", ".htm", ".css", ".scss", ".sass", ".less", ".vue", ".svelte", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".xml", ".md", ".mdx", ".graphql", ".gql"]
export const DEFAULT_FORMATTERS: FormatterSpec[] = [
  { name: "prettier", command: ["prettier", "--write", "$FILE"], extensions: WEB_EXTENSIONS, environment: { BUN_BE_BUN: "1" }, project: "dependency" },
  { name: "oxfmt", command: ["oxfmt", "$FILE"], extensions: JS_EXTENSIONS, environment: { BUN_BE_BUN: "1" }, project: "dependency", experimental: true },
  { name: "biome", command: ["biome", "format", "--write", "$FILE"], extensions: WEB_EXTENSIONS, environment: { BUN_BE_BUN: "1" }, project: "biome" },
  ...STACK_FORMATTERS,
]

export async function loadFormatterRegistry({ directory }: { directory: string }): Promise<FormatterRegistry> {
  const source = join(directory, ".mendcode", "formatter.json")
  const issues: FormatterIssue[] = []
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(source, "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") issues.push({ source, message: "cannot read formatter configuration (expected valid JSON)" })
    return { formatters: [], issues }
  }
  if (raw === false) return { formatters: [], issues }
  if (raw !== true && (typeof raw !== "object" || raw === null || Array.isArray(raw))) return { formatters: [], issues: [{ source, message: "expected true, false or formatter overrides" }] }
  const byName = new Map(DEFAULT_FORMATTERS.map((spec) => [spec.name, { ...spec }]))
  if (raw !== true) {
    for (const [name, value] of Object.entries(raw)) {
      const parsed = FormatterEntry.safeParse(value)
      if (!parsed.success || !FormatterConfig.safeParse({ [name]: value }).success) {
        // An invalid override cannot fall back to executing the builtin it meant to disable.
        byName.delete(name)
        issues.push({ source, formatter: name, message: "invalid formatter entry (command, extensions, environment, env or disabled)" })
        continue
      }
      const override = parsed.data
      if (override.disabled) { byName.delete(name); continue }
      const base = byName.get(name)
      if (!base && (!override.command || !override.extensions)) {
        issues.push({ source, formatter: name, message: "a custom formatter needs command and extensions" })
        continue
      }
      const spec: FormatterSpec = {
        ...base,
        name,
        command: override.command ?? base!.command,
        extensions: override.extensions ?? base!.extensions,
        environment: { ...base?.environment, ...override.environment, ...override.env },
      }
      if (override.command) { delete spec.project; delete spec.experimental; delete spec.probe }
      byName.set(name, spec)
    }
    // Ruff and uv share a backend; disabling either must not enable the fallback.
    const overrides = raw as Record<string, unknown>
    if (["ruff", "uv"].some((name) => FormatterEntry.safeParse(overrides[name]).data?.disabled)) {
      byName.delete("ruff")
      byName.delete("uv")
    }
  }
  return { formatters: [...byName.values()], issues }
}

const exists = (file: string) => access(file).then(() => true, () => false)

/** Project directory through its enclosing Git worktree, without reading another checkout. */
export async function formatterDirectories(cwd: string): Promise<string[]> {
  const directories = [resolve(cwd)]
  for (let directory = resolve(cwd);;) {
    if (await exists(join(directory, ".git"))) return directories
    const parent = dirname(directory)
    if (parent === directory) return [resolve(cwd)]
    directories.push(parent)
    directory = parent
  }
}

type FormatterResolution = { command?: string[]; reason?: string; skipped?: boolean }
type ProbeOptions = { run?: typeof runManaged; signal?: AbortSignal; deadline?: number }

export async function formatterCommand(spec: FormatterSpec, directories: string[], which: (binary: string) => string | null, options: ProbeOptions = {}): Promise<FormatterResolution> {
  if (spec.experimental && process.env.MENDCODE_EXPERIMENTAL_OXFMT !== "1") return { reason: "experimental formatter disabled (MENDCODE_EXPERIMENTAL_OXFMT=1)", skipped: true }
  if (spec.project === "dependency" || spec.project === "biome") {
    let configured = false
    for (const directory of directories) {
      if (spec.project === "biome") {
        if (await exists(join(directory, "biome.json")) || await exists(join(directory, "biome.jsonc"))) configured = true
      } else {
        const pkg = await readFile(join(directory, "package.json"), "utf8").then((text) => JSON.parse(text), () => undefined).catch(() => undefined)
        if (pkg?.dependencies?.[spec.name] || pkg?.devDependencies?.[spec.name]) configured = true
      }
    }
    if (!configured) return { reason: spec.project === "biome" ? "no biome.json or biome.jsonc in project" : `no project ${spec.name} dependency`, skipped: true }
  }
  if (!await stackFormatterConfigured(spec, directories)) return { reason: `no project ${spec.name} configuration or dependency`, skipped: true }
  if (spec.probe === "uv") {
    const ruff = STACK_FORMATTERS.find((item) => item.name === "ruff")!
    if ((await formatterCommand(ruff, directories, which, options)).command) return { reason: "project Ruff takes precedence over uv", skipped: true }
  }
  const resolved = await resolveFormatterBinary(spec, directories, which)
  if (!resolved.command || !spec.probe) return resolved
  const timeoutMs = (options.deadline ?? Date.now() + 4_000) - Date.now()
  const signal = options.signal ?? new AbortController().signal
  if (signal.aborted) return { reason: "cancelled" }
  if (timeoutMs <= 0) return { reason: "timed out" }
  const result = await (options.run ?? runManaged)({ argv: [resolved.command[0]!, ...(spec.probe === "air" ? ["--help"] : ["format", "--help"])], cwd: directories[0]!, env: { ...process.env, ...spec.environment }, timeoutMs, signal })
  if (result.cancelled) return { reason: "cancelled" }
  if (result.timedOut) return { reason: "timed out" }
  if (result.spawnError) return { reason: "could not start" }
  if (result.exitCode !== 0) return { reason: `formatter probe exit ${result.exitCode}`, skipped: true }
  const firstLine = result.output.split("\n")[0] ?? ""
  if (spec.probe === "air" && (!firstLine.includes("R language") || !firstLine.includes("formatter"))) return { reason: "air is not the R language formatter", skipped: true }
  return resolved
}

async function resolveFormatterBinary(spec: FormatterSpec, directories: string[], which: (binary: string) => string | null): Promise<FormatterResolution> {
  const binary = spec.command[0]!
  if (isAbsolute(binary) || binary.includes("/") || binary.includes("\\")) {
    const file = resolve(directories[0]!, binary)
    if (await access(file, constants.X_OK).then(() => true, () => false)) return { command: [file, ...spec.command.slice(1)] }
  } else {
    for (const directory of directories) {
      const local = join(directory, "node_modules", ".bin", binary)
      if (await access(local, constants.X_OK).then(() => true, () => false)) return { command: [local, ...spec.command.slice(1)] }
    }
    if (spec.environment?.PATH !== undefined) {
      for (const directory of spec.environment.PATH.split(delimiter)) {
        const local = resolve(directories[0]!, directory, binary)
        if (await access(local, constants.X_OK).then(() => true, () => false)) return { command: [local, ...spec.command.slice(1)] }
      }
      return { reason: `${binary} is not installed (configured PATH)` }
    }
    const installed = which(binary)
    if (installed) return { command: [installed, ...spec.command.slice(1)] }
  }
  return { reason: `${binary} is not installed (project node_modules/.bin or PATH)` }
}
