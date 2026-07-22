import { cmd } from "../cmd"
import { UI } from "@/cli/ui"
import { tui } from "./app"
import { win32DisableProcessedInput, win32InstallCtrlCGuard } from "./win32"
import { TuiConfig } from "@/cli/cmd/tui/config/tui"
import { errorMessage } from "@/util/error"
import { validateSession } from "./validate-session"
import { ServerAuth } from "@/server/auth"
import { loadMendTuiProfile } from "@/mend/profile"
import { isProcessMemoryUsage, processMemoryUsage, type DiagnosticsSnapshot } from "@/util/process-memory"

async function readServerDiagnostics(input: { url: string; headers: RequestInit["headers"] }) {
  const response = await fetch(new URL("/global/diagnostics/memory", input.url), {
    headers: input.headers,
  })
  if (!response.ok) throw new Error(`diagnostics endpoint returned HTTP ${response.status}`)
  const value: unknown = await response.json()
  if (!isProcessMemoryUsage(value)) throw new Error("diagnostics endpoint returned an invalid response")
  return value
}

export const AttachCommand = cmd({
  command: "attach <url>",
  describe: "attach to a running MendCode runtime server",
  builder: (yargs) =>
    yargs
      .positional("url", {
        type: "string",
        describe: "http://localhost:4096",
        demandOption: true,
      })
      .option("dir", {
        type: "string",
        description: "directory to run in",
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
      .option("password", {
        alias: ["p"],
        type: "string",
        describe: "basic auth password (defaults to OPENCODE_SERVER_PASSWORD)",
      })
      .option("username", {
        alias: ["u"],
        type: "string",
        describe: "basic auth username (defaults to OPENCODE_SERVER_USERNAME or 'mendcode')",
      })
      .option("diagnostics", {
        type: "boolean",
        default: false,
        describe: "enable the on-demand diagnostics command",
      }),
  handler: async (args) => {
    const unguard = win32InstallCtrlCGuard()
    try {
      win32DisableProcessedInput()

      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exitCode = 1
        return
      }

      const directory = (() => {
        if (!args.dir) return undefined
        try {
          process.chdir(args.dir)
          return process.cwd()
        } catch {
          // If the directory doesn't exist locally (remote attach), pass it through.
          return args.dir
        }
      })()
      const headers = ServerAuth.headers({ password: args.password, username: args.username })
      const config = await TuiConfig.get()
      const mendProfile = await loadMendTuiProfile(directory ?? process.cwd(), config)

      try {
        await validateSession({
          url: args.url,
          sessionID: args.session,
          directory,
          headers,
        })
      } catch (error) {
        UI.error(errorMessage(error))
        process.exitCode = 1
        return
      }

      await tui({
        url: args.url,
        ...(args.diagnostics
          ? {
              async onDiagnostics(): Promise<DiagnosticsSnapshot> {
                const tui = processMemoryUsage("tui")
                try {
                  return {
                    tui,
                    server: await readServerDiagnostics({ url: args.url, headers }),
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
        args: {
          continue: args.continue,
          sessionID: args.session,
          fork: args.fork,
        },
        directory,
        headers,
      })
    } finally {
      unguard?.()
    }
  },
})
