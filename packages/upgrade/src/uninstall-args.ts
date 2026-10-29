import { PROGRAM_NAME } from "@mendcode/program"
export type UninstallCommand = { dir?: string; keepConfig: boolean; keepData: boolean; dryRun: boolean; force: boolean; json: boolean; help: boolean }
export const UNINSTALL_USAGE = [
  `usage: ${PROGRAM_NAME} uninstall [--keep-config|-c] [--keep-data|-d] [--dry-run] [--force|-f] [--dir D] [--json]`,
  "  --keep-config   keep settings, providers, extensions and terminal configuration",
  "  --keep-data     keep sessions, snapshots, attachments and their encryption key",
  "  --dry-run       review targets without changing them or starting a daemon",
  "  --force         skip confirmation; ownership and active-daemon checks still apply",
  "  removed files go to Trash; unowned installations are left alone",
].join("\n")

const VALUES = new Set(["--dir", "--format"])
const ALIASES: Record<string, string> = { "-c": "--keep-config", "-d": "--keep-data", "-f": "--force", "-h": "--help" }
const FLAGS = new Set(["--keep-config", "--keep-data", "--dry-run", "--force", "--json", "--help"])

/** Dispatch on the first positional only; a prompt containing "uninstall" is still a prompt. */
export function isUninstallCommand(args: string[]) {
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!
    if (token.startsWith("--")) {
      if (!token.includes("=") && VALUES.has(token)) i++
    } else if (!(token in ALIASES)) return token === "uninstall"
  }
  return false
}

export function parseUninstallArgs(args: string[]): { ok: true; command: UninstallCommand } | { ok: false; message: string } {
  const flags = new Set<string>()
  const values = new Map<string, string>()
  const words: string[] = []
  for (let i = 0; i < args.length; i++) {
    const token = ALIASES[args[i]!] ?? args[i]!
    const [name, inline] = token.split(/=(.*)/s, 2)
    if (VALUES.has(name!)) {
      const value = inline ?? args[++i]
      if (!value || value.startsWith("-")) return { ok: false, message: `${name} needs a value` }
      values.set(name!, value)
    } else if (FLAGS.has(name!) && inline === undefined) flags.add(name!)
    else if (token.startsWith("-")) return { ok: false, message: `unknown flag ${name}` }
    else words.push(token)
  }
  if (words.length !== 1 || words[0] !== "uninstall") return { ok: false, message: "uninstall takes no positional arguments" }
  if (values.has("--format") && values.get("--format") !== "json") return { ok: false, message: "--format must be json" }
  return { ok: true, command: {
    ...(values.has("--dir") ? { dir: values.get("--dir")! } : {}),
    keepConfig: flags.has("--keep-config"), keepData: flags.has("--keep-data"),
    dryRun: flags.has("--dry-run"), force: flags.has("--force"),
    json: flags.has("--json") || values.get("--format") === "json", help: flags.has("--help"),
  } }
}
