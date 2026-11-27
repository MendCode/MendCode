import { createHash, randomBytes } from "node:crypto"
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { PARITY_CHUNK_BYTES, PARITY_MAX_BUNDLE_BYTES, type ConfigParityInput } from "@mendcode/protocol"
import { applyImport, CONFIG_IMPORTS_DIR, exportBundle, manifestHash, parseBundle, planImport, serializeBundle, type Bundle, type ImportPorts } from "./config-bundle"
import { canonicalJson, sha256 } from "./config-bundle/bundle"
import { readSyncConfig, remoteTarget } from "./sync/config"

/**
 * Configuration parity (docs/sync.md, "Keeping the hub like this machine"): what a device's portable configuration holds that its
 * hub does not, and the way to bring the hub level. Built on the personal configuration bundle: the device exports one, compares
 * its manifest with the hub's, and sends only the differing units, which the hub plans and applies like an import with backups.
 * Never moved: credentials, tokens, logins (an MCP server arrives pending and signs in on the hub), settings (session sync carries
 * the preference ones), the terminal's own look, and code that runs on its own unless the owner asks for it (`allowCode`).
 * Loaded only when a parity command arrives.
 */

export type ParityRowState = "same" | "missing" | "differs" | "state" | "code" | "blocked" | "hub-only" | "no-tool"
export type ParityRow = { kind: string; item: string; state: ParityRowState; key?: string; note?: string }
export type ParityManifest = {
  mendcode: { version?: string; buildId?: string; platform: string }
  units: Record<string, { sha256: string; files: number; action: string; os?: string[] }>
  packages: Array<{ name: string; version?: string; enabled: boolean; treeSha256: string; disabledResources: string[]; autoRuns: string[]; os?: string[] }>
  mcp: Record<string, string>
  settings: Record<string, string>
  blocked: Array<{ item: string; reason: string }>
  tools?: Record<string, string | null>
}
export type ParityOutcome = {
  remote: string
  applied: boolean
  before: ParityRow[]
  after?: ParityRow[]
  counts: Record<ParityRowState, number>
  import?: { importId: string; summary: string; blocked: string[]; notes: string[]; pendingFile?: string }
  versions: { here?: string; there?: string }
}

export type ParityPorts = ImportPorts & {
  dir: string
  now(): number
  version?: string | undefined
  buildId?: string | undefined
  log(message: string): void
}

/** What parity looks at: the terminal's own look and the folder's activation are per terminal, and sessions and caches are not configuration. */
const inScope = (relative: string) => relative !== "activation.json" && !relative.startsWith("tui/") && relative !== "mcp.json"
const MCP_LOCAL_KEYS = ["pendingApproval", "enabled", "disabled"]
/** Hashes only: a flagged file is read to compare, never sent, so the manifest may include what a bundle would leave out. */
const HASH_ONLY = ["packages"]
const kindOf = (unit: string) => {
  const head = unit.split("/")[0]!
  if (head === "skills") return "skill"
  if (head === "agents") return "agent"
  if (head === "themes") return "theme"
  if (head === "extensions") return "extension"
  if (head === "commands") return "command"
  if (head === "recipes") return "recipe"
  return /^(APPEND_SYSTEM|SYSTEM|COMPACTION|AGENTS)\.md$/.test(unit) ? "prompt" : "file"
}
const STAGE_KEEP_MS = 60 * 60_000
/** What a file says about the system it was written for; across systems such a unit is held back until the owner names it. */
const OS_HINTS = new Set(["macOS-only command", "macOS Library folder", "Homebrew path", "macOS app bundle", "Linux-only command", "Windows path"])
const osHints = (hints: readonly string[] | undefined) => (hints ?? []).filter((hint) => OS_HINTS.has(hint))

/** The comparable shape of a bundle: a hash per unit, per profile, per MCP server and per portable setting. No file content. */
export function manifestOf(bundle: Bundle): ParityManifest {
  const source = bundle.manifest
  const groups = new Map<string, { lines: string[]; action: string; os: Set<string> }>()
  for (const entry of source.entries) {
    if (entry.action === "package" || entry.action === "mcp-pending" || !inScope(entry.path)) continue
    const group = groups.get(entry.unit) ?? { lines: [], action: entry.action, os: new Set<string>() }
    group.lines.push(`${entry.path}\0${entry.sha256}`)
    osHints(entry.hostHints).forEach((hint) => group.os.add(hint))
    groups.set(entry.unit, group)
  }
  const units: ParityManifest["units"] = {}
  for (const [unit, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) units[unit] = { sha256: sha256(group.lines.sort().join("\n")), files: group.lines.length, action: group.action, ...(group.os.size ? { os: [...group.os].sort() } : {}) }
  const mcp: Record<string, string> = {}
  const mcpEntry = source.entries.find((entry) => entry.action === "mcp-pending")
  if (mcpEntry) {
    try {
      const servers = (JSON.parse(Buffer.from(bundle.files[mcpEntry.path]!, "base64").toString("utf8")) as { servers?: Record<string, Record<string, unknown>> }).servers ?? {}
      for (const [name, config] of Object.entries(servers)) mcp[name] = sha256(canonicalJson(Object.fromEntries(Object.entries(config).filter(([key]) => !MCP_LOCAL_KEYS.includes(key)))))
    } catch {}
  }
  const settings: Record<string, string> = {}
  for (const [key, value] of Object.entries(source.settings.portable)) settings[key] = sha256(canonicalJson(value))
  const blocked = source.excluded.filter((entry) => entry.column !== "omitted" && (entry.path === "mcp.json" || entry.path.startsWith("packages/") || inScope(entry.path))).map((entry) => ({ item: entry.path, reason: entry.reason }))
  return {
    mendcode: { ...(source.source.mendcodeVersion ? { version: source.source.mendcodeVersion } : {}), ...(source.source.buildId ? { buildId: source.source.buildId } : {}), platform: source.source.platform },
    units,
    packages: source.packages.map((pkg) => {
      const os = [...new Set(source.entries.filter((entry) => entry.action === "package" && entry.path.startsWith(`packages/${pkg.name}/`)).flatMap((entry) => osHints(entry.hostHints)))].sort()
      return { name: pkg.name, ...(pkg.version ? { version: pkg.version } : {}), enabled: pkg.enabled, treeSha256: pkg.treeSha256, disabledResources: [...pkg.disabledResources].sort(), autoRuns: pkg.autoRuns, ...(os.length ? { os } : {}) }
    }),
    mcp, settings, blocked,
  }
}

/**
 * The first line of `<tool> --version`, from the PATH or from `~/.local/bin` (a service's PATH often lacks it), or null when there is none.
 * A short, bounded probe: run only when a person asked for the comparison.
 */
async function toolVersion(command: string): Promise<string | null> {
  for (const program of [command, path.join(os.homedir(), ".local", "bin", command)]) {
    try {
      const child = Bun.spawn([program, "--version"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" })
      const timer = setTimeout(() => child.kill(), 8_000)
      const text = await new Response(child.stdout).text()
      clearTimeout(timer)
      if ((await child.exited) !== 0) continue
      const version = text.split("\n")[0]?.trim().replace(/^graft\s+/i, "").slice(0, 60)
      if (version) return version
    } catch {}
  }
  return null
}

/** Across systems, a unit written for this one (macOS-only commands, Homebrew paths) is held back unless the owner named it with `--allow-flagged`. */
export function holdForPlatform(input: { rows: ParityRow[]; here: ParityManifest; hub: ParityManifest; allowFlagged: readonly string[] }) {
  const { rows, here, hub } = input
  if (here.mendcode.platform === hub.mendcode.platform) return
  const named = (key: string) => input.allowFlagged.some((entry) => key === entry || key.startsWith(`${entry}/`))
  for (const row of rows) {
    if (!row.key || !["missing", "differs", "state"].includes(row.state) || named(row.key)) continue
    const found = row.key.startsWith("packages/") ? here.packages.find((pkg) => pkg.name === row.key!.slice("packages/".length))?.os : here.units[row.key]?.os
    if (found?.length) { row.state = "blocked"; row.note = `written for ${here.mendcode.platform} (${found.join(", ")}): name it with --allow-flagged to send it` }
  }
}

const emptyCounts = (): Record<ParityRowState, number> => ({ same: 0, missing: 0, differs: 0, state: 0, code: 0, blocked: 0, "hub-only": 0, "no-tool": 0 })
export const parityCounts = (rows: readonly ParityRow[]) => { const counts = emptyCounts(); for (const row of rows) counts[row.state]++; return counts }
const stateWord = (on: boolean) => on ? "on" : "off"

/** The rows that say how `hub` differs from `here`. Pure: both manifests come from one export each. */
export function compareManifests(input: { here: ParityManifest; hub: ParityManifest; allowCode: boolean }): ParityRow[] {
  const { here, hub, allowCode } = input
  const rows: ParityRow[] = []
  const hubPackages = new Map(hub.packages.map((pkg) => [pkg.name, pkg]))
  for (const pkg of here.packages) {
    const there = hubPackages.get(pkg.name)
    const item = `${pkg.name}${pkg.version ? `@${pkg.version}` : ""}`
    const key = `packages/${pkg.name}`
    const code = pkg.autoRuns.length > 0
    const gated = code && !allowCode
    const note = code ? `runs ${pkg.autoRuns.join(", ")}${gated ? ": add --code to send it" : ""}` : undefined
    const row = (state: ParityRowState, extra?: string) => rows.push({ kind: "profile", item, state, key, ...(extra || note ? { note: [extra, note].filter(Boolean).join(" · ") } : {}) })
    if (!there) row(gated ? "code" : "missing", `${stateWord(pkg.enabled)} here`)
    else if (there.treeSha256 !== pkg.treeSha256) row(gated ? "code" : "differs", `${there.version ? `there ${there.version}` : "there another build"}`)
    else if (there.enabled !== pkg.enabled || canonicalJson(there.disabledResources) !== canonicalJson(pkg.disabledResources)) row("state", `${stateWord(pkg.enabled)} here, ${stateWord(there.enabled)} there`)
    else rows.push({ kind: "profile", item, state: "same", key })
  }
  const herePackages = new Set(here.packages.map((pkg) => pkg.name))
  for (const pkg of hub.packages) if (!herePackages.has(pkg.name)) rows.push({ kind: "profile", item: `${pkg.name}${pkg.version ? `@${pkg.version}` : ""}`, state: "hub-only", key: `packages/${pkg.name}` })

  for (const [unit, own] of Object.entries(here.units)) {
    const there = hub.units[unit]
    const code = own.action === "quarantine"
    const gated = code && !allowCode
    const note = code ? `code${gated ? ": add --code to send it" : ""}` : undefined
    const state: ParityRowState = !there ? "missing" : there.sha256 !== own.sha256 ? "differs" : "same"
    rows.push({ kind: kindOf(unit), item: unit, state: state !== "same" && gated ? "code" : state, key: unit, ...(note && state !== "same" ? { note } : {}) })
  }
  for (const unit of Object.keys(hub.units)) if (!here.units[unit]) rows.push({ kind: kindOf(unit), item: unit, state: "hub-only", key: unit })

  for (const [name, fingerprint] of Object.entries(here.mcp)) {
    const there = hub.mcp[name]
    rows.push({ kind: "mcp", item: name, state: there === undefined ? "missing" : there !== fingerprint ? "differs" : "same", key: `mcp.json#${name}`, ...(there === fingerprint ? {} : { note: "arrives pending there: approve it in /mcp; its sign-in stays per machine" }) })
  }
  for (const name of Object.keys(hub.mcp)) if (here.mcp[name] === undefined) rows.push({ kind: "mcp", item: name, state: "hub-only" })

  for (const [key, fingerprint] of Object.entries(here.settings)) if (hub.settings[key] !== fingerprint) rows.push({ kind: "setting", item: key, state: "differs", note: "carried by session sync (settings), not by parity" })

  for (const [tool, version] of Object.entries(here.tools ?? {})) {
    const there = hub.tools?.[tool]
    if (version === null) continue
    rows.push({ kind: "tool", item: `${tool} ${version}`, state: there === undefined ? "same" : there === null ? "no-tool" : there === version ? "same" : "differs", ...(there === null ? { note: "not installed there; parity does not install tools" } : there && there !== version ? { note: `there ${there}` } : {}) })
  }
  return rows
}

type Remote = { send(command: { type: "config.parity"; input: ConfigParityInput }): Promise<{ ok: true; result?: Record<string, unknown> } | { ok: false; error: { code: string; message: string } }>; close(): void }

export function createParity(ports: ParityPorts) {
  let queue: Promise<void> = Promise.resolve()
  const pending = new Map<string, Promise<ParityOutcome>>()
  const importsDir = path.join(ports.dir, CONFIG_IMPORTS_DIR)
  const staged = (id: string, part: boolean) => path.join(importsDir, `parity-${id}.${part ? "part" : "bundle"}`)

  async function exportHere(allowFlagged: readonly string[]) {
    return exportBundle({ dataDir: ports.dir, settings: await ports.settings(), home: os.homedir(), platform: process.platform, arch: process.arch, now: ports.now(), mendcodeVersion: ports.version, buildId: ports.buildId, allowFlagged }).bundle
  }
  /** `allowFlagged`: what the owner named, so a flagged standalone resource they chose is in the comparison and can be selected. */
  async function manifest(tools: boolean, allowFlagged: readonly string[] = []): Promise<ParityManifest> {
    const built = manifestOf(await exportHere([...HASH_ONLY, ...allowFlagged]))
    return tools ? { ...built, tools: { graft: await toolVersion("graft") } } : built
  }

  /** Drops stale partial bundles; one bundle is staged at a time. */
  function sweep() {
    try {
      for (const name of readdirSync(importsDir)) {
        if (!/^parity-[a-f0-9]+\.(part|bundle)$/.test(name)) continue
        const file = path.join(importsDir, name)
        if (ports.now() - statSync(file).mtimeMs > STAGE_KEEP_MS) rmSync(file, { force: true })
      }
    } catch {}
  }
  function stage(input: Extract<ConfigParityInput, { op: "stage" }>) {
    const bytes = Buffer.from(input.data, "base64")
    if (bytes.length > PARITY_CHUNK_BYTES) throw new Error("[PARITY]: a piece holds at most 128 KiB")
    mkdirSync(importsDir, { recursive: true, mode: 0o700 })
    const file = staged(input.id, true)
    if (input.offset === 0) { sweep(); rmSync(file, { force: true }) }
    const size = existsSync(file) ? statSync(file).size : 0
    if (size !== input.offset) throw new Error(`[PARITY]: expected the next piece at byte ${size}, got ${input.offset}`)
    if (size + bytes.length > input.total) throw new Error("[PARITY]: more bytes than announced")
    const descriptor = openSync(file, "a", 0o600)
    try { writeSync(descriptor, bytes) } finally { closeSync(descriptor) }
    const done = size + bytes.length === input.total
    if (done) renameSync(file, staged(input.id, false))
    return { stored: size + bytes.length, done }
  }

  /** The hub applies the staged bundle as an import that replaces what differs, with backups and a journal (`config-bundle rollback ID` undoes it). */
  async function apply(input: Extract<ConfigParityInput, { op: "apply" }>) {
    const file = staged(input.id, false)
    if (!existsSync(file)) throw new Error("[PARITY]: nothing staged under that id")
    try {
      const text = readFileSync(file)
      if (createHash("sha256").update(text).digest("hex") !== input.sha256) throw new Error("[PARITY]: the staged bundle does not match its hash")
      const bundle = parseBundle(JSON.parse(text.toString("utf8")))
      const settings = await ports.settings()
      const plan = planImport({ bundle, dataDir: ports.dir, settings, home: os.homedir(), platform: process.platform, onConflict: "replace", resolve: {}, rewriteHome: false })
      const applied = await applyImport({ bundle, plan, expectedPlanId: plan.planId, ports, now: ports.now(), rewriteHome: false })
      const blocked = plan.steps.flatMap((step) => "status" in step && step.status === "blocked" ? [`${step.kind === "unit" ? step.unit : step.kind === "package" ? `packages/${step.name}` : step.kind === "mcp" ? `mcp.json#${step.name}` : step.kind}: ${"reason" in step && step.reason ? step.reason : "blocked"}`] : [])
      return { importId: applied.importId, summary: applied.report.summary, blocked: blocked.slice(0, 50), notes: applied.journal.notes.slice(0, 20), ...(applied.pendingFile ? { pendingFile: applied.pendingFile } : {}), ...(applied.quarantineFolder ? { quarantineFolder: applied.quarantineFolder } : {}) }
    } finally { rmSync(file, { force: true }) }
  }

  /** The bundle that carries only what differs: the chosen units, profiles and MCP servers, never settings, and code only when allowed. */
  function subset(bundle: Bundle, input: { keys: ReadonlySet<string>; allowCode: boolean }): Bundle {
    const names = new Set(bundle.manifest.packages.filter((pkg) => input.keys.has(`packages/${pkg.name}`)).map((pkg) => pkg.name))
    const servers = new Set([...input.keys].filter((key) => key.startsWith("mcp.json#")).map((key) => key.slice("mcp.json#".length)))
    const files: Record<string, string> = {}
    const entries = bundle.manifest.entries.filter((entry) => entry.action === "package" ? names.has(entry.unit.split("/")[1]!) : entry.action === "mcp-pending" ? servers.size > 0 : input.keys.has(entry.unit))
      .map((entry) => {
        if (entry.action !== "mcp-pending") return input.allowCode && entry.action === "quarantine" ? { ...entry, action: "write" as const } : entry
        // Only the chosen servers travel: the hub compares whole configurations, so a server that was not chosen would be replaced and disabled pending approval.
        const parsed = JSON.parse(Buffer.from(bundle.files[entry.path]!, "base64").toString("utf8")) as { servers?: Record<string, unknown> }
        const text = JSON.stringify({ ...parsed, servers: Object.fromEntries(Object.entries(parsed.servers ?? {}).filter(([name]) => servers.has(name))) }, null, 2)
        files[entry.path] = Buffer.from(text, "utf8").toString("base64")
        return { ...entry, sha256: sha256(text), bytes: Buffer.byteLength(text) }
      })
    for (const entry of entries) files[entry.path] ??= bundle.files[entry.path]!
    const manifest = {
      ...bundle.manifest, entries,
      packages: bundle.manifest.packages.filter((pkg) => names.has(pkg.name)).map((pkg) => input.allowCode ? { ...pkg, autoRuns: [] } : pkg),
      settings: { portable: {}, approval: {}, machine: {}, withheld: [] }, excluded: [], warnings: [],
    }
    return { manifest, manifestSha256: manifestHash(manifest), files }
  }

  async function connect(remote: string): Promise<Remote> {
    const target = remoteTarget(ports.dir, remote, undefined, "PARITY")
    const { createClient } = await import("@mendcode/client")
    const client = createClient({ name: "parity", remote: target, reconnect: false, timeoutMs: 60_000 })
    await client.connect()
    return client as unknown as Remote
  }
  async function call(remote: Remote, input: ConfigParityInput) {
    const reply = await remote.send({ type: "config.parity", input })
    if (!reply.ok) throw new Error(`[PARITY]: ${reply.error.message.replace(/^\[PARITY\]: /, "")}`)
    return reply.result ?? {}
  }
  const hubName = (requested: string | undefined) => {
    if (requested) return requested
    const config = (() => { try { return readSyncConfig(ports.dir) } catch { return undefined } })()
    if (config) return config.remote
    try {
      const profiles = JSON.parse(readFileSync(path.join(ports.dir, "remotes.json"), "utf8")) as { defaultRemote?: string }
      if (profiles.defaultRemote) return profiles.defaultRemote
    } catch {}
    throw new Error("[PARITY]: name the saved remote: `mendcode sync parity REMOTE` (mendcode remote list)")
  }

  async function runOnce(input: { remote?: string; apply?: boolean; allowFlagged?: readonly string[]; allowCode?: boolean }): Promise<ParityOutcome> {
    const remoteName = hubName(input.remote)
    const allowCode = input.allowCode === true
    const remote = await connect(remoteName)
    try {
      const here = await manifest(true, input.allowFlagged ?? [])
      const hub = await call(remote, { op: "manifest", tools: true }).then((result) => result.manifest as ParityManifest)
      const before = compareManifests({ here, hub, allowCode })
      // What the credential scan withholds here has no unit to compare: it is listed, with the way to send it, instead of passing for hub-only or nothing to send.
      for (const entry of here.blocked) {
        if (before.some((row) => row.key !== undefined && (row.key === entry.item || row.key.startsWith(`${entry.item}/`) || entry.item.startsWith(`${row.key}/`)))) continue
        if (entry.item === "mcp.json" || entry.item.startsWith("packages/")) continue
        before.push({ kind: kindOf(entry.item), item: entry.item, state: "blocked", note: `withheld here: ${entry.reason.slice(0, 200)}; name it with --allow-flagged to send it` })
      }
      // A unit the hub holds as a link (`skills` pointing into a checkout) is never written through.
      const hubBlocked = new Map(hub.blocked.map((entry) => [entry.item, entry.reason]))
      for (const row of before) {
        const parts = row.key?.split("#")[0]!.split("/") ?? []
        const reason = parts.length ? hubBlocked.get(parts.join("/")) ?? hubBlocked.get(parts.slice(0, 2).join("/")) ?? hubBlocked.get(parts[0]!) : undefined
        if (reason && ["missing", "differs", "state"].includes(row.state)) { row.state = "blocked"; row.note = `there: ${reason}` }
      }
      holdForPlatform({ rows: before, here, hub, allowFlagged: input.allowFlagged ?? [] })
      const outcome: ParityOutcome = { remote: remoteName, applied: false, before, counts: parityCounts(before), versions: { ...(here.mendcode.version ? { here: here.mendcode.version } : {}), ...(hub.mendcode.version ? { there: hub.mendcode.version } : {}) } }
      if (input.apply !== true) return outcome
      const wanted = before.filter((row) => ["missing", "differs", "state"].includes(row.state) && row.key !== undefined)
      if (!wanted.length) return { ...outcome, applied: true, after: before }
      const bundle = await exportHere(input.allowFlagged ?? [])
      const present = new Set([...bundle.manifest.entries.filter((entry) => entry.action !== "package").map((entry) => entry.unit), ...bundle.manifest.packages.map((pkg) => `packages/${pkg.name}`), ...(bundle.manifest.entries.some((entry) => entry.action === "mcp-pending") ? Object.keys(here.mcp).map((name) => `mcp.json#${name}`) : [])])
      const keys = new Set<string>()
      for (const row of wanted) {
        if (present.has(row.key!)) { keys.add(row.key!); continue }
        const why = bundle.manifest.excluded.find((entry) => row.key === entry.path || row.key!.startsWith(`${entry.path}/`) || entry.path.startsWith(`${row.key}/`))
        row.state = "blocked"
        row.note = why ? why.reason.slice(0, 300) : "not exported"
      }
      outcome.before = before
      outcome.counts = parityCounts(before)
      if (!keys.size) return { ...outcome, applied: true, after: before }
      const text = serializeBundle(subset(bundle, { keys, allowCode }))
      const bytes = Buffer.from(text, "utf8")
      if (bytes.length > PARITY_MAX_BUNDLE_BYTES) throw new Error(`[PARITY]: the difference is ${Math.round(bytes.length / 1024 / 1024)} MB; the most parity sends at once is ${PARITY_MAX_BUNDLE_BYTES / 1024 / 1024} MB: send it in parts or use config-bundle`)
      const id = randomBytes(12).toString("hex")
      for (let offset = 0; offset < bytes.length; offset += PARITY_CHUNK_BYTES) await call(remote, { op: "stage", id, offset, total: bytes.length, data: bytes.subarray(offset, offset + PARITY_CHUNK_BYTES).toString("base64") })
      const done = await call(remote, { op: "apply", id, sha256: createHash("sha256").update(bytes).digest("hex") }) as NonNullable<ParityOutcome["import"]>
      const hubAfter = await call(remote, { op: "manifest", tools: true }).then((result) => result.manifest as ParityManifest)
      const after = compareManifests({ here, hub: hubAfter, allowCode })
      for (const row of after) {
        if (row.kind === "mcp" && row.state === "same") row.note = "pending approval there (/mcp); sign-in stays per machine"
        const was = before.find((entry) => entry.kind === row.kind && entry.item === row.item)
        if (was?.state === "blocked" && row.state !== "same") { row.state = "blocked"; if (was.note) row.note = was.note }
        // The hub's own comparison leaves out what its credential scan flags, so a resource sent by name cannot show there; the import's own report says whether it was taken.
        else if (row.key !== undefined && row.state === "missing" && keys.has(row.key) && (input.allowFlagged ?? []).some((entry) => row.key === entry || row.key!.startsWith(`${entry}/`)) && !done.blocked.some((line) => line.startsWith(`${row.key}:`))) { row.state = "same"; row.note = "sent by name" }
      }
      return { ...outcome, applied: true, after, import: done, counts: parityCounts(after) }
    } finally { try { remote.close() } catch {} }
  }

  return {
    manifest: (tools: boolean) => manifest(tools),
    stage,
    apply,
    /** This machine against a saved remote; one at a time, in the order asked. A request identical to one already waiting or running shares its answer; a different one (another remote, apply, allowances) runs after it. */
    run(input: { remote?: string; apply?: boolean; allowFlagged?: readonly string[]; allowCode?: boolean }) {
      const key = JSON.stringify([input.remote ?? null, input.apply === true, [...(input.allowFlagged ?? [])].sort(), input.allowCode === true])
      const same = pending.get(key)
      if (same) return same
      const started = queue.then(() => runOnce(input))
      const result = started.finally(() => { if (pending.get(key) === result) pending.delete(key) })
      pending.set(key, result)
      queue = result.then(() => undefined, () => undefined)
      return result
    },
  }
}
export type Parity = ReturnType<typeof createParity>

/** One line for `sync status`: what a following round found. */
export function paritySummary(outcome: ParityOutcome): string {
  const counts = outcome.counts
  const open = counts.missing + counts.differs + counts.state
  const rest = [counts.code ? `${counts.code} code` : "", counts.blocked ? `${counts.blocked} blocked` : "", counts["no-tool"] ? `${counts["no-tool"]} tool missing` : ""].filter(Boolean)
  return `${outcome.remote}: ${open === 0 ? "level" : `${open} still differ`}${rest.length ? ` · ${rest.join(" · ")}` : ""}${outcome.import ? ` · import ${outcome.import.importId}` : ""}`
}
