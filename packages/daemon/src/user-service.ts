import { spawn, spawnSync } from "node:child_process"
import { constants, closeSync, openSync } from "node:fs"
import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { daemonLogPaths, daemonLogs } from "./daemon-logs"

export type ServiceAction = "plan" | "install" | "start" | "stop" | "restart" | "uninstall" | "status" | "logs"
export type ServiceOptions = { dir: string; cwd: string; command: string[]; engine?: string; serviceDir?: string; platform?: string; home?: string; uid?: number }
export type ServicePlan = {
  label: string
  backend: "launchd" | "systemd-user" | "unsupported"
  supported: boolean
  dataDir: string
  cwd: string
  definitionPath: string
  bindingPath: string
  stdoutPath: string
  stderrPath: string
  programArguments: string[]
  installCommand: string[]
  startCommand: string[]
  stopCommand: string[]
  statusCommand: string[]
  uninstallCommand: string[]
}
export type ServiceResult = ServicePlan & { installed?: boolean; loaded?: boolean; drift?: string[]; detail?: string }
export type ServiceExecutor = (command: string[]) => { code: number; stdout: string; stderr: string }

const LABEL = "com.mendcode.v2.daemon"

/** How long a detached daemon waits with no client, work or standing feature before it stops itself. */
export const DETACHED_IDLE_EXIT_MS = 10 * 60_000

/** The user service keeps its daemon on purpose (launchd and systemd would restart one that left): it never stops for being idle. */
export function runsAsUserService(env: NodeJS.ProcessEnv) {
  return env.MENDCODE_V2_SERVICE === "1" || env.XPC_SERVICE_NAME === LABEL || Boolean(env.INVOCATION_ID)
}
const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;")
const unitQuote = (text: string) => '"' + text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", () => "$$") + '"'

export function daemonServicePlan(options: ServiceOptions): ServicePlan {
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const backend = platform === "darwin" ? "launchd" : platform === "linux" ? "systemd-user" : "unsupported"
  const serviceDir = options.serviceDir ?? (platform === "darwin" ? path.join(home, "Library", "LaunchAgents") : path.join(home, ".config", "systemd", "user"))
  const dir = path.resolve(options.dir)
  const cwd = path.resolve(options.cwd)
  const programArguments = [...options.command, "--dir", dir, "--cwd", cwd, "--local-only", ...(options.engine ? ["--engine", options.engine] : [])]
  if (!options.command.length || programArguments.some((arg) => /[\x00-\x1f\x7f]/.test(arg))) throw new Error("Invalid daemon service arguments")
  if (!path.isAbsolute(options.command[0]!)) throw new Error("Daemon service executable must be absolute")
  const definitionPath = path.join(path.resolve(serviceDir), `${LABEL}.${backend === "launchd" ? "plist" : "service"}`)
  const domain = `gui/${options.uid ?? process.getuid?.() ?? 0}`
  const unit = `${LABEL}.service`
  const logs = daemonLogPaths(dir)
  return {
    label: LABEL, backend, supported: backend !== "unsupported", dataDir: dir, cwd, definitionPath,
    bindingPath: path.join(path.resolve(serviceDir), `${LABEL}.json`), stdoutPath: logs.stdout, stderrPath: logs.stderr, programArguments,
    installCommand: backend === "systemd-user" ? ["systemctl", "--user", "enable", unit] : [],
    startCommand: backend === "launchd" ? ["launchctl", "bootstrap", domain, definitionPath] : ["systemctl", "--user", "start", unit],
    stopCommand: backend === "launchd" ? ["launchctl", "bootout", `${domain}/${LABEL}`] : ["systemctl", "--user", "stop", unit],
    statusCommand: backend === "launchd" ? ["launchctl", "print", `${domain}/${LABEL}`] : ["systemctl", "--user", "is-active", unit],
    uninstallCommand: backend === "systemd-user" ? ["systemctl", "--user", "disable", unit] : [],
  }
}

export function daemonServiceDefinition(plan: ServicePlan) {
  if (plan.backend === "launchd") return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${plan.label}</string>
<key>ProgramArguments</key><array>${plan.programArguments.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(plan.cwd)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>EnvironmentVariables</key><dict><key>MENDCODE_V2_SERVICE</key><string>1</string></dict>
<key>ThrottleInterval</key><integer>5</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(plan.stdoutPath)}</string>
<key>StandardErrorPath</key><string>${xml(plan.stderrPath)}</string>
</dict></plist>
`
  if (plan.backend !== "systemd-user") throw new Error("User service activation supports macOS/Linux only; use daemon start or daemon run")
  return `[Unit]
Description=MendCode user daemon (loops and Dream)

[Service]
Type=simple
WorkingDirectory=${unitQuote(plan.cwd).replaceAll("$$", "$")}
ExecStart=${plan.programArguments.map(unitQuote).join(" ")}
Environment=MENDCODE_V2_SERVICE=1
Restart=always
RestartSec=5
UMask=0077
StandardOutput=append:${plan.stdoutPath.replaceAll("%", "%%")}
StandardError=append:${plan.stderrPath.replaceAll("%", "%%")}

[Install]
WantedBy=default.target
`
}

const readOptional = async (file: string) => {
  try {
    if ((await lstat(file)).isSymbolicLink()) throw new Error("Service files must not be symlinks")
    return await readFile(file, "utf8")
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error }
}

/** One fixed user label: different projects cannot install competing loop/Dream daemons. */
export function createUserService(options: ServiceOptions, execute: ServiceExecutor = (command) => {
  const result = spawnSync(command[0]!, command.slice(1), { encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 })
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.error?.message ?? result.stderr ?? "" }
}) {
  const requested = daemonServicePlan(options)
  const run = (command: string[]) => {
    if (!command.length) return
    const result = execute(command)
    if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `${command[0]} failed`)
  }
  async function binding(requireMatch = true) {
    const text = await readOptional(requested.bindingPath)
    if (!text) return undefined
    const value = JSON.parse(text) as ServiceOptions
    if (typeof value.dir !== "string" || typeof value.cwd !== "string" || !Array.isArray(value.command) || !value.command.every((item) => typeof item === "string") || (value.engine !== undefined && typeof value.engine !== "string")) throw new Error("Invalid daemon service binding")
    if (requireMatch && path.resolve(value.dir) !== requested.dataDir) throw new Error(`User service belongs to ${value.dir}; use that --dir`)
    return daemonServicePlan({ ...options, dir: value.dir, cwd: value.cwd, command: value.command, ...(value.engine ? { engine: value.engine } : {}) })
  }
  async function status(): Promise<ServiceResult> {
    const plan = await binding(false) ?? requested
    const definition = await readOptional(plan.definitionPath)
    const loaded = plan.supported ? execute(plan.statusCommand) : { code: 1, stdout: "", stderr: "No user service manager on this platform; use daemon start or daemon run" }
    const drift = [...(definition === undefined ? ["definition-missing"] : definition !== daemonServiceDefinition(plan) ? ["definition-drift"] : []), ...(plan.dataDir !== requested.dataDir ? ["data-dir-mismatch"] : [])]
    return { ...plan, installed: definition !== undefined, loaded: loaded.code === 0, drift, detail: (loaded.stdout || loaded.stderr).trim().slice(0, 2000) }
  }
  async function control(action: ServiceAction): Promise<ServiceResult> {
    if (action === "plan") return requested
    if (!requested.supported) throw new Error("User service activation supports macOS/Linux only; use daemon start or daemon run")
    const plan = await binding() ?? requested
    if (action === "status") return status()
    const existing = await status()
    if (action === "install") {
      if (existing.loaded) throw new Error("Stop the user service before reinstalling")
      if (existing.installed && !await readOptional(plan.bindingPath)) throw new Error("Service definition has no MendCode binding; refusing to overwrite")
      await mkdir(path.dirname(plan.definitionPath), { recursive: true })
      await mkdir(path.dirname(plan.stdoutPath), { recursive: true, mode: 0o700 })
      for (const file of [plan.stdoutPath, plan.stderrPath]) {
        const fd = openSync(file, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
        closeSync(fd)
        await chmod(file, 0o600)
      }
      await writeFile(plan.definitionPath, daemonServiceDefinition(requested), { mode: 0o600 })
      await writeFile(plan.bindingPath, JSON.stringify({ dir: requested.dataDir, cwd: requested.cwd, command: options.command, ...(options.engine ? { engine: options.engine } : {}) }) + "\n", { mode: 0o600 })
      if (plan.backend === "systemd-user") run(["systemctl", "--user", "daemon-reload"])
      run(plan.installCommand)
      return status()
    }
    if (!existing.installed || existing.drift?.length) throw new Error("Install a matching user service definition first")
    if (action === "start") { if (!existing.loaded) run(plan.startCommand) }
    else if (action === "stop") { if (existing.loaded) run(plan.stopCommand) }
    else if (action === "restart") { if (existing.loaded) run(plan.stopCommand); run(plan.startCommand) }
    else if (action === "uninstall") {
      if (existing.loaded) run(plan.stopCommand)
      run(plan.uninstallCommand)
      const trash = path.join(plan.dataDir, "service", "trash", String(Date.now()))
      await mkdir(trash, { recursive: true, mode: 0o700 })
      await rename(plan.definitionPath, path.join(trash, path.basename(plan.definitionPath)))
      if (await readOptional(plan.bindingPath)) await rename(plan.bindingPath, path.join(trash, path.basename(plan.bindingPath)))
      if (plan.backend === "systemd-user") run(["systemctl", "--user", "daemon-reload"])
    }
    return status()
  }
  return { plan: requested, control, status, logs: (lines = 100) => daemonLogs(requested.dataDir, lines) }
}

/** Detached startup owns file descriptors only until spawn; the daemon owns its existing writer lock. */
export async function launchUserDaemon(options: ServiceOptions) {
  const plan = daemonServicePlan(options)
  await mkdir(path.dirname(plan.stdoutPath), { recursive: true, mode: 0o700 })
  const descriptors: number[] = []
  try {
    for (const file of [plan.stdoutPath, plan.stderrPath]) descriptors.push(openSync(file, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600))
    const child = spawn(plan.programArguments[0]!, plan.programArguments.slice(1), { cwd: plan.cwd, detached: true, stdio: ["ignore", descriptors[0]!, descriptors[1]!] })
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject) })
    child.unref()
    return child.pid!
  } finally { for (const fd of descriptors) closeSync(fd) }
}
