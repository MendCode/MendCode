import { MIGRATE_USAGE, type MigrateCommand } from "./args"
import { MigrateError } from "./errors"
import { summaryText } from "./report"
import { runMigration } from "./run"
import { MIGRATE_EXIT } from "./settings"

export type MigrateCommandDeps = {
  out: { write(text: string): unknown }
  err: { write(text: string): unknown }
  /** The user's home, for refusing a target inside a legacy MendCode directory. */
  home: string
}

/** Runs a parsed `migrate-v1` command and returns the process exit code. */
export async function runMigrateCommand(command: MigrateCommand, deps: MigrateCommandDeps): Promise<number> {
  const { out, err } = deps
  if (command.help) {
    out.write(`${MIGRATE_USAGE}\n`)
    return MIGRATE_EXIT.ok
  }
  try {
    const report = await runMigration({
      from: command.from,
      dir: command.dir,
      dryRun: command.dryRun,
      memories: command.memories,
      home: deps.home,
      ...(command.since !== undefined ? { since: command.since } : {}),
      onProgress: (line) => void err.write(`${line}\n`),
    })
    out.write(command.json ? `${JSON.stringify(report, null, 2)}\n` : summaryText(report))
    return report.sessions.failed > 0 || report.errors.length > 0 ? MIGRATE_EXIT.errors : MIGRATE_EXIT.ok
  } catch (error) {
    if (error instanceof MigrateError) {
      err.write(`error: ${error.message.replace(/^\[MIGRATE\]: /, "")}\n`)
      return MIGRATE_EXIT.refused
    }
    err.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
    return MIGRATE_EXIT.errors
  }
}
