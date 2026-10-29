import { realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import type { Settings } from "@mendcode/protocol"
import type { AppContext } from "./context"

export const ADD_DIR_USAGE = "usage: /add-dir [PATH | save PATH | remove PATH]"
const MAX_DIRECTORIES = 20

/** An existing directory as a real absolute path, or undefined; relative paths resolve from the session's directory. */
function existingDirectory(target: string, base: string): string | undefined {
  const expanded = target === "~" ? homedir() : target.startsWith("~/") ? path.join(homedir(), target.slice(2)) : target
  const resolved = path.resolve(base, expanded)
  try {
    return statSync(resolved).isDirectory() ? realpathSync(resolved) : undefined
  } catch {
    return undefined
  }
}

/**
 * `/add-dir` declares extra workspace directories: tools reach them without the external-directory ask and shell
 * commands may write there under the OS sandbox. `PATH` is for this session only (like `--add-dir`); `save PATH`
 * also keeps it in the `additionalDirectories` setting; `remove PATH` drops it from both. Explicit deny rules still win.
 */
export function createAddDir(ctx: AppContext) {
  const { state, input, say, fail, requestFrame } = ctx

  async function sessionDirectories(): Promise<string[] | undefined> {
    const reply = await input.send({ type: "session.run.configure", sessionId: state.sessionId })
    if (!reply.ok) { fail(reply.error.message.replace(/^\[DAEMON\]:\s*/, "")); return undefined }
    return [...((reply.result as { limits?: { addDirs?: string[] } } | undefined)?.limits?.addDirs ?? [])]
  }

  async function setSessionDirectories(next: string[]): Promise<boolean> {
    const reply = await input.send({ type: "session.run.configure", sessionId: state.sessionId, addDirs: next.length ? next : null })
    if (!reply.ok) { fail(reply.error.message.replace(/^\[DAEMON\]:\s*/, "")); return false }
    return true
  }

  async function setSaved(next: string[]): Promise<boolean> {
    const reply = await input.send({ type: "settings.set", patch: { additionalDirectories: next } })
    if (!reply.ok) { fail(reply.error.message); return false }
    state.settingsNow = ((reply.result as { settings?: Settings } | undefined)?.settings) ?? { ...state.settingsNow, additionalDirectories: next }
    return true
  }

  async function addDirCommand(text: string): Promise<boolean> {
    const match = /^\/add-dir(?:\s+(.*))?$/s.exec(text.trim())
    if (!match) return false
    if (input.remote) { fail("Extra directories belong to the machine that runs the commands and are local only"); return true }
    const rest = (match[1] ?? "").trim()
    const saved = state.settingsNow.additionalDirectories ?? []
    if (!rest) {
      const session = await sessionDirectories()
      if (!session) return true
      const lines = [...saved.map((dir) => `${dir} · saved`), ...session.filter((dir) => !saved.includes(dir)).map((dir) => `${dir} · this session`)]
      say(lines.length ? `extra directories\n${lines.join("\n")}` : `no extra directories · ${ADD_DIR_USAGE}`)
      return true
    }
    const word = /^(save|remove)(?:\s+(.*))?$/s.exec(rest)
    const mode = (word?.[1] ?? "session") as "session" | "save" | "remove"
    const target = (word ? word[2] ?? "" : rest).trim()
    if (!target) { say(ADD_DIR_USAGE, "warning"); return true }
    const directory = existingDirectory(target, input.directory ?? process.cwd())
    if (mode === "remove") {
      const drop = directory ?? path.resolve(input.directory ?? process.cwd(), target)
      const session = await sessionDirectories()
      if (!session) return true
      const keepSession = session.filter((dir) => dir !== drop)
      const keepSaved = saved.filter((dir) => dir !== drop)
      if (keepSession.length === session.length && keepSaved.length === saved.length) { say(`not an extra directory: ${target}`, "warning"); return true }
      if (keepSession.length !== session.length && !(await setSessionDirectories(keepSession))) return true
      if (keepSaved.length !== saved.length && !(await setSaved(keepSaved))) return true
      say(`no longer an extra directory: ${drop}`, "success")
      requestFrame()
      return true
    }
    if (!directory) { say(`not a directory: ${target}`, "warning"); return true }
    if (directory === path.resolve(input.directory ?? process.cwd())) { say("that is already the project directory", "warning"); return true }
    if (mode === "save") {
      if (saved.includes(directory)) { say(`already saved: ${directory}`); return true }
      if (saved.length >= MAX_DIRECTORIES) { fail(`at most ${MAX_DIRECTORIES} saved directories`); return true }
      if (!(await setSaved([...saved, directory]))) return true
      say(`extra directory saved: ${directory}`, "success")
      requestFrame()
      return true
    }
    const session = await sessionDirectories()
    if (!session) return true
    if (session.includes(directory) || saved.includes(directory)) { say(`already an extra directory: ${directory}`); return true }
    if (session.length >= MAX_DIRECTORIES) { fail(`at most ${MAX_DIRECTORIES} directories per session`); return true }
    if (!(await setSessionDirectories([...session, directory]))) return true
    say(`extra directory for this session: ${directory}`, "success")
    requestFrame()
    return true
  }

  return { addDirCommand }
}
