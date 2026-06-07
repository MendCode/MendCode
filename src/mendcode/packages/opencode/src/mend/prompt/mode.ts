import { mkdir, readFile, writeFile } from "fs/promises"
import path from "path"
import { mendPaths } from "../config/paths"

export type MendPromptMode = "minimal" | "focus" | "full" | "dev-js"
const modes: MendPromptMode[] = ["minimal", "focus", "full", "dev-js"]

type PromptModeState = { mode: MendPromptMode; live: "runtime-run-chat"; note: string }

const live: PromptModeState["live"] = "runtime-run-chat"
const note = "Persisted prompt mode is consumed by mend run/chat and shown by the MendCode TUI footer."

export async function readPromptMode(root?: string): Promise<PromptModeState> {
  const paths = mendPaths(root)
  try {
    const parsed = JSON.parse(await readFile(paths.promptMode, "utf8"))
    if (modes.includes(parsed.mode)) return { mode: parsed.mode, live, note }
  } catch {}
  return { mode: "focus", live, note }
}

export async function cyclePromptMode(root?: string) {
  const current = await readPromptMode(root)
  const next = modes[(modes.indexOf(current.mode) + 1) % modes.length] ?? "focus"
  return writePromptMode(next, root)
}

export async function writePromptMode(mode: string, root?: string) {
  if (!modes.includes(mode as MendPromptMode)) throw new Error(`prompt mode must be one of: ${modes.join(", ")}`)
  const paths = mendPaths(root)
  await mkdir(path.dirname(paths.promptMode), { recursive: true })
  await writeFile(paths.promptMode, `${JSON.stringify({ version: 0, mode, updatedAt: new Date().toISOString(), live, note }, null, 2)}\n`)
  return readPromptMode(root)
}
