import { spawnSync } from "child_process"
import { mkdir, readFile, rm, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import { computeGlobalRoots, resolveActiveAppSegment } from "@mendcode/core/global-layout"

export type DreamServicePlatform = "darwin" | "linux" | "win32"
export type DreamServiceBackend = "launchd" | "systemd-user" | "scheduled-task"

export type DreamServicePlan = {
  label: string
  backend: DreamServiceBackend
  platform: DreamServicePlatform
  workingDirectory: string
  definitionPath: string
  stdoutPath: string
  stderrPath: string
  programArguments: string[]
  serviceProgramArguments: string[]
  memoryDirectory: string
  installCommand: string[]
  startCommand: string[]
  stopCommand: string[]
  uninstallCommand: string[]
  statusCommand: string[]
  intervalMs: number
}

export type DreamServiceStatus = {
  installed: boolean
  loaded: boolean
  label: string
  backend: DreamServiceBackend
  platform: DreamServicePlatform
  definitionPath: string
  stdoutPath: string
  stderrPath: string
  intervalMs: number
  detail?: string
}

export type DreamServiceArgs = {
  intervalMs?: number
  command?: string
  platform?: NodeJS.Platform | DreamServicePlatform
  serviceDir?: string
  logDir?: string
  workingDirectory?: string
}

function launchctlDomain() {
  return `gui/${process.getuid?.() ?? os.userInfo().uid}`
}

function platform(value: DreamServiceArgs["platform"] = process.platform): DreamServicePlatform {
  if (value === "darwin" || value === "linux" || value === "win32") return value
  throw new Error(`Dream service is not supported on ${value}. Use \`mendcode memory dream daemon\` in a live terminal.`)
}

function backendFor(value: DreamServicePlatform): DreamServiceBackend {
  if (value === "darwin") return "launchd"
  if (value === "linux") return "systemd-user"
  return "scheduled-task"
}

function defaultCommand() {
  return process.env.MENDCODE_PUBLIC_BIN || "mendcode"
}

function servicePath() {
  const fallback = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
  const seen = new Set<string>()
  const entries = (process.env.PATH || fallback)
    .split(path.delimiter)
    .filter((entry) => entry && !entry.includes("/.codex/tmp/") && !seen.has(entry) && seen.add(entry))
  return entries.join(path.delimiter) || fallback
}

function defaultServiceDir(platformValue: DreamServicePlatform) {
  const configured = process.env.MENDCODE_DREAM_SERVICE_DIR
  if (configured) return path.resolve(configured)
  if (platformValue === "darwin") return path.join(os.homedir(), "Library", "LaunchAgents")
  if (platformValue === "linux") return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "systemd", "user")
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "MendCode", "Dream")
}

function defaultLogDir(platformValue: DreamServicePlatform) {
  const configured = process.env.MENDCODE_DREAM_LOG_DIR
  if (configured) return path.resolve(configured)
  if (platformValue === "darwin") return path.join(os.homedir(), "Library", "Logs", "MendCode")
  if (platformValue === "linux") return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "mendcode", "logs")
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "MendCode", "Logs")
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

function shellQuote(args: string[]) {
  return args.map((arg) => {
    if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(arg)) return arg
    return `'${arg.replaceAll("'", "'\\''")}'`
  }).join(" ")
}

function windowsQuote(value: string) {
  if (/^[^\s"]+$/.test(value)) return value
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

function windowsCommandLine(args: string[]) {
  return args.map(windowsQuote).join(" ")
}

function serviceRunsOneShot(platformValue: DreamServicePlatform) {
  return platformValue === "darwin" || platformValue === "win32"
}

function serviceIntervalSeconds(intervalMs: number) {
  return Math.max(60, Math.ceil(intervalMs / 1000))
}

function dreamDaemonArgs(args: Required<Pick<DreamServiceArgs, "intervalMs">>, options: { once?: boolean } = {}) {
  const daemonArgs = ["memory", "dream", "daemon", "--interval-ms", String(args.intervalMs)]
  if (options.once) daemonArgs.push("--once")
  daemonArgs.push("--quiet")
  return daemonArgs
}

function dreamWindowPreflightCommand(input: { daemonArguments: string[]; memoryDirectory: string }) {
  const fallback = shellQuote(input.daemonArguments)
  const config = shellQuote([path.join(input.memoryDirectory, "config.json")])
  const schedule = shellQuote([path.join(input.memoryDirectory, "dream", "schedule.json")])
  return [
    "to_minutes() {",
    "  hour=${1%%:*}; minute=${1#*:}",
    "  hour=${hour#0}; minute=${minute#0}",
    "  [ -n \"$hour\" ] || hour=0; [ -n \"$minute\" ] || minute=0",
    "  printf '%s\\n' $((hour * 60 + minute))",
    "}",
    "check_window() {",
    "  file=$1; key=$2; window_active=0",
    "  enabled=$(/usr/bin/plutil -extract \"$key.enabled\" raw -o - \"$file\" 2>/dev/null) || return 1",
    "  [ \"$enabled\" = \"true\" ] || return 1",
    "  start=$(/usr/bin/plutil -extract \"$key.start\" raw -o - \"$file\" 2>/dev/null) || return 1",
    "  end=$(/usr/bin/plutil -extract \"$key.end\" raw -o - \"$file\" 2>/dev/null) || return 1",
    "  case \"$start\" in [0-9]:[0-9][0-9]|[0-9][0-9]:[0-9][0-9]) ;; *) return 1 ;; esac",
    "  case \"$end\" in [0-9]:[0-9][0-9]|[0-9][0-9]:[0-9][0-9]) ;; *) return 1 ;; esac",
    "  start_minutes=$(to_minutes \"$start\"); end_minutes=$(to_minutes \"$end\")",
    "  [ \"$start_minutes\" -le 1439 ] && [ \"$end_minutes\" -le 1439 ] || return 1",
    "  timezone=$(/usr/bin/plutil -extract \"$key.timezone\" raw -o - \"$file\" 2>/dev/null) || timezone=",
    "  if [ -n \"$timezone\" ]; then current=$(TZ=\"$timezone\" /bin/date +%H:%M 2>/dev/null) || current=$(/bin/date +%H:%M); else current=$(/bin/date +%H:%M); fi",
    "  current_minutes=$(to_minutes \"$current\")",
    "  if [ \"$start_minutes\" -le \"$end_minutes\" ]; then",
    "    [ \"$current_minutes\" -ge \"$start_minutes\" ] && [ \"$current_minutes\" -le \"$end_minutes\" ] && window_active=1",
    "  elif [ \"$current_minutes\" -ge \"$start_minutes\" ] || [ \"$current_minutes\" -le \"$end_minutes\" ]; then",
    "    window_active=1",
    "  fi",
    "  return 0",
    "}",
    `if check_window ${config} dreamWindow; then [ "$window_active" = "1" ] && exec ${fallback}; exit 0; fi`,
    `if check_window ${schedule} window; then [ "$window_active" = "1" ] && exec ${fallback}; fi`,
    "exit 0",
  ].join("\n")
}

export function dreamServicePlan(args: DreamServiceArgs = {}): DreamServicePlan {
  const platformValue = platform(args.platform)
  const backend = backendFor(platformValue)
  const label = "com.mendcode.dream"
  const intervalMs = args.intervalMs ?? 60_000
  const command = args.command ?? defaultCommand()
  const serviceDir = path.resolve(args.serviceDir || defaultServiceDir(platformValue))
  const logDir = path.resolve(args.logDir || defaultLogDir(platformValue))
  const workingDirectory = path.resolve(args.workingDirectory || os.homedir())
  const oneShot = serviceRunsOneShot(platformValue)
  const memoryDirectory = process.env.MENDCODE_MEMORY_DIR || path.join(computeGlobalRoots(resolveActiveAppSegment()).data, "memory")
  const programArguments = platformValue === "win32"
    ? [command, ...dreamDaemonArgs({ intervalMs }, { once: oneShot })]
    : [
        "/usr/bin/env",
        `PATH=${servicePath()}`,
        command,
        ...dreamDaemonArgs({ intervalMs }, { once: oneShot }),
      ]
  const definitionPath =
    platformValue === "darwin"
      ? path.join(serviceDir, `${label}.plist`)
      : platformValue === "linux"
        ? path.join(serviceDir, `${label}.service`)
        : path.join(serviceDir, `${label}.cmd`)
  const serviceProgramArguments = platformValue === "darwin"
    ? ["/bin/sh", "-c", dreamWindowPreflightCommand({ daemonArguments: programArguments, memoryDirectory })]
    : programArguments
  const programLine = platformValue === "win32" ? windowsCommandLine(programArguments) : shellQuote(programArguments)
  return {
    label,
    backend,
    platform: platformValue,
    workingDirectory,
    definitionPath,
    stdoutPath: path.join(logDir, `${label}.log`),
    stderrPath: path.join(logDir, `${label}.err.log`),
    programArguments,
    serviceProgramArguments,
    memoryDirectory,
    installCommand:
      platformValue === "darwin"
        ? ["write", definitionPath]
        : platformValue === "linux"
          ? ["systemctl", "--user", "enable", `${label}.service`]
          : ["schtasks.exe", "/Create", "/F", "/TN", "MendCode\\Dream", "/SC", "ONLOGON", "/TR", programLine],
    startCommand:
      platformValue === "darwin"
        ? ["launchctl", "bootstrap", launchctlDomain(), definitionPath]
        : platformValue === "linux"
          ? ["systemctl", "--user", "enable", "--now", `${label}.service`]
          : ["schtasks.exe", "/Run", "/TN", "MendCode\\Dream"],
    stopCommand:
      platformValue === "darwin"
        ? ["launchctl", "bootout", launchctlDomain(), definitionPath]
        : platformValue === "linux"
          ? ["systemctl", "--user", "stop", `${label}.service`]
          : ["schtasks.exe", "/End", "/TN", "MendCode\\Dream"],
    uninstallCommand:
      platformValue === "darwin"
        ? ["launchctl", "bootout", launchctlDomain(), definitionPath]
        : platformValue === "linux"
          ? ["systemctl", "--user", "disable", "--now", `${label}.service`]
          : ["schtasks.exe", "/Delete", "/F", "/TN", "MendCode\\Dream"],
    statusCommand:
      platformValue === "darwin"
        ? ["launchctl", "print", `${launchctlDomain()}/${label}`]
        : platformValue === "linux"
          ? ["systemctl", "--user", "status", `${label}.service`, "--no-pager"]
          : ["schtasks.exe", "/Query", "/TN", "MendCode\\Dream"],
    intervalMs,
  }
}

export function dreamServicePlist(plan: DreamServicePlan) {
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
    <key>MENDCODE_MEMORY_DIR</key>
    ${stringNode(plan.memoryDirectory)}
  </dict>
  <key>WorkingDirectory</key>
  ${stringNode(plan.workingDirectory)}
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

export function dreamServiceSystemdUnit(plan: DreamServicePlan) {
  return `[Unit]
Description=MendCode global Memory Dream daemon
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${plan.workingDirectory}
ExecStart=${shellQuote(plan.programArguments)}
Restart=always
RestartSec=5
StandardOutput=append:${plan.stdoutPath}
StandardError=append:${plan.stderrPath}

[Install]
WantedBy=default.target
`
}

export function dreamServiceWindowsCommand(plan: DreamServicePlan) {
  return `${windowsCommandLine(plan.programArguments)} >> "${plan.stdoutPath}" 2>> "${plan.stderrPath}"`
}

export function dreamServiceDefinition(plan: DreamServicePlan) {
  if (plan.platform === "darwin") return dreamServicePlist(plan)
  if (plan.platform === "linux") return dreamServiceSystemdUnit(plan)
  return `@echo off\r\ncd /d "${plan.workingDirectory}"\r\n${dreamServiceWindowsCommand(plan)}\r\n`
}

function runLaunchctl(args: string[]) {
  return spawnSync("launchctl", args, { encoding: "utf8" })
}

function runServiceCommand(plan: DreamServicePlan, command: string[]) {
  if (plan.platform === "darwin" && command[0] === "launchctl") return runLaunchctl(command.slice(1))
  return spawnSync(command[0]!, command.slice(1), { encoding: "utf8" })
}

function serviceLoaded(plan: DreamServicePlan) {
  if (platform() !== plan.platform) return { loaded: false, detail: `service is configured for ${plan.platform}, current platform is ${process.platform}` }
  const result = runServiceCommand(plan, plan.statusCommand)
  return {
    loaded: result.status === 0,
    detail: [result.stdout, result.stderr].filter(Boolean).join("\n").trim() || undefined,
  }
}

export async function dreamServiceInstall(args: DreamServiceArgs = {}) {
  const plan = dreamServicePlan(args)
  if (platform() !== plan.platform) throw new Error(`Dream service install target is ${plan.platform}, current platform is ${process.platform}.`)
  await mkdir(path.dirname(plan.definitionPath), { recursive: true })
  await mkdir(path.dirname(plan.stdoutPath), { recursive: true })
  await writeFile(plan.definitionPath, dreamServiceDefinition(plan))
  if (plan.platform === "linux") runServiceCommand(plan, ["systemctl", "--user", "daemon-reload"])
  if (plan.platform !== "darwin") {
    const result = runServiceCommand(plan, plan.installCommand)
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${plan.backend} install failed`)
  }
  return plan
}

export async function dreamServiceUninstall(args: DreamServiceArgs = {}) {
  const plan = dreamServicePlan(args)
  if (platform() !== plan.platform) throw new Error(`Dream service uninstall target is ${plan.platform}, current platform is ${process.platform}.`)
  if (serviceLoaded(plan).loaded) runServiceCommand(plan, plan.uninstallCommand)
  await rm(plan.definitionPath, { force: true })
  if (plan.platform === "linux") runServiceCommand(plan, ["systemctl", "--user", "daemon-reload"])
  return plan
}

export async function dreamServiceStart(args: DreamServiceArgs = {}) {
  const plan = await dreamServiceInstall(args)
  if (platform() !== plan.platform) throw new Error(`Dream service start target is ${plan.platform}, current platform is ${process.platform}.`)
  const existing = serviceLoaded(plan)
  if (existing.loaded) runServiceCommand(plan, plan.stopCommand)
  const result = runServiceCommand(plan, plan.startCommand)
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${plan.backend} start failed`)
  return plan
}

export async function dreamServiceStop(args: DreamServiceArgs = {}) {
  const plan = dreamServicePlan(args)
  if (platform() !== plan.platform) throw new Error(`Dream service stop target is ${plan.platform}, current platform is ${process.platform}.`)
  const result = runServiceCommand(plan, plan.stopCommand)
  if (result.status !== 0 && serviceLoaded(plan).loaded) throw new Error(result.stderr || result.stdout || `${plan.backend} stop failed`)
  return plan
}

export async function dreamServiceStatus(args: DreamServiceArgs = {}): Promise<DreamServiceStatus> {
  const plan = dreamServicePlan(args)
  let installed = false
  try {
    await readFile(plan.definitionPath, "utf8")
    installed = true
  } catch {
    installed = false
  }
  const loaded = serviceLoaded(plan)
  return {
    installed,
    loaded: loaded.loaded,
    label: plan.label,
    backend: plan.backend,
    platform: plan.platform,
    definitionPath: plan.definitionPath,
    stdoutPath: plan.stdoutPath,
    stderrPath: plan.stderrPath,
    intervalMs: plan.intervalMs,
    detail: loaded.detail,
  }
}
