import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export const OWNER_MARKER = ".mcev-owned"

/** Removes one run's state directory: it must be a direct child of a directory the kit marked as its own. */
export function removeOwnedChild(root: string, child: string): void {
  const parent = path.resolve(root)
  const target = path.resolve(child)
  if (path.dirname(target) !== parent || !existsSync(path.join(parent, OWNER_MARKER))) throw new Error(`[SAFETY]: refusing to remove ${target}: not a run directory of a kit-owned root`)
  rmSync(target, { recursive: true, force: true })
}

/** Directories the kit must never use as state: the operator's real product, Codex, pi and Claude data. */
function forbiddenRoots(home = homedir()): string[] {
  return [".mendcode", ".mendcode-v2", ".mendcode-v1", ".codex", ".pi", ".claude", ".config", ".local", ".ssh", "mc2-prueba", "Library"].map((name) => path.join(home, name))
}

const isInside = (child: string, parent: string) => child === parent || child.startsWith(`${parent}${path.sep}`)

/** Throws when `dir` is (or sits inside) real user state, or is a non-empty directory the kit did not create. */
export function assertSafeStateRoot(dir: string, home = homedir()): string {
  const resolved = path.resolve(dir)
  const real = existsSync(resolved) ? realpathSync(resolved) : resolved
  for (const forbidden of forbiddenRoots(home)) {
    if (isInside(resolved, forbidden) || isInside(real, forbidden)) throw new Error(`[SAFETY]: ${resolved} is inside ${forbidden}; use a dedicated empty directory`)
  }
  if (resolved === path.resolve(home) || resolved === path.parse(resolved).root) throw new Error(`[SAFETY]: ${resolved} is not a dedicated directory`)
  if (existsSync(resolved)) {
    const entries = readdirSync(resolved)
    if (entries.length > 0 && !entries.includes(OWNER_MARKER)) throw new Error(`[SAFETY]: ${resolved} is not empty and was not created by this kit; pass an empty directory`)
  }
  mkdirSync(resolved, { recursive: true, mode: 0o700 })
  writeFileSync(path.join(resolved, OWNER_MARKER), "created by the harness evaluation kit\n", { flag: "a" })
  return resolved
}
