import type { Argv } from "yargs"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { runGlobalLayoutMigration } from "@/storage/global-layout-migration"
import { errorMessage } from "../../util/error"

const MigrateCommand = cmd({
  command: "migrate",
  describe: "copy legacy opencode global dirs into mendcode XDG layout and write migration marker (restart after)",
  builder: (yargs: Argv) =>
    yargs.option("force", {
      type: "boolean",
      default: false,
      describe: "allow migrate when mend data dir already has files (dangerous)",
    }),
  handler: async (args: { force: boolean }) => {
    try {
      const result = await runGlobalLayoutMigration({ force: args.force })
      if (result.status === "skipped" && result.reason === "already_migrated") {
        UI.println("Global layout already migrated (marker present). Restart not required.")
        return
      }
      if (result.status === "skipped" && result.reason === "nothing_to_migrate") {
        UI.println("No legacy global data to migrate. Greenfield installs already use the mend layout.")
        return
      }
      UI.println(`Copied: ${result.copiedRoots.join(", ")}`)
      UI.println("Migration marker written. Restart mend-runtime so Global.Path uses the mend segment.")
    } catch (e) {
      UI.error(errorMessage(e))
      process.exit(1)
    }
  },
})

export const GlobalLayoutCommand = cmd({
  command: "global-layout",
  describe: "global XDG directory layout (Phase B migration)",
  builder: (yargs: Argv) => yargs.command(MigrateCommand).demandCommand(),
  handler: () => {},
})
