import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import * as Log from "@mendcode/core/util/log"
import { Global } from "@mendcode/core/global"
import { UI } from "./cli/ui"
import { Installation } from "./installation"
import { NamedError } from "@mendcode/core/util/error"
import { FormatError } from "./cli/error"
import { EOL } from "os"
import { errorMessage } from "./util/error"
import { Heap } from "./cli/heap"
import { ensureProcessMetadata } from "@mendcode/core/util/opencode-process"
import path from "path"
import { existsSync } from "fs"
import { automationJSONRequested, writeAutomationEnvelope } from "./cli/automation"

const processMetadata = ensureProcessMetadata("main")

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: errorMessage(e),
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: errorMessage(e),
  })
})

const args = hideBin(process.argv)

type RuntimeCommand = {
  command?: string | readonly string[]
}

const commandLoaders = {
  acp: () => import("./cli/cmd/acp").then((module) => module.AcpCommand),
  mcp: () => import("./cli/cmd/mcp").then((module) => module.McpCommand),
  attach: () => import("./cli/cmd/tui/attach").then((module) => module.AttachCommand),
  run: () => import("./cli/cmd/run").then((module) => module.RunCommand),
  generate: () => import("./cli/cmd/generate").then((module) => module.GenerateCommand),
  debug: () => import("./cli/cmd/debug").then((module) => module.DebugCommand),
  console: () => import("./cli/cmd/account").then((module) => module.ConsoleCommand),
  providers: () => import("./cli/cmd/providers").then((module) => module.ProvidersCommand),
  agent: () => import("./cli/cmd/agent").then((module) => module.AgentCommand),
  upgrade: () => import("./cli/cmd/upgrade").then((module) => module.UpgradeCommand),
  uninstall: () => import("./cli/cmd/uninstall").then((module) => module.UninstallCommand),
  serve: () => import("./cli/cmd/serve").then((module) => module.ServeCommand),
  web: () => import("./cli/cmd/web").then((module) => module.WebCommand),
  models: () => import("./cli/cmd/models").then((module) => module.ModelsCommand),
  stats: () => import("./cli/cmd/stats").then((module) => module.StatsCommand),
  export: () => import("./cli/cmd/export").then((module) => module.ExportCommand),
  import: () => import("./cli/cmd/import").then((module) => module.ImportCommand),
  github: () => import("./cli/cmd/github").then((module) => module.GithubCommand),
  pr: () => import("./cli/cmd/pr").then((module) => module.PrCommand),
  session: () => import("./cli/cmd/session").then((module) => module.SessionCommand),
  plugin: () => import("./cli/cmd/plug").then((module) => module.PluginCommand),
  db: () => import("./cli/cmd/db").then((module) => module.DbCommand),
  "global-layout": () => import("./cli/cmd/global-layout").then((module) => module.GlobalLayoutCommand),
} satisfies Record<string, () => Promise<RuntimeCommand>>

function loadTuiCommand() {
  return import("./cli/cmd/tui/thread").then((module) => module.TuiThreadCommand)
}

async function commandsForArgs(): Promise<RuntimeCommand[]> {
  if (args.includes("--version") || args.includes("-v")) return []
  if (args.includes("--help") || args.includes("-h") || args.includes("completion")) {
    const commands: RuntimeCommand[] = [await loadTuiCommand()]
    for (const load of Object.values(commandLoaders)) commands.push(await load())
    return commands
  }
  const command = (() => {
    for (let index = 0; index < args.length; index++) {
      const token = args[index]
      if (
        /^(?:--(?:print-logs|pure|trace)(?:=(?:true|false))?|--no-(?:print-logs|pure|trace))$/.test(token) ||
        token.startsWith("--log-level=")
      )
        continue
      if (token === "--log-level") {
        index++
        continue
      }
      if (token.startsWith("-")) return
      return token in commandLoaders ? token : undefined
    }
  })()
  if (command) return [await commandLoaders[command as keyof typeof commandLoaders]()]
  return [await loadTuiCommand()]
}

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith("mendcode ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text)
    return
  }
  process.stderr.write(out)
}

const cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName("mendcode")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", Installation.displayVersion())
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .option("trace", {
    describe: "capture correlated backend and TUI queue diagnostics",
    type: "boolean",
  })
  .middleware(async (opts) => {
    if (opts.pure) {
      process.env.OPENCODE_PURE = "1"
    }
    if (opts.trace) {
      process.env.MENDCODE_TRACE = "1"
    }

    await Log.init({
      print: process.argv.includes("--print-logs"),
      dev: Installation.isLocal(),
      level: (() => {
        if (opts.logLevel) return opts.logLevel as Log.Level
        if (Installation.isLocal()) return "DEBUG"
        return "INFO"
      })(),
    })

    Heap.start()

    process.env.AGENT = "1"
    process.env.OPENCODE = "1"
    process.env.MENDCODE_RUNTIME = "1"
    process.env.OPENCODE_PID = String(process.pid)

    Log.Default.info("mendcode", {
      version: Installation.displayVersion(),
      args: process.argv.slice(2),
      process_role: processMetadata.processRole,
      run_id: processMetadata.runID,
    })

    const migrationDonePath = path.join(Global.Path.data, ".mendcode-json-storage-migration-v0.done")
    if (!existsSync(migrationDonePath)) {
      const [{ JsonMigration }, { Database }, { drizzle }] = await Promise.all([
        import("@/storage/json-migration"),
        import("@/storage/db"),
        import("drizzle-orm/bun-sqlite"),
      ])
      const tty = process.stderr.isTTY
      process.stderr.write("Performing one time database migration, may take a few minutes..." + EOL)
      const width = 36
      const orange = "\x1b[38;5;214m"
      const muted = "\x1b[0;2m"
      const reset = "\x1b[0m"
      let last = -1
      if (tty) process.stderr.write("\x1b[?25l")
      try {
        await JsonMigration.run(drizzle({ client: Database.Client().$client }), {
          progress: (event) => {
            const percent = Math.floor((event.current / event.total) * 100)
            if (percent === last && event.current !== event.total) return
            last = percent
            if (tty) {
              const fill = Math.round((percent / 100) * width)
              const bar = `${"■".repeat(fill)}${"･".repeat(width - fill)}`
              process.stderr.write(
                `\r${orange}${bar} ${percent.toString().padStart(3)}%${reset} ${muted}${event.label.padEnd(12)} ${event.current}/${event.total}${reset}`,
              )
              if (event.current === event.total) process.stderr.write("\n")
            } else {
              process.stderr.write(`sqlite-migration:${percent}${EOL}`)
            }
          },
        })
        await JsonMigration.writeJsonStorageMigrationDoneMarker()
        process.stderr.write("Database migration complete." + EOL)
      } finally {
        if (tty) process.stderr.write("\x1b[?25h")
        else {
          process.stderr.write(`sqlite-migration:done${EOL}`)
        }
      }
    }
  })
  .usage("")
  .completion("completion", "generate shell completion script")

for (const command of await commandsForArgs()) {
  ;(cli.command as unknown as (command: RuntimeCommand) => typeof cli)(command)
}

cli
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp(show)
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

try {
  if (args.includes("-h") || args.includes("--help")) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    await cli.parse()
  }
} catch (e) {
  let data: Record<string, any> = {}
  if (e instanceof NamedError) {
    const obj = e.toObject()
    Object.assign(data, {
      ...obj.data,
    })
  }

  if (e instanceof Error) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      cause: e.cause?.toString(),
      stack: e.stack,
    })
  }

  if (e instanceof ResolveMessage) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      code: e.code,
      specifier: e.specifier,
      referrer: e.referrer,
      position: e.position,
      importKind: e.importKind,
    })
  }
  Log.Default.error("fatal", data)
  if (automationJSONRequested(args)) {
    writeAutomationEnvelope({
      kind: "error",
      event: "cli.error",
      data: {
        name: e instanceof Error ? e.name : "Error",
        message: e instanceof Error ? e.message : errorMessage(e),
        ...(data.code ? { code: data.code } : {}),
      },
    })
  }
  const formatted = FormatError(e)
  if (!automationJSONRequested(args) && formatted) UI.error(formatted)
  if (!automationJSONRequested(args) && formatted === undefined) {
    UI.error("Unexpected error, check log file at " + Log.file() + " for more details" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}
