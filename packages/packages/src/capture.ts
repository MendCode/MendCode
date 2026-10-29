import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { activationProblems, TUI_DEFAULTS } from "@mendcode/protocol/wire"
import { PackageError } from "./install"
import { MANIFEST_FILE } from "./manifest"

/** Profile keys that record what the user has done, not how MendCode looks: never part of a captured look. */
const STATE_KEYS = new Set(["tutorialDone"])

/**
 * The stored terminal profile as a package's `activate.tuiProfile`: every look key the profile holds, without the keys a package
 * may not set (launch settings, clipboard, notifications) and without state. A key the activation check still refuses is left
 * out rather than failing the capture; a look over the activation size limit fails with that reason. `skipped` names the left-out
 * keys the user had changed from their default.
 */
export function capturedProfile(profile: Record<string, unknown>): { tuiProfile: Record<string, unknown>; skipped: string[] } {
  let tuiProfile = Object.fromEntries(Object.entries(profile).filter(([key]) => key in TUI_DEFAULTS && !STATE_KEYS.has(key)))
  const skipped = Object.keys(profile).filter((key) => !(key in tuiProfile))
  const refused = new Set(activationProblems({ tuiProfile }).map((line) => /^activate\.tuiProfile\.(\w+)/.exec(line)?.[1]).filter((key): key is string => key !== undefined))
  tuiProfile = Object.fromEntries(Object.entries(tuiProfile).filter(([key]) => !refused.has(key)))
  const problems = activationProblems({ tuiProfile })
  if (problems.length) throw new PackageError(`the look cannot be captured: ${problems[0]}`)
  // Only what the user changed is worth naming: a left-out key still at its default loses nothing.
  const changed = (key: string) => JSON.stringify(profile[key]) !== JSON.stringify(TUI_DEFAULTS[key])
  return { tuiProfile, skipped: [...new Set([...skipped, ...refused])].filter(changed).sort() }
}

/** Writes a package folder holding only the captured look, under `userDir`; the caller installs it and then calls `cleanup`. */
export function stageCapturedLook(input: { userDir: string; name: string; profile: Record<string, unknown> }): { dir: string; skipped: string[]; cleanup(): void } {
  const { tuiProfile, skipped } = capturedProfile(input.profile)
  const dir = mkdtempSync(path.join(input.userDir, ".package-capture-"))
  const manifest = { name: input.name, version: "0.1.0", description: `Look captured from the terminal profile (${Object.keys(tuiProfile).length} keys)`, activate: { tuiProfile } }
  writeFileSync(path.join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  return { dir, skipped, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
