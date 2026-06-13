import { mkdir, readFile, writeFile } from "fs/promises"
import path from "path"
import { mendPaths } from "../config/paths"
import { activeMendPackageProjection } from "../runtime/packages"

export type MendPromptMode = "minimal" | "focus" | "full"
const modes: MendPromptMode[] = ["minimal", "focus", "full"]

type PromptModeState = { mode: MendPromptMode; live: "runtime-run-chat"; note: string }

const live: PromptModeState["live"] = "runtime-run-chat"
const note = "Persisted prompt mode is consumed by mendcode run/chat and shown by the MendCode TUI footer."

export async function readPromptMode(root?: string): Promise<PromptModeState> {
  const paths = mendPaths(root)
  const projected = await activeMendPackageProjection(paths.root).catch(() => undefined)
  const packageMode = normalizePromptMode(projected?.runtimePacks.findLast((pack) => normalizePromptMode(pack.prompts?.mode))
    ?.prompts.mode)
  if (packageMode) return { mode: packageMode, live, note }
  try {
    const parsed = JSON.parse(await readFile(paths.promptMode, "utf8"))
    const mode = normalizePromptMode(parsed.mode)
    if (mode) return { mode, live, note }
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

function normalizePromptMode(mode: unknown): MendPromptMode | null {
  if (mode === "minimal" || mode === "focus" || mode === "full") return mode
  if (mode === "dev-js") return "full"
  return null
}
