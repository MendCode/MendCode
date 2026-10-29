import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * Opens the user's own editor on some text and reads it back. This is the only place in the terminal client
 * that runs another program, so the CLI loads it with a dynamic import, only when the keybinding is used.
 *
 * The editor owns the terminal while it runs (`stdio: "inherit"`), so the caller passes `suspend` (leave the
 * alternate screen and raw mode) and `resume` (take them back); `resume` runs even when the editor fails.
 */

export type EditRequest = {
  text: string
  /** Overrides $VISUAL / $EDITOR; `code --wait` style arguments are split on spaces, quotes keep words together. */
  editor?: string | undefined
  env?: Readonly<Record<string, string | undefined>> | undefined
  suspend?: (() => void) | undefined
  resume?: (() => void) | undefined
  /** Where the temporary file goes; the system temp folder by default. */
  tmpDir?: string | undefined
  /** File name in the temporary folder; `.md` so editors highlight the prompt as text. */
  fileName?: string | undefined
}

export type EditResult =
  | { ok: true; text: string; changed: boolean }
  | { ok: false; reason: "no-editor" | "spawn-failed" | "exit-code" | "read-failed"; message: string }

/** `$VISUAL`, else `$EDITOR`; undefined when neither holds a command. */
export function resolveEditor(env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  for (const name of ["VISUAL", "EDITOR"]) {
    const value = env[name]?.trim()
    if (value) return value
  }
  return undefined
}

/** Splits a command line into words: spaces separate, single or double quotes group, a backslash escapes outside single quotes. */
export function splitCommand(command: string): string[] {
  const words: string[] = []
  let word = ""
  let started = false
  let quote: '"' | "'" | undefined
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!
    if (quote) {
      if (char === quote) quote = undefined
      else if (char === "\\" && quote === '"' && i + 1 < command.length) word += command[++i]
      else word += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (char === "\\" && i + 1 < command.length) {
      word += command[++i]
      started = true
    } else if (/\s/.test(char)) {
      if (started) words.push(word)
      word = ""
      started = false
    } else {
      word += char
      started = true
    }
  }
  if (started) words.push(word)
  return words
}

/** Editors end a file with a newline the user never typed; one final line break is dropped. */
function trimFinalNewline(text: string) {
  return text.replace(/\r?\n$/, "")
}

/** Writes `text` to a temporary file, runs the editor on it, waits, and returns the saved text. Always removes the file. */
export function editExternally(request: EditRequest): EditResult {
  const command = request.editor?.trim() || resolveEditor(request.env ?? process.env)
  if (!command) return { ok: false, reason: "no-editor", message: "set $VISUAL or $EDITOR to edit the prompt in your editor" }
  const [program, ...args] = splitCommand(command)
  if (!program) return { ok: false, reason: "no-editor", message: "set $VISUAL or $EDITOR to edit the prompt in your editor" }

  let dir: string | undefined
  try {
    dir = mkdtempSync(path.join(request.tmpDir ?? tmpdir(), "mendcode-edit-"))
    const file = path.join(dir, request.fileName ?? "prompt.md")
    writeFileSync(file, request.text, { mode: 0o600 })
    request.suspend?.()
    let status: number | null
    let spawnError: Error | undefined
    try {
      const run = spawnSync(program, [...args, file], { stdio: "inherit", shell: process.platform === "win32", ...(request.env ? { env: { ...process.env, ...request.env } } : {}) })
      status = run.status
      spawnError = run.error
    } finally {
      request.resume?.()
    }
    if (spawnError) return { ok: false, reason: "spawn-failed", message: `could not start ${program}: ${spawnError.message}` }
    if (status !== 0) return { ok: false, reason: "exit-code", message: `${program} exited with ${status === null ? "a signal" : `code ${status}`}; prompt left as it was` }
    let saved: string
    try {
      saved = trimFinalNewline(readFileSync(file, "utf8"))
    } catch (error) {
      return { ok: false, reason: "read-failed", message: `could not read the edited file: ${error instanceof Error ? error.message : String(error)}` }
    }
    return { ok: true, text: saved, changed: saved !== trimFinalNewline(request.text) }
  } catch (error) {
    return { ok: false, reason: "spawn-failed", message: `could not open ${program}: ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
}
