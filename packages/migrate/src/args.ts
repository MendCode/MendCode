import { existsSync, realpathSync } from "node:fs"
import path from "node:path"
import { MigrateError } from "./errors"
import { V1_DB_FILE } from "./settings"
import { PROGRAM_NAME } from "@mendcode/program"

export type MigrateCommand = {
  from: string
  dir: string
  dryRun: boolean
  /** Only v1 sessions updated on or after this instant (ms since epoch); from `--since YYYY-MM-DD` (UTC midnight). */
  since?: number
  memories: boolean
  json: boolean
  help: boolean
}
export type MigrateParse = { ok: true; command: MigrateCommand } | { ok: false; message: string }

const VALUE_FLAGS = new Set(["from", "dir", "since", "format"])
const BOOLEAN_FLAGS = new Set(["dry-run", "no-memories", "json", "help"])
/** Value flags of the rest of the CLI, so the subcommand is still found when one of them comes first. */
const OTHER_VALUE_FLAGS = new Set(["engine", "session"])

export const MIGRATE_USAGE = [
  `usage: ${PROGRAM_NAME} migrate-v1 --from <legacy data dir> --dir <data dir> [--dry-run] [--since YYYY-MM-DD] [--no-memories] [--json]`,
  "  --from D        the legacy MendCode data directory (must contain mendcode-local.db); it is only read, never written",
  "  --dir D         the MendCode data directory to import into (required: there is no default); stop the MendCode daemon first",
  "  --dry-run       read everything and print the full report; opens no MendCode store and writes nothing",
  "  --since DATE    only sessions updated on or after DATE (YYYY-MM-DD, UTC)",
  "  --no-memories   do not import the v1 memory files",
  "  --json          print the report as JSON instead of the summary",
  "  Safe to rerun: sessions and memories already imported are skipped. The report is saved to <dir>/migrations/.",
].join("\n")

/** Splits `--flag value` and `--flag=value`; the first positional is the subcommand. */
function tokenize(argv: string[]) {
  const flags = new Map<string, string | true>()
  const positionals: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (!token.startsWith("--")) {
      positionals.push(token)
      continue
    }
    const equals = token.indexOf("=")
    const name = token.slice(2, equals < 0 ? undefined : equals)
    if (VALUE_FLAGS.has(name)) {
      const value = equals >= 0 ? token.slice(equals + 1) : argv[++i]
      if (value === undefined || value === "" || (equals < 0 && value.startsWith("--"))) return { error: `--${name} needs a value` }
      flags.set(name, value)
    } else if (BOOLEAN_FLAGS.has(name) && equals < 0) flags.set(name, true)
    else return { error: `unknown flag ${token.split("=")[0]}` }
  }
  return { flags, positionals }
}

/** True when the first word of the command line (flag values skipped) is `migrate-v1`. */
export function isMigrateCommand(argv: string[]) {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token.startsWith("--")) {
      if (!token.includes("=") && (VALUE_FLAGS.has(token.slice(2)) || OTHER_VALUE_FLAGS.has(token.slice(2)))) i++
      continue
    }
    return token === "migrate-v1"
  }
  return false
}

/** `YYYY-MM-DD` as UTC midnight; undefined when it is not a real calendar date. */
export function parseSince(text: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined
  const at = Date.parse(`${text}T00:00:00Z`)
  return Number.isFinite(at) && new Date(at).toISOString().startsWith(text) ? at : undefined
}

export function parseMigrateArgs(argv: string[]): MigrateParse {
  const tokens = tokenize(argv)
  if ("error" in tokens) return { ok: false, message: tokens.error }
  const { flags, positionals } = tokens
  if (positionals[0] !== "migrate-v1") return { ok: false, message: "not a migrate-v1 command" }
  if (positionals.length > 1) return { ok: false, message: `unexpected argument ${positionals[1]}` }
  const help = flags.has("help")
  const format = flags.get("format")
  if (format !== undefined && format !== "json") return { ok: false, message: "--format must be json" }
  const from = flags.get("from")
  const dir = flags.get("dir")
  if (!help && typeof from !== "string") return { ok: false, message: "--from <legacy data dir> is required" }
  if (!help && typeof dir !== "string") return { ok: false, message: "--dir <data dir> is required (there is no default, so the real data directory is never hit by accident)" }
  const sinceText = flags.get("since")
  let since: number | undefined
  if (typeof sinceText === "string") {
    since = parseSince(sinceText)
    if (since === undefined) return { ok: false, message: "--since must be a date like 2026-01-31" }
  }
  return {
    ok: true,
    command: {
      from: typeof from === "string" ? from : "",
      dir: typeof dir === "string" ? dir : "",
      dryRun: flags.has("dry-run"),
      ...(since !== undefined ? { since } : {}),
      memories: !flags.has("no-memories"),
      json: flags.has("json") || format === "json",
      help,
    },
  }
}

/** `base` itself or anything below it. */
function within(base: string, target: string) {
  const relative = path.relative(base, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/** Absolute path with symlinks resolved as far as the path exists, so a link cannot smuggle a target into v1. */
function realResolve(target: string) {
  const absolute = path.resolve(target)
  let existing = absolute
  const rest: string[] = []
  while (!existsSync(existing) && path.dirname(existing) !== existing) {
    rest.unshift(path.basename(existing))
    existing = path.dirname(existing)
  }
  return path.join(realpathSync(existing), ...rest)
}

/** Legacy MendCode locations; the import never writes under them. */
export const v1Homes = (home: string) => [path.join(home, ".mendcode"), path.join(home, ".local", "share", "mendcode")]

/** The absolute source and target directories, or a refusal. Nothing is created here. */
export function resolveTargets({ from, dir, home }: { from: string; dir: string; home: string }) {
  if (!from) throw new MigrateError("missing-from", "--from is required")
  const source = realResolve(from)
  if (!existsSync(path.join(source, V1_DB_FILE))) throw new MigrateError("missing-db", `${source} does not contain ${V1_DB_FILE}; --from must be a legacy MendCode data directory`)
  if (!dir) throw new MigrateError("missing-dir", "--dir is required")
  const target = realResolve(dir)
  if (within(source, target)) throw new MigrateError("dir-inside-from", `--dir ${target} is inside the legacy MendCode directory ${source}; the import never writes there`)
  for (const v1 of v1Homes(home)) {
    if (within(realResolve(v1), target)) throw new MigrateError("dir-is-v1", `--dir ${target} belongs to legacy MendCode (${v1}); the import never writes there`)
  }
  return { from: source, dir: target }
}
