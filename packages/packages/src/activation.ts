import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { ACTIVATION_STATE_FILE, activationProblems, activationStateJson, describeChanges, EMPTY_ACTIVATION_STATE, hasLook, lookOwner, parseActivationState, resolveActivation, type Activation, type ActivationPackage, type ActivationResult, type ActivationScope, type ActivationState } from "@mendcode/protocol/wire"
import { scopeBase } from "./layers"
import { PackageError } from "./install"
import { listPackages, type PackageInfo } from "./manifest"

/**
 * The daemon's half of package activation (docs/packages.md): who owns the look of each scope, and what an enabled package overrides.
 * The activation itself is applied by the terminal, from the same manifests, through the same pure `resolveActivation`; nothing
 * here writes into the user's settings, profile or keybindings. The only state is `<scope folder>/activation.json`:
 * the owner of the look, and (user scope) the keys the user chose by hand after activation.
 */

const MAX_KEYBINDINGS_BYTES = 64 * 1024

export const activationStatePath = (input: { scope: ActivationScope; userDir: string; directory: string }) => path.join(scopeBase({ source: input.scope, userDir: input.userDir, directory: input.directory }), ACTIVATION_STATE_FILE)

export function readActivationState(input: { scope: ActivationScope; userDir: string; directory: string }): ActivationState {
  try {
    const file = activationStatePath(input)
    return existsSync(file) ? parseActivationState(JSON.parse(readFileSync(file, "utf8"))) : EMPTY_ACTIVATION_STATE
  } catch {
    return EMPTY_ACTIVATION_STATE
  }
}

/** Writes the state whole (temp file, then rename); an empty state removes the file's content to the bare minimum. */
export function writeActivationState(input: { scope: ActivationScope; userDir: string; directory: string; state: ActivationState }) {
  const file = activationStatePath(input)
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, activationStateJson(input.state))
  renameSync(temporary, file)
}

/** The activation a package declares, or undefined when it has none or it is invalid (an invalid one never applies; `package check` says why). */
export function activationOf(pkg: Pick<PackageInfo, "manifest">): Activation | undefined {
  const raw = pkg.manifest?.activate
  return raw !== undefined && activationProblems(raw).length === 0 ? raw as Activation : undefined
}

/** A package's keybindings file as `{ key: action | null }`; undefined when it is missing, linked, too large or not an object. */
export function readPackageKeybindings(dir: string, relative: string): Record<string, string | null> | undefined {
  const file = path.join(dir, relative)
  const info = lstatSync(file, { throwIfNoEntry: false })
  if (!info?.isFile() || info.size > MAX_KEYBINDINGS_BYTES || path.relative(dir, file).startsWith("..")) return undefined
  try {
    const json: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (typeof json !== "object" || json === null || Array.isArray(json)) return undefined
    return Object.fromEntries(Object.entries(json).filter((entry): entry is [string, string | null] => entry[1] === null || typeof entry[1] === "string"))
  } catch {
    return undefined
  }
}

/** Enabled packages that declare an activation, lowest precedence first (user packages, then project packages). */
export function activationPackages(input: { userDir: string; directory: string; disabled?: readonly string[] }): Array<ActivationPackage & { info: PackageInfo }> {
  const out: Array<ActivationPackage & { info: PackageInfo }> = []
  for (const info of listPackages(input)) {
    const activation = info.enabled ? activationOf(info) : undefined
    if (!activation) continue
    const keybindings = activation.keybindings ? readPackageKeybindings(info.dir, activation.keybindings) : undefined
    out.push({ key: info.key, scope: info.source, activation, ...(keybindings ? { keybindings } : {}), info })
  }
  return out
}

/** The user's stored terminal profile as plain JSON (for reports: "was X, becomes Y"). */
export function readStoredProfile(userDir: string): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(path.join(userDir, "tui", "profile.json"), "utf8"))
    return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** What every enabled package currently overrides, per key, with who owns the look; the daemon-side twin of what the terminal applies. */
export function describeActivation(input: { userDir: string; directory: string; disabled?: readonly string[]; projectTrusted: boolean; panel?: (name: string) => Record<string, unknown> | undefined }): ActivationResult {
  return resolveActivation({
    packages: activationPackages(input),
    state: { user: readActivationState({ scope: "user", userDir: input.userDir, directory: input.directory }), project: readActivationState({ scope: "project", userDir: input.userDir, directory: input.directory }) },
    projectTrusted: input.projectTrusted,
    base: readStoredProfile(input.userDir),
    panel: input.panel ?? (() => undefined),
  })
}

/** Another package owns the look: the CLI and the terminal show this and ask before replacing it. */
export class LookOwnedError extends PackageError {
  constructor(readonly owner: string, readonly key: string, readonly changes: readonly string[], readonly exclusive = false) {
    super(`${owner} owns the look; enabling ${key} replaces it${exclusive ? ` and switches ${owner} off (both set the tier)` : ""}${changes.length ? ` (${changes.join("; ")})` : ""}. Run again with --switch to replace it`)
  }
}

/**
 * Enabling `key`: when it brings a look, it becomes the owner of its scope. Another enabled package that already owns the look is
 * replaced only with `switch`; otherwise this throws `LookOwnedError` listing what would change. A package with no look
 * (only keybindings or prompt files) claims nothing. The user's "kept" choices reset: they were made against another look.
 */
export function claimLook(input: { userDir: string; directory: string; key: string; switch?: boolean; disabled?: readonly string[] }): { claimed: boolean; replaced?: string; /** The replaced owner the caller must disable. */ off?: string } {
  const packages = listPackages({ userDir: input.userDir, directory: input.directory, disabled: input.disabled ?? [] })
  const target = packages.find((pkg) => pkg.key === input.key)
  const activation = target ? activationOf(target) : undefined
  if (!target || !activation || !hasLook(activation)) return { claimed: false }
  const scope = target.source
  const others = packages.filter((pkg) => pkg.source === scope && pkg.enabled && pkg.key !== input.key && pkg.manifest && activationOf(pkg) && hasLook(activationOf(pkg)!))
  const state = readActivationState({ scope, userDir: input.userDir, directory: input.directory })
  const current = lookOwner(others.map((pkg) => pkg.key), state.look)
  // A package that sets the tier is a whole setup, and two setups cannot both hold: the one replaced goes off, with its skills and tools.
  const owner = others.find((pkg) => pkg.key === current)
  const exclusive = Boolean(activation.tier && owner && activationOf(owner)?.tier)
  if (current && !input.switch) throw new LookOwnedError(current, input.key, describeChanges(activation, readStoredProfile(input.userDir), () => undefined), exclusive)
  // `kept` is stored with the set of owners it was made under (`keptFor`), so it stops counting by itself when an owner changes.
  writeActivationState({ scope, userDir: input.userDir, directory: input.directory, state: { ...state, look: input.key } })
  return { claimed: true, ...(current ? { replaced: current } : {}), ...(current && exclusive ? { off: current } : {}) }
}

/** `key` stops being enabled or installed: if it owned the look the scope has no recorded owner, so the next enabled package with a look (if any) takes it, else the look is the user's own again. */
export function releaseLook(input: { userDir: string; directory: string; key: string }): boolean {
  const scope: ActivationScope = input.key.startsWith("project:") ? "project" : "user"
  const state = readActivationState({ scope, userDir: input.userDir, directory: input.directory })
  if (state.look !== input.key) return false
  const { look: _released, ...rest } = state
  writeActivationState({ scope, userDir: input.userDir, directory: input.directory, state: rest })
  return true
}
