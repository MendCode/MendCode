import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { activationStateJson, parseActivationState } from "@mendcode/protocol/wire"
import { addMcpConfig } from "../mcp-config"
import { mcpPendingBudget } from "../mcp-pending-budget"
import { canonicalJson, ConfigBundleError, entryBytes, sha256, type Bundle } from "./bundle"
import { CONFIG_IMPORTS_DIR } from "./classify"
import { compareWithBundle, type CompareReport } from "./compare"
import { installedTreeHash } from "./export"
import { linkOnPath, targetBytes, type ImportPlan, type PlanStep } from "./plan"

/** What an import asks the running daemon to do, through the same commands `/packages`, `/settings` and the CLI use. */
export type ImportPorts = {
  settings(): Promise<Record<string, unknown>>
  /** `settings.set`: validated by the daemon, every client hears it. */
  setSettings(patch: Record<string, unknown>): Promise<void>
  /** `packages.install` of a local folder (the audited installer; it enables the package and may refuse the look). */
  installPackage(input: { dir: string; replace: boolean }): Promise<void>
  /** `packages.enable`. */
  enablePackage(input: { key: string; enabled: boolean }): Promise<void>
  /** `packages.remove` (to the Trash). */
  removePackage(input: { name: string }): Promise<void>
  /** `packages.resource`. */
  setPackageResource(input: { key: string; resource: string; enabled: boolean }): Promise<void>
}

type Written = { path: string; sha256: string }
/** `undone` is set once a rollback reverted the entry, so running rollback again resumes where it stopped. */
export type JournalOp = (
  | { type: "unit"; unit: string; backup?: string; written: Written[] }
  | { type: "file"; path: string; backup?: string; afterSha256: string; mcpServers?: string[] }
  | { type: "package"; name: string; change: "new" | "replace" | "state"; backup?: string; before: { installed: boolean; enabled: boolean; disabledResources: string[]; listedOff: boolean }; after: { enabled: boolean; disabledResources: string[] } }
  | { type: "settings"; before: Record<string, unknown>; after: Record<string, unknown> }
) & { undone?: boolean }

export type ImportJournal = {
  version: 1
  importId: string
  planId: string
  bundleSha256: string
  createdAt: number
  dataDir: string
  state: "applying" | "applied" | "rolled-back" | "failed"
  ops: JournalOp[]
  quarantine: string[]
  notes: string[]
}

export type ImportResult = { importId: string; folder: string; journal: ImportJournal; report: CompareReport; pendingFile?: string; quarantineFolder?: string }

const importsRoot = (dataDir: string) => path.join(dataDir, CONFIG_IMPORTS_DIR)
const IMPORT_ID = /^imp-[0-9a-z]+-[0-9a-f]{6}$/

function atomicWrite(file: string, bytes: Uint8Array, executable = false) {
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`
  writeFileSync(temporary, bytes, { mode: executable ? 0o755 : 0o644 })
  if (executable) chmodSync(temporary, 0o755)
  renameSync(temporary, file)
}

function saveJournal(folder: string, journal: ImportJournal) {
  atomicWrite(path.join(folder, "journal.json"), Buffer.from(`${JSON.stringify(journal, null, 2)}\n`))
}

const fileSha = (file: string) => { try { return sha256(readFileSync(file)) } catch { return undefined } }

/** Moves what a unit holds now into the import's backup folder; returns its place there, or undefined when there was nothing. */
function backupPath(input: { dataDir: string; folder: string; relative: string }) {
  const from = path.join(input.dataDir, input.relative)
  if (!lstatSync(from, { throwIfNoEntry: false })) return undefined
  const to = path.join(input.folder, "backup", input.relative)
  mkdirSync(path.dirname(to), { recursive: true })
  renameSync(from, to)
  return path.relative(input.folder, to)
}

/** Copies a file into the backup folder (it stays in place, to be replaced by a merge). */
function backupCopy(input: { dataDir: string; folder: string; relative: string }) {
  const from = path.join(input.dataDir, input.relative)
  if (!lstatSync(from, { throwIfNoEntry: false })?.isFile()) return undefined
  const to = path.join(input.folder, "backup", input.relative)
  mkdirSync(path.dirname(to), { recursive: true })
  cpSync(from, to)
  return path.relative(input.folder, to)
}

/** Regular files under a unit (a folder or one file), relative to the data dir. */
function unitFiles(dataDir: string, unit: string): string[] {
  const full = path.join(dataDir, unit)
  const info = lstatSync(full, { throwIfNoEntry: false })
  if (!info) return []
  if (!info.isDirectory()) return [unit]
  return readdirSync(full, { recursive: true, withFileTypes: true }).filter((entry) => !entry.isDirectory()).map((entry) => path.relative(dataDir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
}

/** The installer and `packages.enable` refuse a second look owner with this sentence (`LookOwnedError`). */
const isLookRefusal = (error: unknown) => error instanceof Error && error.message.includes("owns the look")

/**
 * Applies a previewed plan. It refuses unless `planId` still matches (the target changed or the preview was another one),
 * writes every change with a backup and a journal entry first, and on any failure undoes what it already did. Code,
 * hooks and scripts only reach the quarantine folder; settings of the user's authority only reach `pending.json`.
 */
export async function applyImport(input: { bundle: Bundle; plan: ImportPlan; expectedPlanId: string; ports: ImportPorts; now: number; rewriteHome: boolean }): Promise<ImportResult> {
  const { bundle, plan, ports } = input
  if (input.expectedPlanId.length < 12 || !plan.planId.startsWith(input.expectedPlanId)) throw new ConfigBundleError(`the plan changed since the preview (now ${plan.planId.slice(0, 12)}): preview again and apply that plan`)
  const dataDir = plan.target.dataDir
  const rootLink = linkOnPath(dataDir, CONFIG_IMPORTS_DIR)
  if (rootLink) throw new ConfigBundleError(`${CONFIG_IMPORTS_DIR} is a link; refusing to keep backups through it`)
  const importId = `imp-${input.now.toString(36)}-${randomBytes(3).toString("hex")}`
  const folder = path.join(importsRoot(dataDir), importId)
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const journal: ImportJournal = { version: 1, importId, planId: plan.planId, bundleSha256: plan.bundleSha256, createdAt: input.now, dataDir, state: "applying", ops: [], quarantine: [], notes: [] }
  saveJournal(folder, journal)
  const entryFor = new Map(bundle.manifest.entries.map((entry) => [entry.path, entry]))
  const bytesFor = (relative: string) => targetBytes({ bundle, entry: entryFor.get(relative)!, home: plan.target.home, rewriteHome: input.rewriteHome }).bytes
  const record = (op: JournalOp) => { journal.ops.push(op); saveJournal(folder, journal) }
  try {
    for (const step of plan.steps) {
      if (step.kind === "unit" && (step.status === "new" || step.status === "replace")) {
        const backup = step.status === "replace" ? backupPath({ dataDir, folder, relative: step.unit }) : undefined
        const op: JournalOp = { type: "unit", unit: step.unit, ...(backup ? { backup } : {}), written: [] }
        record(op)
        for (const file of step.files) {
          atomicWrite(path.join(dataDir, file.path), bytesFor(file.path), file.executable)
          op.written.push({ path: file.path, sha256: file.sha256 })
        }
        saveJournal(folder, journal)
      }
      if (step.kind === "package" && step.status === "quarantine") {
        for (const entry of bundle.manifest.entries) if (entry.path.startsWith(`packages/${step.name}/`)) {
          atomicWrite(path.join(folder, "quarantine", entry.path), bytesFor(entry.path), false)
          journal.quarantine.push(entry.path)
        }
        saveJournal(folder, journal)
      }
      if (step.kind === "quarantine") {
        for (const file of step.files) {
          atomicWrite(path.join(folder, "quarantine", file.path), bytesFor(file.path), false)
          journal.quarantine.push(file.path)
        }
        saveJournal(folder, journal)
      }
    }
    await applyMcp({ plan, bundle, dataDir, folder, record, save: () => saveJournal(folder, journal), now: input.now })
    for (const step of plan.steps) if (step.kind === "package") await applyPackage({ step, bundle, dataDir, folder, ports, record, journal, bytesFor })
    const settingSteps = plan.steps.filter((step): step is Extract<PlanStep, { kind: "setting" }> => step.kind === "setting" && (step.status === "new" || step.status === "replace"))
    if (settingSteps.length) {
      const current = await ports.settings()
      const after = Object.fromEntries(settingSteps.map((step) => [step.key, step.value]))
      const before = Object.fromEntries(settingSteps.map((step) => [step.key, step.key in current ? current[step.key] : null]))
      record({ type: "settings", before, after })
      await ports.setSettings(after)
    }
    mergeJson({ plan, dataDir, folder, record, relative: "tui/profile.json", patch: Object.fromEntries(plan.steps.filter((step): step is Extract<PlanStep, { kind: "profile" }> => step.kind === "profile" && (step.status === "new" || step.status === "replace")).map((step) => [step.key, step.value])) })
    const activation = plan.steps.find((step): step is Extract<PlanStep, { kind: "activation" }> => step.kind === "activation" && step.status === "merge")
    if (activation) {
      const file = path.join(dataDir, "activation.json")
      const current = parseActivationState((() => { try { return JSON.parse(readFileSync(file, "utf8")) } catch { return {} } })())
      if (activation.look && current.look && current.look !== activation.look) journal.notes.push(`activation: the look belongs to ${current.look} here, not ${activation.look}; the keys kept by hand (${activation.kept.join(", ")}) were not applied`)
      else {
        const next = { ...current, ...(current.look ? {} : activation.look ? { look: activation.look } : {}), kept: [...new Set([...current.kept, ...activation.kept])], ...(activation.saved || current.saved ? { saved: { ...activation.saved, ...current.saved } } : {}) }
        const backup = backupCopy({ dataDir, folder, relative: "activation.json" })
        const bytes = Buffer.from(activationStateJson(next))
        record({ type: "file", path: "activation.json", ...(backup ? { backup } : {}), afterSha256: sha256(bytes) })
        atomicWrite(file, bytes)
      }
    }
    const pending = plan.steps.filter((step): step is Extract<PlanStep, { kind: "pending" }> => step.kind === "pending")
    const pendingFile = pending.length ? path.join(folder, "pending.json") : undefined
    if (pendingFile) atomicWrite(pendingFile, Buffer.from(`${JSON.stringify({ importId, note: "Not applied. Each change needs your approval on this machine: /settings, /customize, /permissions, or ask in a session to propose them with mendcode_settings (you approve each card).", items: pending, approvalSettings: bundle.manifest.settings.approval, withheld: bundle.manifest.settings.withheld }, null, 2)}\n`))
    journal.state = "applied"
    saveJournal(folder, journal)
    const report = compareWithBundle({ plan, dataDir, settings: await ports.settings() })
    atomicWrite(path.join(folder, "report.json"), Buffer.from(`${JSON.stringify({ importId, planId: plan.planId, report, warnings: plan.warnings, notes: journal.notes, precedence: plan.precedence }, null, 2)}\n`))
    rmSync(path.join(folder, "stage"), { recursive: true, force: true })
    return { importId, folder, journal, report, ...(pendingFile ? { pendingFile } : {}), ...(journal.quarantine.length ? { quarantineFolder: path.join(folder, "quarantine") } : {}) }
  } catch (error) {
    journal.notes.push(`apply failed: ${error instanceof Error ? error.message : String(error)}`)
    saveJournal(folder, journal)
    const undone = await rollbackImport({ dataDir, importId, ports, force: true }).catch((rollbackError: unknown) => ({ problems: [String(rollbackError)] }))
    // The rollback wrote its own marks into the journal on disk: keep them, and say the import failed.
    const after = (() => { try { return JSON.parse(readFileSync(path.join(folder, "journal.json"), "utf8")) as ImportJournal } catch { return journal } })()
    after.state = "failed"
    after.notes.push(...undone.problems.map((problem) => `rollback: ${problem}`))
    saveJournal(folder, after)
    throw new ConfigBundleError(`import failed and was undone: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function applyMcp(input: { plan: ImportPlan; bundle: Bundle; dataDir: string; folder: string; record: (op: JournalOp) => void; save: () => void; now: number }) {
  const steps = input.plan.steps.filter((step): step is Extract<PlanStep, { kind: "mcp" }> => step.kind === "mcp" && (step.status === "new" || step.status === "replace"))
  if (!steps.length) return
  const entry = input.bundle.manifest.entries.find((item) => item.action === "mcp-pending")!
  const servers = (JSON.parse(entryBytes(input.bundle, entry).toString("utf8")) as { servers: Record<string, Parameters<typeof addMcpConfig>[0]["config"]> }).servers
  const backup = backupCopy({ dataDir: input.dataDir, folder: input.folder, relative: "mcp.json" })
  const op: JournalOp = { type: "file", path: "mcp.json", ...(backup ? { backup } : {}), afterSha256: "", mcpServers: steps.map((step) => step.name) }
  input.record(op)
  // The same path `/import setup` and REST use: each server is stored disabled with a pending approval the user answers in /mcp.
  for (const step of steps) addMcpConfig({ dir: input.dataDir, directory: input.dataDir, name: step.name, scope: "user", config: servers[step.name]!, replace: step.status === "replace", pending: true, now: input.now })
  op.afterSha256 = fileSha(path.join(input.dataDir, "mcp.json")) ?? ""
  input.save()
}

async function applyPackage(input: { step: PlanStep; bundle: Bundle; dataDir: string; folder: string; ports: ImportPorts; record: (op: JournalOp) => void; journal: ImportJournal; bytesFor: (relative: string) => Buffer }) {
  const { step, ports } = input
  if (step.kind !== "package" || !["new", "replace"].includes(step.status)) return
  const key = `user:${step.name}`
  const settings = await ports.settings()
  const disabledResources = (Array.isArray(settings.disabledPackageResources) ? settings.disabledPackageResources as string[] : []).filter((entry) => entry.startsWith(`${key}/`)).map((entry) => entry.slice(key.length + 1))
  const listedOff = (Array.isArray(settings.disabledPackages) ? settings.disabledPackages as string[] : []).includes(key)
  const before = { installed: Boolean(step.current), enabled: step.current?.enabled ?? false, disabledResources, listedOff }
  const sameTree = step.current?.treeSha256 === step.treeSha256
  const change: "new" | "replace" | "state" = !step.current ? "new" : sameTree ? "state" : "replace"
  let backup: string | undefined
  if (change === "replace") {
    const to = path.join(input.folder, "backup", "packages", step.name)
    mkdirSync(path.dirname(to), { recursive: true })
    cpSync(path.join(input.dataDir, "packages", step.name), to, { recursive: true, verbatimSymlinks: true })
    backup = path.relative(input.folder, to)
  }
  input.record({ type: "package", name: step.name, change, ...(backup ? { backup } : {}), before, after: { enabled: step.enabled, disabledResources: step.disabledResources } })
  if (change !== "state") {
    const stage = path.join(input.folder, "stage", step.name)
    for (const entry of input.bundle.manifest.entries) if (entry.path.startsWith(`packages/${step.name}/`)) {
      const target = path.join(stage, entry.path.slice(`packages/${step.name}/`.length))
      atomicWrite(target, input.bytesFor(entry.path), entry.executable)
    }
    try { await ports.installPackage({ dir: stage, replace: change === "replace" }) } catch (error) {
      // Another package owns the look: the installer keeps this one installed and off. That is the state to report, not a failure.
      if (!(isLookRefusal(error) && existsSync(path.join(input.dataDir, "packages", step.name)))) throw error
      if (step.enabled) input.journal.notes.push(`packages/${step.name}: installed but off, another package owns the look (${error instanceof Error ? error.message : ""}); /packages switches it`)
    }
  }
  const now = await ports.settings()
  const on = !(Array.isArray(now.disabledPackages) ? now.disabledPackages as string[] : []).includes(key)
  if (on !== step.enabled) {
    try { await ports.enablePackage({ key, enabled: step.enabled }) } catch (error) {
      if (!isLookRefusal(error)) throw error
      input.journal.notes.push(`packages/${step.name}: left off, another package owns the look; /packages switches it`)
    }
  }
  for (const resource of step.disabledResources) if (!disabledResources.includes(resource)) await ports.setPackageResource({ key, resource, enabled: false })
  const tree = installedTreeHash(path.join(input.dataDir, "packages", step.name))
  if (tree?.sha256 !== step.treeSha256) input.journal.notes.push(`packages/${step.name}: the installed files differ from the bundle (${tree?.sha256.slice(0, 12) ?? "unreadable"})`)
}

/** Merges keys into a JSON object file, keeping the file's other keys; backs the old file up first. */
function mergeJson(input: { plan: ImportPlan; dataDir: string; folder: string; record: (op: JournalOp) => void; relative: string; patch: Record<string, unknown> }) {
  if (!Object.keys(input.patch).length) return
  const file = path.join(input.dataDir, input.relative)
  let current: Record<string, unknown> = {}
  try { const parsed = JSON.parse(readFileSync(file, "utf8")); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ConfigBundleError(`${input.relative} on this machine is not valid JSON; fix it before importing`)
  }
  const backup = backupCopy({ dataDir: input.dataDir, folder: input.folder, relative: input.relative })
  const bytes = Buffer.from(`${JSON.stringify({ ...current, ...input.patch }, null, 2)}\n`)
  input.record({ type: "file", path: input.relative, ...(backup ? { backup } : {}), afterSha256: sha256(bytes) })
  atomicWrite(file, bytes)
}

/** Every import of this data directory, newest first. */
export function listImports(dataDir: string): ImportJournal[] {
  const root = importsRoot(path.resolve(dataDir))
  if (!existsSync(root)) return []
  return readdirSync(root).filter((name) => IMPORT_ID.test(name)).flatMap((name) => {
    try { return [JSON.parse(readFileSync(path.join(root, name, "journal.json"), "utf8")) as ImportJournal] } catch { return [] }
  }).sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * Undoes one import from its journal, newest change first. A change made by hand since the import is left alone and
 * reported (unless `force`): rollback never overwrites work it did not write.
 */
export async function rollbackImport(input: { dataDir: string; importId: string; ports: ImportPorts; force?: boolean }): Promise<{ importId: string; undone: string[]; skipped: string[]; problems: string[] }> {
  if (!IMPORT_ID.test(input.importId)) throw new ConfigBundleError(`not an import id: ${input.importId}`)
  const dataDir = path.resolve(input.dataDir)
  const folder = path.join(importsRoot(dataDir), input.importId)
  let journal: ImportJournal
  try { journal = JSON.parse(readFileSync(path.join(folder, "journal.json"), "utf8")) as ImportJournal } catch { throw new ConfigBundleError(`no journal for ${input.importId}`) }
  if (journal.state === "rolled-back") return { importId: input.importId, undone: [], skipped: ["already rolled back"], problems: [] }
  const undone: string[] = [], skipped: string[] = [], problems: string[] = []
  const restore = (backup: string | undefined, relative: string) => {
    if (!backup) return
    const to = path.join(dataDir, relative)
    mkdirSync(path.dirname(to), { recursive: true })
    renameSync(path.join(folder, backup), to)
  }
  for (const op of [...journal.ops].reverse()) {
    if (op.undone) continue
    const doneBefore = undone.length
    try {
      if (op.type === "unit") {
        const changed = op.written.filter((file) => fileSha(path.join(dataDir, file.path)) !== file.sha256)
        const added = unitFiles(dataDir, op.unit).filter((file) => !op.written.some((written) => written.path === file))
        if ((changed.length || added.length) && !input.force) { skipped.push(`${op.unit}: changed since the import (${[...changed.map((file) => file.path), ...added].join(", ")})`); continue }
        rmSync(path.join(dataDir, op.unit), { recursive: true, force: true })
        restore(op.backup, op.unit)
        undone.push(op.unit)
      } else if (op.type === "file") {
        if (op.afterSha256 && fileSha(path.join(dataDir, op.path)) !== op.afterSha256 && !input.force) { skipped.push(`${op.path}: changed since the import`); continue }
        if (op.backup) { rmSync(path.join(dataDir, op.path), { force: true }); restore(op.backup, op.path) }
        else rmSync(path.join(dataDir, op.path), { force: true })
        // Pending MCP servers hold a slot of the daemon-wide pending budget until they expire: give the slots back.
        for (const name of op.mcpServers ?? []) mcpPendingBudget(dataDir, `${path.resolve(path.join(dataDir, op.path))}\0${name}`, undefined, Date.now())
        undone.push(op.path)
      } else if (op.type === "package") {
        const key = `user:${op.name}`
        // The resource switches this import turned off go back on first, while the package is still installed.
        for (const resource of op.after.disabledResources) if (!op.before.disabledResources.includes(resource)) await input.ports.setPackageResource({ key, resource, enabled: true })
        if (op.change === "new") {
          await input.ports.removePackage({ name: op.name })
          const listed = await input.ports.settings()
          const off = Array.isArray(listed.disabledPackages) ? listed.disabledPackages as string[] : []
          if (!op.before.listedOff && off.includes(key)) await input.ports.setSettings({ disabledPackages: off.length > 1 ? off.filter((entry) => entry !== key) : null })
        } else {
          if (op.change === "replace" && op.backup) {
            await input.ports.removePackage({ name: op.name })
            await input.ports.installPackage({ dir: path.join(folder, op.backup), replace: false }).catch((error: unknown) => { if (!isLookRefusal(error)) throw error })
          }
          const now = await input.ports.settings()
          const on = !(Array.isArray(now.disabledPackages) ? now.disabledPackages as string[] : []).includes(key)
          if (on !== op.before.enabled) await input.ports.enablePackage({ key, enabled: op.before.enabled }).catch((error: unknown) => { if (!isLookRefusal(error)) throw error; problems.push(`packages/${op.name}: could not switch back on, another package owns the look`) })
        }
        undone.push(`packages/${op.name}`)
      } else if (op.type === "settings") {
        const current = await input.ports.settings()
        const keys = Object.keys(op.after).filter((key) => input.force || canonicalJson(current[key]) === canonicalJson(op.after[key]))
        for (const key of Object.keys(op.after)) if (!keys.includes(key)) skipped.push(`settings.${key}: changed since the import`)
        if (keys.length) await input.ports.setSettings(Object.fromEntries(keys.map((key) => [key, op.before[key] ?? null])))
        undone.push(...keys.map((key) => `settings.${key}`))
      }
      if (undone.length > doneBefore && !(op.type === "settings" && Object.keys(op.after).some((key) => !undone.includes(`settings.${key}`)))) op.undone = true
    } catch (error) {
      problems.push(`${op.type === "unit" ? op.unit : op.type === "file" ? op.path : op.type === "package" ? `packages/${op.name}` : "settings"}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (!skipped.length && !problems.length) journal.state = "rolled-back"
  journal.notes.push(`rollback: ${undone.length} undone, ${skipped.length} skipped, ${problems.length} problems`)
  saveJournal(folder, journal)
  return { importId: input.importId, undone, skipped, problems }
}
