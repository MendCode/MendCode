import { spawnSync } from "child_process"
import { createHash } from "crypto"
import { mkdir, readFile, rename, rm, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import { computeGlobalRoots, resolveActiveAppSegment } from "@mendcode/core/global-layout"
import { resolveDualReadDbPathFromLayout } from "@/storage/resolve-default-sqlite-path"
import { readMendConfig } from "../config/project"
import { loopProjectScopeSql } from "./loop-project-scope"

export type LoopServiceMode = "dry-run" | "report-only" | "execute"
export type LoopServicePlatform = "darwin" | "linux" | "win32"
export type LoopServiceBackend = "launchd" | "systemd-user" | "scheduled-task"

export type LoopServicePlan = {
  label: string
  backend: LoopServiceBackend
  platform: LoopServicePlatform
  projectRoot: string
  definitionPath: string
  stdoutPath: string
  stderrPath: string
  healthPath: string
  executable: string
  programArguments: string[]
  serviceProgramArguments: string[]
  databasePath: string
  installCommand: string[]
  startCommand: string[]
  stopCommand: string[]
  uninstallCommand: string[]
  statusCommand: string[]
  mode: LoopServiceMode
  intervalMs: number
  limit: number
}

export type LoopServiceStatus = {
  installed: boolean
  loaded: boolean
  label: string
  backend: LoopServiceBackend
  platform: LoopServicePlatform
  projectRoot: string
  databasePath: string
  definitionPath: string
  stdoutPath: string
  stderrPath: string
  healthPath: string
  executable: string
  executablePath?: string
  executableVersion?: string
  executableFingerprint?: string
  definitionFingerprint?: string
  expectedDefinitionFingerprint: string
  lastWakeAttempt?: number
  lastError?: string
  healthUpdatedAt?: number
  drift: string[]
  degraded: boolean
  mode: LoopServiceMode
  detail?: string
}

export type LoopServiceHealthRecord = {
  schema: 1
  projectRoot: string
  databasePath: string
  definitionPath: string
  executable: string
  executablePath?: string
  executableVersion?: string
  executableFingerprint?: string
  definitionFingerprint: string
  lastWakeAttempt?: number
  lastError?: string
  degraded: boolean
  updatedAt: number
}

export type LoopServiceHealthUpdate = {
  lastWakeAttempt?: number
  lastError?: string
  degraded: boolean
  updatedAt?: number
}

export type LoopServiceArgs = {
  projectRoot: string
  intervalMs?: number
  limit?: number
  execute?: boolean
  reportOnly?: boolean
  quiet?: boolean
  command?: string
  platform?: NodeJS.Platform | LoopServicePlatform
  serviceDir?: string
  logDir?: string
}

export const DEFAULT_LOOP_SERVICE_LIMIT = 10
const maxHealthErrorChars = 1_000
const maxHealthDriftItems = 12

export function loopDaemonCanDispatch(activeTickCount: number) {
  return activeTickCount === 0
}

function stableProjectID(projectRoot: string) {
  return createHash("sha256").update(path.resolve(projectRoot)).digest("hex").slice(0, 12)
}

function launchctlDomain() {
  return `gui/${process.getuid?.() ?? os.userInfo().uid}`
}

function platform(value: LoopServiceArgs["platform"] = process.platform): LoopServicePlatform {
  if (value === "darwin" || value === "linux" || value === "win32") return value
  throw new Error(`Loop service is not supported on ${value}. Use \`mendcode loops daemon\` in a live terminal.`)
}

function backendFor(value: LoopServicePlatform): LoopServiceBackend {
  if (value === "darwin") return "launchd"
  if (value === "linux") return "systemd-user"
  return "scheduled-task"
}

function loopServiceMode(args: Pick<LoopServiceArgs, "execute" | "reportOnly">): LoopServiceMode {
  if (!args.execute) return "dry-run"
  return args.reportOnly ? "report-only" : "execute"
}

function defaultCommand() {
  return process.env.MENDCODE_PUBLIC_BIN || "mend"
}

function servicePath() {
  const fallback = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
  const seen = new Set<string>()
  const entries = (process.env.PATH || fallback)
    .split(path.delimiter)
    .filter((entry) => entry && !entry.includes("/.codex/tmp/") && !seen.has(entry) && seen.add(entry))
  return entries.join(path.delimiter) || fallback
}

function defaultServiceDir(platformValue: LoopServicePlatform) {
  const configured = process.env.MENDCODE_LOOP_SERVICE_DIR
  if (configured) return path.resolve(configured)
  if (platformValue === "darwin") return path.join(os.homedir(), "Library", "LaunchAgents")
  if (platformValue === "linux")
    return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "systemd", "user")
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "MendCode", "Loops")
}

function defaultLogDir(platformValue: LoopServicePlatform) {
  const configured = process.env.MENDCODE_LOOP_LOG_DIR
  if (configured) return path.resolve(configured)
  if (platformValue === "darwin") return path.join(os.homedir(), "Library", "Logs", "MendCode")
  if (platformValue === "linux")
    return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "mendcode", "logs")
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "MendCode", "Logs")
}

function envOpen(openKey: string) {
  const mendKey = openKey.startsWith("OPENCODE_") ? `MENDCODE_${openKey.slice("OPENCODE_".length)}` : openKey
  return process.env[mendKey] || process.env[openKey]
}

function loopDatabasePath() {
  const dataDir = computeGlobalRoots(resolveActiveAppSegment()).data
  const override = envOpen("OPENCODE_DB")
  if (override) return override === ":memory:" || path.isAbsolute(override) ? override : path.join(dataDir, override)
  const channel = envOpen("OPENCODE_CHANNEL") || "local"
  const disabled = [envOpen("OPENCODE_DISABLE_CHANNEL_DB")].some(
    (value) => value === "1" || value?.toLowerCase() === "true",
  )
  return resolveDualReadDbPathFromLayout(dataDir, channel, disabled)
}

function escapedXML(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

function stringNode(value: string) {
  return `<string>${escapedXML(value)}</string>`
}

function serviceIntervalSeconds(intervalMs: number) {
  return Math.max(60, Math.ceil(intervalMs / 1000))
}

function loopDaemonArgs(
  args: Required<Pick<LoopServiceArgs, "intervalMs" | "limit">> &
    Pick<LoopServiceArgs, "execute" | "reportOnly" | "quiet">,
  options: { once?: boolean } = {},
) {
  const daemonArgs = ["loops", "daemon", "--interval-ms", String(args.intervalMs), "--limit", String(args.limit)]
  if (args.execute) daemonArgs.push("--execute")
  if (args.reportOnly) daemonArgs.push("--report-only")
  if (options.once) daemonArgs.push("--once")
  if (args.quiet !== false) daemonArgs.push("--quiet")
  return daemonArgs
}

function sqlLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}

function loopServicePreflightCommand(input: { daemonArguments: string[]; databasePath: string; projectRoot: string }) {
  const project = sqlLiteral(input.projectRoot)
  const scope = loopProjectScopeSql(project)
  const scheduledMode =
    "(json_valid(w.data) = 0 OR json_extract(w.data, '$.spec.trigger.mode') IS NULL OR json_extract(w.data, '$.spec.trigger.mode') IN ('interval', 'daily', 'adaptive', 'external-signal', 'self-paced'))"
  const query = [
    "WITH scheduled AS (",
    `SELECT w.state, w.next_wakeup FROM loop_workflow AS w JOIN project AS p ON p.id = w.project_id WHERE ${scope} AND w.state IN ('working', 'needs_input', 'active', 'sleeping') AND ${scheduledMode}`,
    ") SELECT CASE",
    "WHEN EXISTS (SELECT 1 FROM scheduled WHERE state IN ('working', 'needs_input') OR (state IN ('active', 'sleeping') AND next_wakeup IS NOT NULL AND next_wakeup <= strftime('%s', 'now') * 1000)) THEN 1",
    "WHEN EXISTS (SELECT 1 FROM scheduled) THEN 2",
    "ELSE 0 END;",
  ].join(" ")
  const fallback = shellQuote(input.daemonArguments)
  const database = shellQuote([input.databasePath])
  return [
    `state=$(/usr/bin/sqlite3 -readonly ${database} ${shellQuote([query])} 2>/dev/null) || exec ${fallback}`,
    `if [ "$state" = "1" ]; then exec ${fallback}; fi`,
    `if [ "$state" = "0" ]; then exec ${fallback}; fi`,
  ].join("\n")
}

function configuredMode(value: unknown): LoopServiceMode {
  return value === "dry-run" || value === "execute" || value === "report-only" ? value : "report-only"
}

export function loopServiceArgsFromConfig(
  projectRoot: string,
  overrides: Partial<LoopServiceArgs> = {},
): LoopServiceArgs {
  const root = path.resolve(projectRoot)
  const cfg = readMendConfig(root)
  const loop = cfg.loop && typeof cfg.loop === "object" ? cfg.loop : {}
  const mode = configuredMode(loop.defaultServiceMode)
  const cleanOverrides = Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined))
  const projectPath = (value: unknown) =>
    typeof value === "string" && value.trim() ? path.resolve(root, value) : undefined
  return {
    execute: mode !== "dry-run",
    reportOnly: mode !== "execute",
    ...cleanOverrides,
    projectRoot: root,
    serviceDir: projectPath(cleanOverrides.serviceDir ?? loop.serviceDir),
    logDir: projectPath(cleanOverrides.logDir ?? loop.logDir),
  }
}

export function loopServicePlan(args: LoopServiceArgs): LoopServicePlan {
  const platformValue = platform(args.platform)
  const backend = backendFor(platformValue)
  const projectRoot = path.resolve(args.projectRoot)
  const id = stableProjectID(projectRoot)
  const label = `com.mendcode.loops.${id}`
  const intervalMs = args.intervalMs ?? 30_000
  const limit = args.limit ?? DEFAULT_LOOP_SERVICE_LIMIT
  const command = args.command ?? defaultCommand()
  const serviceDir = path.resolve(args.serviceDir || defaultServiceDir(platformValue))
  const logDir = path.resolve(args.logDir || defaultLogDir(platformValue))
  const daemonArguments = loopDaemonArgs({
    intervalMs,
    limit,
    execute: args.execute,
    reportOnly: args.reportOnly,
    quiet: args.quiet,
  })
  const programArguments =
    platformValue === "win32"
      ? [command, ...daemonArguments]
      : ["/usr/bin/env", `PATH=${servicePath()}`, command, ...daemonArguments]
  const scheduledProgramArguments = platformValue === "darwin"
    ? [
        "/usr/bin/env",
        `PATH=${servicePath()}`,
        command,
        ...loopDaemonArgs(
          { intervalMs, limit, execute: args.execute, reportOnly: args.reportOnly, quiet: args.quiet },
          { once: true },
        ),
      ]
    : programArguments
  const definitionPath =
    platformValue === "darwin"
      ? path.join(serviceDir, `${label}.plist`)
      : platformValue === "linux"
        ? path.join(serviceDir, `${label}.service`)
        : path.join(serviceDir, `${label}.cmd`)
  const databasePath = loopDatabasePath()
  const serviceProgramArguments =
    platformValue === "darwin"
      ? ["/bin/sh", "-c", loopServicePreflightCommand({ daemonArguments: scheduledProgramArguments, databasePath, projectRoot })]
      : programArguments
  const programLine = platformValue === "win32" ? windowsCommandLine(programArguments) : shellQuote(programArguments)
  return {
    label,
    backend,
    platform: platformValue,
    projectRoot,
    definitionPath,
    stdoutPath: path.join(logDir, `${label}.log`),
    stderrPath: path.join(logDir, `${label}.err.log`),
    healthPath: path.join(logDir, `${label}.health.json`),
    executable: command,
    programArguments,
    serviceProgramArguments,
    databasePath,
    installCommand:
      platformValue === "darwin"
        ? ["write", definitionPath]
        : platformValue === "linux"
          ? ["systemctl", "--user", "enable", `${label}.service`]
          : ["schtasks.exe", "/Create", "/F", "/TN", `MendCode\\Loops\\${label}`, "/SC", "ONLOGON", "/TR", programLine],
    startCommand:
      platformValue === "darwin"
        ? ["launchctl", "bootstrap", launchctlDomain(), definitionPath]
        : platformValue === "linux"
          ? ["systemctl", "--user", "enable", "--now", `${label}.service`]
          : ["schtasks.exe", "/Run", "/TN", `MendCode\\Loops\\${label}`],
    stopCommand:
      platformValue === "darwin"
        ? ["launchctl", "bootout", launchctlDomain(), definitionPath]
        : platformValue === "linux"
          ? ["systemctl", "--user", "stop", `${label}.service`]
          : ["schtasks.exe", "/End", "/TN", `MendCode\\Loops\\${label}`],
    uninstallCommand:
      platformValue === "darwin"
        ? ["launchctl", "bootout", `${launchctlDomain()}/${label}`]
        : platformValue === "linux"
          ? ["systemctl", "--user", "disable", "--now", `${label}.service`]
          : ["schtasks.exe", "/Delete", "/F", "/TN", `MendCode\\Loops\\${label}`],
    statusCommand:
      platformValue === "darwin"
        ? ["launchctl", "print", `${launchctlDomain()}/${label}`]
        : platformValue === "linux"
          ? ["systemctl", "--user", "status", `${label}.service`, "--no-pager"]
          : ["schtasks.exe", "/Query", "/TN", `MendCode\\Loops\\${label}`],
    mode: loopServiceMode(args),
    intervalMs,
    limit,
  }
}

function fingerprint(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex")
}

function boundedHealthText(value: string | undefined) {
  if (!value) return undefined
  const text = value.trim()
  if (text.length <= maxHealthErrorChars) return text
  return `${text.slice(0, maxHealthErrorChars - 32)} [health truncated]`
}

function executableLocation(command: string) {
  if (path.isAbsolute(command) || /[\\/]/.test(command)) return path.resolve(command)
  const lookup = process.platform === "win32" ? "where.exe" : "which"
  const result = spawnSync(lookup, [command], { encoding: "utf8" })
  if (result.status !== 0) return undefined
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
}

async function executableIdentity(command: string) {
  const executablePath = executableLocation(command)
  if (!executablePath)
    return { executablePath: undefined, executableVersion: undefined, executableFingerprint: undefined }
  const [executableFingerprint, executableVersion] = await Promise.all([
    readFile(executablePath)
      .then(fingerprint)
      .catch(() => undefined),
    Promise.resolve()
      .then(() => {
        const result = spawnSync(executablePath, ["--version"], { encoding: "utf8", timeout: 5_000 })
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim()
        return output
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean)
          ?.slice(0, 200)
      })
      .catch(() => undefined),
  ])
  return { executablePath, executableVersion, executableFingerprint }
}

function parseHealthRecord(value: unknown): LoopServiceHealthRecord | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  if (
    record.schema !== 1 ||
    typeof record.projectRoot !== "string" ||
    typeof record.databasePath !== "string" ||
    typeof record.definitionPath !== "string" ||
    typeof record.executable !== "string" ||
    typeof record.definitionFingerprint !== "string" ||
    typeof record.degraded !== "boolean" ||
    typeof record.updatedAt !== "number" ||
    !Number.isFinite(record.updatedAt)
  )
    return undefined
  return {
    schema: 1,
    projectRoot: record.projectRoot,
    databasePath: record.databasePath,
    definitionPath: record.definitionPath,
    executable: record.executable,
    executablePath: typeof record.executablePath === "string" ? record.executablePath : undefined,
    executableVersion: typeof record.executableVersion === "string" ? record.executableVersion : undefined,
    executableFingerprint: typeof record.executableFingerprint === "string" ? record.executableFingerprint : undefined,
    definitionFingerprint: record.definitionFingerprint,
    lastWakeAttempt:
      typeof record.lastWakeAttempt === "number" && Number.isFinite(record.lastWakeAttempt)
        ? record.lastWakeAttempt
        : undefined,
    lastError: typeof record.lastError === "string" ? boundedHealthText(record.lastError) : undefined,
    degraded: record.degraded,
    updatedAt: record.updatedAt,
  }
}

async function readHealthRecord(file: string) {
  try {
    return parseHealthRecord(JSON.parse(await readFile(file, "utf8")))
  } catch {
    return undefined
  }
}

export async function writeLoopServiceHealth(plan: LoopServicePlan, update: LoopServiceHealthUpdate) {
  const identity = await executableIdentity(plan.executable)
  const record: LoopServiceHealthRecord = {
    schema: 1,
    projectRoot: plan.projectRoot,
    databasePath: plan.databasePath,
    definitionPath: plan.definitionPath,
    executable: plan.executable,
    executablePath: identity.executablePath,
    executableVersion: identity.executableVersion,
    executableFingerprint: identity.executableFingerprint,
    definitionFingerprint: fingerprint(loopServiceDefinition(plan)),
    lastWakeAttempt: update.lastWakeAttempt,
    lastError: boundedHealthText(update.lastError),
    degraded: update.degraded,
    updatedAt: update.updatedAt ?? Date.now(),
  }
  await mkdir(path.dirname(plan.healthPath), { recursive: true })
  const temporaryPath = `${plan.healthPath}.${process.pid}.${crypto.randomUUID()}.tmp`
  await writeFile(temporaryPath, JSON.stringify(record))
  await rename(temporaryPath, plan.healthPath)
}

function shellQuote(args: string[]) {
  return args
    .map((arg) => {
      if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(arg)) return arg
      return `'${arg.replaceAll("'", "'\\''")}'`
    })
    .join(" ")
}

function windowsQuote(value: string) {
  if (/^[^\s"]+$/.test(value)) return value
  const escaped = value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/, "$1$1")
  return `"${escaped}"`
}

function windowsCommandLine(args: string[]) {
  return args.map(windowsQuote).join(" ")
}

export function loopServicePlist(plan: LoopServicePlan) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${stringNode(plan.label)}
  <key>ProgramArguments</key>
  <array>
    ${plan.serviceProgramArguments.map(stringNode).join("\n    ")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MENDCODE_SHELL_CWD</key>
    ${stringNode(plan.projectRoot)}
  <key>MENDCODE_LOOP_SERVICE</key>
  <string>1</string>
   <key>MENDCODE_DB</key>
   ${stringNode(plan.databasePath)}
   <key>MENDCODE_LOOP_SERVICE_DIR</key>
   ${stringNode(path.dirname(plan.definitionPath))}
   <key>MENDCODE_LOOP_LOG_DIR</key>
   ${stringNode(path.dirname(plan.healthPath))}
   </dict>
  <key>WorkingDirectory</key>
  ${stringNode(plan.projectRoot)}
  <key>RunAtLoad</key>
  <false/>
  <key>StartInterval</key>
  <integer>${serviceIntervalSeconds(plan.intervalMs)}</integer>
  <key>StandardOutPath</key>
  ${stringNode(plan.stdoutPath)}
  <key>StandardErrorPath</key>
  ${stringNode(plan.stderrPath)}
</dict>
</plist>
`
}

function systemdString(value: string) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`
}

export function loopServiceSystemdUnit(plan: LoopServicePlan) {
  return `[Unit]
Description=MendCode Loop Workflow daemon for ${plan.projectRoot}
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${plan.projectRoot}
Environment=MENDCODE_SHELL_CWD=${systemdString(plan.projectRoot)}
Environment=MENDCODE_LOOP_SERVICE=1
Environment=MENDCODE_LOOP_SERVICE_DIR=${systemdString(path.dirname(plan.definitionPath))}
Environment=MENDCODE_LOOP_LOG_DIR=${systemdString(path.dirname(plan.healthPath))}
ExecStart=${shellQuote(plan.programArguments)}
Restart=always
RestartSec=5
StandardOutput=append:${plan.stdoutPath}
StandardError=append:${plan.stderrPath}

[Install]
WantedBy=default.target
`
}

export function loopServiceWindowsCommand(plan: LoopServicePlan) {
  const projectRoot = plan.projectRoot.replaceAll('"', '""')
  const serviceDir = path.dirname(plan.definitionPath).replaceAll('"', '""')
  const logDir = path.dirname(plan.healthPath).replaceAll('"', '""')
  return `set "MENDCODE_SHELL_CWD=${projectRoot}" && set "MENDCODE_LOOP_SERVICE=1" && set "MENDCODE_LOOP_SERVICE_DIR=${serviceDir}" && set "MENDCODE_LOOP_LOG_DIR=${logDir}" && ${windowsCommandLine(plan.programArguments)} >> "${plan.stdoutPath}" 2>> "${plan.stderrPath}"`
}

export function loopServiceDefinition(plan: LoopServicePlan) {
  if (plan.platform === "darwin") return loopServicePlist(plan)
  if (plan.platform === "linux") return loopServiceSystemdUnit(plan)
  return `@echo off\r\ncd /d "${plan.projectRoot}"\r\n${loopServiceWindowsCommand(plan)}\r\n`
}

function runLaunchctl(args: string[]) {
  return spawnSync("launchctl", args, { encoding: "utf8" })
}

function runServiceCommand(plan: LoopServicePlan, command: string[]) {
  if (plan.platform === "darwin" && command[0] === "launchctl") return runLaunchctl(command.slice(1))
  return spawnSync(command[0]!, command.slice(1), { encoding: "utf8" })
}

function serviceLoaded(plan: LoopServicePlan) {
  if (platform() !== plan.platform)
    return {
      loaded: false,
      detail: `service is configured for ${plan.platform}, current platform is ${process.platform}`,
    }
  const result = runServiceCommand(plan, plan.statusCommand)
  return {
    loaded: result.status === 0,
    detail: [result.stdout, result.stderr].filter(Boolean).join("\n").trim() || undefined,
  }
}

function kickstartService(plan: LoopServicePlan) {
  if (plan.platform !== "darwin") return
  const result = runServiceCommand(plan, ["launchctl", "kickstart", `${launchctlDomain()}/${plan.label}`])
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${plan.backend} kickstart failed`)
}

export async function loopServiceInstall(args: LoopServiceArgs) {
  const plan = loopServicePlan(args)
  if (platform() !== plan.platform)
    throw new Error(`Loop service install target is ${plan.platform}, current platform is ${process.platform}.`)
  await mkdir(path.dirname(plan.definitionPath), { recursive: true })
  await mkdir(path.dirname(plan.stdoutPath), { recursive: true })
  await writeFile(plan.definitionPath, loopServiceDefinition(plan))
  if (plan.platform === "linux") runServiceCommand(plan, ["systemctl", "--user", "daemon-reload"])
  if (plan.platform !== "darwin") {
    const result = runServiceCommand(plan, plan.installCommand)
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${plan.backend} install failed`)
  }
  return plan
}

export async function loopServiceUninstall(args: LoopServiceArgs) {
  const plan = loopServicePlan(args)
  if (platform() !== plan.platform)
    throw new Error(`Loop service uninstall target is ${plan.platform}, current platform is ${process.platform}.`)
  const loaded = serviceLoaded(plan).loaded
  if (plan.platform === "darwin") await rm(plan.definitionPath, { force: true })
  if (loaded) runServiceCommand(plan, plan.uninstallCommand)
  if (plan.platform !== "darwin") await rm(plan.definitionPath, { force: true })
  if (plan.platform === "linux") runServiceCommand(plan, ["systemctl", "--user", "daemon-reload"])
  return plan
}

export async function loopServiceStart(args: LoopServiceArgs) {
  const plan = loopServicePlan(args)
  if (platform() !== plan.platform)
    throw new Error(`Loop service start target is ${plan.platform}, current platform is ${process.platform}.`)
  const previousDefinition = await readFile(plan.definitionPath, "utf8").catch(() => undefined)
  const existing = serviceLoaded(plan)
  const installed = await loopServiceInstall(args)
  if (existing.loaded && previousDefinition === loopServiceDefinition(installed)) {
    kickstartService(installed)
    return installed
  }
  if (existing.loaded) {
    const stopped = runServiceCommand(installed, installed.stopCommand)
    if (stopped.status !== 0 && serviceLoaded(installed).loaded) {
      throw new Error(stopped.stderr || stopped.stdout || `${installed.backend} stop failed while restarting`)
    }
  }
  const result = runServiceCommand(installed, installed.startCommand)
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${installed.backend} start failed`)
  const loaded = serviceLoaded(installed)
  if (!loaded.loaded) throw new Error(loaded.detail || `${installed.backend} started but is not loaded`)
  kickstartService(installed)
  return installed
}

export async function loopServiceStop(args: LoopServiceArgs) {
  const plan = loopServicePlan(args)
  if (platform() !== plan.platform)
    throw new Error(`Loop service stop target is ${plan.platform}, current platform is ${process.platform}.`)
  const result = runServiceCommand(plan, plan.stopCommand)
  if (result.status !== 0 && serviceLoaded(plan).loaded)
    throw new Error(result.stderr || result.stdout || `${plan.backend} stop failed`)
  return plan
}

export async function loopServiceStatus(args: LoopServiceArgs): Promise<LoopServiceStatus> {
  const plan = loopServicePlan(args)
  let installed = false
  try {
    await readFile(plan.definitionPath, "utf8")
    installed = true
  } catch {
    installed = false
  }
  const loaded = serviceLoaded(plan)
  const expectedDefinition = loopServiceDefinition(plan)
  const [definition, identity, health] = await Promise.all([
    readFile(plan.definitionPath, "utf8").catch(() => undefined),
    executableIdentity(plan.executable),
    readHealthRecord(plan.healthPath),
  ])
  const expectedDefinitionFingerprint = fingerprint(expectedDefinition)
  const definitionFingerprint = definition ? fingerprint(definition) : undefined
  const drift: string[] = []
  if (platform() !== plan.platform) drift.push("platform-mismatch")
  if (!installed) drift.push("definition-missing")
  else if (definition !== expectedDefinition) drift.push("definition-drift")
  if (!loaded.loaded) drift.push("service-not-loaded")
  if (!identity.executablePath || !identity.executableFingerprint) drift.push("executable-missing")
  if (!health) drift.push("health-missing")
  if (health) {
    if (health.projectRoot !== plan.projectRoot) drift.push("project-drift")
    if (health.databasePath !== plan.databasePath) drift.push("database-drift")
    if (health.definitionPath !== plan.definitionPath) drift.push("definition-path-drift")
    if (health.executable !== plan.executable) drift.push("executable-drift")
    if (health.executablePath !== identity.executablePath) drift.push("executable-path-drift")
    if (health.executableFingerprint !== identity.executableFingerprint) drift.push("executable-fingerprint-drift")
    if (health.definitionFingerprint !== definitionFingerprint) drift.push("definition-fingerprint-drift")
    if (Date.now() - health.updatedAt > Math.max(5 * 60_000, plan.intervalMs * 3)) drift.push("health-stale")
    if (health.degraded) drift.push("scheduler-degraded")
  }
  const uniqueDrift = [...new Set(drift)].slice(0, maxHealthDriftItems)
  return {
    installed,
    loaded: loaded.loaded,
    label: plan.label,
    backend: plan.backend,
    platform: plan.platform,
    projectRoot: plan.projectRoot,
    databasePath: plan.databasePath,
    definitionPath: plan.definitionPath,
    stdoutPath: plan.stdoutPath,
    stderrPath: plan.stderrPath,
    healthPath: plan.healthPath,
    executable: plan.executable,
    executablePath: identity.executablePath,
    executableVersion: identity.executableVersion,
    executableFingerprint: identity.executableFingerprint,
    definitionFingerprint,
    expectedDefinitionFingerprint,
    lastWakeAttempt: health?.lastWakeAttempt,
    lastError: health?.lastError,
    healthUpdatedAt: health?.updatedAt,
    drift: uniqueDrift,
    degraded: uniqueDrift.length > 0,
    mode: plan.mode,
    detail: loaded.detail,
  }
}
