import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs"
import path from "node:path"
import { parseActivationState, tuiProblems, type ActivationState, type SavedLook } from "@mendcode/protocol/wire"
import { serverConfigSchema } from "@mendcode/mcp"
import { readMcpServers } from "../mcp-config"
import { settingsDiff } from "../settings-tool"
import { canonicalJson, entryBytes, sha256, type Bundle, type BundleEntry, type BundleExclusion, type BundlePackage } from "./bundle"
import { APPROVAL_PROFILE_KEYS, CONFIG_IMPORTS_DIR } from "./classify"
import { installedTreeHash, packageTreeHash } from "./export"

export type Resolution = "keep" | "replace"
export type StepStatus = "new" | "identical" | "replace" | "keep" | "blocked"

/** One thing an import does or decides not to do. `expected` is the sha256 (or JSON) the target should hold afterwards. */
export type PlanStep =
  | { kind: "unit"; unit: string; status: StepStatus; files: Array<{ path: string; sha256: string; executable: boolean; rewritten: boolean }>; reason?: string }
  | { kind: "quarantine"; unit: string; files: Array<{ path: string; sha256: string; executable: boolean; rewritten: boolean }>; reason: string }
  | { kind: "mcp"; name: string; status: StepStatus; reason?: string }
  | { kind: "package"; name: string; status: StepStatus | "quarantine"; enabled: boolean; disabledResources: string[]; treeSha256: string; current?: { treeSha256?: string; enabled: boolean }; reason?: string }
  | { kind: "setting"; key: string; status: StepStatus; value: unknown }
  | { kind: "profile"; key: string; status: StepStatus; value: unknown; reason?: string }
  | { kind: "activation"; look?: string; kept: string[]; /** Hand choices saved per look owner set; a slot this machine already has stays its own. */ saved?: Record<string, SavedLook>; status: "merge" | "identical" | "none" }
  | { kind: "pending"; item: string; scope: "approval" | "machine"; reason: string; diff: string[] }

export type ImportPlan = {
  /** Changes when the bundle, the target or a resolution changes: an apply must name the plan it previewed. */
  planId: string
  bundleSha256: string
  source: Bundle["manifest"]["source"]
  target: { dataDir: string; home: string; platform: string }
  steps: PlanStep[]
  conflicts: Array<{ item: string; resolution: Resolution | "blocked"; detail: string }>
  warnings: string[]
  precedence: string[]
  excluded: BundleExclusion[]
}

export type PlanInput = {
  bundle: Bundle
  dataDir: string
  /** The target daemon's saved settings (`settings.get`). */
  settings: Record<string, unknown>
  home: string
  platform: string
  onConflict: Resolution
  /** Per item: a unit (`skills/x`), `packages/<name>`, `mcp.json#<server>`, `settings.<key>` or `tui/profile.json#<key>`. */
  resolve?: Record<string, Resolution>
  /** Replace the source's home folder with the target's in text that names it. */
  rewriteHome?: boolean
}

/** The first link on the way from `root` to `relative` (that path included), or undefined: a link is never written through. */
export function linkOnPath(root: string, relative: string): { at: string; target: string } | undefined {
  let current = root
  for (const part of relative.split("/")) {
    current = path.join(current, part)
    const info = lstatSync(current, { throwIfNoEntry: false })
    if (!info) return undefined
    if (info.isSymbolicLink()) return { at: path.relative(root, current), target: readlinkSync(current) }
  }
  return undefined
}

/** The bytes an entry will have on the target: the source's home folder replaced when asked and when the text names it. */
export function targetBytes(input: { bundle: Bundle; entry: BundleEntry; home: string; rewriteHome: boolean }): { bytes: Buffer; rewritten: boolean } {
  const bytes = entryBytes(input.bundle, input.entry)
  const from = input.bundle.manifest.source.home
  if (!input.rewriteHome || !from || from === input.home || !input.entry.hostHints?.some((hint) => hint.startsWith("home folder"))) return { bytes, rewritten: false }
  const text = bytes.toString("utf8")
  return { bytes: Buffer.from(text.split(from).join(input.home), "utf8"), rewritten: true }
}

/** Every regular file of a target unit (`skills/x` folder or a single file), relative to the data dir. */
function targetFiles(dataDir: string, unit: string): string[] {
  const full = path.join(dataDir, unit)
  const info = lstatSync(full, { throwIfNoEntry: false })
  if (!info) return []
  if (!info.isDirectory()) return [unit]
  const out: string[] = []
  const visit = (relative: string) => {
    for (const name of readdirSync(path.join(dataDir, relative)).sort()) {
      const child = `${relative}/${name}`
      const childInfo = lstatSync(path.join(dataDir, child))
      if (childInfo.isDirectory()) visit(child)
      else out.push(child)
    }
  }
  visit(unit)
  return out
}

const fileSha = (file: string) => { try { return sha256(readFileSync(file)) } catch { return undefined } }
const readJson = (file: string): unknown => { try { return JSON.parse(readFileSync(file, "utf8")) } catch { return undefined } }
const BARE_IMPORT = /(?:from\s+|require\(\s*|import\(\s*)["']([^"'./][^"']*)["']/g

/** Bare module names a quarantined script imports that do not come with Bun or Node: they must exist on the target. */
export function dependencyNames(text: string): string[] {
  const names = new Set<string>()
  for (const match of text.matchAll(BARE_IMPORT)) {
    const name = match[1]!
    if (name.startsWith("node:") || name.startsWith("bun:") || name === "bun") continue
    names.add(name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0]!)
  }
  return [...names].sort()
}

const resourceName = (relative: string): string | undefined => {
  const [kind, name] = relative.split("/")
  if (!name) return undefined
  if (kind === "skills") return `skills/${name}`
  if (["commands", "agents", "themes"].includes(kind!)) return `${kind}/${name.replace(/\.(md|json)$/, "")}`
  return undefined
}

/**
 * The import preview: what would be written, kept, quarantined or left for approval, every conflict with the resolution
 * that decides it, and every warning about paths, links, platforms and dependencies. Reads only; writes nothing.
 */
export function planImport(input: PlanInput): ImportPlan {
  const dataDir = path.resolve(input.dataDir)
  const { bundle } = input
  const manifest = bundle.manifest
  const resolve = (item: string) => input.resolve?.[item] ?? input.onConflict
  const rewriteHome = input.rewriteHome === true
  const steps: PlanStep[] = []
  const conflicts: ImportPlan["conflicts"] = []
  const warnings: string[] = []
  const precedence: string[] = []
  if (manifest.source.platform !== input.platform) warnings.push(`the bundle comes from ${manifest.source.platform}; this machine is ${input.platform}: paths, scripts and binaries made for one may not work on the other`)
  if (manifest.source.home !== input.home && !rewriteHome) {
    const named = manifest.entries.filter((entry) => entry.hostHints?.some((hint) => hint.startsWith("home folder"))).length
    if (named) warnings.push(`${named} file${named === 1 ? "" : "s"} name the source home ${manifest.source.home}; pass --rewrite-home to replace it with ${input.home}`)
  }
  for (const entry of manifest.entries) {
    const other = (entry.hostHints ?? []).filter((hint) => !hint.startsWith("home folder") && !(rewriteHome && hint.startsWith("macOS home path")))
    if (other.length && input.platform !== "darwin" && other.some((hint) => hint.startsWith("macOS"))) warnings.push(`${entry.path}: ${other.join(", ")}`)
  }

  // Plain resources, unit by unit.
  const byUnit = new Map<string, BundleEntry[]>()
  for (const entry of manifest.entries) if (entry.action === "write") byUnit.set(entry.unit, [...byUnit.get(entry.unit) ?? [], entry])
  for (const [unit, entries] of byUnit) {
    const files = entries.map((entry) => {
      const { bytes, rewritten } = targetBytes({ bundle, entry, home: input.home, rewriteHome })
      return { path: entry.path, sha256: sha256(bytes), executable: entry.executable, rewritten }
    })
    const link = linkOnPath(dataDir, unit) ?? files.map((file) => linkOnPath(dataDir, file.path)).find(Boolean)
    if (link) {
      steps.push({ kind: "unit", unit, status: "blocked", files, reason: `${link.at} is a link to ${link.target}: not written through` })
      conflicts.push({ item: unit, resolution: "blocked", detail: `${link.at} is a link to ${link.target}; replace the link by hand or copy into its target yourself` })
      continue
    }
    const present = targetFiles(dataDir, unit)
    const same = present.length === files.length && files.every((file) => fileSha(path.join(dataDir, file.path)) === file.sha256)
    const status: StepStatus = present.length === 0 ? "new" : same ? "identical" : resolve(unit)
    if (status === "keep" || status === "replace") conflicts.push({ item: unit, resolution: status, detail: `${present.length} file${present.length === 1 ? "" : "s"} on this machine differ from the bundle` })
    steps.push({ kind: "unit", unit, status, files })
  }

  // Code, hooks and scripts: copied beside the journal, never where a loader reads.
  const quarantined = new Map<string, BundleEntry[]>()
  for (const entry of manifest.entries) if (entry.action === "quarantine") quarantined.set(entry.unit, [...quarantined.get(entry.unit) ?? [], entry])
  for (const [unit, entries] of quarantined) {
    const deps = new Set<string>()
    const files = entries.map((entry) => {
      const { bytes, rewritten } = targetBytes({ bundle, entry, home: input.home, rewriteHome })
      for (const name of /\.(m?[jt]s|cjs)$/.test(entry.path) ? dependencyNames(bytes.toString("utf8")) : []) deps.add(name)
      return { path: entry.path, sha256: sha256(bytes), executable: entry.executable, rewritten }
    })
    steps.push({ kind: "quarantine", unit, files, reason: `runs code: review it, then move it into place by hand${deps.size ? `; needs ${[...deps].join(", ")}` : ""}` })
    if (deps.size) warnings.push(`${unit}: imports ${[...deps].join(", ")}, which must be installed on this machine`)
  }

  // MCP servers: pending until the user approves each one in /mcp.
  const mcpEntry = manifest.entries.find((entry) => entry.action === "mcp-pending")
  if (mcpEntry) {
    let servers: { servers?: Record<string, unknown> } | undefined
    try { servers = JSON.parse(entryBytes(bundle, mcpEntry).toString("utf8")) as { servers?: Record<string, unknown> } } catch { warnings.push("mcp.json in the bundle is not valid JSON: MCP servers are not imported") }
    const link = linkOnPath(dataDir, "mcp.json")
    let current: Record<string, Record<string, unknown>> = {}
    try { current = link ? {} : readMcpServers(path.join(dataDir, "mcp.json")) } catch { warnings.push("mcp.json on this machine is unreadable: MCP servers are not imported") }
    for (const [name, config] of Object.entries(servers?.servers ?? {})) {
      const item = `mcp.json#${name}`
      const parsed = serverConfigSchema.safeParse(config)
      const literal = Object.values({ ...(config as { env?: Record<string, unknown> }).env, ...(config as { headers?: Record<string, unknown> }).headers }).some((value) => typeof value !== "string" || !/^(\$\{[^}]+\}|\{env:[^}]+\})$/.test(value))
      if (link) { steps.push({ kind: "mcp", name, status: "blocked", reason: `mcp.json is a link to ${link.target}` }); conflicts.push({ item, resolution: "blocked", detail: "mcp.json is a link" }); continue }
      if (!parsed.success || literal) { steps.push({ kind: "mcp", name, status: "blocked", reason: !parsed.success ? "not a valid server for this MendCode" : "env/headers must be secret references" }); continue }
      const existing = current[name]
      const status: StepStatus = !existing ? "new" : canonicalJson(existing) === canonicalJson(config) ? "identical" : resolve(item)
      if (status === "keep" || status === "replace") conflicts.push({ item, resolution: status, detail: "a server with this name is configured differently here" })
      steps.push({ kind: "mcp", name, status, ...(status === "new" || status === "replace" ? { reason: "arrives disabled, pending approval in /mcp (24 h)" } : {}) })
    }
  }

  // Packages: installed by the package installer, or quarantined when they would run code once enabled.
  const packagesLink = linkOnPath(dataDir, "packages")
  for (const pkg of manifest.packages) {
    const item = `packages/${pkg.name}`
    const dir = path.join(dataDir, "packages", pkg.name)
    const disabled = Array.isArray(input.settings.disabledPackages) ? input.settings.disabledPackages as string[] : []
    const installed = existsSync(dir)
    const current = installed ? { ...(installedTreeHash(dir) ? { treeSha256: installedTreeHash(dir)!.sha256 } : {}), enabled: !disabled.includes(`user:${pkg.name}`) } : undefined
    const pkgEntries = manifest.entries.filter((entry) => entry.path.startsWith(`${item}/`))
    const rewritten = pkgEntries.map((entry) => { const target = targetBytes({ bundle, entry, home: input.home, rewriteHome }); return { path: entry.path, sha256: sha256(target.bytes), rewritten: target.rewritten } })
    const treeSha256 = rewritten.some((entry) => entry.rewritten) ? packageTreeHash(rewritten, pkg.name) : pkg.treeSha256
    const base = { kind: "package" as const, name: pkg.name, enabled: pkg.enabled, disabledResources: pkg.disabledResources, treeSha256, ...(current ? { current } : {}) }
    if (pkg.autoRuns.length) { steps.push({ ...base, status: "quarantine", reason: `runs code once enabled (${pkg.autoRuns.join(", ")}): review it, then install it with mendcode package install` }); continue }
    const link = packagesLink ?? linkOnPath(dataDir, item)
    if (link) { steps.push({ ...base, status: "blocked", reason: `${link.at} is a link to ${link.target}` }); conflicts.push({ item, resolution: "blocked", detail: `${link.at} is a link` }); continue }
    const status: StepStatus = !current ? "new" : current.treeSha256 === treeSha256 && current.enabled === pkg.enabled ? "identical" : resolve(item)
    if (status === "keep" || status === "replace") conflicts.push({ item, resolution: status, detail: current!.treeSha256 === treeSha256 ? `same files, but ${current!.enabled ? "on" : "off"} here and ${pkg.enabled ? "on" : "off"} in the bundle` : "a different copy is installed here" })
    steps.push({ ...base, status })
    const hinted = manifest.entries.filter((entry) => entry.path.startsWith(`${item}/`) && entry.hostHints?.length)
    if (hinted.length && !rewriteHome) warnings.push(`${item}: ${hinted.length} file${hinted.length === 1 ? "" : "s"} name the source machine (${[...new Set(hinted.flatMap((entry) => entry.hostHints!))].slice(0, 3).join(", ")})`)
  }

  // Settings: preferences apply; the user's authority and this machine's folders wait.
  const portable = manifest.settings.portable
  for (const key of Object.keys(portable).sort()) {
    const raw = portable[key]
    const value = rewriteHome && manifest.source.home && manifest.source.home !== input.home ? JSON.parse(JSON.stringify(raw).split(manifest.source.home).join(input.home)) as unknown : raw
    const item = `settings.${key}`
    const status: StepStatus = !(key in input.settings) ? "new" : canonicalJson(input.settings[key]) === canonicalJson(value) ? "identical" : resolve(item)
    if (status === "keep" || status === "replace") conflicts.push({ item, resolution: status, detail: "set differently on this machine" })
    steps.push({ kind: "setting", key, status, value })
  }
  for (const [key, value] of Object.entries(manifest.settings.approval).sort(([a], [b]) => a.localeCompare(b))) {
    // Which packages are on, and their switched-off resources, travel with each package (`packages.enable`, `packages.resource`).
    if (key === "disabledPackages" || key === "disabledPackageResources") continue
    if (canonicalJson(input.settings[key]) === canonicalJson(value)) continue
    const withheld = manifest.settings.withheld.includes(key)
    steps.push({ kind: "pending", item: `settings.${key}`, scope: "approval", reason: withheld ? "your authority; the bundle hides its credential-like value: set it on this machine" : "your authority (permissions, models, trust, spend, execution): approve it on this machine", diff: settingsDiff(input.settings, { ...input.settings, [key]: value }, [key]) })
  }
  for (const key of Object.keys(manifest.settings.machine).sort()) steps.push({ kind: "pending", item: `settings.${key}`, scope: "machine", reason: "describes the source machine (folders, shells, schedules): not applied", diff: [] })

  // Terminal profile: key by key, through the profile's own validation.
  const profileEntry = manifest.entries.find((entry) => entry.action === "tui-profile")
  if (profileEntry) {
    const incoming = (() => { try { return JSON.parse(entryBytes(bundle, profileEntry).toString("utf8")) as Record<string, unknown> } catch { return {} } })()
    const link = linkOnPath(dataDir, "tui/profile.json")
    const stored = (link ? {} : readJson(path.join(dataDir, "tui", "profile.json")) ?? {}) as Record<string, unknown>
    if (link) conflicts.push({ item: "tui/profile.json", resolution: "blocked", detail: `${link.at} is a link to ${link.target}` })
    for (const key of Object.keys(incoming).sort()) {
      const value = incoming[key]
      const item = `tui/profile.json#${key}`
      if (APPROVAL_PROFILE_KEYS.has(key)) {
        if (canonicalJson(stored[key]) !== canonicalJson(value)) steps.push({ kind: "pending", item, scope: "approval", reason: "starts things, touches the clipboard or the network: set it in /customize", diff: [`${key}: ${stored[key] === undefined ? "unset" : JSON.stringify(stored[key])} → ${JSON.stringify(value)}`] })
        continue
      }
      const problems = tuiProblems({ [key]: value })
      if (problems.length || link) { steps.push({ kind: "profile", key, status: "blocked", value, reason: link ? "profile.json is a link" : `this MendCode does not accept it: ${problems[0]}` }); continue }
      const status: StepStatus = !(key in stored) ? "new" : canonicalJson(stored[key]) === canonicalJson(value) ? "identical" : resolve(item)
      if (status === "keep" || status === "replace") conflicts.push({ item, resolution: status, detail: `${JSON.stringify(stored[key])} here, ${JSON.stringify(value)} in the bundle` })
      steps.push({ kind: "profile", key, status, value })
    }
  }

  // Activation: the keys kept by hand over the look's package.
  const activationEntry = manifest.entries.find((entry) => entry.action === "activation")
  if (activationEntry) {
    const state: ActivationState = parseActivationState((() => { try { return JSON.parse(entryBytes(bundle, activationEntry).toString("utf8")) } catch { return {} } })())
    const current = parseActivationState(readJson(path.join(dataDir, "activation.json")) ?? {})
    const merged = [...new Set([...current.kept, ...state.kept])].sort()
    const saved = Object.fromEntries(Object.entries(state.saved ?? {}).filter(([signature]) => !current.saved?.[signature]))
    const status = !state.kept.length && !state.look && !Object.keys(state.saved ?? {}).length ? "none" : merged.length === current.kept.length && current.look === state.look && !Object.keys(saved).length ? "identical" : "merge"
    steps.push({ kind: "activation", ...(state.look ? { look: state.look } : {}), kept: state.kept.slice().sort(), ...(Object.keys(saved).length ? { saved } : {}), status })
  }

  // Precedence: who wins for a name both a package and your own folder hold.
  const own = new Set<string>()
  for (const step of steps) if (step.kind === "unit" && step.status !== "blocked") for (const file of step.files) { const name = resourceName(file.path); if (name) own.add(name) }
  for (const kind of ["skills", "commands", "agents", "themes"]) for (const name of existsSync(path.join(dataDir, kind)) ? readdirSync(path.join(dataDir, kind)) : []) { const resource = resourceName(`${kind}/${name}`); if (resource) own.add(resource) }
  const packaged = new Map<string, Set<string>>()
  const notePackage = (pkg: string, relative: string) => { const name = resourceName(relative); if (name) packaged.set(name, new Set([...packaged.get(name) ?? [], pkg])) }
  for (const pkg of manifest.packages) for (const entry of manifest.entries) if (entry.path.startsWith(`packages/${pkg.name}/`)) notePackage(pkg.name, entry.path.slice(`packages/${pkg.name}/`.length))
  for (const name of existsSync(path.join(dataDir, "packages")) && !packagesLink ? readdirSync(path.join(dataDir, "packages")) : []) for (const kind of ["skills", "commands", "agents", "themes"]) for (const child of existsSync(path.join(dataDir, "packages", name, kind)) ? readdirSync(path.join(dataDir, "packages", name, kind)) : []) notePackage(name, `${kind}/${child}`)
  for (const [name, pkgs] of [...packaged].sort(([a], [b]) => a.localeCompare(b))) if (own.has(name)) precedence.push(`${name}: your own folder wins over package ${[...pkgs].join(", ")}; a project's .mendcode can still override both`)
    else if (pkgs.size > 1) precedence.push(`${name}: packages ${[...pkgs].join(", ")} all ship it; the later package in layer order wins`)

  const planId = sha256(canonicalJson({ bundle: bundle.manifestSha256, dataDir, rewriteHome, steps, conflicts }))
  return { planId, bundleSha256: bundle.manifestSha256, source: manifest.source, target: { dataDir, home: input.home, platform: input.platform }, steps, conflicts, warnings: [...new Set(warnings)], precedence, excluded: manifest.excluded.filter((entry) => entry.path !== CONFIG_IMPORTS_DIR) }
}
