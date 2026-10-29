import { existsSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { CommandInput } from "@mendcode/client"
import type { Common } from "./automation"
import type { ConfigBundleAutomation } from "./config-bundle-args"
import { startedBySession } from "./agent-origin"

type Reply = { ok: true; result: Record<string, unknown> } | { ok: false; code: string; message: string }
type Context = {
  directory: string
  allowFiles?: boolean
  env?: Record<string, string | undefined>
  home?: string
  now(): number
  version: string
  request(command: CommandInput): Promise<Reply>
  result(data: Record<string, unknown>, human: string): number
  fail(message: string, exit?: number, code?: string): number
}

const COLUMNS = { exportable: "exportable today", omitted: "omitted", machine: "machine-specific", approval: "needs authentication or approval", "not-portable": "not portable" } as const

/**
 * `config-bundle`: the user's own MendCode setup in one verifiable file, separate from packages. Files are read and written
 * here, on this machine (never for a remote attachment); every setting, package and profile change goes through the
 * daemon's own commands. The bundle module (zod) loads only when this command runs.
 */
export function createConfigBundleAutomation(ctx: Context) {
  const daemon = async (command: CommandInput) => {
    const reply = await ctx.request(command)
    if (!reply.ok) throw new Error(reply.message)
    return reply.result
  }
  const settings = async () => (await daemon({ type: "settings.get" })).settings as Record<string, unknown>
  const dataDir = async () => {
    const facts = (await daemon({ type: "system.query", directory: ctx.directory, operation: "config-paths" })).facts as { paths?: { data?: string } } | undefined
    if (!facts?.paths?.data) throw new Error("the daemon did not report its data directory")
    return facts.paths.data
  }
  const ports = {
    settings,
    setSettings: async (patch: Record<string, unknown>) => { await daemon({ type: "settings.set", patch }) },
    installPackage: async (input: { dir: string; replace: boolean }) => { await daemon({ type: "packages.install", directory: ctx.directory, source: input.dir, scope: "user", ...(input.replace ? { replace: true } : {}) }) },
    enablePackage: async (input: { key: string; enabled: boolean }) => { await daemon({ type: "packages.enable", directory: ctx.directory, key: input.key, enabled: input.enabled }) },
    removePackage: async (input: { name: string }) => { await daemon({ type: "packages.remove", directory: ctx.directory, name: input.name, scope: "user" }) },
    setPackageResource: async (input: { key: string; resource: string; enabled: boolean }) => { await daemon({ type: "packages.resource", directory: ctx.directory, key: input.key, resource: input.resource, enabled: input.enabled }) },
  }
  const home = ctx.home ?? ctx.env?.HOME ?? ""
  const fromSession = (dir: string) => startedBySession({ env: ctx.env ?? {}, dir })

  return async (command: ConfigBundleAutomation & Common): Promise<number> => {
    if (ctx.allowFiles === false) return ctx.fail("config-bundle reads and writes this machine's data directory: local only", 64, "usage")
    const bundles = await import("@mendcode/daemon/config-bundle")
    try {
      const dir = await dataDir()
      const resolveFile = (file: string) => path.resolve(ctx.directory, file)
      if (command.kind === "config-bundle.inventory" || command.kind === "config-bundle.export") {
        const adapter = (await daemon({ type: "system.query", directory: ctx.directory, operation: "adapter-status" })).facts as { adapter?: { buildId?: string | null } } | undefined
        const { bundle, inventory } = bundles.exportBundle({ dataDir: dir, settings: await settings(), home, platform: process.platform, arch: process.arch, now: ctx.now(), mendcodeVersion: ctx.version, buildId: adapter?.adapter?.buildId ?? undefined, ...(command.kind === "config-bundle.export" ? { allowFlagged: command.allowFlagged } : {}) })
        if (command.kind === "config-bundle.inventory") {
          const lines = [`data directory: ${dir}`]
          for (const [column, label] of Object.entries(COLUMNS)) {
            const rows = inventory.filter((row) => row.column === column)
            if (!rows.length) continue
            lines.push("", `${label} (${rows.length})`)
            for (const row of rows) lines.push(`  ${row.item}${row.files ? ` · ${row.files} file${row.files === 1 ? "" : "s"}` : ""} — ${row.reason}`)
          }
          if (bundle.manifest.warnings.length) lines.push("", "warnings", ...bundle.manifest.warnings.map((line) => `  ${line}`))
          return ctx.result({ dataDir: dir, inventory, warnings: bundle.manifest.warnings }, `${lines.join("\n")}\n`)
        }
        const target = resolveFile(command.file)
        if (existsSync(target) && !command.overwrite) return ctx.fail(`${target} exists; pass --overwrite to replace it`, 64, "usage")
        const text = bundles.serializeBundle(bundle)
        writeFileSync(target, text, { mode: 0o600 })
        const manifest = bundle.manifest
        const summary = { file: target, manifestSha256: bundle.manifestSha256, entries: manifest.entries.length, bytes: Buffer.byteLength(text), packages: manifest.packages.map((pkg) => `${pkg.name}${pkg.enabled ? "" : " (off)"}`), settings: { applied: Object.keys(manifest.settings.portable), approval: Object.keys(manifest.settings.approval), machine: Object.keys(manifest.settings.machine), withheld: manifest.settings.withheld }, excluded: manifest.excluded, warnings: manifest.warnings }
        const lines = [
          `exported ${manifest.entries.length} files (${Buffer.byteLength(text)} bytes) to ${target}`, `manifest sha256 ${bundle.manifestSha256}`,
          `packages: ${summary.packages.join(", ") || "none"}`,
          `settings applied on import: ${summary.settings.applied.join(", ") || "none"}`,
          `settings waiting for approval on the target: ${summary.settings.approval.join(", ") || "none"}`,
          `settings of this machine (shown, never applied): ${summary.settings.machine.join(", ") || "none"}`,
          `left out (${manifest.excluded.length}):`, ...manifest.excluded.map((entry) => `  ${entry.path} [${COLUMNS[entry.column]}] ${entry.reason}`),
          ...(manifest.warnings.length ? ["warnings:", ...manifest.warnings.map((line) => `  ${line}`)] : []),
        ]
        return ctx.result(summary, `${lines.join("\n")}\n`)
      }
      if (command.kind === "config-bundle.inspect") {
        const bundle = bundles.readBundle(resolveFile(command.file))
        const manifest = bundle.manifest
        const lines = [
          `valid bundle v${manifest.version}: ${manifest.entries.length} files, every sha256 checked; manifest ${bundle.manifestSha256}`,
          `from ${manifest.source.platform}/${manifest.source.arch} ${manifest.source.dataDir}${manifest.source.mendcodeVersion ? ` · MendCode ${manifest.source.mendcodeVersion}` : ""}${manifest.source.buildId ? ` · ${manifest.source.buildId}` : ""} · ${new Date(manifest.createdAt).toISOString()}`,
          `packages: ${manifest.packages.map((pkg) => `${pkg.name}@${pkg.version ?? "?"}${pkg.enabled ? "" : " (off)"}${pkg.autoRuns.length ? ` runs ${pkg.autoRuns.join(",")}` : ""}`).join(", ") || "none"}`,
          `files by action: ${Object.entries(manifest.entries.reduce<Record<string, number>>((count, entry) => ({ ...count, [entry.action]: (count[entry.action] ?? 0) + 1 }), {})).map(([action, count]) => `${action} ${count}`).join(", ")}`,
          `left out: ${manifest.excluded.length} · warnings: ${manifest.warnings.length}`,
        ]
        return ctx.result({ manifest: { ...manifest, entries: manifest.entries.map(({ path: entryPath, action, sha256, bytes }) => ({ path: entryPath, action, sha256, bytes })) }, manifestSha256: bundle.manifestSha256 }, `${lines.join("\n")}\n`)
      }
      if (command.kind === "config-bundle.imports") {
        const imports = bundles.listImports(dir)
        return ctx.result({ imports: imports.map(({ importId, state, createdAt, planId, ops, quarantine, notes }) => ({ importId, state, createdAt, planId, changes: ops.length, quarantined: quarantine.length, notes })) }, imports.length ? `${imports.map((entry) => `${entry.importId}  ${entry.state.padEnd(11)} ${new Date(entry.createdAt).toISOString()}  ${entry.ops.length} changes · ${entry.quarantine.length} quarantined`).join("\n")}\n` : "no imports\n")
      }
      if (command.kind === "config-bundle.rollback") {
        if (fromSession(dir)) return ctx.fail("a session cannot roll back an import: run it yourself in a terminal", 1, "forbidden")
        const outcome = await bundles.rollbackImport({ dataDir: dir, importId: command.importId, ports, force: command.force })
        const lines = [`rollback ${outcome.importId}: ${outcome.undone.length} undone, ${outcome.skipped.length} skipped, ${outcome.problems.length} problems`, ...outcome.skipped.map((line) => `  skipped ${line}`), ...outcome.problems.map((line) => `  problem ${line}`)]
        ctx.result(outcome, `${lines.join("\n")}\n`)
        return outcome.problems.length || outcome.skipped.length ? 1 : 0
      }
      const bundle = bundles.readBundle(resolveFile(command.file))
      const plan = bundles.planImport({ bundle, dataDir: dir, settings: await settings(), home, platform: process.platform, onConflict: command.onConflict, resolve: command.resolve, rewriteHome: command.rewriteHome })
      if (!command.apply) return ctx.result({ preview: true, plan }, planText({ plan, file: command.file, command }))
      if (fromSession(dir)) return ctx.fail("a session cannot apply a configuration import: run it yourself in a terminal", 1, "forbidden")
      const applied = await bundles.applyImport({ bundle, plan, expectedPlanId: command.plan!, ports, now: ctx.now(), rewriteHome: command.rewriteHome })
      const report = applied.report
      const lines = [
        `import ${applied.importId} applied · journal and backups in ${applied.folder}`,
        `comparison with the bundle: ${report.summary}`,
        ...report.rows.filter((row) => row.status !== "match").map((row) => `  ${row.status.padEnd(16)} ${row.item}${row.expected ? `  expected ${row.expected}` : ""}${row.obtained ? `  obtained ${row.obtained}` : ""}${row.note ? `  (${row.note})` : ""}`),
        ...(applied.pendingFile ? [`waiting for your approval: ${applied.pendingFile}`] : []),
        ...(applied.quarantineFolder ? [`quarantined, never loaded: ${applied.quarantineFolder}`] : []),
        ...applied.journal.notes.map((note) => `note: ${note}`),
        `undo with: config-bundle rollback ${applied.importId}`,
      ]
      ctx.result({ importId: applied.importId, folder: applied.folder, report, pendingFile: applied.pendingFile ?? null, quarantineFolder: applied.quarantineFolder ?? null, notes: applied.journal.notes }, `${lines.join("\n")}\n`)
      return 0
    } catch (error) {
      return ctx.fail(error instanceof Error ? error.message : String(error))
    }
  }
}

type PlanView = import("@mendcode/daemon/config-bundle").ImportPlan
function planText({ plan, file, command }: { plan: PlanView; file: string; command: Extract<ConfigBundleAutomation, { kind: "config-bundle.import" }> }) {
  const lines = [`preview only: nothing was changed · plan ${plan.planId.slice(0, 16)}`, `from ${plan.source.platform} ${plan.source.dataDir} into ${plan.target.platform} ${plan.target.dataDir}`]
  const count = (predicate: (step: PlanView["steps"][number]) => boolean) => plan.steps.filter(predicate).length
  lines.push(`write ${count((step) => step.kind === "unit" && (step.status === "new" || step.status === "replace"))} resources · identical ${count((step) => "status" in step && step.status === "identical")} · packages to install ${count((step) => step.kind === "package" && (step.status === "new" || step.status === "replace"))} · settings ${count((step) => step.kind === "setting" && (step.status === "new" || step.status === "replace"))} · profile keys ${count((step) => step.kind === "profile" && (step.status === "new" || step.status === "replace"))}`)
  const section = (title: string, rows: string[]) => { if (rows.length) lines.push("", `${title} (${rows.length})`, ...rows.map((row) => `  ${row}`)) }
  section("changes", plan.steps.flatMap((step) => step.kind === "unit" && (step.status === "new" || step.status === "replace") ? [`${step.status.padEnd(8)} ${step.unit}${step.files.some((entry) => entry.rewritten) ? " (home folder rewritten)" : ""}`]
    : step.kind === "package" && (step.status === "new" || step.status === "replace") ? [`${step.status.padEnd(8)} packages/${step.name} (${step.enabled ? "on" : "off"}) via the package installer`]
      : step.kind === "setting" && (step.status === "new" || step.status === "replace") ? [`${step.status.padEnd(8)} settings.${step.key} = ${JSON.stringify(step.value).slice(0, 80)}`]
        : step.kind === "profile" && (step.status === "new" || step.status === "replace") ? [`${step.status.padEnd(8)} tui/profile.json#${step.key} = ${JSON.stringify(step.value).slice(0, 60)}`]
          : step.kind === "mcp" && (step.status === "new" || step.status === "replace") ? [`${step.status.padEnd(8)} mcp.json#${step.name} (pending approval in /mcp)`]
            : step.kind === "activation" && step.status === "merge" ? [`merge    activation.json kept keys ${step.kept.join(", ")}`] : []))
  section("conflicts", plan.conflicts.map((conflict) => `${conflict.resolution.padEnd(8)} ${conflict.item}: ${conflict.detail}`))
  section("quarantined (copied, never loaded or run)", plan.steps.flatMap((step) => step.kind === "quarantine" ? [`${step.unit}: ${step.reason}`] : step.kind === "package" && step.status === "quarantine" ? [`packages/${step.name}: ${step.reason ?? ""}`] : []))
  section("waiting for your approval on this machine", plan.steps.flatMap((step) => step.kind === "pending" ? [`${step.item}: ${step.reason}${step.diff.length ? ` (${step.diff.slice(0, 2).join("; ")})` : ""}`] : []))
  section("blocked", plan.steps.flatMap((step) => "status" in step && step.status === "blocked" ? [`${step.kind === "unit" ? step.unit : step.kind === "package" ? `packages/${step.name}` : step.kind === "profile" ? `tui/profile.json#${step.key}` : step.kind === "mcp" ? `mcp.json#${step.name}` : step.kind}: ${"reason" in step ? step.reason ?? "" : ""}`] : []))
  section("precedence", plan.precedence)
  section("warnings", plan.warnings)
  section("left out by the export", plan.excluded.map((entry) => `${entry.path}: ${entry.reason}`))
  const options = [command.onConflict !== "keep" ? `--on-conflict ${command.onConflict}` : "", ...Object.entries(command.resolve).map(([item, choice]) => `--resolve ${item}=${choice}`), command.rewriteHome ? "--rewrite-home" : ""].filter(Boolean).join(" ")
  lines.push("", `apply exactly this plan: config-bundle import ${file} --apply --plan ${plan.planId.slice(0, 16)}${options ? ` ${options}` : ""}`)
  return `${lines.join("\n")}\n`
}
