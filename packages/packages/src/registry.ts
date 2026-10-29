import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { z } from "zod"
import type { PackageCatalogEntry, PackageCatalogReport, PackagePreviewReport, PackageSourceInfo, PackageAssetsReport } from "@mendcode/protocol"
import type { PromptMode } from "@mendcode/protocol/wire"
import { PACKAGE_NAME, type ExtensionLayer, type ExtensionSource } from "./layers"
import { auditPackageTree, installPackage, isPinnedSpec, PackageError, parsePackageSource, type PackageFetchers, type PackageHost } from "./install"
import { extensionsProblem, listPackages, packageContents, readManifest } from "./manifest"
import { packageCapabilities } from "./capabilities"
import { LOCAL_PACKAGE_DIR } from "./authoring"
import { packageFingerprint } from "./trust"

const MAX_INDEX_BYTES = 1024 * 1024
const MAX_SOURCES = 64
const sourceSchema = z.strictObject({ id: z.string().regex(PACKAGE_NAME), location: z.string().min(1).max(4096), enabled: z.boolean() })
const stateSchema = z.strictObject({ version: z.literal(0), sources: z.array(sourceSchema).max(MAX_SOURCES) })
const entrySchema = z.object({
  id: z.string().regex(PACKAGE_NAME), version: z.string().min(1).max(40), title: z.string().max(200).optional(),
  description: z.string().max(500).optional(), tags: z.array(z.string().max(100)).max(32).optional(),
  source: z.object({ url: z.string().min(1).max(4096), integrity: z.string().max(200).optional() }).optional(),
})
const CACHE_DIR = "package-cache"
const cacheSchema = z.strictObject({ version: z.literal(0), url: z.string(), fetchedAt: z.number(), packs: z.array(entrySchema).max(200) })
/** An index entry pointing at an npm package or git repository instead of a folder next to the index. */
const SPEC_URL = /^(npm:|github:|git:|https?:\/\/|ssh:\/\/|git@)/

/** Remote catalog locations: https, or http to a literal loopback address (local mirrors and tests). No credentials, no fragment. */
export function remoteCatalogUrl(location: string): URL | undefined {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(location)) return undefined
  let url: URL
  try { url = new URL(location) } catch { throw new PackageError("invalid catalog URL") }
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new PackageError("remote catalogs must use https")
  if (url.username || url.password) throw new PackageError("catalog URLs cannot carry credentials")
  if (url.hash) throw new PackageError("catalog URLs cannot carry a fragment")
  return url
}

async function fetchText(url: string, limit: number): Promise<string> {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000), headers: { accept: "application/json" } })
  if (!response.ok) throw new PackageError(`catalog request failed: HTTP ${response.status}`)
  const reader = response.body?.getReader()
  if (!reader) return ""
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) { await reader.cancel(); throw new PackageError(`catalog is larger than ${limit / 1024 / 1024} MiB`) }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}
const indexSchema = z.object({ version: z.literal(0), packs: z.array(entrySchema).max(200) })
const INDEX_FILES = [".mendcode/marketplace/index.json", ".mendcode/marketplace/index.jsonc", ".mendcode/registry-index.json", ".mendcode/registry-index.jsonc", "marketplace-index.json", "marketplace-index.jsonc"]

/** Strip JSONC syntax outside strings, preserving URLs and escaped quotes. */
function jsonc(raw: string) {
  let clean = "", quoted = false
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!
    if (quoted) {
      clean += char
      if (char === "\\") clean += raw[++i] ?? ""
      else if (char === '"') quoted = false
    } else if (char === '"') { quoted = true; clean += char }
    else if (char === "/" && raw[i + 1] === "/") { while (i < raw.length && raw[i] !== "\n") i++; clean += "\n" }
    else if (char === "/" && raw[i + 1] === "*") {
      const end = raw.indexOf("*/", i + 2)
      if (end < 0) throw new Error("unterminated catalog comment")
      clean += " "; i = end + 1
    } else clean += char
  }
  let result = ""
  quoted = false
  for (let i = 0; i < clean.length; i++) {
    const char = clean[i]!
    if (quoted) {
      result += char
      if (char === "\\") result += clean[++i] ?? ""
      else if (char === '"') quoted = false
    } else if (char === '"') { quoted = true; result += char }
    else {
      let next = i + 1
      if (char === ",") while (next < clean.length && /\s/.test(clean[next]!)) next++
      if (char !== "," || !["}", "]"].includes(clean[next]!)) result += char
    }
  }
  return result
}

function json(file: string) {
  const info = lstatSync(file, { throwIfNoEntry: false })
  if (!info?.isFile() || info.size > MAX_INDEX_BYTES) throw new PackageError(`invalid or oversized catalog: ${file}`)
  try {
    const raw = readFileSync(file, "utf8")
    return JSON.parse(file.endsWith(".jsonc") ? jsonc(raw) : raw) as unknown
  } catch { throw new PackageError(`invalid catalog JSON: ${file}`) }
}

function localFolder(location: string, cwd: string) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(location) || /^[\w.-]+@/.test(location)) throw new PackageError("this source is not a local folder")
  const folder = path.resolve(cwd, location)
  if (!statSync(folder, { throwIfNoEntry: false })?.isDirectory()) throw new PackageError(`no source folder at ${folder}`)
  return realpathSync(folder)
}

/** Local catalogs are explicit and contain metadata only. Reading never imports package code or uses the network. */
export function createPackageRegistry(input: { userDir: string; directory: string; disabled?: readonly string[]; fetchers?: PackageFetchers; capabilities?: boolean; host?: PackageHost }) {
  const file = path.join(input.userDir, "package-sources.json")
  const cacheFile = (id: string) => path.join(input.userDir, CACHE_DIR, `${id}.json`)
  const readCache = (id: string) => {
    const info = lstatSync(cacheFile(id), { throwIfNoEntry: false })
    if (!info?.isFile() || info.size > MAX_INDEX_BYTES * 2) return undefined
    try {
      const parsed = cacheSchema.safeParse(JSON.parse(readFileSync(cacheFile(id), "utf8")))
      return parsed.success ? parsed.data : undefined
    } catch { return undefined }
  }
  const installed = () => listPackages(input)
  const read = () => {
    if (!existsSync(file)) return { version: 0 as const, sources: [] as z.infer<typeof sourceSchema>[] }
    const parsed = stateSchema.safeParse(json(file))
    if (!parsed.success) throw new PackageError("invalid package-sources.json")
    return parsed.data
  }
  const write = (state: z.infer<typeof stateSchema>) => {
    mkdirSync(input.userDir, { recursive: true })
    const temporary = `${file}.tmp`
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, file)
  }
  function sources(): PackageSourceInfo[] {
    return [{ id: "local", location: input.directory, enabled: true, builtin: true }, ...read().sources.map((source): PackageSourceInfo => {
      if (!remoteCatalogUrl(source.location)) return { ...source, builtin: false }
      const fetchedAt = readCache(source.id)?.fetchedAt
      return { ...source, builtin: false, remote: true, ...(fetchedAt ? { fetchedAt } : {}) }
    })]
  }
  /** Local folders and remote https catalogs. A remote source is only ever contacted by `refresh`, and only while enabled. */
  function addSource(id: string, location: string, enabled = false) {
    if (!PACKAGE_NAME.test(id) || id === "local") throw new PackageError("source id must be a package name other than local")
    const source = { id, location: remoteCatalogUrl(location)?.href ?? localFolder(location, input.directory), enabled }
    const state = read()
    const next = [...state.sources.filter((item) => item.id !== id), source]
    if (next.length > MAX_SOURCES) throw new PackageError(`at most ${MAX_SOURCES} sources`)
    write({ version: 0, sources: next })
    return sources()
  }
  function removeSource(id: string) {
    if (id === "local") throw new PackageError("the local catalog cannot be removed")
    const state = read()
    if (!state.sources.some((item) => item.id === id)) throw new PackageError(`unknown source: ${id}`)
    write({ ...state, sources: state.sources.filter((item) => item.id !== id) })
    rmSync(cacheFile(id), { force: true })
    return sources()
  }
  /** An index entry that names an npm package or git repository: nothing to read on disk until it is installed, and it must be pinned. */
  function specEntry(pack: z.infer<typeof entrySchema>, sourceId: string): PackageCatalogEntry {
    const found = installed().find((item) => item.name === pack.id)
    const { url, integrity } = pack.source!
    const spec = integrity && url.startsWith("npm:") && !url.includes("#") ? `${url}#${integrity}` : url
    let problem: string | undefined
    try { parsePackageSource(spec, input.directory) } catch (error) { problem = error instanceof PackageError ? error.message.replace("[PACKAGES]: ", "") : "invalid source" }
    if (!problem && !isPinnedSpec(spec)) problem = "source is not pinned: use npm:name@x.y.z or a full git commit"
    return { name: pack.id, version: pack.version, description: pack.description ?? "", sourceId, location: spec, tags: [...(pack.tags ?? []), "remote"], ...(pack.title ? { title: pack.title } : {}), contents: { tools: 0, skills: 0, commands: 0, themes: 0, mcp: false }, state: found ? found.enabled ? "active" : "installed" : "available", remote: true, ...(problem ? { problem } : {}) }
  }
  function indexEntries(packs: Array<z.infer<typeof entrySchema>>, source: PackageSourceInfo, root?: string) {
    const names = new Set<string>()
    return packs.map((pack) => {
      if (names.has(pack.id)) throw new PackageError(`duplicate catalog id: ${pack.id}`)
      names.add(pack.id)
      if (pack.source && SPEC_URL.test(pack.source.url)) return specEntry(pack, source.id)
      if (!root) throw new PackageError(`package ${pack.id} in remote source ${source.id} must name an npm or git source`)
      const location = localFolder(pack.source?.url ?? ".", root)
      const relative = path.relative(root, location)
      if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new PackageError(`package ${pack.id} escapes source folder`)
      return entry(pack.id, pack.version, pack.description ?? "", source.id, location, pack)
    })
  }
  /** Downloads a remote source's index (explicit, opt-in: the source must be enabled) and stores the validated copy that search reads. */
  async function refresh(id: string) {
    const source = sources().find((item) => item.id === id)
    if (!source) throw new PackageError(`unknown source: ${id}`)
    if (!source.remote) throw new PackageError(`${id} is a local source; there is nothing to fetch`)
    if (!source.enabled) throw new PackageError(`source is disabled: ${id}; enable it before fetching`)
    const raw = await (input.fetchers?.text ?? fetchText)(source.location, MAX_INDEX_BYTES)
    if (Buffer.byteLength(raw) > MAX_INDEX_BYTES) throw new PackageError("catalog is larger than 1 MiB")
    let parsed: ReturnType<typeof indexSchema.safeParse>
    try { parsed = indexSchema.safeParse(JSON.parse(jsonc(raw))) } catch { throw new PackageError(`invalid catalog JSON from ${id}`) }
    if (!parsed.success) throw new PackageError(`invalid marketplace index from ${id}`)
    indexEntries(parsed.data.packs, source)
    mkdirSync(path.dirname(cacheFile(id)), { recursive: true })
    const temporary = `${cacheFile(id)}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ version: 0, url: source.location, fetchedAt: Date.now(), packs: parsed.data.packs })}\n`, { mode: 0o600 })
    renameSync(temporary, cacheFile(id))
    return { sources: sources(), entries: parsed.data.packs.length }
  }
  function entry(name: string, version: string, description: string, sourceId: string, location: string, metadata: { title?: string | undefined; tags?: string[] | undefined } = {}): PackageCatalogEntry {
    const found = installed().find((item) => item.name === name)
    const manifest = readManifest(location)
    const mismatch = "manifest" in manifest && (manifest.manifest.name !== name || manifest.manifest.version !== version)
    const problem = "problem" in manifest ? manifest.problem : mismatch ? "catalog name/version differs from package manifest" : undefined
    return { name, version, description, sourceId, location, tags: metadata.tags ?? [], ...(metadata.title ? { title: metadata.title } : {}), contents: packageContents(location), state: found ? found.enabled ? "active" : "installed" : "available", ...(problem ? { problem } : {}) }
  }
  function catalog(source: PackageSourceInfo): PackageCatalogEntry[] {
    if (source.builtin) {
      const rows: PackageCatalogEntry[] = installed().map((item) => ({ name: item.name, version: item.manifest?.version ?? "unversioned", description: item.manifest?.description ?? "", sourceId: "local", location: item.dir, contents: item.contents, tags: [item.source], state: item.enabled ? "active" : "installed", ...(item.problem ? { problem: item.problem } : {}) }))
      const authored = path.join(input.directory, ".mendcode", LOCAL_PACKAGE_DIR)
      if (lstatSync(authored, { throwIfNoEntry: false })?.isDirectory()) {
        const manifest = readManifest(authored)
        if ("manifest" in manifest) {
          const value = manifest.manifest
          // The current authored revision takes precedence over an older installed copy in this source.
          return [...rows.filter((item) => item.name !== value.name), entry(value.name, value.version, value.description, "local", authored, { title: value.title, tags: ["authored", "unsigned"] })]
        }
      }
      return rows
    }
    if (source.remote) {
      const cached = readCache(source.id)
      if (!cached) throw new PackageError(`${source.id} has not been fetched; run refresh`)
      return indexEntries(cached.packs, source)
    }
    const root = localFolder(source.location, input.directory)
    const indexFile = INDEX_FILES.map((candidate) => path.join(root, candidate)).find(existsSync)
    if (!indexFile) {
      const manifest = readManifest(root)
      if ("problem" in manifest) throw new PackageError(manifest.problem)
      return [entry(manifest.manifest.name, manifest.manifest.version, manifest.manifest.description, source.id, root)]
    }
    const parsed = indexSchema.safeParse(json(indexFile))
    if (!parsed.success) throw new PackageError(`invalid marketplace index in ${source.id}`)
    return indexEntries(parsed.data.packs, source, root)
  }
  function search(query = "", sourceId?: string): PackageCatalogReport {
    const list = sources()
    if (sourceId && !list.some((source) => source.id === sourceId)) throw new PackageError(`unknown source: ${sourceId}`)
    const entries: PackageCatalogEntry[] = []
    const issues: string[] = []
    for (const source of list.filter((source) => !sourceId || source.id === sourceId)) {
      if (!source.enabled) { if (sourceId) throw new PackageError(`source is disabled: ${source.id}`); continue }
      try { entries.push(...catalog(source)) } catch (error) {
        if (sourceId) throw error
        issues.push(`${source.id}: ${error instanceof Error ? error.message : "catalog unavailable"}`)
      }
    }
    const needle = query.trim().toLowerCase()
    return { query, issues, entries: entries.filter((item) => [item.name, item.version, item.title ?? "", item.description, item.sourceId, ...item.tags].some((value) => value.toLowerCase().includes(needle))) }
  }
  function show(name?: string, sourceId?: string) {
    const entries = search("", sourceId).entries.filter((item) => !name || item.name === name)
    if (!entries.length) throw new PackageError(`package not found: ${name ?? sourceId}`)
    // One source install is deterministic; a multi-pack source requires an explicit package choice.
    if (entries.length !== 1) throw new PackageError(name ? `ambiguous package ${name}; choose a source` : "source contains several packages; choose a package")
    return entries[0]!
  }
  function preview(name: string | undefined, sourceId: string | undefined, scope: ExtensionSource): PackagePreviewReport {
    const selected = show(name, sourceId)
    const current = installed().find((item) => item.name === selected.name && item.source === scope)
    // Remote entries are staged and audited at install time; previewing never touches the network.
    const manifest = selected.remote ? { problem: "remote" } : readManifest(selected.location)
    const mismatch = "manifest" in manifest ? extensionsProblem({ manifest: manifest.manifest, dir: selected.location }) : undefined
    const problems = [...(selected.problem ? [selected.problem] : []), ...(mismatch ? [mismatch] : []), ...(selected.remote ? [] : auditPackageTree(selected.location, { skipSourceFiles: true }))]
    const result = { entry: selected, scope, action: current ? "replace" as const : "install" as const, ...(current?.manifest ? { installedVersion: current.manifest.version } : {}), problems }
    if (input.capabilities === false) return result
    const fingerprint = selected.remote ? undefined : packageFingerprint(selected.location)
    const candidates = installed().filter((item) => item.dir !== selected.location && item.key !== current?.key)
    const comparisons = candidates.slice(0, 128).map((item) => ({ key: item.key, fingerprint: packageFingerprint(item.dir) }))
    const trust = { identity: selected.name, signed: false as const, authorization: "required" as const, duplicates: comparisons.filter((item) => fingerprint && item.fingerprint === fingerprint).map((item) => item.key), comparisonComplete: !!fingerprint && comparisons.every((item) => !!item.fingerprint) && candidates.length <= 128 }
    return { ...result, trust, capabilities: selected.remote ? { declared: [], observed: [], complete: false } : packageCapabilities(selected.location) }
  }
  async function install(name: string | undefined, sourceId: string | undefined, scope: ExtensionSource, replace = false, now?: () => number) {
    const plan = preview(name, sourceId, scope)
    if (plan.problems.length) throw new PackageError(plan.problems.join("; "))
    return installPackage({ spec: plan.entry.location, scope, userDir: input.userDir, directory: input.directory, replace, ...(now ? { now } : {}), ...(input.fetchers ? { fetchers: input.fetchers } : {}), ...(input.host ? { host: input.host } : {}), expected: { name: plan.entry.name, version: plan.entry.version } })
  }
  return { sources, addSource, removeSource, refresh, search, show, preview, install }
}

/** Counts files in active layers without reading their contents or importing modules. */
export function packageAssets(layers: ExtensionLayer[], promptMode: PromptMode): PackageAssetsReport {
  const markdown = (dir: string): number => {
    if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return 0
    return readdirSync(dir, { withFileTypes: true }).reduce((total, entry) => total + (entry.isDirectory() ? markdown(path.join(dir, entry.name)) : entry.isFile() && entry.name.endsWith(".md") ? 1 : 0), 0)
  }
  const rows = layers.map((layer) => ({ source: layer.pkg ? `${layer.source}:${layer.pkg}` : layer.source, contents: packageContents(layer.dir), prompts: ["SYSTEM.md", "APPEND_SYSTEM.md", "COMPACTION.md"].filter((name) => lstatSync(path.join(layer.dir, name), { throwIfNoEntry: false })?.isFile()).length, templates: ["prompt", "prompts", "goals"].reduce((total, dir) => total + markdown(path.join(layer.dir, dir)), 0) }))
  const totals = { tools: 0, skills: 0, commands: 0, themes: 0, mcp: false, extensions: 0, agents: 0, prompts: 0, templates: 0 }
  for (const row of rows) {
    for (const key of ["tools", "skills", "commands", "themes", "extensions", "agents"] as const) totals[key] += row.contents[key] ?? 0
    totals.mcp ||= row.contents.mcp
    totals.prompts += row.prompts
    totals.templates += row.templates
  }
  return { layers: rows, totals, promptMode }
}
