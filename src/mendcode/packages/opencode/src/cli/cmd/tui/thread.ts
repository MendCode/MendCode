import { cmd } from "@/cli/cmd/cmd"
import { tui } from "./app"
import { Rpc } from "@/util/rpc"
import { type rpc } from "./worker"
import { spawn, type ChildProcess } from "child_process"
import { readdir, stat } from "fs/promises"
import { createHash, randomUUID } from "crypto"
import path from "path"
import { existsSync } from "fs"
import { fileURLToPath } from "url"
import { UI } from "@/cli/ui"
import * as Log from "@mendcode/core/util/log"
import { errorMessage } from "@/util/error"
import { withTimeout } from "@/util/timeout"
import { withNetworkOptions, resolveNetworkOptionsNoConfig } from "@/cli/network"
import { Filesystem } from "@/util/filesystem"
import { createOpencodeClient, type GlobalEvent } from "@mendcode/sdk/v2"
import type { EventSource } from "./context/sdk"
import { win32DisableProcessedInput, win32InstallCtrlCGuard } from "./win32"
import { writeHeapSnapshot } from "v8"
import { TuiConfig } from "./config/tui"
import {
  OPENCODE_PROCESS_ROLE,
  OPENCODE_RUN_ID,
  ensureRunID,
  sanitizedProcessEnv,
} from "@mendcode/core/util/opencode-process"
import { validateSession } from "./validate-session"
import { loadMendTuiProfile } from "@/mend/profile"
import { ServerAuth } from "@/server/auth"
import { SharedServer, type SharedServerClientLease, type SharedServerState } from "./shared-server"
import { isProcessMemoryUsage, processMemoryUsage, type DiagnosticsSnapshot } from "@/util/process-memory"
import { readBackendPhase, waitForBackend } from "@/installation/backend-startup"

const SHARED_SERVER_PROBE_TIMEOUT_MS = 2_000
const SHARED_SERVER_WAIT_TIMEOUT_MS = 8_000
const SHARED_SERVER_RECONNECT_RETRY_DELAY_MS = 250
export const SHARED_SERVER_RECONNECT_MAX_ATTEMPTS = Number.POSITIVE_INFINITY
const SHARED_SERVER_RECONNECT_MAX_DELAY_MS = 3_000
// Allow three missed 10s heartbeats before replacing a healthy local stream under timer throttling.
const SHARED_SERVER_RECONNECT_STALE_DELAY_MS = 35_000

declare global {
  const OPENCODE_WORKER_PATH: string
}

type RpcClient = ReturnType<typeof Rpc.client<typeof rpc>>

type ThreadTransport = {
  url: string
  fetch?: typeof fetch
  headers?: RequestInit["headers"]
  events?: EventSource
}

export function resolveSharedServerURL(value?: string, environment = process.env.MENDCODE_SERVER_URL) {
  const raw = value || environment
  if (!raw) return

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error("Invalid MendCode server URL")
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("MendCode server URL must use http or https")
  }
  if (url.username || url.password) {
    throw new Error("MendCode server URL must not contain credentials")
  }
  return url.toString()
}

async function probeSharedServer(input: { url: string; directory: string; headers?: RequestInit["headers"] }) {
  const client = createOpencodeClient({
    baseUrl: input.url,
    directory: input.directory,
    headers: input.headers,
    signal: AbortSignal.timeout(SHARED_SERVER_PROBE_TIMEOUT_MS),
  })
  await client.global.health({ throwOnError: true })
}

function sharedServerConnection(state: SharedServerState) {
  return {
    pid: state.pid,
    url: state.url,
    headers: ServerAuth.headers({ username: state.username, password: state.password }),
  }
}

type LocalSharedServerConnection = ReturnType<typeof sharedServerConnection> & {
  lease: SharedServerClientLease
}

async function connectToSharedServerState(
  directory: string,
  state: SharedServerState,
  lease?: SharedServerClientLease,
) {
  const connection = sharedServerConnection(state)
  try {
    await probeSharedServer({ ...connection, directory })
    const nextLease = lease?.serverPID === state.pid ? lease : await SharedServer.acquireClientLease(state.pid)
    if (lease && lease !== nextLease) await lease.release()
    return {
      ...connection,
      lease: nextLease,
    }
  } catch {
    return
  }
}

async function connectToLocalSharedServer(directory: string, runtimeID: string, lease?: SharedServerClientLease) {
  const state = await SharedServer.readState()
  if (!state || state.runtimeID !== runtimeID) return
  return connectToSharedServerState(directory, state, lease)
}

async function waitForLocalSharedServer(
  directory: string,
  runtimeID: string,
  lease?: SharedServerClientLease,
  timeoutMs = SHARED_SERVER_WAIT_TIMEOUT_MS,
) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const connection = await connectToLocalSharedServer(directory, runtimeID, lease)
    if (connection) return connection
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  // A PID without a reachable listener is not a usable connection. Returning
  // it as attached state makes the bootstrap render an empty TUI forever.
  return undefined
}

async function waitForExistingLocalSharedServer(
  directory: string,
  lease?: SharedServerClientLease,
  timeoutMs = SHARED_SERVER_WAIT_TIMEOUT_MS,
) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const state = await SharedServer.readState()
    if (state) {
      const connection = await connectToSharedServerState(directory, state, lease)
      if (connection) return connection
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return undefined
}

async function stopLocalSharedServer(state: SharedServerState) {
  if (state.pid === process.pid || !SharedServer.isProcessAlive(state.pid)) return true
  const connection = sharedServerConnection(state)
  await fetch(new URL("/global/dispose", connection.url), {
    method: "POST",
    headers: connection.headers,
    signal: AbortSignal.timeout(3_000),
  }).catch(() => undefined)
  try {
    process.kill(state.pid, "SIGTERM")
  } catch {
    return !SharedServer.isProcessAlive(state.pid)
  }

  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (!SharedServer.isProcessAlive(state.pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return !SharedServer.isProcessAlive(state.pid)
}

export function resolveRuntimeEntrypoint(entry: string | undefined, runtimeCwd: string) {
  if (!entry || !/(^|[\\/])src[\\/]index\.(?:ts|js)$/.test(entry)) return
  if (entry.includes("$bunfs") || entry.includes("~BUN")) return
  const resolved = path.isAbsolute(entry) ? entry : path.resolve(runtimeCwd, entry)
  if (!existsSync(resolved)) return
  return resolved
}

function runtimeEntrypoint(runtimeCwd: string) {
  return resolveRuntimeEntrypoint(process.argv[1], runtimeCwd)
}

function sharedServerCommand(runtimeCwd: string) {
  const entry = runtimeEntrypoint(runtimeCwd)
  const port = process.env.MENDCODE_SHARED_SERVER_PORT || "0"
  if (!entry) {
    return {
      command: process.execPath,
      args: ["serve", "--hostname", "127.0.0.1", "--port", port],
      cwd: runtimeCwd,
    }
  }

  const packageRoot = path.dirname(path.dirname(entry))
  return {
    command: process.execPath,
    args: [
      "--cwd",
      packageRoot,
      "--no-install",
      "--conditions=browser",
      entry,
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      port,
    ],
    cwd: packageRoot,
  }
}

function sharedServerEnvironment(credentials: ReturnType<typeof SharedServer.credentials>, runtimeID: string) {
  const env = { ...process.env }
  for (const key of [
    "MENDCODE_ROOT",
    "OPENCODE_ROOT",
    "MENDCODE_CONFIG_DIR",
    "OPENCODE_CONFIG_DIR",
    "MENDCODE_CONFIG",
    "OPENCODE_CONFIG",
    "MENDCODE_DB",
    "OPENCODE_DB",
    "MENDCODE_TUI_CONFIG",
    "OPENCODE_TUI_CONFIG",
    "MENDCODE_SHELL_CWD",
    "MENDCODE_PUBLIC_BIN",
    "OPENCODE_PROCESS_ROLE",
    "OPENCODE_RUN_ID",
    "MENDCODE_SHARED_SERVER_RUNTIME_ID",
  ]) {
    delete env[key]
  }
  return {
    ...env,
    MENDCODE_SERVER_USERNAME: credentials.username,
    MENDCODE_SERVER_PASSWORD: credentials.password,
    OPENCODE_SERVER_USERNAME: credentials.username,
    OPENCODE_SERVER_PASSWORD: credentials.password,
    MENDCODE_SHARED_SERVER_STATE_FILE: SharedServer.statePath(),
    MENDCODE_SHARED_SERVER_RUNTIME_ID: runtimeID,
  }
}

async function sharedServerRuntimeID(runtimeCwd: string) {
  const entry = runtimeEntrypoint(runtimeCwd)
  const executable = entry || process.execPath
  const metadata = await stat(executable).catch(() => undefined)
  if (!entry) return [executable, metadata?.size ?? "unknown", metadata?.mtimeMs ?? "unknown"].join(":")

  // Bun executes imported TypeScript directly in local builds, so the entrypoint
  // mtime alone cannot detect stale code in a shared server.
  const packageRoot = path.dirname(path.dirname(entry))
  const sourceRoot = path.join(packageRoot, "src")
  const sourceFiles: string[] = []
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    await Promise.all(
      entries.map(async (item) => {
        const file = path.join(directory, item.name)
        if (item.isDirectory()) return visit(file)
        if (!item.isFile()) return
        const fileMetadata = await stat(file).catch(() => undefined)
        if (!fileMetadata) return
        sourceFiles.push(`${path.relative(packageRoot, file)}:${fileMetadata.size}:${fileMetadata.mtimeMs}`)
      }),
    )
  }
  await visit(sourceRoot)
  const sourceHash = createHash("sha256").update(sourceFiles.sort().join("\n")).digest("hex")
  return [executable, metadata?.size ?? "unknown", metadata?.mtimeMs ?? "unknown", sourceHash].join(":")
}

export async function ensureLocalSharedServer(input: {
  directory: string
  runtimeCwd: string
  lease?: SharedServerClientLease
}): Promise<LocalSharedServerConnection | undefined> {
  const runtimeID = await sharedServerRuntimeID(input.runtimeCwd)
  const existing = await connectToLocalSharedServer(input.directory, runtimeID, input.lease)
  if (existing) return existing

  const release = await SharedServer.acquireLock()
  if (!release) return waitForLocalSharedServer(input.directory, runtimeID, input.lease)

  let child: ChildProcess | undefined
  let connected = false
  try {
    const startedByAnotherClient = await connectToLocalSharedServer(input.directory, runtimeID, input.lease)
    if (startedByAnotherClient) {
      connected = true
      return startedByAnotherClient
    }

    const state = await SharedServer.readState()
    if (state) {
      const activeClients = await SharedServer.activeClientLeaseCountForServer(state.pid)
      const live = SharedServer.isProcessAlive(state.pid)
      const runtimeMatches = state.runtimeID === runtimeID

      const canReplace = SharedServer.shouldReplaceSharedServer({
        live,
        runtimeMatches,
        activeClients,
        reachable: false,
      })
      if (SharedServer.shouldAttachExistingSharedServer({
        live,
        runtimeMatches,
        activeClients,
        reachable: false,
      })) {
        // An active client owns the old runtime. Attach to that server until
        // its leases drain; starting a second server would split durable state
        // and make reconnects race between databases.
        const existing = await waitForExistingLocalSharedServer(input.directory, input.lease)
        if (existing) {
          connected = true
          return existing
        }
        return
      } else if (canReplace) {
        if (!(await stopLocalSharedServer(state)))
          return waitForLocalSharedServer(input.directory, runtimeID, input.lease)
        await SharedServer.clearStateIfOwned(state.pid)
      } else {
        // A live but unreachable server with active clients cannot be safely
        // replaced. Fail closed and let the owning client recover it.
        return undefined
      }
    }

    await SharedServer.clearState()
    const credentials = SharedServer.credentials()
    const command = sharedServerCommand(input.runtimeCwd)
    const token = randomUUID()
    const progressFile = path.join(path.dirname(SharedServer.statePath()), `startup-${token}.json`)
    child = spawn(command.command, command.args, {
      cwd: command.cwd,
      env: { ...sharedServerEnvironment(credentials, runtimeID),
        MENDCODE_BACKEND_STARTUP_FILE: progressFile, MENDCODE_BACKEND_STARTUP_TOKEN: token },
      detached: true,
      stdio: "ignore",
    })
    child.on("error", (error) => {
      Log.Default.warn("shared server process failed to start", {
        command: command.command,
        args: command.args,
        cwd: command.cwd,
        error: errorMessage(error),
      })
    })
    child.unref()

    const started = await waitForBackend({
      connect: () => connectToLocalSharedServer(input.directory, runtimeID, input.lease),
      alive: () => child?.exitCode === null && child?.signalCode === null,
      phase: () => child?.pid ? readBackendPhase(progressFile, child.pid, token) : undefined,
      progress: (phase) => {
        if (phase === "backup") process.stderr.write("Preparing session database backup; large histories may take several minutes.\n")
        if (phase === "migration") process.stderr.write("Applying session database migration; please wait.\n")
      },
    })
    if (!started) {
      const phase = child.pid ? readBackendPhase(progressFile, child.pid, token) : undefined
      throw new Error(`Shared backend startup ${phase === "failed" ? "failed" : "did not finish"}${phase ? ` during ${phase}` : ""}. Startup record: ${progressFile}. Session data was not reset.`)
    }
    connected = true
    return started
  } finally {
    if (!connected) child?.kill()
    await release()
  }
}

function createWorkerFetch(client: RpcClient): typeof fetch {
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const body = request.body ? await request.text() : undefined
    const result = await client.call("fetch", {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
    })
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    })
  }
  return fn as typeof fetch
}

function createEventSource(client: RpcClient): EventSource {
  return {
    subscribe: async (handler) => {
      return client.on<GlobalEvent>("global.event", (e) => {
        handler(e)
      })
    },
  }
}

async function target() {
  if (typeof OPENCODE_WORKER_PATH !== "undefined") return OPENCODE_WORKER_PATH
  const dist = new URL("./cli/cmd/tui/worker.js", import.meta.url)
  if (await Filesystem.exists(fileURLToPath(dist))) return dist
  return new URL("./worker.ts", import.meta.url)
}

async function input(value?: string) {
  const piped = process.stdin.isTTY ? undefined : await Bun.stdin.text()
  if (!value) return piped
  if (!piped) return value
  return piped + "\n" + value
}

async function readServerDiagnostics(transport: ThreadTransport) {
  const request = transport.fetch ?? fetch
  const response = await request(new URL("/global/diagnostics/memory", transport.url), {
    headers: transport.headers,
  })
  if (!response.ok) throw new Error(`diagnostics endpoint returned HTTP ${response.status}`)
  const value: unknown = await response.json()
  if (!isProcessMemoryUsage(value)) throw new Error("diagnostics endpoint returned an invalid response")
  return value
}

export function resolveThreadDirectory(project?: string, envPWD = process.env.PWD, cwd = process.cwd()) {
  const root = Filesystem.resolve(envPWD ?? cwd)
  if (project) return Filesystem.resolve(path.isAbsolute(project) ? project : path.join(root, project))
  return Filesystem.resolve(cwd)
}

export const TuiThreadCommand = cmd({
  command: "$0 [project]",
  describe: "start MendCode TUI",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .positional("project", {
        type: "string",
        describe: "path to start MendCode in",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      .option("fork", {
        type: "boolean",
        describe: "fork the session when continuing (use with --continue or --session)",
      })
      .option("prompt", {
        type: "string",
        describe: "prompt to use",
      })
      .option("initial-message", {
        type: "string",
        describe: "initial message to place in the TUI prompt without auto-submit",
        hidden: true,
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("server-url", {
        type: "string",
        describe:
          "connect to an existing MendCode server instead of starting a local worker (or use MENDCODE_SERVER_URL)",
      })
      .option("isolated", {
        type: "boolean",
        describe: "run with a private local worker instead of the shared local server",
      })
      .option("diagnostics", {
        type: "boolean",
        default: false,
        describe: "enable the on-demand diagnostics commands",
      }),
  handler: async (args) => {
    // Keep ENABLE_PROCESSED_INPUT cleared even if other code flips it.
    // (Important when running under `bun run` wrappers on Windows.)
    const unguard = win32InstallCtrlCGuard()
    try {
      // Must be the very first thing — disables CTRL_C_EVENT before any Worker
      // spawn or async work so the OS cannot kill the process group.
      win32DisableProcessedInput()
      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exitCode = 1
        return
      }

      // Resolve relative --project paths from PWD, then use the real cwd after
      // chdir so the thread and worker share the same directory key.
      const runtimeCwd = process.cwd()
      const next = resolveThreadDirectory(args.project)
      try {
        process.chdir(next)
      } catch {
        UI.error("Failed to change directory to " + next)
        return
      }
      const cwd = Filesystem.resolve(process.cwd())
      const network = resolveNetworkOptionsNoConfig(args)
      let sharedServerURL: string | undefined
      try {
        sharedServerURL = resolveSharedServerURL(args.serverUrl)
      } catch (error) {
        UI.error(errorMessage(error))
        process.exitCode = 1
        return
      }
      const networkOptionSet =
        process.argv.includes("--port") ||
        process.argv.includes("--hostname") ||
        process.argv.includes("--mdns") ||
        network.mdns ||
        network.port !== 0 ||
        network.hostname !== "127.0.0.1"

      if (sharedServerURL && networkOptionSet) {
        UI.error("--server-url cannot be combined with --port, --hostname, or --mdns")
        process.exitCode = 1
        return
      }

      let serverHeaders: RequestInit["headers"] = sharedServerURL ? ServerAuth.headers() : undefined
      let serverURL = sharedServerURL
      let serverProbeFailed = false
      if (serverURL) {
        try {
          await probeSharedServer({ url: serverURL, directory: cwd, headers: serverHeaders })
        } catch (error) {
          serverProbeFailed = true
          UI.println(
            UI.Style.TEXT_WARNING_BOLD +
              "! " +
              UI.Style.TEXT_NORMAL +
              `Server unavailable; keeping the selected server and waiting for reconnect. ${errorMessage(error)}`,
          )
        }
      }

      const isolated =
        args.isolated ||
        process.env.MENDCODE_DISABLE_SHARED_SERVER === "1" ||
        process.env.OPENCODE_DISABLE_SHARED_SERVER === "1"
      let localSharedServer: LocalSharedServerConnection | undefined
      if (
        SharedServer.shouldUseSharedServer({
          serverURL,
          isolated,
          networkOptionSet,
        })
      ) {
        localSharedServer = await ensureLocalSharedServer({ directory: cwd, runtimeCwd })
        if (localSharedServer) {
          serverURL = localSharedServer.url
          serverHeaders = localSharedServer.headers
        }
      }

      const file = serverURL ? undefined : await target()
      const env = sanitizedProcessEnv({
        [OPENCODE_PROCESS_ROLE]: "worker",
        [OPENCODE_RUN_ID]: ensureRunID(),
      })
      const worker = file ? new Worker(file, { env }) : undefined
      if (worker) {
        worker.onerror = (e) => {
          Log.Default.error("thread error", {
            message: e.message,
            filename: e.filename,
            lineno: e.lineno,
            colno: e.colno,
            error: e.error,
          })
        }
      }

      const client = worker ? Rpc.client<typeof rpc>(worker) : undefined
      const error = (e: unknown) => {
        Log.Default.error("process error", { error: errorMessage(e) })
      }
      const reload = () => {
        if (!client) return
        client.call("reload", undefined).catch((err) => {
          Log.Default.warn("worker reload failed", {
            error: errorMessage(err),
          })
        })
      }
      process.on("uncaughtException", error)
      process.on("unhandledRejection", error)
      process.on("SIGUSR2", reload)

      let stopped = false
      const stop = async () => {
        if (stopped) return
        stopped = true
        process.off("uncaughtException", error)
        process.off("unhandledRejection", error)
        process.off("SIGUSR2", reload)
        const lease = localSharedServer?.lease
        localSharedServer = undefined
        await lease?.release().catch((error) => {
          Log.Default.warn("shared server lease release failed", {
            error: errorMessage(error),
          })
        })
        if (!client || !worker) return
        await withTimeout(client.call("shutdown", undefined), 5000).catch((error) => {
          Log.Default.warn("worker shutdown failed", {
            error: errorMessage(error),
          })
        })
        client.close()
        worker.terminate()
      }

      const prompt = await input(args.prompt)
      const config = await TuiConfig.get()
      const mendProfile = await loadMendTuiProfile(cwd, config)

      const external =
        process.argv.includes("--port") ||
        process.argv.includes("--hostname") ||
        process.argv.includes("--mdns") ||
        network.mdns ||
        network.port !== 0 ||
        network.hostname !== "127.0.0.1"

      let transport: ThreadTransport = serverURL
        ? {
            url: serverURL,
            headers: serverHeaders,
          }
        : external
          ? {
              url: (await client!.call("server", network)).url,
              fetch: undefined,
              headers: ServerAuth.headers(),
              events: undefined,
            }
          : {
              url: "http://opencode.internal",
              fetch: createWorkerFetch(client!),
              events: createEventSource(client!),
            }

      const reconnect = localSharedServer
        ? async () => {
            const current = localSharedServer
            if (!current) throw new Error("local shared server connection is unavailable")
            const refreshed = await ensureLocalSharedServer({
              directory: cwd,
              runtimeCwd,
              lease: current.lease,
            })
            if (!refreshed) throw new Error("local shared server is unavailable")
            localSharedServer = refreshed
            serverURL = refreshed.url
            serverHeaders = refreshed.headers
            transport.url = refreshed.url
            transport.headers = refreshed.headers
            return { url: refreshed.url, headers: refreshed.headers }
          }
        : undefined

      const reconnectConfig = !transport.events
        ? {
            ...(reconnect ? { refresh: reconnect } : {}),
            maxAttempts: SHARED_SERVER_RECONNECT_MAX_ATTEMPTS,
            retryDelay: SHARED_SERVER_RECONNECT_RETRY_DELAY_MS,
            maxRetryDelay: SHARED_SERVER_RECONNECT_MAX_DELAY_MS,
            staleDelay: SHARED_SERVER_RECONNECT_STALE_DELAY_MS,
          }
        : undefined

      try {
        try {
          await validateSession({
            url: transport.url,
            sessionID: args.session,
            directory: cwd,
            fetch: transport.fetch,
            headers: transport.headers,
            // An explicitly selected server may be offline during Wi-Fi
            // recovery or an app restart. Let the TUI enter its durable SSE
            // reconnect loop instead of creating a competing local runtime.
            remote: !serverProbeFailed,
          })
        } catch (error) {
          UI.error(errorMessage(error))
          process.exitCode = 1
          return
        }

        await tui({
          url: transport.url,
          ...(args.diagnostics
            ? {
                async onSnapshot() {
                  const tui = writeHeapSnapshot("tui.heapsnapshot")
                  if (!client) return [tui]
                  const server = await client.call("snapshot", undefined)
                  return [tui, server]
                },
                async onDiagnostics(): Promise<DiagnosticsSnapshot> {
                  const tui = processMemoryUsage("tui")
                  try {
                    return {
                      tui,
                      server: await readServerDiagnostics(transport),
                    }
                  } catch (error) {
                    return {
                      tui,
                      serverError: errorMessage(error),
                    }
                  }
                },
              }
            : {}),
          config,
          mendProfile,
          reconnect: reconnectConfig,
          directory: cwd,
          fetch: transport.fetch,
          headers: transport.headers,
          events: transport.events,
          args: {
            continue: args.continue,
            sessionID: args.session,
            agent: args.agent,
            model: args.model,
            prompt,
            initialMessage: args.initialMessage,
            fork: args.fork,
          },
        })
      } finally {
        await stop()
      }
    } finally {
      unguard?.()
    }
    process.exit(process.exitCode ?? 0)
  },
})
// scratch
