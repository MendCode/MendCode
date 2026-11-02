import { listProfileBackups, profileFile, restoreProfile } from "@mendcode/program/profile-history"

/** Shared by the local headless command and /customize; never starts a daemon or reads values into output. */
export function runProfileRestore(dir: string, args: string[]): { restored: boolean; text: string } {
  if (args.length > 1) throw new Error("usage: profile restore [id]")
  const file = profileFile(dir)
  const id = args[0]
  if (!id) {
    const rows = listProfileBackups(file)
    return { restored: false, text: rows.length ? rows.map((row) => `${row.id}  ${new Date(row.at).toISOString()}  ${row.valid ? `${row.differences} settings differ` : "damaged backup"}`).join("\n") + "\nRestore: /customize restore <id> · mendcode profile restore <id>" : "No profile backups yet" }
  }
  const result = restoreProfile(file, id)
  return { restored: true, text: `Profile restored${result.backupId ? ` · undo: /customize restore ${result.backupId}` : ""}` }
}
