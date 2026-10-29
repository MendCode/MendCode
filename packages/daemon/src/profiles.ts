import { homedir } from "node:os"
import { canonicalDir } from "@mendcode/tools"
import { DEFAULT_PROFILE, profileFor, type ModelRoles, type Profile, type Settings } from "@mendcode/protocol"

/** The profile a directory belongs to (by its folders), `personal` outside every profile. */
export function profileOf(settings: Settings, directory: string | undefined): string {
  return profileFor(directory, settings.profiles, homedir())
}

function profileEntry(settings: Settings, directory: string | undefined): Profile | undefined {
  const name = profileOf(settings, directory)
  return name === DEFAULT_PROFILE ? undefined : settings.profiles?.find((profile) => profile.name === name)
}

/** Model roles for work in `directory`: the profile's own roles when it has them, else the top-level ones. */
export function rolesFor(settings: Settings, directory: string | undefined): ModelRoles {
  const roles = profileEntry(settings, directory)?.models ?? settings.models ?? {}
  const project = directory ? settings.projectConfig?.[canonicalDir(directory)]?.models : undefined
  return project ? { ...roles, ...project } : roles
}

/** Permission mode for a new session in `directory`: the profile's, else the top-level default. */
export function defaultPermissionFor(settings: Settings, directory: string | undefined): Settings["defaultPermission"] {
  const project = directory ? settings.projectConfig?.[canonicalDir(directory)]?.defaultPermission : undefined
  if (project) return project
  return profileEntry(settings, directory)?.defaultPermission ?? settings.defaultPermission
}

/** Shell program for commands run in `directory`: the project's override, else the top-level `shell`. */
export function shellFor(settings: Settings, directory: string | undefined): string | undefined {
  return (directory ? settings.projectConfig?.[canonicalDir(directory)]?.shell : undefined) ?? settings.shell
}

/** A settings patch that stores `roles` where work in `directory` reads them (its profile, or the top level). */
export function rolesPatch(settings: Settings, directory: string | undefined, roles: ModelRoles): Partial<Record<keyof Settings, unknown>> {
  const key = directory ? canonicalDir(directory) : undefined
  if (key && settings.projectConfig?.[key]?.models) return { projectConfig: { ...settings.projectConfig, [key]: { ...settings.projectConfig[key], models: roles } } }
  const name = profileOf(settings, directory)
  const value = Object.keys(roles).length ? roles : undefined
  if (name === DEFAULT_PROFILE) return { models: value ?? null }
  return {
    profiles: (settings.profiles ?? []).map((profile) => {
      if (profile.name !== name) return profile
      const { models: _models, ...rest } = profile
      return value ? { ...rest, models: value } : rest
    }),
  }
}
