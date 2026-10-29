import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

export type PluginSelection = { spec: string; options: Record<string, unknown> }
export type PluginFile = { file: string; dir: string; plugin: PluginSelection & { kind: "server" | "tui" | "tool"; root?: string; error?: string } }
export const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** JSONC without evaluating code; quoted comment markers are preserved. */
export function parsePluginConfig(text: string): Record<string, unknown> {
  const stripped = text.replace(/"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, (token) => token.startsWith('"') ? token : " ")
    .replace(/"(?:\\.|[^"\\])*"|,\s*(?=[}\]])/g, (token) => token.startsWith('"') ? token : "")
  const value: unknown = JSON.parse(stripped)
  if (!record(value)) throw new Error("plugin config must be an object")
  return value
}

export function pluginConfig(root: string) {
  const file = ["mendcode.jsonc", "mendcode.json"].map((name) => path.join(root, name)).find(existsSync) ?? path.join(root, "mendcode.json")
  return { file, value: existsSync(file) ? parsePluginConfig(readFileSync(file, "utf8")) : {} }
}

export function pluginSelections(config: Record<string, unknown>): PluginSelection[] {
  if (config.pluginCompatibility !== true) return []
  const disabled = Array.isArray(config.disabledPlugins) ? config.disabledPlugins : []
  const selected = (Array.isArray(config.plugin) ? config.plugin : []).flatMap((item) => {
    const spec = typeof item === "string" ? item : Array.isArray(item) ? item[0] : undefined
    const options = Array.isArray(item) && record(item[1]) ? item[1] : {}
    return typeof spec === "string" && spec.trim() && !disabled.includes(spec) && !disabled.includes(pluginIdentity(spec)) ? [{ spec, options }] : []
  }).slice(0, 64)
  const seen = new Set<string>()
  return selected.toReversed().filter(({ spec }) => { const id = pluginIdentity(spec); if (seen.has(id)) return false; seen.add(id); return true }).toReversed()
}

export function pluginIdentity(spec: string) {
  if (spec.startsWith("file:") || spec.startsWith(".") || path.isAbsolute(spec)) return spec
  const match = /^(@[^/]+\/[^@]+|[^@]+)(?:@.+)?$/.exec(spec)
  return match?.[1] ?? spec
}

function target(pkg: Record<string, unknown>, kind: "server" | "tui") {
  const exports = record(pkg.exports) ? pkg.exports : undefined
  const unwrap = (value: unknown): string | undefined => typeof value === "string" ? value : record(value) ? unwrap(value.import ?? value.default) : undefined
  return unwrap(exports?.[`./${kind}`]) ?? (kind === "server" ? unwrap(exports?.["."] ?? pkg.exports) ?? (typeof pkg.module === "string" ? pkg.module : typeof pkg.main === "string" ? pkg.main : undefined) : undefined)
}

export function resolvePlugin(spec: string, root: string, dataDir: string, kind: "server" | "tui"): string | undefined {
  let source: string
  if (spec.startsWith("file:")) source = fileURLToPath(spec)
  else if (spec.startsWith(".") || path.isAbsolute(spec)) source = path.resolve(root, spec)
  else source = path.join(dataDir, "plugin-cache", "node_modules", pluginIdentity(spec))
  const stat = statSync(source, { throwIfNoEntry: false })
  if (stat?.isFile()) return source
  if (stat?.isDirectory()) {
    const manifest = JSON.parse(readFileSync(path.join(source, "package.json"), "utf8")) as Record<string, unknown>
    if (!spec.startsWith("file:") && !spec.startsWith(".") && !path.isAbsolute(spec)) {
      const version = spec.slice(pluginIdentity(spec).length + 1)
      if (version && version !== manifest.version) throw new Error("cached plugin version differs from selection; install the requested version offline")
    }
    const entry = target(manifest, kind)
    if (!entry) return undefined
    const file = path.resolve(source, entry)
    if (!file.startsWith(source + path.sep) || !statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`invalid ${kind} plugin entrypoint`)
    return file
  }
  // Local node_modules are resolution-only: no automatic dependency install at startup.
  if (kind === "server" && spec === pluginIdentity(spec)) {
    try { return createRequire(path.join(root, "package.json")).resolve(spec) } catch {}
  }
  throw new Error("plugin not in the offline cache; run plugin <module> to install it")
}

export function discoverPluginFiles(root: string, dataDir: string, kind: "server" | "tui"): PluginFile[] {
  const config = pluginConfig(root).value
  const files = pluginSelections(config).flatMap((selection): PluginFile[] => {
    try {
      const file = resolvePlugin(selection.spec, root, dataDir, kind)
      return file ? [{ file, dir: path.dirname(file), plugin: { ...selection, kind, root } }] : []
    } catch {
      return [{ file: path.join(root, `.missing-plugin-${encodeURIComponent(selection.spec)}`), dir: root, plugin: { ...selection, kind, root, error: "plugin not in the offline cache or entrypoint invalid" } }]
    }
  })
  if (kind === "server" && config.pluginCompatibility === true) for (const folder of ["tool", "tools"]) {
    const dir = path.join(root, folder)
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue
    for (const name of readdirSync(dir).sort().slice(0, 64)) if (/^[^.].*\.(ts|js)$/.test(name) && !name.endsWith(".d.ts")) files.push({ file: path.join(dir, name), dir, plugin: { spec: name, options: {}, kind: "tool" } })
  }
  return files
}
