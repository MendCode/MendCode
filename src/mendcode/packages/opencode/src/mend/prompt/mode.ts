import { mkdir, readFile, writeFile } from "fs/promises"
import path from "path"
import { mendPaths } from "../config/paths"
import { CUSTOM_PROMPT_RELATIVE_PATH, readCustomPrompt, type CustomPromptResolution } from "./custom"
import { activeMendPackageProjection } from "../runtime/packages"

export type MendPromptMode = "minimal" | "focus" | "full" | "custom"
export const promptModePresets: MendPromptMode[] = ["minimal", "focus", "full"]
const modes: MendPromptMode[] = [...promptModePresets, "custom"]

export type PromptModeState = {
  mode: MendPromptMode
  live: "runtime-run-chat"
  note: string
  source: "preset" | "project-custom"
  customPrompt: CustomPromptResolution
}

const live: PromptModeState["live"] = "runtime-run-chat"
const note = "Persisted prompt mode is consumed by mendcode run/chat and shown by the MendCode TUI footer."

function state(mode: MendPromptMode, customPrompt: CustomPromptResolution): PromptModeState {
  return {
    mode,
    live,
    note,
    source: mode === "custom" ? "project-custom" : "preset",
    customPrompt,
  }
}

export function promptModeLabel(state: Pick<PromptModeState, "mode" | "customPrompt">) {
  if (state.mode === "custom") return state.customPrompt.name || "Project prompt"
  return state.mode.charAt(0).toUpperCase() + state.mode.slice(1)
}

export async function readPromptMode(root?: string): Promise<PromptModeState> {
  const paths = mendPaths(root)
  const projected = await activeMendPackageProjection(paths.root).catch(() => undefined)
  const packageEntry = projected?.runtimePacks
    .map((pack, index) => ({ pack, root: projected.runtimePackRoots[index] }))
    .findLast(({ pack }) => normalizePromptMode(pack.prompts?.mode))
  const packageMode = normalizePromptMode(packageEntry?.pack.prompts?.mode)
  const packageCustomTemplate = packageEntry?.pack.prompts?.templates.find(
    (file) => file.split(path.sep).join(path.posix.sep) === CUSTOM_PROMPT_RELATIVE_PATH,
  )
  let persistedMode: MendPromptMode | undefined
  try {
    const parsed = JSON.parse(await readFile(paths.promptMode, "utf8"))
    persistedMode = normalizePromptMode(parsed.mode) ?? undefined
  } catch {}
  const customPrompt = await readCustomPrompt(
    paths.root,
    packageMode === "custom"
      ? packageCustomTemplate && packageEntry?.root
        ? path.join(packageEntry.root, CUSTOM_PROMPT_RELATIVE_PATH)
        : null
      : undefined,
  )
  return state(persistedMode ?? packageMode ?? "focus", customPrompt)
}

export async function availablePromptModes(root?: string) {
  const current = await readPromptMode(root)
  return current.customPrompt.available ? [...promptModePresets, "custom" as const] : promptModePresets
}

export async function cyclePromptMode(root?: string) {
  const current = await readPromptMode(root)
  const available = await availablePromptModes(root)
  const currentIndex = available.indexOf(current.mode)
  const next = available[(currentIndex + 1) % available.length] ?? "focus"
  return writePromptMode(next, root)
}

export async function writePromptMode(mode: string, root?: string) {
  if (!modes.includes(mode as MendPromptMode)) throw new Error(`prompt mode must be one of: ${modes.join(", ")}`)
  const paths = mendPaths(root)
  await mkdir(path.dirname(paths.promptMode), { recursive: true })
  await writeFile(
    paths.promptMode,
    `${JSON.stringify({ version: 1, mode, updatedAt: new Date().toISOString(), live, note }, null, 2)}\n`,
  )
  return readPromptMode(root)
}

function normalizePromptMode(mode: unknown): MendPromptMode | null {
  if (mode === "minimal" || mode === "focus" || mode === "full" || mode === "custom") return mode
  if (mode === "dev-js") return "full"
  return null
}
