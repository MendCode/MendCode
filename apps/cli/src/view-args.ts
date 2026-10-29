import path from "node:path"
import { VIEW_SLOT_NAMES, VIEW_SLOTS } from "@mendcode/extension-api/views"
import { scaffoldView } from "./extensions/view-scaffold"
import { PROGRAM_NAME } from "@mendcode/program"

/** `mendcode view list | scaffold <slot>`: works on files only, so it never starts or contacts a daemon. */
export const VIEW_USAGE = `usage: ${PROGRAM_NAME} view list\n  view scaffold <slot> [--force]\n  --dir D | --data-dir D\n  Writes a commented starter to <data dir>/extensions; /customize > Views manages installed views (docs/views.md)\n`

export type ViewCommand = { help: boolean; action?: "list" | "scaffold"; slot?: string; dir?: string; force: boolean; error?: string }

const VALUES = new Set(["dir", "data-dir"])

export function parseViewCommand(argv: string[]): ViewCommand | undefined {
  const words: string[] = []
  let dir: string | undefined
  let help = false
  let force = false
  let error: string | undefined
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    if (token === "--help" || token === "-h") help = true
    else if (token === "--force") force = true
    else if (token.startsWith("--")) {
      const [name, inline] = token.slice(2).split(/=(.*)/s, 2)
      if (!VALUES.has(name!)) { error = `unknown flag ${token}`; continue }
      const value = inline ?? argv[++index]
      if (!value || value.startsWith("--")) error = `--${name} needs a value`
      else dir = value
    } else words.push(token)
  }
  if (words[0] !== "view") return undefined
  const [, action, slot, extra] = words
  // Anything else after `view` is not this command (it may be the start of a prompt).
  if (action !== "list" && action !== "scaffold") return undefined
  if (action === "scaffold" && (!slot || extra)) return { help, action, force, ...(dir ? { dir } : {}), error: error ?? "view scaffold needs one slot" }
  return { help, action, force, ...(slot ? { slot } : {}), ...(dir ? { dir } : {}), ...(error ? { error } : {}) }
}

/** Runs the command; the exit code is the return value. */
export function runViewCommand(command: ViewCommand, io: { dataDir: string; out: { write(text: string): unknown }; err: { write(text: string): unknown } }): number {
  if (command.help) { io.out.write(VIEW_USAGE); return 0 }
  if (command.error) { io.err.write(`error: ${command.error}\n${VIEW_USAGE}`); return 64 }
  if (command.action === "list") {
    io.out.write(VIEW_SLOT_NAMES.map((slot) => `${slot.padEnd(18)} ${VIEW_SLOTS[slot].label}`).join("\n") + "\n")
    return 0
  }
  const result = scaffoldView({ dataDir: path.resolve(io.dataDir), slot: command.slot!, force: command.force })
  if (!result.ok) { io.err.write(`error: ${result.message}\n`); return 1 }
  io.out.write(`wrote ${result.file}\nedit it; a running terminal reloads it by itself\n`)
  return 0
}
