import path from "node:path"
import { EXTENSION_API_VERSION } from "@mendcode/extension-api"
import { VIEW_SLOT_NAMES } from "@mendcode/extension-api/views"
import { PROGRAM_NAME } from "@mendcode/program"

/**
 * `mendcode package new <name> [--dir PARENT]` and `mendcode package check <dir>`: they work on package folders only, so they never
 * start or contact a daemon (like `view scaffold`). `check` loads the package library (zod) only when it runs.
 */
export const PACKAGE_FILE_USAGE = `usage: ${PROGRAM_NAME} package new <name> [--dir PARENT]   a complete, commented package in PARENT/<name> (default: here)\n       ${PROGRAM_NAME} package check [<folder>]       schema, compat, capabilities, activation and size limits of a package folder (default: here)\n`

export type PackageFileCommand = { help: boolean; action: "new" | "check"; target?: string; dir?: string; error?: string }

export function parsePackageFileCommand(argv: string[]): PackageFileCommand | undefined {
  const words: string[] = []
  let dir: string | undefined
  let help = false
  let error: string | undefined
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    if (token === "--help" || token === "-h") help = true
    else if (token.startsWith("--")) {
      const [name, inline] = token.slice(2).split(/=(.*)/s, 2)
      if (name !== "dir") { error = `unknown flag ${token}`; continue }
      const value = inline ?? argv[++index]
      if (!value || value.startsWith("--")) error = "--dir needs a value"
      else dir = value
    } else words.push(token)
  }
  const [command, action, target, extra] = words
  if (command !== "package" || (action !== "new" && action !== "check")) return undefined
  if (action === "new" && (!target || extra)) return { help, action, ...(dir ? { dir } : {}), error: error ?? "package new needs one name" }
  if (action === "check" && extra) return { help, action, ...(target ? { target } : {}), error: error ?? "package check takes one folder" }
  return { help, action, ...(target ? { target } : {}), ...(dir ? { dir } : {}), ...(error ? { error } : {}) }
}

type Io = { cwd: string; version: string; out: { write(text: string): unknown }; err: { write(text: string): unknown } }

/** Runs the command; the exit code is the return value (`check` exits 1 when there are errors). */
export async function runPackageFileCommand(command: PackageFileCommand, io: Io): Promise<number> {
  if (command.help) { io.out.write(PACKAGE_FILE_USAGE); return 0 }
  if (command.error) { io.err.write(`error: ${command.error}\n${PACKAGE_FILE_USAGE}`); return 64 }
  if (command.action === "new") {
    const { scaffoldPackage } = await import("./package-scaffold")
    const result = scaffoldPackage({ name: command.target!, parent: path.resolve(io.cwd, command.dir ?? ".") })
    if (!result.ok) { io.err.write(`error: ${result.message}\n`); return 1 }
    io.out.write(`wrote ${result.dir} (${result.files.length} files)\nnext: ${PROGRAM_NAME} package check ${result.dir}, then ${PROGRAM_NAME} package install ${result.dir}\n`)
    return 0
  }
  const folder = path.resolve(io.cwd, command.target ?? ".")
  const { checkPackage, formatCheck } = await import("../../../packages/packages/src/check")
  const result = checkPackage({ dir: folder, host: { appVersion: io.version, apiVersion: EXTENSION_API_VERSION }, knownSlots: VIEW_SLOT_NAMES })
  io.out.write(`${formatCheck(result).join("\n")}\n`)
  return result.ok ? 0 : 1
}
