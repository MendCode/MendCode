import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { Installation } from "../../installation"
import { InstallationVersion } from "@mendcode/core/installation/version"
import { channels, readChannel, writeChannel } from "../../installation/release-channel"
import { latestUpdateStartup, latestUpdateOperation } from "../../installation/startup"
import { updateLabel } from "../../installation/progress"

export const UpgradeCommand = {
  command: "upgrade [target]",
  aliases: ["update"],
  describe: "upgrade MendCode runtime to the latest or a specific version",
  builder: (yargs: Argv) => {
    return yargs
      .command("channel [action] [channel]", "show or set the release channel without installing", (cli) => cli
        .positional("action", { choices: ["set"] as const })
        .positional("channel", { choices: [...channels] }), async (args) => {
        if (args.action === "set") {
          const channel = await writeChannel(args.channel)
          UI.println(`Release channel: ${channel}. Run mendcode upgrade to install.`)
          return
        }
        UI.println(`Release channel: ${await readChannel()}`)
      })
      .option("check", { type: "boolean", describe: "check the selected channel without installing" })
      .option("rollback", { type: "boolean", describe: "restore the retained previous executable when its data compatibility is verified" })
      .check((args) => {
        if (args.rollback && (args.check || args.target || args.method)) throw new Error("--rollback cannot be combined with --check, a target version, or --method")
        return true
      })
      .positional("target", {
        describe: "version to upgrade to, for ex '0.1.48' or 'v0.1.48'",
        type: "string",
      })
      .option("method", {
        alias: "m",
        describe: "installation method to use",
        type: "string",
        choices: ["curl", "npm", "pnpm", "bun", "brew", "choco", "scoop"],
      })
  },
  handler: async (args: { target?: string; method?: string; check?: boolean; rollback?: boolean }) => {
    if (args.rollback) {
      const { rollback } = await import("../../installation/rollback")
      const result = await rollback({ executable: process.execPath, version: Installation.displayVersion(),
        maintain: async (metadata) => {
          const { SharedServer } = await import("./tui/shared-server")
          const unlock = await SharedServer.acquireLock()
          if (!unlock) throw new Error("Backend startup is busy; close active terminals before rolling back.")
          try {
            const state = await SharedServer.readState()
            if (state && SharedServer.isProcessAlive(state.pid)) {
              throw new Error("The shared backend is still running. Finish its work and close connected terminals before rollback.")
            }
            const { Path } = await import("../../storage/db")
            const { acquireDatabaseMaintenance } = await import("../../storage/compatibility")
            const maintenance = acquireDatabaseMaintenance(Path, metadata.journal)
            return async () => { try { maintenance.release() } finally { await unlock() } }
          } catch (error) { await unlock(); throw error }
        },
      })
      UI.println(`Restored ${result.version}; restart MendCode to verify backend and TUI readiness. Your database was not restored.`)
      return
    }
    if (args.check) {
      UI.println(`Channel: ${await readChannel()} · Installed: ${Installation.displayVersion()}`)
      const operation = await latestUpdateOperation(process.execPath)
      if (operation) {
        UI.println(`Last update: ${operation.version} · ${operation.failed ? "failed during " : ""}${operation.phase}`)
        UI.println(`Update record: ${operation.file}`)
      }
      const startup = await latestUpdateStartup(process.execPath, Installation.displayVersion())
      if (startup) {
        UI.println(`Last startup: ${startup.state}${startup.error ? ` · ${startup.error}` : ""}`)
        UI.println(`Startup record: ${startup.file}`)
      }
      const available = await Installation.latest().catch(() => undefined)
      UI.println(available ? `Available: ${available}` : "Release check unavailable; local installation was not changed.")
      return
    }
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Upgrade")
    const detectedMethod = await Installation.method()
    const method = (args.method as Installation.Method) ?? detectedMethod
    if (method === "unknown") {
      prompts.log.error(`MendCode runtime is installed to ${process.execPath} and may be managed by a package manager`)
      const install = await prompts.select({
        message: "Install anyways?",
        options: [
          { label: "Yes", value: true },
          { label: "No", value: false },
        ],
        initialValue: false,
      })
      if (prompts.isCancel(install) || !install) {
        prompts.outro("Done")
        return
      }
    }
    prompts.log.info("Using method: " + method)
    const target = args.target ? args.target.replace(/^v/, "") : await Installation.latest()

    if (InstallationVersion === target) {
      prompts.log.warn(`MendCode runtime upgrade skipped: ${target} is already installed`)
      prompts.outro("Done")
      return
    }

    prompts.log.info(`From ${InstallationVersion} → ${target}`)
    const spinner = prompts.spinner()
    spinner.start("Checking release...")
    const err = await Installation.upgrade(method, target, (phase, progress) => {
      spinner.message(`${updateLabel(phase, progress)}...`)
    }).catch((err) => err)
    if (err) {
      spinner.stop("Upgrade failed", 1)
      if (err instanceof Installation.UpgradeFailedError) {
        // necessary because choco only allows install/upgrade in elevated terminals
        if (method === "choco" && err.stderr.includes("not running from an elevated command shell")) {
          prompts.log.error("Please run the terminal as Administrator and try again")
        } else {
          prompts.log.error(err.stderr)
        }
      } else if (err instanceof Error) prompts.log.error(err.message)
      prompts.outro("Done")
      return
    }
    spinner.stop("Installed; restart required to check startup")
    prompts.outro("Done")
  },
}
