import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { DEFAULT_PROFILE, profileFor, redactSecrets } from "@mendcode/protocol/wire"
import type { Settings } from "@mendcode/protocol"
import { projectSources } from "./project-control"

/** One place configuration comes from, lowest precedence first. `entries` are `key` or `key = value`; secret-like keys never show a value. */
export type ConfigLayer = { id: string; label: string; source: string; present: boolean; entries: string[]; note?: string }

export const SECRET_KEY = /key|token|secret|password|authorization|credential|bearer/i
const MAX_ENTRIES = 80
const MAX_VALUE = 60
const PROJECT_FILE = path.join(".mendcode", "project.json")

/** `name = value` for short scalars, `name · n items` or `name · n keys` for structures, and the bare name for anything secret-like. */
function describe(name: string, value: unknown): string {
  if (SECRET_KEY.test(name)) return `${name} · hidden`
  if (typeof value === "boolean" || typeof value === "number") return `${name} = ${value}`
  if (typeof value === "string") return `${name} = ${redactSecrets(value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE)}…` : value).text}`
  if (Array.isArray(value)) return `${name} · ${value.length} item${value.length === 1 ? "" : "s"}`
  if (value && typeof value === "object") return `${name} · ${Object.keys(value).length} key${Object.keys(value).length === 1 ? "" : "s"}`
  return name
}

function entriesOf(record: Record<string, unknown>): string[] {
  const names = Object.keys(record).filter((name) => record[name] !== undefined).sort()
  const shown = names.slice(0, MAX_ENTRIES).map((name) => describe(name, record[name]))
  return names.length > MAX_ENTRIES ? [...shown, `… ${names.length - MAX_ENTRIES} more`] : shown
}

/**
 * The layered view behind `/debug-config`: built-in defaults, the user's saved settings, the profile a folder falls
 * under, the project's own files, then environment overrides. Reads only local files the daemon already owns; no
 * value that looks like a credential is shown, and environment variables list their names only.
 */
export function configLayers(input: { dir: string; directory: string; settings: Settings; environment?: NodeJS.ProcessEnv; home?: string; invalidSettings?: readonly string[] }): { layers: ConfigLayer[]; warnings: string[]; problems: string[] } {
  const environment = input.environment ?? process.env
  const home = input.home ?? homedir()
  const warnings: string[] = []
  /** Configuration the daemon ignored because it is invalid: shown at startup, and fatal under `--strict-config`. Also listed in `warnings`. */
  const problems: string[] = [...(input.invalidSettings ?? [])]
  const layers: ConfigLayer[] = []
  layers.push({ id: "defaults", label: "Built-in defaults", source: "MendCode", present: true, entries: [], note: "everything not set below" })

  const saved = input.settings as Record<string, unknown>
  layers.push({ id: "user", label: "User settings", source: `${path.join(input.dir, "mendd.db")}#settings`, present: Object.keys(saved).length > 0, entries: entriesOf(saved) })

  const profile = profileFor(input.directory, input.settings.profiles, home)
  layers.push({ id: "profile", label: "Profile", source: "settings.profiles", present: profile !== DEFAULT_PROFILE, entries: [`profile = ${profile}`], note: profile === DEFAULT_PROFILE ? "no profile folder contains this directory" : "memories, model roles and default permission follow it" })

  const overlay = (input.settings.projectConfig?.[input.directory] ?? {}) as Record<string, unknown>
  layers.push({ id: "project-settings", label: "Project overrides", source: "settings.projectConfig", present: Object.keys(overlay).length > 0, entries: entriesOf(overlay), note: "models, default permission and default agent for this project" })

  const file = path.join(input.directory, PROJECT_FILE)
  let project: Record<string, unknown> = {}
  let projectNote: string | undefined
  if (existsSync(file)) {
    try {
      if (statSync(file).size > 64 * 1024) throw new Error("larger than 64 KiB")
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object")
      project = parsed as Record<string, unknown>
    } catch (error) {
      projectNote = "ignored: unreadable"
      problems.push(`${PROJECT_FILE}: ${error instanceof Error ? redactSecrets(error.message).text.slice(0, 200) : "unreadable"}`)
    }
  }
  layers.push({ id: "project", label: "Project file", source: file, present: existsSync(file), entries: entriesOf(project), ...(projectNote ? { note: projectNote } : {}) })

  if (!projectNote) {
    try { for (const blocked of projectSources(input.directory, input.settings).blocked) warnings.push(`${blocked.path}: ${blocked.reason}`) }
    catch (error) { problems.push(`project sources: ${error instanceof Error ? redactSecrets(error.message).text.slice(0, 200) : "invalid"}`) }
  }
  warnings.unshift(...problems)

  const names = Object.keys(environment).filter((name) => name.startsWith("MENDCODE_") && environment[name] !== undefined).sort()
  layers.push({ id: "environment", label: "Environment", source: "MENDCODE_*", present: names.length > 0, entries: names, note: "names only; values are never shown" })

  const experimental = Object.entries(input.settings.experimental ?? {}).filter(([, value]) => value === true).map(([name]) => name)
  if (experimental.length) warnings.push(`experimental flags on: ${experimental.join(", ")}`)
  if (input.settings.serviceTier === "fast") warnings.push("service tier fast: priority processing is billed at a higher rate")
  return { layers, warnings, problems }
}
