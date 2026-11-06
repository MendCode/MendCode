import { homedir } from "node:os"
import { canonicalDir } from "@mendcode/tools"
import { DEFAULT_AREA, areaFor, type ModelRoles, type Area, type Settings } from "@mendcode/protocol"

/** The area a directory belongs to (by its folders), `personal` outside every area. */
export function areaOf(settings: Settings, directory: string | undefined): string {
  return areaFor(directory, settings.areas, homedir())
}

function areaEntry(settings: Settings, directory: string | undefined): Area | undefined {
  const name = areaOf(settings, directory)
  return name === DEFAULT_AREA ? undefined : settings.areas?.find((area) => area.name === name)
}

/** Model roles for work in `directory`: the area's own roles when it has them, else the top-level ones. */
export function rolesFor(settings: Settings, directory: string | undefined): ModelRoles {
  const roles = areaEntry(settings, directory)?.models ?? settings.models ?? {}
  const project = directory ? settings.projectConfig?.[canonicalDir(directory)]?.models : undefined
  return project ? { ...roles, ...project } : roles
}

/** Permission mode for a new session in `directory`: the area's, else the top-level default. */
export function defaultPermissionFor(settings: Settings, directory: string | undefined): Settings["defaultPermission"] {
  const project = directory ? settings.projectConfig?.[canonicalDir(directory)]?.defaultPermission : undefined
  if (project) return project
  return areaEntry(settings, directory)?.defaultPermission ?? settings.defaultPermission
}

/** Shell program for commands run in `directory`: the project's override, else the top-level `shell`. */
export function shellFor(settings: Settings, directory: string | undefined): string | undefined {
  return (directory ? settings.projectConfig?.[canonicalDir(directory)]?.shell : undefined) ?? settings.shell
}

/** A settings patch that stores `roles` where work in `directory` reads them (its area, or the top level). */
export function rolesPatch(settings: Settings, directory: string | undefined, roles: ModelRoles): Partial<Record<keyof Settings, unknown>> {
  const key = directory ? canonicalDir(directory) : undefined
  if (key && settings.projectConfig?.[key]?.models) return { projectConfig: { ...settings.projectConfig, [key]: { ...settings.projectConfig[key], models: roles } } }
  const name = areaOf(settings, directory)
  const value = Object.keys(roles).length ? roles : undefined
  if (name === DEFAULT_AREA) return { models: value ?? null }
  return {
    areas: (settings.areas ?? []).map((area) => {
      if (area.name !== name) return area
      const { models: _models, ...rest } = area
      return value ? { ...rest, models: value } : rest
    }),
  }
}
