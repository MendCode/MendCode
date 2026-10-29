import { existsSync, lstatSync, readFileSync } from "node:fs"
import path from "node:path"
import { ACTIVATION_STATE_FILE, activationProblems, parseActivationState, resolveActivation, type Activation, type ActivationPackage, type ActivationResult, type ActivationScope, type ActivationState } from "@mendcode/protocol/wire"
import { SIDEBAR_PRESETS, panelPreset } from "../view/sidebar-spec"
import { parseKeybindings, type KeybindingEntry } from "./keybindings"
import type { ActivationManifest } from "./discover"

/**
 * The terminal's half of package activation: reads the enabled packages' `activate` sections and `activation.json`, and combines them
 * with the pure `resolveActivation` the daemon uses for its reports. Loaded with a dynamic import and only when an enabled package
 * declares an activation, so a terminal without any never parses this module (docs/packages.md, apps/cli/test/footprint.test.ts).
 * Nothing here writes: the overlay is computed each time, so removing a package removes it.
 */

const MAX_KEYBINDINGS_BYTES = 64 * 1024

export type TuiActivation = {
  result: ActivationResult
  /** Keybinding entries of the packages, merged (later package wins), in the format of `keybindings.json`. */
  keybindings: KeybindingEntry[]
  /** Why a package's activation (or keybindings file) was not used; shown in /help and /packages. */
  problems: string[]
}

const stateFile = (input: { dataDir: string; directory?: string | undefined }, scope: ActivationScope) => scope === "user" ? path.join(input.dataDir, ACTIVATION_STATE_FILE) : path.join(input.directory ?? "", ".mendcode", ACTIVATION_STATE_FILE)

export function readActivationState(input: { dataDir: string; directory?: string | undefined }, scope: ActivationScope): ActivationState {
  try {
    const file = stateFile(input, scope)
    return existsSync(file) ? parseActivationState(JSON.parse(readFileSync(file, "utf8"))) : parseActivationState(undefined)
  } catch {
    return parseActivationState(undefined)
  }
}

function readKeybindingsFile(dir: string, relative: string): Record<string, string | null> | { problem: string } {
  const file = path.join(dir, relative)
  const info = lstatSync(file, { throwIfNoEntry: false })
  if (!info?.isFile()) return { problem: `${relative} is missing or not a regular file` }
  if (info.size > MAX_KEYBINDINGS_BYTES) return { problem: `${relative} is larger than ${MAX_KEYBINDINGS_BYTES / 1024} KB` }
  try {
    const json: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (typeof json !== "object" || json === null || Array.isArray(json)) return { problem: `${relative} is not an object of "key": "action"` }
    return Object.fromEntries(Object.entries(json).filter((entry): entry is [string, string | null] => entry[1] === null || typeof entry[1] === "string"))
  } catch {
    return { problem: `${relative} is not valid JSON` }
  }
}

const panel = (name: string): Record<string, unknown> | undefined => {
  const preset = panelPreset(name)
  return preset ? { sidebarWidgets: structuredClone(SIDEBAR_PRESETS[preset]) } : undefined
}

/** `base` is the user's stored profile (plain JSON): what each overridden key was. */
export function loadActivation(input: { manifests: readonly ActivationManifest[]; dataDir: string; directory?: string | undefined; projectTrusted: boolean; base: Record<string, unknown> }): TuiActivation {
  const problems: string[] = []
  const packages: ActivationPackage[] = []
  for (const entry of input.manifests) {
    const bad = activationProblems(entry.manifest.activate)
    if (bad.length) { problems.push(`${entry.key}: ${bad[0]}${bad.length > 1 ? ` (+${bad.length - 1} more)` : ""}; its activation is ignored`); continue }
    const activation = entry.manifest.activate as Activation
    let keybindings: Record<string, string | null> | undefined
    if (activation.keybindings) {
      const read = readKeybindingsFile(entry.dir, activation.keybindings)
      if ("problem" in read) problems.push(`${entry.key}: ${read.problem}`)
      else keybindings = read
    }
    packages.push({ key: entry.key, scope: entry.source, activation, ...(keybindings ? { keybindings } : {}) })
  }
  const result = resolveActivation({
    packages,
    state: { user: readActivationState(input, "user"), project: readActivationState(input, "project") },
    projectTrusted: input.projectTrusted,
    base: input.base,
    panel,
  })
  const merged: Record<string, string | null> = {}
  for (const entry of result.keybindings) merged[entry.spec] = entry.action
  const parsed = parseKeybindings(JSON.stringify(merged))
  return { result, keybindings: parsed.entries, problems: [...problems, ...parsed.problems.map((line) => `packages: ${line}`)] }
}
