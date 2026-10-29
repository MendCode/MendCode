#!/usr/bin/env bun
import { parseRemoteFlags, parseTokenCommand, remoteTransport, REMOTE_DISABLED_NOTE, runTokenCommand } from "./remote"
import { createClient } from "@mendcode/client"
import { defaultLocalTransport, localEndpointPath, readLocalEndpoint } from "@mendcode/client/local-endpoint"
import type { GlobalEvent, SessionEvent, SessionId, SessionSummary, Settings, ThemesReport } from "@mendcode/protocol"
import { helpText, parseAutomation, runAutomation, SCHEMA } from "./automation"
import { COMPAT, compatEnvelope } from "./compat"
import { computeBuildId } from "@mendcode/build-id"
import { homedir, tmpdir } from "node:os"
import { mkdtemp, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { DEFAULT_DIR, ensureDaemon, stopIfStale, terminateDaemon, waitForSocketGone } from "./launcher"
import { resolveProcessMode, startsSolo } from "./process-modes"
import { createHeadlessRun } from "./run"
import { loadRunOutput, type RunOutput } from "./run-output"
import { readPipedStdin, STDIN_FIRST_BYTE_MS } from "./run-stdin"
import { parseStartup, prepareStartup, prepareRunSubmission, STARTUP_USAGE, type Startup } from "./startup"
import type { createApp as CreateApp } from "./ui/app"
import type { PresentationMode } from "./view/transcript"
import { readTuiProfile } from "./view/tui-profile"
import packageJson from "../package.json"
import { parseGlobalOptions, cliLogger } from "./global-options"
import { completionScript } from "./support-output"
import { sessionToMarkdown } from "./export"
import { HTTP_USAGE, parseServerCommand } from "./http-cli"
import { createDaemonServiceCli, DAEMON_USAGE, parseDaemonService, type DaemonServiceCommand } from "./daemon-service"
import { daemonCommand } from "./launcher"
import { parseViewCommand, runViewCommand } from "./view-args"
import { parseDocsCommand } from "./docs-args"
import { parsePackageFileCommand, runPackageFileCommand } from "./package-file-command"
import { PROGRAM_NAME } from "@mendcode/program"
import { createHerdrReporter, createTuiosChildren, createTuiosMeta, herdrPane, paneState, tuiosPane, waitingChild, type PaneChild, type PaneFacts } from "./herdr"
import { guardClient, originCapabilities, originRefusal, startedBySession } from "./agent-origin"
import { AGENT_SHELL_ENV } from "@mendcode/protocol/wire"
import { EXTENSION_DIALOGS_CAPABILITY } from "@mendcode/extension-api"

/** The product version shown on the home screen. */
const CLI_VERSION = packageJson.version

let globalOptions: ReturnType<typeof parseGlobalOptions>
try { globalOptions = parseGlobalOptions(process.argv.slice(2)) } catch (error) {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(64)
}
const log = cliLogger(globalOptions, process.stderr)
/** The data directory a command works on, as the session mark names it. */
const originDir = (dir?: string) => path.resolve(dir ?? process.env.MENDCODE_V2_DIR ?? DEFAULT_DIR)
/**
 * Started from a session's own shell against the daemon that session runs under: what only the user decides stops here
 * (docs/permissions.md). `anywhere`: the command changes this installation, whatever data directory it names.
 */
function refuseFromSession(dir: string | undefined, what: string, anywhere = false) {
  if (!(anywhere ? process.env[AGENT_SHELL_ENV] : startedBySession({ env: process.env, dir: originDir(dir) }))) return
  process.stderr.write(`error: ${originRefusal({ argv: process.argv.slice(2), what })}\n`)
  process.exit(1)
}
const rawArgv = globalOptions.args
/** `--safe-mode` / MENDCODE_SAFE_MODE=1: a pure start that also leaves out packages, shell hooks, MCP and project tools (docs/tiers.md). */
const safeMode = globalOptions.safeMode === true || process.env.MENDCODE_SAFE_MODE === "1"
const pure = globalOptions.pure === true || safeMode
try {
  const server = parseServerCommand(rawArgv)
  if (server) {
    if (server.help) { process.stdout.write(HTTP_USAGE); process.exit(0) }
    refuseFromSession(server.dir, "opens an HTTP server on the data directory")
    const { launchHttpServer } = await import("@mendcode/daemon/http-launch")
    await launchHttpServer({ ...server, dir: server.dir!, ...(globalOptions.logLevel ? { logLevel: globalOptions.logLevel } : {}) })
    await new Promise(() => {})
  }
} catch (error) {
  process.stderr.write(`error: ${error instanceof Error ? error.message : "HTTP server setup failed"}\n${HTTP_USAGE}`)
  process.exit(64)
}
let transportFlags: ReturnType<typeof parseRemoteFlags>
try {
  // Token administration runs without connecting to or launching a daemon.
  if (rawArgv.includes("remote")) {
    const command = parseTokenCommand(rawArgv)
    if (command) {
      if (command.action !== "list") refuseFromSession(command.dir, "creates or revokes remote access")
      await runTokenCommand(command, process.stdout)
      process.exit(0)
    }
  }
  transportFlags = parseRemoteFlags(rawArgv)
} catch (error) {
  process.stderr.write(`error: ${error instanceof Error ? error.message : "remote setup failed"}\n`)
  process.exit(64)
}
const argv = transportFlags.args
const remote = transportFlags.remote ? remoteTransport(transportFlags.remote, process.env) : undefined
const remoteAttach = Boolean(remote || transportFlags.socketPath)
const traceEnabled = globalOptions.trace ?? process.env.MENDCODE_TRACE === "1"
if (traceEnabled && remoteAttach) {
  process.stderr.write("error: --trace is local-only\n")
  process.exit(64)
}
if (globalOptions.approve === true && remoteAttach) {
  process.stderr.write("error: --approve is local-only; trust a remote project on its own machine\n")
  process.exit(64)
}
let daemonService: DaemonServiceCommand | undefined
try { daemonService = parseDaemonService(argv) } catch (error) {
  process.stderr.write(`error: ${error instanceof Error ? error.message : "Invalid daemon command"}\n${DAEMON_USAGE}`)
  process.exit(64)
}
if (daemonService) {
  if (remoteAttach) { process.stderr.write("error: daemon lifecycle commands are local-only\n"); process.exit(64) }
  if (daemonService.help) { process.stdout.write(DAEMON_USAGE); process.exit(0) }
  if (!["status", "logs", "plan"].includes(daemonService.action)) refuseFromSession(daemonService.dir, "stops, starts or reinstalls the daemon every session runs under")
  const dir = path.resolve(daemonService.dir ?? process.env.MENDCODE_V2_DIR ?? DEFAULT_DIR)
  const cwd = path.resolve(daemonService.cwd ?? process.cwd())
  const runtime = await import("../../../packages/daemon/src/user-service")
  const command = daemonCommand()
  if (command[0] === "bun") command[0] = process.execPath
  const options = { dir, cwd, command, ...(daemonService.engine ? { engine: daemonService.engine } : {}), ...(daemonService.serviceDir ? { serviceDir: daemonService.serviceDir } : {}) }
  const host = runtime.createUserService(options)
  process.exit(await createDaemonServiceCli({
    dir, cwd, host, out: process.stdout, err: process.stderr, now: Date.now, sleep: Bun.sleep,
    connect: async () => {
      const client = createClient({ ...(defaultLocalTransport() === "tcp" || readLocalEndpoint(dir) ? { localTcp: () => readLocalEndpoint(dir) } : { socketPath: path.join(dir, "mendd.sock") }), name: "daemon-control", reconnect: false, timeoutMs: 2000 })
      try { await client.connect(); return client } catch { client.close(); return undefined }
    },
    launch: async () => { await runtime.launchUserDaemon(options) },
    foreground: async () => {
      process.argv = [process.execPath, "__daemon", ...host.plan.programArguments.slice(command.length)]
      await import("../../../packages/daemon/src/main")
      await new Promise<void>(() => {})
    },
    waitStopped: async () => {
      await waitForSocketGone(path.join(dir, "mendd.sock"), 5000)
      await waitForSocketGone(localEndpointPath(dir), 5000)
    },
  })(daemonService))
}
// `view list|scaffold` writes files only: no daemon, no terminal.
const viewCommand = parseViewCommand(argv)
// A starter is this program's own template in a new file, so a session may write one; replacing a view the user already has (`--force`) stays the user's.
if (viewCommand?.action === "scaffold" && viewCommand.force) refuseFromSession(viewCommand.dir, "replaces an extension view the user has")
if (viewCommand) process.exit(runViewCommand(viewCommand, { dataDir: viewCommand.dir ?? process.env.MENDCODE_V2_DIR ?? DEFAULT_DIR, out: process.stdout, err: process.stderr }))
// `docs [topic]` prints a reference card of this version from the binary and local files; a daemon is asked only when one already runs. The cards load on demand.
const docsCommand = parseDocsCommand(argv)
if (docsCommand) process.exit(await (await import("./docs-run")).runDocsCommand(docsCommand, { dataDir: docsCommand.dir ?? process.env.MENDCODE_V2_DIR ?? DEFAULT_DIR, cwd: process.cwd(), out: process.stdout, err: process.stderr }))
// `package new|check` work on package folders only: no daemon, no terminal.
const packageFileCommand = parsePackageFileCommand(argv)
if (packageFileCommand) process.exit(await runPackageFileCommand(packageFileCommand, { cwd: process.cwd(), version: CLI_VERSION, out: process.stdout, err: process.stderr }))
function arg(name: string) {
  const inline = argv.find((token) => token.startsWith(`--${name}=`))
  if (inline !== undefined) return inline.slice(name.length + 3)
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : undefined
}
const flag = (name: string) => argv.includes(`--${name}`)
const VALUE_FLAGS = new Set(["--dir", "--engine", "--session", "--format", "--compat"])
const compat = arg("compat") === COMPAT
if ((flag("compat") || arg("compat") !== undefined) && !compat) {
  process.stderr.write(`error: --compat must be ${COMPAT}\n`)
  process.exit(64)
}
/** `--format json` is v1's spelling of `--json`. */
const wantsJson = flag("json") || arg("format") === "json" || compat
function positional() {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (VALUE_FLAGS.has(argv[i]!)) i++
    else if (!argv[i]!.startsWith("--")) out.push(argv[i]!)
  }
  return out
}

if (remoteAttach && ["acp", "app-server", "upgrade", "migrate-v1", "uninstall", "update"].includes(positional()[0] ?? "")) {
  process.stderr.write("error: acp, app-server, upgrade, update, migrate-v1 and uninstall are local-only commands\n")
  process.exit(64)
}

// Local uninstall reviews ownership before any daemon connection or startup.
const uninstall = argv.includes("uninstall") ? await import("@mendcode/upgrade/uninstall-args") : undefined
if (uninstall?.isUninstallCommand(argv)) {
  const parsed = uninstall.parseUninstallArgs(argv)
  if (!parsed.ok) {
    process.stderr.write(`error: ${parsed.message}\n${uninstall.UNINSTALL_USAGE}\n`)
    process.exit(64)
  }
  if (!parsed.command.dryRun && !parsed.command.help) refuseFromSession(parsed.command.dir, "removes this installation", true)
  const { runUninstallCommand } = await import("@mendcode/upgrade/uninstall")
  process.exit(await runUninstallCommand(parsed.command, {
    out: process.stdout, err: process.stderr, env: process.env, home: homedir(), defaultDir: DEFAULT_DIR, platform: process.platform,
    ...(/^(\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/.test(Bun.main) ? { runningBinary: process.execPath } : {}),
    ...(process.stdin.isTTY && process.stdout.isTTY && !parsed.command.json ? { confirm: async (plan: import("@mendcode/upgrade/uninstall").UninstallPlan) => (await import("./ui/uninstall-prompt")).terminalUninstallPrompt(plan) } : {}),
    ...(process.stdin.isTTY && process.stdout.isTTY && !parsed.command.json ? { review: async (plan: import("@mendcode/upgrade/uninstall").UninstallPlan, dryRun: boolean) => { await (await import("./ui/uninstall-prompt")).terminalUninstallPrompt(plan, dryRun) } } : {}),
  }))
}

// `upgrade` replaces the installed binary: it never starts or stops a daemon, so it runs before any connection.
// The module loads on demand to keep it out of the startup graph.
const upgrade = argv.includes("upgrade") || argv.includes("update") ? await import("@mendcode/upgrade") : undefined
if (upgrade?.isUpgradeCommand(argv)) {
  if (remoteAttach) {
    process.stderr.write("error: upgrade and update are local-only commands\n")
    process.exit(64)
  }
  const parsed = upgrade.parseUpgradeArgs(argv)
  if (!parsed.ok) {
    process.stderr.write(`error: ${parsed.message}\n${upgrade.UPGRADE_USAGE}\n`)
    process.exit(upgrade.UPGRADE_EXIT.usage)
  }
  if (!parsed.command.check && !parsed.command.inspect && !parsed.command.help) refuseFromSession(parsed.command.dir, "replaces the installed program", true)
  const { createNodePorts } = await import("@mendcode/upgrade/io")
  process.exit(
    await upgrade.runUpgradeCommand(parsed.command, {
      ports: createNodePorts(),
      out: process.stdout,
      err: process.stderr,
      env: process.env,
      home: homedir(),
      defaultDir: DEFAULT_DIR,
      currentVersion: CLI_VERSION,
      platform: { os: process.platform, arch: process.arch },
    }),
  )
}

// `migrate-v1` imports legacy MendCode history into an explicit MendCode data dir: it opens the target store itself
// (and refuses while a daemon holds it), so it runs before any connection. Loaded on demand like `upgrade`.
const migrate = argv.includes("migrate-v1") ? await import("@mendcode/migrate") : undefined
if (migrate?.isMigrateCommand(argv)) {
  const parsed = migrate.parseMigrateArgs(argv)
  if (!parsed.ok) {
    process.stderr.write(`error: ${parsed.message}\n${migrate.MIGRATE_USAGE}\n`)
    process.exit(migrate.MIGRATE_EXIT.usage)
  }
  refuseFromSession(parsed.command.dir, "imports history into the data directory")
  process.exit(await migrate.runMigrateCommand(parsed.command, { out: process.stdout, err: process.stderr, home: homedir() }))
}

const automation = parseAutomation(globalOptions.offline ? [...argv, "--offline"] : argv)
if (automation.ok === true && automation.command.kind === "storage" && automation.command.offline) {
  if (remoteAttach) { process.stderr.write("error: offline storage compaction is local-only\n"); process.exit(64) }
  if (!automation.command.dryRun) refuseFromSession(arg("dir"), "rewrites the stored sessions")
  try {
    const { compactOfflineStorage } = await import("@mendcode/daemon/storage-compact")
    const result = compactOfflineStorage({ dir: arg("dir")!, dryRun: automation.command.dryRun })
    process.stdout.write(wantsJson ? `${JSON.stringify(result)}\n` : `${result.dryRun ? "preview" : "compacted"}: ${result.pageSize} → ${result.targetPageSize} byte pages · ${result.beforeBytes} → ${result.afterBytes} bytes${result.backup ? ` · backup ${result.backup}` : ""}\n`)
    process.exit(0)
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : "offline compaction failed"}\n`)
    process.exit(1)
  }
}
if (remoteAttach && automation.ok === true && (automation.command.kind.startsWith("github.") || automation.command.kind === "pr")) {
  process.stderr.write("error: GitHub and PR commands are local-only\n")
  process.exit(64)
}
let startup: Startup | undefined
let project = process.cwd()
let runPrompt = ""
let runOutput: RunOutput | undefined
if (automation.ok === "none") {
  try {
    startup = parseStartup(argv)
    startup.offline ||= globalOptions.offline === true
    if (startup.help) { process.stdout.write(STARTUP_USAGE); process.exit(0) }
    if (startup.isolated && remoteAttach) throw new Error("--isolated cannot attach to another daemon")
    if (remoteAttach && (startup.kind === "acp" || startup.kind === "app-server")) throw new Error(`${startup.kind} is local-only`)
    if (remoteAttach && startup.files.length) throw new Error("file attachments disabled while remote")
    if (startup.project && !remoteAttach) {
      project = await realpath(path.resolve(process.env.PWD ?? process.cwd(), startup.project))
      if (!(await stat(project)).isDirectory()) throw new Error("project path is not a directory")
    }
    if (startup.kind === "run") {
      const message = startup.words.join(" ")
      // With a message, a stdin that never speaks must not hold the run: see run-stdin.ts for the rule.
      const piped = process.stdin.isTTY ? { text: "", skipped: false } : await readPipedStdin({ stream: Bun.stdin.stream(), wait: message && !startup.waitStdin ? "first-byte" : "end" })
      if (piped.skipped) process.stderr.write(`stdin: nothing arrived in ${STDIN_FIRST_BYTE_MS / 1000} s, continuing with the message alone (pass - to wait for stdin)\n`)
      runPrompt = [message, piped.text.trim()].filter(Boolean).join("\n").trim()
      if (!runPrompt && !startup.command && !startup.files.length) throw new Error("run needs a message, stdin, --command or --file")
      runOutput = await loadRunOutput({ ...(startup.outputSchema ? { schemaFile: startup.outputSchema } : {}), ...(startup.outputFile ? { outputFile: startup.outputFile } : {}), cwd: process.cwd() })
    }
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n${STARTUP_USAGE}`)
    process.exit(64)
  }
}
/**
 * An isolated run owns a temporary daemon, so a SIGTERM/SIGINT must always end in `finish` (daemon stopped, exit 0), also when it
 * lands while that daemon is still starting or this process is still connecting (a slow machine: the Linux CI run took the default
 * kill, exit 143, and left the daemon behind). The signal is remembered here and acted on as soon as `finish` can reach the client.
 * The handlers are in place before the temporary directory exists: a signal sent the moment it appears would otherwise still be the default kill.
 */
let isolatedStopRequested = false
let stopIsolated: (() => void) | undefined
if (startup?.isolated) {
  const request = () => {
    if (isolatedStopRequested) return
    isolatedStopRequested = true
    stopIsolated?.()
  }
  process.once("SIGTERM", request)
  process.once("SIGINT", request)
}
const isolatedDir = startup?.isolated ? await mkdtemp(path.join(tmpdir(), "mendcode-isolated-")) : undefined
const daemonDataDir =isolatedDir ?? startup?.dataDir ?? (automation.ok === true && (automation.command.kind.startsWith("session.") || automation.command.kind.startsWith("catalog.") || automation.command.kind.startsWith("theme.") || automation.command.kind.startsWith("agent.") || ["db", "debug", "debug.wait"].includes(automation.command.kind) || automation.command.kind.startsWith("github.") || automation.command.kind === "pr") ? automation.command.dir : arg("dir"))
const daemonOptions = {
  ...(daemonDataDir ? { dir: daemonDataDir } : {}),
  ...(arg("engine") ? { engine: arg("engine")! } : {}),
  cwd: project,
  ...(globalOptions.logLevel ? { logLevel: globalOptions.logLevel } : {}),
  printLogs: globalOptions.printLogs,
  pure,
  ...(safeMode ? { safeMode: true } : {}),
  trace: false,
}

// Automation subcommands (session/memory/loop/usage/help): usage errors and help never need a daemon.
if (compat && automation.ok === "none" && startup?.kind !== "run") {
  process.stdout.write(`${JSON.stringify(compatEnvelope({ kind: "error", command: "usage", error: { code: "usage", message: "--compat requires an automation command or run" } }))}\n`)
  process.exit(64)
}
if (automation.ok === false) {
  if (compat) process.stdout.write(`${JSON.stringify(compatEnvelope({ kind: "error", command: automation.topic ?? "usage", error: { code: "usage", message: automation.message } }))}\n`)
  else process.stderr.write(`error: ${automation.message}\n${helpText(automation.topic)}`)
  process.exit(64)
}
if (automation.ok === true && automation.command.kind === "help") {
  process.stdout.write(helpText(automation.command.topic) + (automation.command.topic ? "" : STARTUP_USAGE))
  process.exit(0)
}
if (automation.ok === true && (automation.command.kind === "version" || automation.command.kind === "completion")) {
  process.stdout.write(automation.command.kind === "version" ? `${CLI_VERSION}\n` : completionScript(automation.command.shell))
  process.exit(0)
}
if (automation.ok === true) {
  if (automation.command.kind === "generate" && automation.command.backend === "httpapi") {
    const { loadHttpApi, renderHttpApi } = await import("./generate-httpapi")
    const text = renderHttpApi({ spec: await loadHttpApi(), json: automation.command.json, compat: automation.command.compat, schema: SCHEMA, now: Date.now() })
    // The document exceeds a pipe's buffer: exit only after the write is flushed.
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()))
    process.exit(0)
  }
}
/** Whether this terminal was started by a session of the daemon it is about to talk to. */
const fromSession = !remoteAttach && startedBySession({ env: process.env, dir: originDir(daemonDataDir) })
if (flag("restart-daemon") && !remoteAttach) refuseFromSession(daemonDataDir, "stops the daemon every session runs under")
// A session never starts or drives another session with approvals off: that would be more authority than it has.
if (!remoteAttach && (flag("approve") || flag("dangerously-skip-permissions"))) refuseFromSession(daemonDataDir, "starts or drives a session with approvals off")
if (flag("restart-daemon")) await terminateDaemon(daemonDataDir)

/**
 * Solo mode (solo.ts): an interactive local terminal that finds no daemon runs it in this process. Decided once, at the
 * first connection: `--process`, `MENDCODE_PROCESS` and the saved profile's `processMode` (default `auto`) choose; a daemon
 * that is already running (or an installed user service) keeps the separate-process shape.
 */
const processMode = startup?.kind === "tui" && !remoteAttach
  ? resolveProcessMode({ flag: globalOptions.processMode, env: process.env.MENDCODE_PROCESS, profile: readTuiProfile(daemonDataDir ?? process.env.MENDCODE_V2_DIR ?? DEFAULT_DIR).processMode })
  : "daemon"
let soloPending = startsSolo({ mode: processMode, interactive: startup?.kind === "tui", remote: remoteAttach, explicitSocket: Boolean(transportFlags.socketPath), printLogs: globalOptions.printLogs })
// A compiled interactive terminal restarts itself once, in place (`execve`: same pid, same terminal), with fewer JIT tiers: they are
// read from the environment before any code runs (launcher.ts `LEAN_JIT`). Nothing has been drawn or connected yet.
if (startup?.kind === "tui" && /^(\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/.test(Bun.main)) {
  const { leanClientEnv, forgetLeanJit, liveDaemon } = await import("./launcher")
  // Solo is only a wish until the first connection: with a daemon already running this terminal only draws.
  const hosts = soloPending && !(await liveDaemon(daemonDataDir ?? process.env.MENDCODE_V2_DIR ?? DEFAULT_DIR))
  const lean = leanClientEnv(process.env, hosts)
  if (lean) (await (await import("./relaunch")).selfExec())?.(process.execPath, process.argv.slice(2), lean)
  forgetLeanJit()
}
/**
 * The terminal's own modules (the app, the screen and every view they draw, about 240 modules) load only for the TUI and only
 * after the restart above: the process that restarts and every scripted command never parse them. They load while this
 * process connects.
 */
const loadTerminalModules = () => Promise.all([import("./ui/app"), import("./ui/screen"), import("./ui/keyboard-protocol"), import("./ui/keyboard-layout"), import("./ui/crash"), import("./ui/theme"), import("./ui/theme-files"), import("./view/transcript"), import("./view/accessible")])
const terminalModules = startup?.kind === "tui" ? loadTerminalModules() : undefined
/** The daemon this process hosts, while it does. */
let soloHost: import("./solo").SoloHost | undefined

type Listener = { onEvent(event: SessionEvent): void }
let listener: Listener | undefined
/** Automation commands that wait for pushes (`workflow start --wait`) take global events before the TUI would. */
let globalListener: ((event: GlobalEvent) => void) | undefined
let app: ReturnType<typeof CreateApp> | undefined
const earlyGlobals: GlobalEvent[] = []

/** Settles once a daemon that was asked to stop has released its socket; a reconnect must not land on the dying one. */
let pendingStop: Promise<void> = Promise.resolve()
async function connect() {
  log("DEBUG", "connecting to daemon")
  const hostSolo = soloPending
  soloPending = false
  const local = transportFlags.socketPath || remote ? undefined : await ensureDaemon({ ...daemonOptions, ...(hostSolo ? { solo: true } : {}) })
  if (local?.host) soloHost = local.host
  const socketPath = transportFlags.socketPath ?? local?.socketPath ?? ""
  const next = createClient({
    ...(remote ? { remote } : local?.tcp ? { localTcp: () => readLocalEndpoint(local.dir) } : { socketPath }),
    // The hosted daemon is reached in memory while it lives; once it stops (/daemon restart) the client falls back to the socket of the daemon that replaces it.
    ...(soloHost ? { loopback: () => (soloHost && !soloHost.stopped ? soloHost.attach : undefined) } : {}),
    name: "mendcode",
    // The interactive terminal draws extension dialogs; a headless run, ACP or the app server never declares it, so a hook's dialog answers its default there at once.
    ...(remoteAttach ? {} : { capabilities: [...originCapabilities({ env: process.env, dir: originDir(daemonDataDir) }), ...(startup?.kind === "tui" ? [EXTENSION_DIALOGS_CAPABILITY] : [])] }),
    trace: traceEnabled,
    onEvent: (event) => (listener ?? app)?.onEvent(event),
    // The daemon pushes the last quota right after the handshake, before the app exists; keep it.
    onGlobal: (event) => (globalListener ? globalListener(event) : app ? app.onGlobal(event) : void earlyGlobals.push(event)),
    onConnection: (state) => app?.onConnection(state),
    // The schema detail of a command the daemon refused stays in the debug log; the user sees "daemon rejected X · /daemon restart".
    onRejected: ({ command, detail }) => log("DEBUG", `daemon rejected ${command}: ${detail}`),
    ...(remoteAttach ? {} : { buildId: computeBuildId() }),
    // A daemon that died (crash, kill) is started again instead of leaving the TUI reconnecting forever.
    ...(remoteAttach ? {} : { beforeReconnect: async () => { await pendingStop; return ensureDaemon(daemonOptions) } }),
  })
  await next.connect()
  if (fromSession) guardClient(next, process.argv.slice(2))
  if (pure) {
    const info = await next.send({ type: "daemon.info" })
    if (!info.ok || info.result?.extensionsEnabled !== false) {
      next.close()
      throw new Error("--pure requires a daemon started with --pure; use a separate --dir or --isolated")
    }
    if (safeMode && info.result?.safeMode !== true) {
      next.close()
      throw new Error("--safe-mode requires a daemon started with --safe-mode; use a separate --dir or --isolated")
    }
  }
  log("INFO", "daemon connected")
  return { client: next, socketPath }
}

let { client, socketPath } = await connect()
let startupNotice = ""
// This process is the new build an open terminal restarted into (relaunch.ts): said once, and not passed on to anything it starts.
const relaunched = process.env.MENDCODE_RELAUNCHED
if (relaunched !== undefined) {
  delete process.env.MENDCODE_RELAUNCHED
  if (relaunched === "restart") startupNotice = "restarted"
}
let daemonOlder = false
/** A daemon is restarted for version skew once per run: a second mismatch means this terminal, not the daemon, is behind. */
let skewRestarts = 0
const expectedBuildId = remoteAttach ? "" : computeBuildId()
const freshness = remoteAttach ? "fresh" : await stopIfStale(client, expectedBuildId)
if (freshness === "stopped") {
  skewRestarts++
  client.close()
  await waitForSocketGone(socketPath)
  // Said to nobody: an idle daemon replaced by the build that is starting is housekeeping, with nothing for the user to do.
  ;({ client, socketPath } = await connect())
} else if (freshness === "busy") daemonOlder = true
else if (freshness === "legacy") startupNotice = "daemon outdated; run with --restart-daemon"

/** After a reconnect: the same check as at startup, so a daemon replaced behind this terminal's back is not trusted blindly. */
async function checkDaemonSkew(): Promise<"fresh" | "restarting" | "busy" | "legacy"> {
  if (client.daemonBuildId === expectedBuildId) return "fresh"
  if (skewRestarts > 0) return "busy"
  const result = await stopIfStale(client, expectedBuildId)
  if (result !== "stopped") return result
  skewRestarts++
  pendingStop = waitForSocketGone(socketPath)
  return "restarting"
}

/** `/daemon restart`: an idle daemon stops now; a busy one once its running work ends. The client's own reconnect then starts the new one. */
async function restartDaemon(): Promise<{ ok: true; pending?: true } | { ok: false; message: string }> {
  const reply = await client.send({ type: "daemon.shutdown", whenIdle: true })
  if (!reply.ok) return { ok: false, message: reply.error.message }
  if ((reply.result as { pending?: boolean } | undefined)?.pending) return { ok: true, pending: true }
  pendingStop = waitForSocketGone(socketPath)
  return { ok: true }
}

/**
 * `/restart`: this terminal starts again from the installed build, on the same session. The daemon and the other terminals
 * keep running; a daemon older than the new build is restarted by the version check once it is idle. Only comes back when it could not.
 */
async function restartTerminal(): Promise<{ ok: false; message: string }> {
  const hosting = soloHost && !soloHost.stopped
  if (hosting) {
    // The daemon lives in this process: it may go only when no other session needs it.
    const status = await client.send({ type: "daemon.status" })
    const work = status.ok ? (status.result ?? {}) as { activeTurns?: number; backgroundJobs?: number } : undefined
    if (!work || work.activeTurns || work.backgroundJobs) return { ok: false, message: "this terminal runs the daemon and other work is running · /restart when it finishes" }
  }
  const exec = await (await import("./relaunch")).selfExec()
  if (!exec || !app) return { ok: false, message: "this terminal cannot restart in place · reopen it" }
  await reopenTerminal(exec, "restart", async () => {
    if (!hosting) return
    client.close()
    await soloHost!.stop()
  })
  return { ok: false, message: "could not restart" }
}

/**
 * Leaves the screen, saves drafts, stops extensions and the daemon (`stopDaemon`), then replaces this process with the same
 * session started again (`execve`: same pid, same terminal). Only returns when the system refused, and then exits.
 */
async function reopenTerminal(exec: (file: string, args: readonly string[], env: Record<string, string | undefined>) => void, reason: "update" | "restart", stopDaemon: () => Promise<void>) {
  const { relaunchArgs, RELAUNCHED_ENV } = await import("./relaunch")
  const sessionId = app!.sessionId
  // A compiled binary is the program; from source, bun runs the entry script again.
  const compiled = /^(\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/.test(Bun.main)
  const args = [...(compiled ? [] : [Bun.main]), ...relaunchArgs(process.argv.slice(2), { project, sessionId })]
  leaving = true
  // A restart enters again at once: the frame stays on screen until the new process paints over it.
  screen.leave(reason !== "update")
  screen.releaseKeyboard()
  process.stdin.setRawMode?.(false)
  await Promise.all([draftsSaved(), extensionsStopped()])
  await stopDaemon()
  client.close()
  exec(process.execPath, args, { ...process.env, [RELAUNCHED_ENV]: reason })
  // Only reached when the system refused to start the binary; a restart had kept the alternate screen.
  if (reason !== "update" && altScreen) process.stdout.write("\x1b[?25h\x1b[?1049l")
  process.stderr.write(`mendcode: could not restart · reopen with: mendcode --session ${sessionId}\n`)
  process.exit(1)
}

let directory = remoteAttach ? client.daemonDirectory : project
if (remoteAttach && !directory) throw new Error("remote daemon did not report its project directory")
// --approve: the same project trust /trust and /tools set (project tools, extensions and hooks), given before anything runs.
if (globalOptions.approve === true) {
  const trusted = await client.send({ type: "tools.trust", directory: project, trusted: true })
  if (!trusted.ok) {
    process.stderr.write(`error: could not trust this project: ${trusted.error.message}\n`)
    process.exit(1)
  }
}
/** The terminal is closing and this process hosts the daemon: see `leaveSolo` for what stays, what exits and what is handed over. `hangup`: the terminal is gone, so nothing is printed. */
async function leaveSoloHost(hangup: boolean) {
  const host = soloHost
  if (!host || host.stopped) return
  const { leaveSolo } = await import("./solo")
  // The terminal may be gone: from here on a hangup must not end the work this process is finishing.
  process.on("SIGHUP", () => {})
  const interrupted = new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve())
    process.once("SIGTERM", () => resolve())
  })
  await leaveSolo({
    host,
    status: async () => { const reply = await client.send({ type: "daemon.status" }); return reply.ok ? reply.result : undefined },
    closeClient: () => client.close(),
    handOff: () => ensureDaemon(daemonOptions),
    interrupted,
    notify: (message) => { if (!hangup) try { process.stderr.write(`mendcode: ${message}\n`) } catch {} },
    sleep: Bun.sleep,
  }).catch((error: unknown) => log("ERROR", `solo exit: ${error instanceof Error ? error.message : String(error)}`))
}
async function finish(code: number) {
  if (isolatedDir) {
    await client.send({ type: "daemon.shutdown", force: true }).catch(() => undefined)
    // A separate daemon finishes stopping on its own; one in this process stops only while this process lives.
    for (let waited = 0; soloHost && !soloHost.stopped && waited < 5_000; waited += 20) await Bun.sleep(20)
  } else await leaveSoloHost(code === 129)
  client.close()
  process.exit(code)
}
if (isolatedDir) {
  stopIsolated = () => void finish(0)
  if (isolatedStopRequested) stopIsolated()
}

// Settings the daemon ignored (invalid, unknown, unreadable project.json): a notice in the TUI, or a refusal to start under --strict-config. Local daemons only: the report reads local files.
if (!remoteAttach && (startup?.kind === "tui" || startup?.kind === "run" || globalOptions.strictConfig)) {
  const checked = await client.send({ type: "system.query", directory: directory!, operation: "config-layers" })
  const problems = checked.ok ? ((checked.result?.facts as { problems?: string[] } | undefined)?.problems ?? []) : []
  if (problems.length && globalOptions.strictConfig) {
    process.stderr.write(`error: --strict-config: ${problems.length} configuration problem${problems.length === 1 ? "" : "s"}\n${problems.map((line) => `  ${line}\n`).join("")}`)
    await finish(78)
  }
  if (problems.length && startup?.kind === "tui") startupNotice = [startupNotice, `config: ${problems[0]!}${problems.length > 1 ? ` (+${problems.length - 1} more, /debug-config)` : " (/debug-config)"}`].filter(Boolean).join(" · ")
}

if (automation.ok === true) {
  // A closed pipe (e.g. `| head`) ends the command quietly, like `run`.
  let checkedOutPr: import("@mendcode/protocol").PrCheckoutReport | undefined
  const quietOut = {
    write(text: string) {
      try {
        process.stdout.write(text)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPIPE") process.exit(0)
        throw error
      }
    },
  }
  process.stdout.on("error", (error: NodeJS.ErrnoException) => process.exit(error.code === "EPIPE" ? 0 : 1))
  const code = await runAutomation(automation.command, {
    client,
    listen: (handler) => void (listener = handler ? { onEvent: handler } : undefined),
    listenGlobal: (handler) => void (globalListener = handler),
    out: quietOut,
    err: process.stderr,
    cwd: directory!,
    env: process.env,
    openPr: async (report) => { checkedOutPr = report },
    ...(remoteAttach ? { allowFiles: false, readJson: async () => { throw new Error("workflow files disabled while remote; use a workflow name") } } : {}),
    ...(process.env.HOME ? { home: process.env.HOME } : {}),
    now: Date.now,
    ...(process.stdin.isTTY && process.stdout.isTTY ? { prompt: async (request: import("./catalog-automation").CatalogPrompt) => request.title === "Export session" ? (await import("./session-transfer-prompt")).terminalSessionExportPrompt(request) : (await import("./catalog-prompts")).terminalCatalogPrompt(request) } : {}),
    onInterrupt: (callback) => {
      process.once("SIGINT", callback)
      process.once("SIGTERM", callback)
    },
  })
  if (code === 0 && checkedOutPr) {
    directory = checkedOutPr.directory
    startup = parseStartup(["--cwd", directory!])
  } else {
    client.close()
    process.exit(code)
  }
}

const [command, ...words] = positional()
if (command === "export") {
  const target = (words[0] ?? arg("session")) as SessionId | undefined
  if (!target) {
    process.stderr.write(`usage: ${PROGRAM_NAME} export <session-id> [--json] [--reasoning]\n`)
    process.exit(64)
  }
  const events: SessionEvent[] = []
  listener = { onEvent: (event) => void events.push(event) }
  const subscribed = await client.subscribe(target, 0)
  if (!subscribed.ok) {
    process.stderr.write(`error: ${subscribed.error.message}\n`)
    process.exit(1)
  }
  const lastSeq = Number(subscribed.result?.lastSeq ?? 0)
  const history = events.filter((event) => event.seq <= lastSeq)
  if (wantsJson) process.stdout.write(history.map((event) => JSON.stringify(event)).join("\n") + "\n")
  else {
    const listed = await client.send({ type: "session.list", limit: 500, archived: true })
    const summary = listed.ok ? (listed.result?.sessions as SessionSummary[] | undefined)?.find((s) => s.sessionId === target) : undefined
    process.stdout.write(sessionToMarkdown(history, { ...(summary ? { title: summary.title, directory: summary.directory } : {}), reasoning: flag("reasoning") }))
  }
  client.close()
  process.exit(0)
}

// `acp`: an Agent Client Protocol agent on stdio for editors (Zed and others). Stdout carries only protocol messages.
if (startup?.kind === "acp") {
  // Loaded here: the agent draws tool cards and markdown with the terminal's own views, which nothing before the TUI needs.
  const { createAcpAgent } = await import("./acp")
  const agent = createAcpAgent({ client, listen: (handler) => void (listener = { onEvent: handler }), write: (line) => void process.stdout.write(line), version: CLI_VERSION, cwd: directory! })
  const decoder = new TextDecoder()
  let pending = ""
  for await (const chunk of Bun.stdin.stream()) {
    pending += decoder.decode(chunk, { stream: true })
    let newline = pending.indexOf("\n")
    while (newline >= 0) {
      await agent.handleLine(pending.slice(0, newline))
      pending = pending.slice(newline + 1)
      newline = pending.indexOf("\n")
    }
  }
  client.close()
  process.exit(0)
}

// `app-server`: JSON-RPC on stdio for third-party UIs (docs/embedding.md). Stdout carries only protocol messages.
if (startup?.kind === "app-server") {
  const { createAppServer } = await import("./app-server")
  const server = createAppServer({ client, listen: (handler) => void (listener = { onEvent: handler }), write: (line) => void process.stdout.write(line), version: CLI_VERSION, cwd: directory! })
  const decoder = new TextDecoder()
  let pending = ""
  const running = new Set<Promise<void>>()
  // Requests run side by side: a turn/start that waits for its turn must not block turn/interrupt or an approval reply.
  const run = (line: string) => {
    const task: Promise<void> = server.handleLine(line).finally(() => running.delete(task))
    running.add(task)
  }
  for await (const chunk of Bun.stdin.stream()) {
    pending += decoder.decode(chunk, { stream: true })
    let newline = pending.indexOf("\n")
    while (newline >= 0) {
      run(pending.slice(0, newline))
      pending = pending.slice(newline + 1)
      newline = pending.indexOf("\n")
    }
  }
  if (pending.trim()) run(pending)
  await Promise.allSettled([...running])
  client.close()
  process.exit(0)
}

let sessionId: SessionId
/** Where the terminal was started when `--session` resumed a session that lives in another directory; the TUI asks where to continue. */
let launchDirectory: string | undefined
try {
  const launched = directory!
  const remoteAccess = remoteAttach ? { readOnly: client.remoteInfo?.readOnly ?? false } : undefined
  const selected = await prepareStartup(client, startup!, directory!, runPrompt, remoteAccess).catch((error: unknown) => {
    // A terminal that restarted into a new build names the chat it had. An empty one is gone by now (a starting daemon removes
    // empty chats): that is a new chat, not an error.
    if (!relaunched || !startup?.session) throw error
    const { session: _gone, ...fresh } = startup
    return prepareStartup(client, fresh as typeof startup, directory!, runPrompt, remoteAccess)
  })
  sessionId = selected.sessionId
  directory = selected.directory
  if (startup?.kind === "tui" && startup.session && !remoteAttach) {
    const real = (target: string) => realpath(target).catch(() => path.resolve(target))
    if ((await real(launched)) !== (await real(selected.directory))) launchDirectory = launched
  }
} catch (error) {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
  await finish(1)
}

/** `--ephemeral`: the session is removed once the turn is over (a turn that just ended can still report busy for a moment). */
async function deleteSession(target: SessionId) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const reply = await client.send({ type: "session.delete", sessionId: target })
    if (reply.ok || reply.error.code !== "busy") return
    await Bun.sleep(100)
  }
  process.stderr.write(`warning: ephemeral session ${target} could not be deleted\n`)
}

/** `--add-dir` entries as existing absolute directories (relative ones resolve from the project); local runs only, since the daemon checks the paths on its own machine. */
async function extraDirectories(entries: readonly string[]) {
  if (remoteAttach) throw new Error("--add-dir is local-only: the directories belong to the machine that runs the commands")
  return Promise.all(entries.map(async (entry) => {
    const resolved = path.resolve(directory ?? process.cwd(), entry.startsWith("~/") ? path.join(homedir(), entry.slice(2)) : entry)
    if (!(await stat(resolved).catch(() => undefined))?.isDirectory()) throw new Error(`--add-dir ${entry}: not a directory`)
    return realpath(resolved)
  }))
}

/** Scripted-run limits and the session's permission mode reach the daemon before anything is submitted; a daemon that cannot honour them fails the run instead of running it unrestricted. */
async function applyRunLimits(options: Startup, target: SessionId, instruction?: string) {
  const appendSystemPrompt = [options.appendSystemPrompt, instruction].filter(Boolean).join("\n\n")
  const limits = {
    ...(options.maxTurns ? { maxSteps: options.maxTurns } : {}),
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.excludeTools ? { excludeTools: options.excludeTools } : {}),
    ...(options.offline ? { offline: true } : {}),
    ...(options.noContextFiles ? { noContextFiles: true } : {}),
    ...(options.addDirs ? { addDirs: await extraDirectories(options.addDirs) } : {}),
    ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
    ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
  }
  if (Object.keys(limits).length) {
    const reply = await client.send({ type: "session.run.configure", sessionId: target, ...limits })
    if (!reply.ok) throw new Error(`the daemon did not accept the run limits (${reply.error.message}); restart it with --restart-daemon`)
  }
  if (options.permission) {
    const reply = await client.send({ type: "session.permission.set", sessionId: target, mode: options.permission })
    if (!reply.ok) throw new Error(reply.error.message)
  }
  // Flags MendCode does not know belong to an extension; the daemon refuses one no extension of the project declares.
  if (options.extensionFlags) {
    const reply = await client.send({ type: "extensions.flags", sessionId: target, flags: options.extensionFlags })
    if (!reply.ok) throw new Error(reply.error.message)
  }
}

if (startup?.kind === "tui" && (startup.offline || startup.addDirs || startup.noContextFiles || startup.extensionFlags)) {
  try { await applyRunLimits(startup, sessionId!) } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
    await finish(1)
  }
}

if (startup?.kind === "run") {
  let submission: Awaited<ReturnType<typeof prepareRunSubmission>>
  try {
    await applyRunLimits(startup, sessionId!, runOutput?.instruction)
    submission = await prepareRunSubmission(client, startup, sessionId!, directory!, runPrompt, remoteAttach)
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
    if (startup.ephemeral) await deleteSession(sessionId!)
    await finish(1)
  }
  if (startup.background) {
    // The daemon owns the turn; this process only hands it over and prints how to follow it.
    const handOver = () => client.send(submission)
    const accepted = await handOver()
    if (!accepted.ok) {
      process.stderr.write(`error: ${accepted.error.message}\n`)
      await finish(1)
    }
    if (startup.json) process.stdout.write(`${JSON.stringify(compat ? compatEnvelope({ kind: "result", command: "run.background", data: { sessionId: sessionId!, status: "started" } }) : { sessionId: sessionId!, status: "started" })}\n`)
    else process.stdout.write(`${sessionId!}\nrunning in the background · logs ${sessionId!} -f · attach ${sessionId!} · kill ${sessionId!}\n`)
    await finish(0)
  }
  process.stderr.write(`session: ${sessionId!}${startup.ephemeral ? " (ephemeral: deleted when the run ends)" : ""}\n`)
  // A closed pipe (e.g. `| head`) ends the run quietly, like any well-behaved CLI.
  const out = {
    write(text: string) {
      try {
        process.stdout.write(text)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPIPE") process.exit(0)
        throw error
      }
    },
  }
  const run = createHeadlessRun({ client, sessionId: sessionId!, prompt: runPrompt, json: startup.json, ...(compat ? { compat: true } : {}), approve: startup.approve, skipPermissions: startup.skipPermissions, thinking: startup.thinking, hold: runOutput?.hold === true, ...(runOutput ? { finish: (message: string) => runOutput!.finish(message) } : {}), submit: () => client.send(submission!), out, err: process.stderr })
  listener = run
  const subscribed = await client.subscribe(sessionId!, 0)
  if (!subscribed.ok) throw new Error(subscribed.error.message)
  const code = await run.start()
  if (startup.ephemeral) await deleteSession(sessionId!)
  await finish(code)
}

// A `pr` command that checked out its branch continues here as a terminal without having loaded them.
const [{ createApp }, { createScreen }, { keyboardWanted }, { currentLayout }, { createCrashGuard }, { registerThemes, setTheme }, { themesFromFiles }, { PRESENTATION_MODES }, { accessibleMode }] = await (terminalModules ?? loadTerminalModules())
// Theme files of the packages, the user's and the project's `themes/` join the built-ins before settings apply.
const themeFiles = await client.send({ type: "themes.list", directory: directory! })
if (themeFiles.ok) {
  const { themes, problems } = themesFromFiles((themeFiles.result as ThemesReport | undefined)?.themes ?? [])
  registerThemes(themes)
  if (process.env.MENDCODE_THEME) setTheme(process.env.MENDCODE_THEME)
  if (problems.length) startupNotice = [startupNotice, `theme ${problems[0]!.name}: ${problems[0]!.message}${problems.length > 1 ? ` (+${problems.length - 1} more)` : ""}`].filter(Boolean).join(" · ")
}

// The app applies the terminal-local image protocol from /customize before its first frame.
const dataDir = daemonDataDir ?? process.env.MENDCODE_V2_DIR ?? DEFAULT_DIR
// The alternate screen is the default; `--no-alt-screen`, MENDCODE_ALT_SCREEN=0 or the saved `altScreen` setting keep the chat inline.
// Screen-reader mode (`--accessible`, MENDCODE_ACCESSIBLE=1 or the saved `accessible` setting) keeps the chat inline and turns mouse reporting off, unless `--alt-screen` says otherwise.
const accessible = accessibleMode({ flag: startup?.accessible, env: process.env, saved: remoteAttach ? false : readTuiProfile(dataDir).accessible })
const altScreen = startup?.altScreen ?? (process.env.MENDCODE_ALT_SCREEN === "0" ? false : process.env.MENDCODE_ALT_SCREEN === "1" ? true : accessible ? false : (remoteAttach ? true : readTuiProfile(dataDir).altScreen))
/** stdout while the terminal is there: once it is gone (a closed window or tab) nothing more is written to it. */
let terminalGone = false
const terminalOut = {
  write: (data: string) => terminalGone || process.stdout.write(data),
  get columns() { return process.stdout.columns },
  get rows() { return process.stdout.rows },
  isTTY: process.stdout.isTTY,
}
const screen = createScreen(terminalOut, process.env,{ inline: !altScreen, keyboard: keyboardWanted(readTuiProfile(dataDir).keyProtocol, process.platform), ...(accessible ? { mouse: false } : {}), ...(relaunched === "restart" || relaunched === "terminal" ? { keepFrame: true } : {}) })
// Whatever way the process ends, the keyboard flags it pushed come off: a shell that kept them would get escape codes for every key.
process.once("exit", () => screen.releaseKeyboard())
// A plain `kill` ends the process without running the handler above; with the flags pushed that would leave the shell in the protocol.
// A terminal that hosts the daemon leaves the way a closed one does instead: other sessions' turns finish first (a second SIGTERM stops them).
if (!startup?.isolated) process.once("SIGTERM", () => {
  if (!soloHost || soloHost.stopped) return process.exit(143)
  soloHost.log("warn", "[SOLO]: SIGTERM while hosting the daemon; leaving after the running work")
  exit(143)
})
// Whatever ends this process with the daemon still in it (a kill, process.exit) is in the daemon log; a SIGKILL or a native crash leaves no line at all.
process.once("exit", (code) => {
  if (soloHost && !soloHost.stopped) soloHost.log("warn", `[SOLO]: the terminal hosting the daemon exited (code ${code}); turns still running end as interrupted`)
})
// MendCode's own pets only: another program's pets folder (Codex's) is that program's.
const pets = {
  dirs: [{ dir: path.join(dataDir, "pets"), source: "user" as const }],
  cacheDir: path.join(dataDir, "pets-cache"),
  images: false,
}
/** The unsent prompt reaches the daemon before the socket closes; a daemon that does not answer in a second does not hold the exit. */
const draftsSaved = () => Promise.race([Promise.resolve().then(() => app?.saveDrafts()).catch(() => undefined), Bun.sleep(1000)])
/** Extension helpers end with this process; the runtime already bounds a stuck one to 2 s. */
/** Inside a herdr or tuios pane, the session's state goes to the multiplexer's sidebar (docs/herdr.md). */
const pane = herdrPane(process.env)
const herdr = pane ? createHerdrReporter({ ...pane, program: PROGRAM_NAME, now: Date.now }) : undefined
const tuiosMetaPane = tuiosPane(process.env)
const tuiosMeta = tuiosMetaPane ? createTuiosMeta(tuiosMetaPane) : undefined
// Sub-agent rows need the pane's agent state, which the herdr report sets (tuios answers herdr's socket in its panes).
const tuiosChildren = tuiosMetaPane && herdr ? createTuiosChildren(tuiosMetaPane) : undefined
const paneReleased = () => Promise.race([(tuiosChildren?.clear() ?? Promise.resolve()).then(() => herdr?.release()), Bun.sleep(300)])
const extensionsStopped = () => Promise.race([Promise.resolve().then(() => app?.stopExtensions()).catch(() => undefined), Bun.sleep(2_500)])
let leaving = false
function exit(code = 0) {
  leaving = true
  screen.leave()
  // v1 prints which session this was and what it cost, so it can be resumed.
  // A crashed app may not be able to say; the exit goes on without the summary.
  let summary: string | undefined
  try { summary = app?.exitSummary({ color: process.stdout.isTTY === true && !process.env.NO_COLOR }) } catch { summary = undefined }
  if (summary) process.stdout.write(summary)
  process.stdin.setRawMode?.(false)
  void Promise.all([draftsSaved(), extensionsStopped(), paneReleased()]).then(() => finish(code), () => finish(code))
}
let hungUp = false
/**
 * The terminal is gone: SIGHUP, its input ended, or a write failed with EIO. What was being typed is saved, then the process
 * leaves as `leaveSolo` decides (a hosted daemon finishes the running work first). Terminals send SIGHUP more than once
 * (Ghostty's every 10 ms until the shell exits): the handler stays registered, and every hangup after the first is ignored.
 */
function hangUp() {
  if (hungUp) return
  hungUp = true
  if (soloHost && !soloHost.stopped) soloHost.log("info", "[SOLO]: the terminal hosting the daemon closed; leaving after the running work")
  terminalGone = true
  void Promise.all([draftsSaved(), extensionsStopped(), paneReleased()]).then(() => finish(129))
}
process.on("SIGHUP", hangUp)
// Only a terminal's input ending means it closed; piped input (tests, embedders) may end at once.
if (process.stdin.isTTY) {
  process.stdin.on("end", hangUp)
  process.stdin.on("error", hangUp)
}
app = createApp({
  platform: process.platform,
  ...(herdr || tuiosMeta ? { paneState: ({ foreground, message, sessionId, facts, children }: { foreground: string; message?: string; sessionId: string; facts: PaneFacts; children: PaneChild[] }) => {
    // A sub-agent waiting on the person holds the pane as blocked too: herdr has no sub-agent rows, so that is how it shows.
    const childWaits = foreground !== "waiting_approval" ? waitingChild(children) : undefined
    const reported = herdr?.report({ state: childWaits ? "blocked" : paneState(foreground), sessionId, ...(foreground === "waiting_approval" && message ? { message } : childWaits ? { message: childWaits } : {}) })
    if (tuiosChildren) void (reported ?? Promise.resolve()).then(() => tuiosChildren.sync(sessionId, children))
    void tuiosMeta?.set(facts)
  } } : {}),
  ...(process.platform === "darwin" ? { keyboardLayout: () => currentLayout(process.env.HOME) } : {}),
  terminalConfig: { home: homedir() },
  ...(startup?.tuiControl ? { tuiControl: true } : {}),
  ...(globalOptions.approve === false ? { trustPrompt: false } : {}),
  ...(traceEnabled ? { trace: (sample: import("@mendcode/protocol").TraceSample) => client.recordTrace(sample) } : {}),
  sessionId: sessionId!,
  screen,
  send: (c) => client.send(c),
  subscribe: (id, afterSeq) => client.subscribe(id, afterSeq),
  events: {
    loadWindow: (id) => client.loadWindow(id),
    loadBefore: (id, firstSeq) => client.loadBefore(id, firstSeq),
  },
  exit: () => exit(0),
  directory: directory!,
  ...(launchDirectory ? { launchDirectory } : {}),
  ...(remoteAttach ? { remote: { host: remote?.hostname ?? "unix tunnel", readOnly: client.remoteInfo?.readOnly ?? false } } : {}),
  // The same data dir the daemon uses: keybindings.json and terminal extensions live there.
  ...(remoteAttach ? {} : { dataDir }),
  ...(startup?.prompt !== undefined ? { startup: { prompt: startup.prompt } } : startup?.initialMessage !== undefined ? { startup: { initialMessage: startup.initialMessage } } : {}),
  ...(startup?.diagnostics ? { diagnostics: { memory: () => process.memoryUsage(), snapshot: async () => (await import("./diagnostics")).writeSnapshot(dataDir, "tui") } } : {}),
  version: CLI_VERSION,
  pure,
  ...(safeMode ? { safeMode: true } : {}),
  ...(process.env.HOME ? { home: process.env.HOME } : {}),
  reducedMotion: process.env.MENDCODE_REDUCED_MOTION === "1",
  accessible,
  notice: [startupNotice, remoteAttach ? REMOTE_DISABLED_NOTE : ""].filter(Boolean).join(" · "),
  ...(relaunched !== undefined && relaunched !== "restart" ? { updated: true } : {}),
  ...(client.daemonBuildId ? { daemonBuildId: client.daemonBuildId } : {}),
  ...(remoteAttach ? {} : { daemon: { ...(daemonOlder ? { older: true } : {}), check: checkDaemonSkew, restart: restartDaemon, restartTerminal } }),
  ...(remoteAttach ? {} : { pets }),
  // The external editor (ctrl+x e) owns the terminal while it runs: we leave the alternate screen and raw mode, then take them back and repaint.
  terminal: {
    async suspendProcess() {
      process.stdin.pause()
      screen.leave()
      process.stdin.setRawMode?.(false)
      await new Promise<void>((resolve) => {
        process.once("SIGCONT", () => {
          process.stdin.setRawMode?.(true)
          screen.enter()
          screen.invalidate()
          process.stdin.resume()
          resolve()
        })
        process.kill(process.pid, "SIGTSTP")
      })
    },
    suspend() {
      process.stdin.pause()
      screen.leave()
      process.stdin.setRawMode?.(false)
    },
    resume() {
      process.stdin.setRawMode?.(true)
      screen.enter()
      screen.invalidate()
      process.stdin.resume()
    },
  },
  ...(PRESENTATION_MODES.includes(process.env.MENDCODE_VIEW as PresentationMode) ? { mode: process.env.MENDCODE_VIEW as PresentationMode } : {}),
})
for (const event of earlyGlobals.splice(0)) app.onGlobal(event)
// Saved settings (theme, view, motion) apply before the first frame; env vars stay as overrides.
let savedSettings: Settings | undefined
const saved = await client.send({ type: "settings.get" })
if (saved.ok) {
  const settings = { ...(saved.result?.settings as Settings) }
  if (process.env.MENDCODE_THEME) { delete settings.theme; delete settings.projectThemes }
  if (process.env.MENDCODE_VIEW) delete settings.view
  app.applySettings(settings)
  savedSettings = saved.result?.settings as Settings
}
// Raw mode before the screen asks the terminal anything: a terminal still echoing prints the answer to the keyboard query (`^[[?1;2;4c`) as text.
process.stdin.setRawMode?.(true)
screen.enter()
// An error nobody caught shows the crash screen (the draft saved, the terminal restored on leaving) instead of a stack trace over the alternate screen.
const crash = createCrashGuard({ screen, now: Date.now, version: CLI_VERSION, env: process.env, home: process.env.HOME, saveDrafts: draftsSaved, exit: (code) => (leaving ? undefined : exit(code)), resume: () => app?.render() })
// With the daemon in this process an error nobody caught can come from either side. The process survives it (a separate daemon would have died with its turn):
// the turn and the log keep going, the error is written to the daemon log, and the terminal shows the crash screen, where `r` goes back to the app.
const uncaught = (error: unknown) => {
  // A write to a terminal that closed: not a crash, a hangup.
  if ((error as NodeJS.ErrnoException | undefined)?.code === "EIO") return hangUp()
  if (leaving) return soloHost?.log("error", `uncaught while leaving: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  soloHost?.log("error", `uncaught: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  void crash.handle(error)
}
process.on("uncaughtException", uncaught)
process.on("unhandledRejection", uncaught)
process.stdout.on("resize", () => {
  screen.resize(process.stdout.columns, process.stdout.rows)
  if (crash.active) crash.redraw()
  else app?.render()
})
let lastInputAt = Date.now()
// One decoder for the whole stream: a character whose bytes arrive in two reads (ñ, CJK, an emoji) is completed, not replaced.
const stdinText = new TextDecoder()
process.stdin.on("data", (data: Buffer) => {
  lastInputAt = Date.now()
  const text = stdinText.decode(data, { stream: true })
  if (!text) return
  if (!crash.onInput(text)) void app?.onInput(text)
})
await app.start()
app.render()
if (soloHost && processMode === "auto") {
  const { HAND_OFF_CHECK_MS, handOffWanted } = await import("./solo")
  const handOff = setInterval(async () => {
    if (!soloHost || soloHost.stopped || leaving) return clearInterval(handOff)
    const status = await client.send({ type: "daemon.status" }).catch(() => undefined)
    if (!status?.ok || !handOffWanted(status.result)) return
    clearInterval(handOff)
    soloHost.log("info", "[SOLO]: another client attached; the daemon moves to a separate process so this terminal cannot take other sessions' turns with it")
    await restartDaemon()
  }, HAND_OFF_CHECK_MS)
  handOff.unref?.()
}
// An install replaces the binary this terminal runs. The terminal says so above the prompt at once, and restarts into it by itself, in place
// and on the same session, when that interrupts nothing of its own: no turn here, nothing typed, the chat showing, no key for a while.
if (/^(\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/.test(Bun.main) && !remoteAttach && !startup?.isolated && !startup?.ephemeral) {
  const { binaryStamp, selfExec, RELAUNCH_CHECK_MS, RELAUNCH_QUIET_MS } = await import("./relaunch")
  const launched = binaryStamp(process.execPath)
  let seen: string | undefined
  let checking = false
  const timer = setInterval(async () => {
    if (checking || leaving || !app) return
    const stamp = binaryStamp(process.execPath)
    // The same new file on two checks in a row: one still being written is not started.
    if (!stamp || stamp === launched || stamp !== seen) return void (seen = stamp)
    app.announceUpdate()
    if (app.page !== "chat" || app.editor.text !== "" || Date.now() - lastInputAt < RELAUNCH_QUIET_MS || crash.active) return
    // Only this terminal's own session has to rest: other sessions' turns run in the daemon, which a terminal restart leaves alone.
    // A terminal that hosts the daemon itself waits for all of its work.
    if (app.transcript.activeTurn || app.transcript.pendingRequests.length) return
    checking = true
    try {
      if (soloHost && !soloHost.stopped) {
        const status = await client.send({ type: "daemon.status" })
        const work = status.ok ? (status.result ?? {}) as { activeTurns?: number; backgroundJobs?: number } : undefined
        if (!work || work.activeTurns || work.backgroundJobs) return
      }
      const exec = await selfExec()
      if (!exec) return clearInterval(timer)
      clearInterval(timer)
      await reopenTerminal(exec, "update", () => leaveSoloHost(false))
    } finally { checking = false }
  }, RELAUNCH_CHECK_MS)
  timer.unref?.()
}
if (savedSettings && !remoteAttach && !startup?.prompt && startup?.initialMessage === undefined) {
  // The installer's receipt names the tier the first launch starts from; it is read only while setup was never completed and no tier is saved.
  const preset = !savedSettings.onboarded && savedSettings.tier === undefined
    ? (await import("@mendcode/upgrade/install-receipt")).readInstallPreset({ ...(/^(\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/.test(Bun.main) ? { runningBinary: process.execPath } : {}), env: process.env, home: process.env.HOME, platform: process.platform })
    : undefined
  void app.openSetupIfFirstRun(savedSettings, preset)
}
