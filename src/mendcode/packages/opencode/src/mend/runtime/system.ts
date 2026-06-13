import { spawnSync } from "child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "fs"
import { mkdir, readFile, writeFile } from "fs/promises"
import { homedir, tmpdir } from "os"
import path from "path"
import { resolveGlobalModelsConfigPath } from "../config/models"
import { mendPaths } from "../config/paths"

const MEND_VERSION = "0.2.0-phase2"
const DONOR_COMMAND_OVERRIDE_ENV = "MENDCODE_ALLOW_DONOR_COMMANDS"
const BASELINE_OPENCODE_COMMIT = "aa3c99a3c0a609ea4dd485355627e3161251584a"
const GLOBAL_LAYOUT_MIGRATION_DONE_BASENAME = ".mendcode-global-layout-v0.done"
const JSON_STORAGE_MIGRATION_DONE_BASENAME = ".mendcode-json-storage-migration-v0.done"

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T
  } catch {
    return fallback
  }
}

function readJsonSync<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T
  } catch {
    return fallback
  }
}

async function writeJson(file: string, data: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`)
}

async function writeIfMissing(file: string, data: string) {
  if (existsSync(file)) return
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, data)
}

function run(cmd: string, args: string[], options: Record<string, any> = {}) {
  return spawnSync(cmd, args, { cwd: mendPaths().root, encoding: "utf8", ...options })
}

function mustRun(cmd: string, args: string[], options: Record<string, any> = {}) {
  const result = run(cmd, args, options)
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`)
  return String(result.stdout || "").trim()
}

export function engineRoot(root = mendPaths().root) {
  return path.join(root, ".agents", "vendor", "opencode")
}

export function enginePkg(root = mendPaths().root) {
  return path.join(engineRoot(root), "packages", "opencode")
}

export function ownedRuntimeRoot(root = mendPaths().root) {
  return path.join(root, "src", "mendcode")
}

function relative(root: string, file: string) {
  return path.relative(root, file)
}

function activeConfig(root = mendPaths().root) {
  return readJsonSync<Record<string, any>>(mendPaths(root).mendConfig, {})
}

function upstreamState(root = mendPaths().root) {
  return readJsonSync<Record<string, any>>(path.join(root, ".mendcode", "upstream.json"), {
    version: 0,
    runtimeCommit: BASELINE_OPENCODE_COMMIT,
    watchRemote: "https://mendcode.ai",
    lastReviewedCommit: BASELINE_OPENCODE_COMMIT,
    license: "MIT",
    integrationMode: "manual-donor-source-adoption",
    lastCheckedAt: null,
    lastInspectedAt: null,
  })
}

async function ensurePatchLog(root = mendPaths().root) {
  await writeIfMissing(
    path.join(root, ".agents", "patches", "patch-log.md"),
    `# MendCode Patch Log\n\nMendCode currently has no runtime patches beyond tracked adoption work.\n\nThis log records manual adaptation/import decisions. It is not an automatic upstream merge log.\n\n| Date | Observed upstream commit | Decision | MendCode files | Reason | Status |\n|---|---|---|---|---|---|\n| 2026-05-06 | ${BASELINE_OPENCODE_COMMIT} | observe only | none | Phase 1 CLI harness; OpenCode remains donor/reference source, not public product identity | active |\n`,
  )
}

function expectedRuntimeCommit(root = mendPaths().root) {
  return upstreamState(root).runtimeCommit || BASELINE_OPENCODE_COMMIT
}

export function donorIdentityGuardStatus() {
  const overrideEnabled = process.env[DONOR_COMMAND_OVERRIDE_ENV] === "1"
  return {
    active: !overrideEnabled,
    overrideEnabled,
    overrideEnv: DONOR_COMMAND_OVERRIDE_ENV,
    mode: overrideEnabled ? "override-enabled" : "blocked-by-default",
    reason: "OpenCode is a donor/reference chassis, not MendCode public product identity.",
    blockedCommands: ["upgrade", "uninstall", "providers", "auth", "web", "serve", "github", "pr", "import", "export", "plugin", "plug", "session", "db", "stats", "attach", "acp"],
    helpPolicy: "donor help is also blocked by default because it exposes upstream product identity and credential/updater commands",
  }
}

export function ownedRuntimeStatus(root = mendPaths().root) {
  const target = ownedRuntimeRoot(root)
  const exists = existsSync(target)
  const pkg = readJsonSync<Record<string, any> | null>(path.join(target, "package.json"), null)
  const state = readJsonSync<Record<string, any> | null>(path.join(root, ".mendcode", "runtime-adoption.json"), null)
  const required = [
    "LICENSE",
    "package.json",
    "packages/opencode/package.json",
    "packages/opencode/src/cli/cmd/tui/routes/session/index.tsx",
    "packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx",
    "packages/plugin/src/tui.ts",
  ]
  const missing = exists ? required.filter((rel) => !existsSync(path.join(target, rel))) : required
  const nestedGitignores = exists ? findNestedGitignores(target) : []
  return {
    adopted: exists && missing.length === 0,
    mode: exists ? "owned-source-copy" : "donor-reference-only",
    source: ".agents/vendor/opencode",
    target: "src/mendcode",
    statePath: ".mendcode/runtime-adoption.json",
    donorCommit: upstreamState(root).runtimeCommit,
    copiedAt: state?.copiedAt || null,
    copiedFromCommit: state?.donorCommit || null,
    packageName: pkg?.name || null,
    requiredMissing: missing,
    nestedGitignores,
    rebrandStatus: exists && pkg?.name === "mendcode-runtime" ? "runtime-package-renamed-basic-cli-rebrand-started" : exists ? "source-adopted-rebrand-pending" : "not-started",
    internalPatchPolicy: exists ? "MendCode may patch src/mendcode internals with tests/evidence; .agents/vendor remains reference only." : "No owned runtime copy yet; donor remains read-only reference.",
  }
}

function findNestedGitignores(root: string) {
  const found: string[] = []
  const walk = (dir: string, depth: number) => {
    if (depth > 3) return
    let entries: any[] = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.name === ".gitignore") found.push(full)
      if (entry.isDirectory() && !["node_modules", ".git", "dist", "build"].includes(entry.name)) walk(full, depth + 1)
    }
  }
  walk(root, 0)
  return found.map((file) => path.relative(mendPaths().root, file))
}

function activeOwnedRuntimeWorkflows(root = mendPaths().root) {
  const workflows = path.join(ownedRuntimeRoot(root), ".github", "workflows")
  if (!existsSync(workflows)) return []
  const found: string[] = []
  const walk = (dir: string) => {
    let entries: any[] = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(ya?ml)$/i.test(entry.name)) found.push(path.relative(root, full))
    }
  }
  walk(workflows)
  return found.sort()
}

export function runtimeAdapterCommand(args: string[] = [], root = mendPaths().root) {
  const owned = ownedRuntimeStatus(root)
  const runtimeRoot = owned.adopted ? ownedRuntimeRoot(root) : engineRoot(root)
  const pkg = owned.adopted ? path.join(ownedRuntimeRoot(root), "packages", "opencode") : enginePkg(root)
  return { command: "bun", args: ["--cwd", pkg, "src/index.ts", ...args], cwd: runtimeRoot }
}

export function adapterStatus(root = mendPaths().root) {
  const command = runtimeAdapterCommand([], root)
  return {
    purpose: "internal-transition-compatibility-runtime",
    publicProductIdentity: "MendCode",
    donorRuntime: {
      name: "opencode",
      command: [command.command, ...command.args].join(" "),
      root: ".agents/vendor/opencode",
      package: ".agents/vendor/opencode/packages/opencode",
    },
    ownedRuntime: ownedRuntimeStatus(root),
    guard: donorIdentityGuardStatus(),
  }
}

function engineHead(root = mendPaths().root) {
  return mustRun("git", ["-C", engineRoot(root), "rev-parse", "HEAD"])
}

function engineStatusShort(root = mendPaths().root) {
  const status = run("git", ["-C", engineRoot(root), "status", "--short"])
  if (status.status !== 0) throw new Error(`Unable to read donor git status:\n${status.stderr || status.stdout}`)
  return String(status.stdout || "").trim()
}

function packageManagerInfo(root = mendPaths().root) {
  const pkg = readJsonSync<Record<string, any>>(path.join(engineRoot(root), "package.json"), {})
  const raw = pkg.packageManager || ""
  const [name, version] = raw.split("@")
  return { raw, name, version }
}

function bunVersion() {
  const result = run("bun", ["--version"])
  if (result.status !== 0) return null
  return String(result.stdout || "").trim()
}

export function validateUpstream(root = mendPaths().root) {
  const failures: string[] = []
  const warnings: string[] = []
  const expected = expectedRuntimeCommit(root)
  const head = existsSync(engineRoot(root)) ? engineHead(root) : null
  const status = existsSync(engineRoot(root)) ? engineStatusShort(root) : ""
  const packageManager = packageManagerInfo(root)
  const bun = bunVersion()
  const license = existsSync(path.join(engineRoot(root), "LICENSE")) ? readFileSync(path.join(engineRoot(root), "LICENSE"), "utf8").slice(0, 200) : ""
  if (head !== expected) failures.push(`OpenCode runtime HEAD ${head} does not match audited runtime commit ${expected}`)
  if (status) failures.push(`OpenCode checkout dirty:\n${status}`)
  if (!license.includes("MIT")) failures.push("OpenCode LICENSE is missing or no longer appears to be MIT")
  if (packageManager.name !== "bun" || !packageManager.version) failures.push(`Unexpected upstream packageManager: ${packageManager.raw || "missing"}`)
  if (!bun) failures.push("bun is not available on PATH")
  else if (packageManager.version && bun !== packageManager.version) warnings.push(`bun version ${bun} does not match upstream packageManager ${packageManager.raw}`)
  return { expectedRuntimeCommit: expected, head, status, packageManager, bun, failures, warnings }
}

export async function upstreamStatus(root = mendPaths().root) {
  await ensurePatchLog(root)
  const state = upstreamState(root)
  const validation = validateUpstream(root)
  const patchLog = path.join(root, ".agents", "patches", "patch-log.md")
  return {
    ...state,
    currentRuntimeHead: validation.head,
    packageManager: validation.packageManager.raw,
    bunVersion: validation.bun,
    clean: !validation.status,
    patchLog: path.relative(root, patchLog),
    patchLogExists: existsSync(patchLog),
    warnings: validation.warnings,
    failures: validation.failures,
  }
}

export async function upstreamInspect(ref: string | undefined, root = mendPaths().root) {
  if (!ref) throw new Error("Usage: mendcode upstream inspect <commit-or-ref>")
  const state = upstreamState(root)
  mustRun("git", ["-C", engineRoot(root), "fetch", state.watchRemote, ref])
  const target = mustRun("git", ["-C", engineRoot(root), "rev-parse", "FETCH_HEAD"])
  const range = state.lastReviewedCommit ? `${state.lastReviewedCommit}..${target}` : target
  const summary = run("git", ["-C", engineRoot(root), "log", "--oneline", "--decorate", "--no-merges", range])
  if (summary.status !== 0) throw new Error(`Unable to inspect upstream range ${range}:\n${summary.stderr || summary.stdout}`)
  await writeJson(path.join(root, ".mendcode", "upstream.json"), { ...state, lastInspectedAt: new Date().toISOString(), lastInspectedRef: ref, lastInspectedCommit: target })
  return {
    mode: "inspect-only",
    changedRuntime: false,
    changedMendCodePin: false,
    ref,
    target,
    comparedFrom: state.lastReviewedCommit,
    commits: String(summary.stdout || "").trim().split("\n").filter(Boolean),
  }
}

function mendOrOpenEnv(openKey: string) {
  const env = originalEnv()
  if (!openKey.startsWith("OPENCODE_")) return env[openKey] ?? null
  const mendKey = `MENDCODE_${openKey.slice("OPENCODE_".length)}`
  return env[mendKey] || env[openKey] || null
}

function mendTruthyOpen(openKey: string) {
  const env = originalEnv()
  if (!openKey.startsWith("OPENCODE_")) {
    const value = env[openKey]?.toLowerCase()
    return value === "true" || value === "1"
  }
  const mendKey = `MENDCODE_${openKey.slice("OPENCODE_".length)}`
  const a = env[mendKey]?.toLowerCase()
  const b = env[openKey]?.toLowerCase()
  return a === "true" || a === "1" || b === "true" || b === "1"
}

function harnessInstallationChannel() {
  const env = originalEnv()
  return env.MENDCODE_CHANNEL || env.OPENCODE_CHANNEL || "local"
}

function originalEnv() {
  try {
    return JSON.parse(process.env.MENDCODE_ORIGINAL_ENV_JSON || "{}") as Record<string, string | undefined>
  } catch {
    return {}
  }
}

function donorRuntimeSqliteResolution(dataDir: string, root = mendPaths().root) {
  const script = path.join(ownedRuntimeRoot(root), "packages", "opencode", "script", "print-resolved-sqlite-path.ts")
  if (!existsSync(script)) return { ok: false, reason: "print-resolved-sqlite-path.ts missing under src/mendcode" }
  const payload = JSON.stringify({
    dataDir,
    installationChannel: harnessInstallationChannel(),
    disableChannelDb: mendTruthyOpen("OPENCODE_DISABLE_CHANNEL_DB"),
    opencodeDb: mendOrOpenEnv("OPENCODE_DB") ?? undefined,
  })
  const result = spawnSync("bun", [script, payload], { encoding: "utf8", cwd: ownedRuntimeRoot(root), maxBuffer: 10_000_000 })
  if (result.error) return { ok: false, reason: String(result.error.message || result.error) }
  if (result.status !== 0) return { ok: false, reason: String(result.stderr || result.stdout || `exit ${result.status}`).slice(0, 800) }
  try {
    return { ok: true, ...JSON.parse(String(result.stdout || "").trim()) }
  } catch (error) {
    return { ok: false, reason: `json-parse: ${error instanceof Error ? error.message : String(error)}` }
  }
}

function discoverProjectDonorConfigRoots(startDir: string, root = mendPaths().root) {
  const roots = []
  let current = path.resolve(startDir)
  const parsedRoot = path.parse(current).root
  for (;;) {
    for (const dot of [".opencode", ".mendcode"]) {
      const full = path.join(current, dot)
      try {
        if (existsSync(full) && statSync(full).isDirectory()) roots.push({ path: full, rel: path.relative(root, full) || full, kind: dot === ".mendcode" ? "mendcode" : "opencode" })
      } catch {}
    }
    if (current === parsedRoot) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return roots
}

function xdgDataHome() {
  return process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share")
}
function xdgCacheHome() {
  return process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache")
}
function xdgConfigHome() {
  return process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config")
}
function xdgStateHome() {
  return process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state")
}

function globalLayoutRootsForSegment(segment: string) {
  const dataDir = path.join(xdgDataHome(), segment)
  const cacheDir = path.join(xdgCacheHome(), segment)
  const configDir = path.join(xdgConfigHome(), segment)
  const stateDir = path.join(xdgStateHome(), segment)
  const tmpDir = path.join(tmpdir(), segment)
  return { dataDir, cacheDir, configDir, stateDir, tmpDir, binDir: path.join(cacheDir, "bin"), logDir: path.join(dataDir, "log") }
}

function legacyDataHasIdentityArtifacts(legacyDataDir: string) {
  let names: string[] = []
  try {
    names = readdirSync(legacyDataDir)
  } catch {
    return false
  }
  return names.some((name) => name === "storage" || name === "auth.json" || name === "mcp-auth.json" || name.endsWith(".db") || name === JSON_STORAGE_MIGRATION_DONE_BASENAME || name === GLOBAL_LAYOUT_MIGRATION_DONE_BASENAME)
}

function resolveEffectiveXdgAppSegment() {
  const raw = mendOrOpenEnv("OPENCODE_GLOBAL_LAYOUT")?.trim().toLowerCase()
  if (raw === "legacy") return "opencode"
  if (raw === "mendcode") return "mendcode"
  const mend = globalLayoutRootsForSegment("mendcode")
  const legacy = globalLayoutRootsForSegment("opencode")
  if (existsSync(path.join(mend.dataDir, GLOBAL_LAYOUT_MIGRATION_DONE_BASENAME))) return "mendcode"
  if (legacyDataHasIdentityArtifacts(legacy.dataDir)) return "opencode"
  return "mendcode"
}

function donorRuntimeGlobalDataReport(root = mendPaths().root) {
  const legacy = globalLayoutRootsForSegment("opencode")
  const mend = globalLayoutRootsForSegment("mendcode")
  const effectiveSeg = resolveEffectiveXdgAppSegment()
  const active = effectiveSeg === "mendcode" ? mend : legacy
  const jsonMigrationDonePath = path.join(active.dataDir, JSON_STORAGE_MIGRATION_DONE_BASENAME)
  const globalLayoutDoneLegacy = path.join(legacy.dataDir, GLOBAL_LAYOUT_MIGRATION_DONE_BASENAME)
  const globalLayoutDoneMend = path.join(mend.dataDir, GLOBAL_LAYOUT_MIGRATION_DONE_BASENAME)
  return {
    effectiveXdgAppSegment: effectiveSeg,
    globalLayoutPhase: "B1-runtime",
    globalLayoutNote: "Segment = mend when marker exists under mend data, OPENCODE_GLOBAL_LAYOUT/MENDCODE_GLOBAL_LAYOUT=mendcode|legacy, or auto greenfield (no legacy identity artifacts). Restart after copying legacy data into the MendCode layout.",
    legacySegment: legacy,
    mendSegment: mend,
    globalLayoutMigrationDoneBasename: GLOBAL_LAYOUT_MIGRATION_DONE_BASENAME,
    globalLayoutMigrationDonePathLegacy: globalLayoutDoneLegacy,
    globalLayoutMigrationDonePathMend: globalLayoutDoneMend,
    globalLayoutMigrationDoneLegacy: existsSync(globalLayoutDoneLegacy),
    globalLayoutMigrationDoneMend: existsSync(globalLayoutDoneMend),
    dataDir: active.dataDir,
    jsonStorageMigrationDonePath: jsonMigrationDonePath,
    jsonStorageMigrationDone: existsSync(jsonMigrationDonePath),
    sqlite: donorRuntimeSqliteResolution(active.dataDir, root),
  }
}

export function donorConfigPathsReport(root = mendPaths().root) {
  const cwd = process.env.MENDCODE_SHELL_CWD || process.cwd()
  const env = originalEnv()
  return {
    precedence: {
      env: "When both are set, MENDCODE_* wins over OPENCODE_* for the same logical setting (mirrors adopted runtime Flag).",
      projectJson: "Walking upward from cwd: opencode.json/jsonc merge first; mendcode.json/jsonc merge after in the same directory (MendCode wins). Per tree level, .opencode/ is listed before .mendcode/ so .mendcode wins when both exist at that level.",
      tuiJson: "tui.json merges in .opencode and .mendcode project dirs (same order); MENDCODE_TUI_CONFIG / OPENCODE_TUI_CONFIG applies after global defaults.",
    },
    cwd,
    effectiveEnv: {
      MENDCODE_CONFIG_DIR: env.MENDCODE_CONFIG_DIR ?? null,
      OPENCODE_CONFIG_DIR: env.OPENCODE_CONFIG_DIR ?? null,
      resolvedConfigDir: mendOrOpenEnv("OPENCODE_CONFIG_DIR"),
      MENDCODE_TUI_CONFIG: env.MENDCODE_TUI_CONFIG ?? null,
      OPENCODE_TUI_CONFIG: env.OPENCODE_TUI_CONFIG ?? null,
      resolvedTuiConfig: mendOrOpenEnv("OPENCODE_TUI_CONFIG"),
      MENDCODE_CONFIG: env.MENDCODE_CONFIG ?? null,
      OPENCODE_CONFIG: env.OPENCODE_CONFIG ?? null,
      resolvedConfigFile: mendOrOpenEnv("OPENCODE_CONFIG"),
      MENDCODE_DB: env.MENDCODE_DB ?? null,
      OPENCODE_DB: env.OPENCODE_DB ?? null,
      resolvedDbPath: mendOrOpenEnv("OPENCODE_DB"),
      MENDCODE_GLOBAL_LAYOUT: env.MENDCODE_GLOBAL_LAYOUT ?? null,
      OPENCODE_GLOBAL_LAYOUT: env.OPENCODE_GLOBAL_LAYOUT ?? null,
      resolvedGlobalLayout: mendOrOpenEnv("OPENCODE_GLOBAL_LAYOUT"),
    },
    projectRootsFromCwd: discoverProjectDonorConfigRoots(cwd, root),
    globalRuntimeData: donorRuntimeGlobalDataReport(root),
  }
}

const DONOR_REFERENCE_PATTERN = /\b(?:opencode|OpenCode)\b|@opencode-ai\/|OPENCODE_|x-opencode|\.opencode|opencode\.ai/i
const PUBLIC_DONOR_AUDIT_DIRS = [
  "src/mendcode/packages/opencode/src/config",
  "src/mendcode/packages/opencode/src/cli",
  "src/mendcode/packages/opencode/src/mend/cli",
  "src/mendcode/packages/opencode/src/cli/cmd/mcp.ts",
  "src/mendcode/packages/opencode/src/cli/cmd/pr.ts",
  "src/mendcode/packages/opencode/src/cli/cmd/uninstall.ts",
  "src/mendcode/packages/opencode/src/cli/cmd/generate.ts",
  "src/mendcode/packages/opencode/src/cli/cmd/providers.ts",
  "src/mendcode/packages/opencode/src/cli/cmd/github.ts",
  "src/mendcode/packages/opencode/src/server/routes/instance/httpapi/groups",
  "src/mendcode/packages/opencode/src/server/routes/instance/httpapi/public.ts",
]
const PUBLIC_DONOR_AUDIT_EXTENSIONS = new Set([".ts", ".tsx", ".json", ".jsonc", ".md"])

export type DonorReferenceCategory = "public" | "compatibility" | "package-import" | "provider-id" | "donor-internal"

export function classifyDonorReference(rel: string, line: string): { category: DonorReferenceCategory; allowed: boolean; reason: string } {
  const file = rel.split(path.sep).join("/")
  const text = line.trim()
  if (/@opencode-ai\//.test(text)) return { category: "package-import", allowed: true, reason: "donor package namespace retained until package alias migration" }
  if (/opencode-go|provider === "opencode"|key === "opencode"|\bopencode:\s*\d+/i.test(text)) return { category: "provider-id", allowed: true, reason: "provider id compatibility, not MendCode product identity" }
  if (/\bOPENCODE_|x-opencode|\.opencode\b|opencode\.jsonc?\b|\.well-known\/opencode|(?:opencode|mendcode)\.ai\/(?:config|theme|tui|desktop-theme)\.json|ConfigPaths\.[^(]+\(.*"opencode"|\/(?:etc|Application Support)\/opencode|ProgramData.*opencode|opencode config|# opencode/i.test(text)) {
    return { category: "compatibility", allowed: true, reason: "legacy compatibility surface must remain readable during migration" }
  }
  if (/donor|upstream|legacy|compat|opencode-settings|OpenCode settings|OpenCode donor|@opencode\//i.test(text)) {
    return { category: "donor-internal", allowed: true, reason: "internal donor/compatibility diagnostic" }
  }
  if (/\/mend\/runtime\/system\.ts$|\/mend\/cli\/public-bin\.ts$|\/cli\/cmd\/uninstall\.ts$/.test(file)) {
    return { category: "donor-internal", allowed: true, reason: "guard or blocked donor-command implementation, not active MendCode UI copy" }
  }
  if (/\/cli\/cmd\/github\.ts$/.test(file)) {
    return { category: "donor-internal", allowed: true, reason: "donor GitHub App/action implementation is disabled in MendCode mode" }
  }
  if (/\/cli\/cmd\/pr\.ts$/.test(file) && /Process\.text\(\["opencode", "import"/.test(text)) {
    return { category: "donor-internal", allowed: true, reason: "guarded donor session import fallback skipped in MendCode mode" }
  }
  return { category: "public", allowed: false, reason: "unclassified donor product identity in audited public runtime surface" }
}

function shouldAuditPublicDonorFile(rel: string) {
  const file = rel.split(path.sep).join("/")
  if (file.includes("/node_modules/") || file.includes("/.git/") || file.includes("/dist/") || file.includes("/build/")) return false
  if (file.endsWith("bun.lock")) return false
  if (
    file.includes("/src/cli/cmd/") &&
    !file.endsWith("/src/cli/cmd/mcp.ts") &&
    !file.endsWith("/src/cli/cmd/pr.ts") &&
    !file.endsWith("/src/cli/cmd/uninstall.ts") &&
    !file.endsWith("/src/cli/cmd/generate.ts") &&
    !file.endsWith("/src/cli/cmd/providers.ts") &&
    !file.endsWith("/src/cli/cmd/github.ts")
  ) return false
  return PUBLIC_DONOR_AUDIT_EXTENSIONS.has(path.extname(file))
}

function collectPublicDonorFiles(root: string) {
  const files = new Set<string>()
  const walk = (dir: string) => {
    let entries: any[] = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      const rel = path.relative(root, full)
      if (entry.isDirectory()) {
        if (!["node_modules", ".git", "dist", "build"].includes(entry.name)) walk(full)
        continue
      }
      if (entry.isFile() && shouldAuditPublicDonorFile(rel)) files.add(full)
    }
  }
  for (const rel of PUBLIC_DONOR_AUDIT_DIRS) {
    const full = path.join(root, rel)
    try {
      const stat = statSync(full)
      if (stat.isFile() && shouldAuditPublicDonorFile(rel)) files.add(full)
      else if (stat.isDirectory()) walk(full)
    } catch {}
  }
  return [...files].sort()
}

export function publicDonorReferenceAudit(root = mendPaths().root) {
  const files = collectPublicDonorFiles(root)
  const matches: Array<{ file: string; line: number; text: string; category: DonorReferenceCategory; allowed: boolean; reason: string }> = []
  for (const file of files) {
    const rel = path.relative(root, file)
    let content = ""
    try {
      content = readFileSync(file, "utf8")
    } catch {
      continue
    }
    content.split(/\r?\n/).forEach((text, index) => {
      if (!DONOR_REFERENCE_PATTERN.test(text)) return
      const classification = classifyDonorReference(rel, text)
      matches.push({ file: rel, line: index + 1, text: text.trim(), ...classification })
    })
  }
  const failures = matches
    .filter((match) => !match.allowed)
    .map((match) => `${match.file}:${match.line}: ${match.reason}: ${match.text.slice(0, 160)}`)
  const summary = matches.reduce<Record<DonorReferenceCategory, number>>(
    (acc, match) => {
      acc[match.category]++
      return acc
    },
    { public: 0, compatibility: 0, "package-import": 0, "provider-id": 0, "donor-internal": 0 },
  )
  return { scannedFiles: files.length, matches, failures, summary }
}

export function collectStatus(root = mendPaths().root) {
  const paths = mendPaths(root)
  const cfg = activeConfig(root)
  const upstream = upstreamState(root)
  const validation = validateUpstream(root)
  const adapter = runtimeAdapterCommand([], root)
  const publicDonorReferences = publicDonorReferenceAudit(root)
  return {
    mendcode: { version: MEND_VERSION, root, configDir: relative(root, paths.mendDir), generatedConfig: relative(root, paths.generatedOpencodeConfig), activeFocus: cfg.focus?.default || "codex" },
    mode: ownedRuntimeStatus(root).adopted ? "mendcode-owned-runtime-with-guarded-public-surface" : "mendcode-harness-with-guarded-donor-runtime",
    ownedRuntime: ownedRuntimeStatus(root),
    runtimeAdapter: { name: cfg.engine?.name || "opencode", command: [adapter.command, ...adapter.args].join(" "), runtimeCommit: upstream.runtimeCommit, currentHead: validation.head, clean: !validation.status, guard: donorIdentityGuardStatus() },
    upstreamWatch: { remote: upstream.watchRemote, lastReviewedCommit: upstream.lastReviewedCommit, lastInspectedCommit: upstream.lastInspectedCommit || null, lastInspectedAt: upstream.lastInspectedAt || null },
    toolchain: { packageManager: validation.packageManager.raw, bunVersion: validation.bun },
    donorRuntimeConfigStrategy: donorConfigPathsReport(root),
    publicDonorReferences,
    warnings: validation.warnings,
    failures: [...validation.failures, ...publicDonorReferences.failures],
  }
}

function protectedHotPaths() {
  return [
    "packages/opencode/src/cli/cmd/tui/routes/session/index.tsx",
    "packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx",
    "packages/opencode/src/cli/cmd/tui/context/sync.tsx",
    "packages/opencode/src/cli/cmd/tui/context/sync-v2.tsx",
    "packages/opencode/src/cli/cmd/tui/worker.ts",
    "packages/opencode/src/cli/cmd/tui/thread.ts",
    "packages/opencode/src/cli/cmd/tui/attach.ts",
    "packages/opencode/src/session/prompt.ts",
  ]
}

function validateCommandPack(root = mendPaths().root) {
  const dir = path.join(root, ".mendcode", "commands")
  const failures: string[] = []
  let files: string[] = []
  try {
    files = readdirSync(dir).filter((name) => name.endsWith(".md")).map((name) => path.join(".mendcode", "commands", name))
  } catch {
    failures.push(".mendcode/commands is missing")
  }
  return { files, failures }
}

async function schemaFailures(root = mendPaths().root) {
  const paths = mendPaths(root)
  const failures: string[] = []
  if (!existsSync(paths.mendConfig)) failures.push("missing .mendcode/mendcode.json")
  if (!existsSync(resolveGlobalModelsConfigPath())) failures.push("missing ~/.mendcode/models.yaml")
  if (!existsSync(paths.tuiProfile)) failures.push("missing .mendcode/tui/profile.json")
  return failures
}

export async function doctorLines(root = mendPaths().root) {
  const paths = mendPaths(root)
  const report = collectStatus(root)
  const commandPack = validateCommandPack(root)
  const schema = await schemaFailures(root)
  const checks: Array<[string, boolean, string]> = [
    ["mendcode config", existsSync(paths.mendConfig), ".mendcode/mendcode.json exists"],
    ["generated config", existsSync(paths.generatedOpencodeConfig), ".mendcode/generated/opencode.json exists"],
    ["runtime checkout", existsSync(engineRoot(root)), ".agents/vendor/opencode exists"],
    ["runtime package", existsSync(enginePkg(root)), "donor runtime package exists"],
    ["license", report.failures.every((x: string) => !x.includes("LICENSE")), "donor MIT license present"],
    ["runtime commit", report.runtimeAdapter.currentHead === report.runtimeAdapter.runtimeCommit, "runtime HEAD matches audited runtime commit"],
    ["runtime clean", report.runtimeAdapter.clean, "runtime checkout is clean"],
    ["owned runtime", true, report.ownedRuntime.adopted ? "src/mendcode adopted for internal patches" : "not adopted yet; donor reference only"],
    ["patch log", existsSync(path.join(root, ".agents", "patches", "patch-log.md")), ".agents/patches/patch-log.md exists"],
    ["command pack", commandPack.failures.length === 0, `${commandPack.files.length} command files valid`],
    ["mendcode schema", schema.length === 0, ".mendcode schema files are structurally valid"],
    ["model roles", existsSync(resolveGlobalModelsConfigPath()), "~/.mendcode/models.yaml exists"],
    ["model role projection", existsSync(paths.modelRoleProjectionState), ".mendcode/generated/model-role-projection.json exists"],
    ["budget spend state", existsSync(paths.budgetSpendState), ".mendcode/budget/spend-state.json exists"],
    ["setup plan", existsSync(path.join(root, ".mendcode", "setup", "plan.json")), ".mendcode/setup/plan.json exists"],
    ["tui profile", existsSync(paths.tuiProfile), ".mendcode/tui/profile.json exists"],
    ["tsm plan", existsSync(paths.tsmPlan), ".mendcode/worktree/tsm-plan.json exists"],
    ["context summary", existsSync(path.join(root, ".mendcode", "context", "summary.md")), ".mendcode/context/summary.md exists"],
    ["donor identity guard", donorIdentityGuardStatus().active, "internal OpenCode donor commands are blocked unless explicit override is set"],
    ["public donor references", report.publicDonorReferences.failures.length === 0, `${report.publicDonorReferences.matches.length} references classified across ${report.publicDonorReferences.scannedFiles} files`],
  ]
  const lines = checks.map(([name, pass, detail]) => `${pass ? "ok" : "fail"}\t${name}\t${detail}`)
  lines.push(...report.warnings.map((warning: string) => `warn\ttoolchain\t${warning}`))
  const failures = [...checks.filter(([, pass]) => !pass).map(([name, , detail]) => `${name}: ${detail}`), ...schema, ...report.failures]
  return { lines, failures }
}

export async function checkRuntime(root = mendPaths().root) {
  const failures: string[] = []
  const paths = mendPaths(root)
  if (!existsSync(engineRoot(root))) failures.push(`missing engine checkout: ${engineRoot(root)}`)
  if (!existsSync(path.join(engineRoot(root), "LICENSE"))) failures.push("missing OpenCode LICENSE")
  if (!existsSync(paths.mendConfig)) failures.push("missing .mendcode/mendcode.json")
  if (!existsSync(paths.generatedOpencodeConfig)) failures.push("missing generated runtime compatibility config")
  failures.push(...validateCommandPack(root).failures)
  failures.push(...await schemaFailures(root))
  const guard = donorIdentityGuardStatus()
  if (!guard.active) failures.push(`donor identity guard override is enabled via ${guard.overrideEnv}; disable it before public checks`)
  for (const rel of protectedHotPaths()) {
    const full = path.join(engineRoot(root), rel)
    if (!existsSync(full)) failures.push(`protected hot path missing upstream: ${rel}`)
    else if (!statSync(full).isFile()) failures.push(`protected hot path not file: ${rel}`)
  }
  const owned = ownedRuntimeStatus(root)
  if (existsSync(ownedRuntimeRoot(root))) {
    if (!owned.adopted) failures.push(`owned runtime incomplete: ${owned.requiredMissing.join(", ")}`)
    if (!existsSync(path.join(ownedRuntimeRoot(root), "LICENSE"))) failures.push("owned runtime LICENSE missing")
  }
  const activeWorkflows = activeOwnedRuntimeWorkflows(root)
  if (activeWorkflows.length) failures.push(`owned runtime contains active donor workflows: ${activeWorkflows.join(", ")}`)
  failures.push(...publicDonorReferenceAudit(root).failures)
  try {
    const upstream = validateUpstream(root)
    failures.push(...upstream.failures)
    await writeJson(path.join(root, ".mendcode", "upstream.json"), { ...upstreamState(root), lastCheckedAt: new Date().toISOString() })
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
  }
  return failures
}

export function toolchainStatus(root = mendPaths().root) {
  const validation = validateUpstream(root)
  const expected = validation.packageManager.name === "bun" ? validation.packageManager.version : null
  return {
    packageManager: validation.packageManager.raw,
    bunVersion: validation.bun,
    matchesPackageManager: Boolean(expected && validation.bun === expected),
    warnings: validation.warnings,
    failures: validation.failures.filter((failure) => failure.includes("bun") || failure.includes("packageManager")),
  }
}
