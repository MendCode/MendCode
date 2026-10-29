import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { pluginConfig, pluginIdentity, resolvePlugin } from "@mendcode/extension-api/plugin-files"

/** Where plugin declarations live: the data directory, or the project's own config file location. */
export function pluginRoot(input: { dataDir: string; directory: string; global?: boolean }) {
  return input.global ? input.dataDir : ["mendcode.json", "mendcode.jsonc"].some((name) => existsSync(path.join(input.directory, name))) ? input.directory : path.join(input.directory, ".mendcode")
}

/** Atomic replace of the `plugin` list, keeping the previous file as a timestamped backup. */
export function savePluginList(root: string, list: unknown[]) {
  const config = pluginConfig(root)
  mkdirSync(root, { recursive: true })
  const temp = `${config.file}.${randomUUID()}.tmp`
  writeFileSync(temp, `${JSON.stringify({ ...config.value, pluginCompatibility: true, plugin: list }, null, 2)}\n`)
  if (existsSync(config.file)) {
    const backups = path.join(root, "plugin-config-backups")
    mkdirSync(backups, { recursive: true })
    writeFileSync(path.join(backups, `${Date.now()}-${randomUUID()}.jsonc`), readFileSync(config.file))
  }
  renameSync(temp, config.file)
  return config.file
}

export async function installPlugin(input: { dataDir: string; directory: string; spec: string; global?: boolean; force?: boolean; resolveNpm?(spec: string, cache: string): Promise<void> }) {
  const root = pluginRoot(input)
  const identity = pluginIdentity(input.spec)
  const npm = !input.spec.startsWith("file:") && !input.spec.startsWith(".") && !path.isAbsolute(input.spec)
  if (npm && !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:@[a-zA-Z0-9.*^~+-]+)?$/.test(input.spec)) throw new Error("invalid npm plugin specifier")
  const config = pluginConfig(root)
  const list = Array.isArray(config.value.plugin) ? [...config.value.plugin] : []
  const duplicates = list.flatMap((item, index) => {
    const spec = typeof item === "string" ? item : Array.isArray(item) ? item[0] : undefined
    return typeof spec === "string" && pluginIdentity(spec) === identity ? [index] : []
  })
  if (duplicates.length && !input.force) return { mode: "noop", file: config.file, scope: input.global ? "user" : "project", spec: input.spec }
  let spec = npm ? input.spec : input.spec.startsWith("file:") ? input.spec : pathToFileURL(path.resolve(input.directory, input.spec)).href
  if (npm) {
    const cache = path.join(input.dataDir, "plugin-cache")
    mkdirSync(cache, { recursive: true })
    if (input.resolveNpm) await input.resolveNpm(spec, cache)
    else {
      const version = Bun.spawn(["pnpm", "--version"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" })
      const versionTimer = setTimeout(() => version.kill(), 5_000)
      const [versionStatus, text] = await Promise.all([version.exited, new Response(version.stdout).text()])
      clearTimeout(versionTimer)
      if (versionStatus !== 0 || !/^\d+\./.test(text.trim()) || Number(text.trim().split(".")[0]) < 11) throw new Error("plugin install requires pnpm 11 or newer")
      if (!existsSync(path.join(cache, "package.json"))) writeFileSync(path.join(cache, "package.json"), '{"name":"mendcode-plugin-cache","private":true}\n')
      const proc = Bun.spawn(["pnpm", "add", "--offline", "--ignore-scripts", "--save-exact", "--config.minimumReleaseAge=1440", "--", spec], { cwd: cache, stdin: "ignore", stdout: "ignore", stderr: "ignore", env: { ...process.env, CI: "1" } })
      const timer = setTimeout(() => proc.kill(), 30_000)
      const status = await proc.exited
      clearTimeout(timer)
      if (status !== 0) throw new Error("offline plugin install failed; populate the pnpm cache separately")
    }
    const manifest = JSON.parse(readFileSync(path.join(cache, "node_modules", identity, "package.json"), "utf8")) as { version?: string }
    if (!manifest.version || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(manifest.version)) throw new Error("plugin package has no valid version")
    spec = `${identity}@${manifest.version}`
  }
  const targets = ["server", "tui"] as const
  const found = targets.filter((kind) => { try { return Boolean(resolvePlugin(spec, root, input.dataDir, kind)) } catch { return false } })
  if (!found.length) throw new Error("plugin exposes no server or tui entrypoint")
  const first = duplicates[0]
  if (first === undefined) list.push(spec)
  else {
    const previous = list[first]
    list[first] = Array.isArray(previous) ? [spec, previous[1]] : spec
    for (const index of duplicates.slice(1).reverse()) list.splice(index, 1)
  }
  savePluginList(root, list)
  return { mode: first === undefined ? "add" : "replace", file: config.file, scope: input.global ? "user" : "project", spec, targets: found }
}
