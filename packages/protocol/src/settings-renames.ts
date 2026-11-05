/**
 * Settings names that were renamed. A saved or patched old name reads as the new one (the new name wins when both are
 * present) and is written as the new one, so installations and clients of an older version keep working.
 */
export const RENAMED_SETTINGS: Readonly<Record<string, string>> = {
  /** The areas of folders were `profiles` before profiles meant what packages were. */
  profiles: "areas",
  disabledPackages: "disabledProfiles",
  disabledPackageResources: "disabledProfileResources",
}

/** The same for the ids inside `features`. */
export const RENAMED_FEATURES: Readonly<Record<string, string>> = {
  packages: "profiles",
  package_tools: "profile_tools",
  package_capabilities: "profile_capabilities",
  official_packages: "official_profiles",
}

/** The same for the names inside `tools` (a tool switched on or off by name). */
export const RENAMED_TOOLS: Readonly<Record<string, string>> = { packages: "profiles" }

function renameKeys(raw: Record<string, unknown>, renames: Readonly<Record<string, string>>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) if (!Object.hasOwn(renames, key)) out[key] = value
  for (const [key, value] of Object.entries(raw)) {
    const now = renames[key]
    if (now !== undefined && !Object.hasOwn(out, now)) out[now] = value
  }
  return out
}

/** `raw` (saved settings or a patch) with every renamed key, also inside `features` and `tools`, under its current name. */
export function currentSettingKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const out = renameKeys(raw, RENAMED_SETTINGS)
  for (const [key, renames] of [["features", RENAMED_FEATURES], ["tools", RENAMED_TOOLS]] as const) {
    const value = out[key]
    if (value && typeof value === "object" && !Array.isArray(value)) out[key] = renameKeys(value as Record<string, unknown>, renames)
  }
  return out
}
