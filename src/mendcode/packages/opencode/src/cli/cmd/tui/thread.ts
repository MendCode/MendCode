import { cmd } from "@/cli/cmd/cmd"
import { tui } from "./app"
import { Rpc } from "@/util/rpc"
import { type rpc } from "./worker"
import { spawn, type ChildProcess } from "child_process"
import path from "path"
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
import { SharedServer, type SharedServerState } from "./shared-server"
import { isProcessMemoryUsage, processMemoryUsage, type DiagnosticsSnapshot } from "@/util/process-memory"

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
  })
  await client.global.health({ throwOnError: true })
  await client.session.list({ limit: 1 }, { throwOnError: true })
}

function sharedServerConnection(state: SharedServerState) {
  return {
    url: state.url,
    headers: ServerAuth.headers({ username: state.username, password: state.password }),
  }
}

async function connectToLocalSharedServer(directory: string) {
  const state = await SharedServer.readState()
  if (!state) return
  const connection = sharedServerConnection(state)
  try {
    await probeSharedServer({ ...connection, directory })
    return connection
  } catch {
    return
  }
}

async function waitForLocalSharedServer(directory: string, timeoutMs = 12_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const connection = await connectToLocalSharedServer(directory)
    if (connection) return connection
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return
}

function runtimeEntrypoint(runtimeCwd: string) {
  const entry = process.argv[1]
  if (!entry || !/(^|[\\/])src[\\/]index\.(?:ts|js)$/.test(entry)) return
  return path.isAbsolute(entry) ? entry : path.resolve(runtimeCwd, entry)
}

function sharedServerCommand(runtimeCwd: string) {
  const entry = runtimeEntrypoint(runtimeCwd)
  if (!entry) {
    return {
      command: process.execPath,
      args: ["serve", "--hostname", "127.0.0.1", "--port", "0"],
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
      "0",
    ],
    cwd: packageRoot,
  }
}

function sharedServerEnvironment(credentials: ReturnType<typeof SharedServer.credentials>) {
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
  }
}

async function ensureLocalSharedServer(input: { directory: string; runtimeCwd: string }) {
  const existing = await connectToLocalSharedServer(input.directory)
  if (existing) return existing

  const release = await SharedServer.acquireLock()
  if (!release) return waitForLocalSharedServer(input.directory)

  let child: ChildProcess | undefined
  let connected = false
  try {
    const startedByAnotherClient = await connectToLocalSharedServer(input.directory)
    if (startedByAnotherClient) {
      connected = true
      return startedByAnotherClient
    }

    await SharedServer.clearState()
    const credentials = SharedServer.credentials()
    const command = sharedServerCommand(input.runtimeCwd)
    child = spawn(command.command, command.args, {
      cwd: command.cwd,
      env: sharedServerEnvironment(credentials),
      detached: true,
      stdio: "ignore",
    })
    child.on("error", () => undefined)
    child.unref()

    const started = await waitForLocalSharedServer(input.directory)
    if (!started) return
    connected = true
    return started
  } catch {
    return
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
      const runtimeCwd = process.cwd()

      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exitCode = 1
        return
      }

      // Resolve relative --project paths from PWD, then use the real cwd after
      // chdir so the thread and worker share the same directory key.
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

      let sharedServerHeaders = sharedServerURL ? ServerAuth.headers() : undefined
      let sharedServer = sharedServerURL
      if (sharedServer) {
        try {
          await probeSharedServer({ url: sharedServer, directory: cwd, headers: sharedServerHeaders })
        } catch (error) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD +
              "! " +
              UI.Style.TEXT_NORMAL +
              `Shared server unavailable; falling back to the local runtime. ${errorMessage(error)}`,
          )
          sharedServer = undefined
        }
      }

      const isolated =
        args.isolated ||
        process.env.MENDCODE_DISABLE_SHARED_SERVER === "1" ||
        process.env.OPENCODE_DISABLE_SHARED_SERVER === "1"
      if (!sharedServer && !isolated && !networkOptionSet) {
        const local = await ensureLocalSharedServer({ directory: cwd, runtimeCwd })
        if (local) {
          sharedServer = local.url
          sharedServerHeaders = local.headers
        }
      }

      const file = sharedServer ? undefined : await target()
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
        if (!client || !worker) return
        await withTimeout(client.call("shutdown", undefined), 5000).catch((error) => {
          Log.Default.warn("worker shutdown failed", {
            error: errorMessage(error),
          })
        })
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

      const transport: ThreadTransport = sharedServer
        ? {
            url: sharedServer,
            headers: sharedServerHeaders,
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

      try {
        await validateSession({
          url: transport.url,
          sessionID: args.session,
          directory: cwd,
          fetch: transport.fetch,
          headers: transport.headers,
        })
      } catch (error) {
        UI.error(errorMessage(error))
        process.exitCode = 1
        return
      }

      if (client) {
        setTimeout(() => {
          client.call("checkUpgrade", { directory: cwd }).catch(() => {})
        }, 1000).unref?.()
      }

      try {
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
