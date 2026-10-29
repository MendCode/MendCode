import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs"
import path from "node:path"

/** Derived output files stay in an owner-only real directory under the selected data root. */
export function outputDirectory(dir: string, name: string, create = false): string | undefined {
  if (create) mkdirSync(dir, { recursive: true, mode: 0o700 })
  let root: string
  try { root = realpathSync(dir) } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  const directory = path.join(root, name)
  try { lstatSync(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    if (!create) return undefined
    mkdirSync(directory, { mode: 0o700 })
  }
  const info = lstatSync(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(directory) !== directory) throw new Error("Output storage must be a real directory")
  if (create) chmodSync(directory, 0o700)
  return path.join(dir, name)
}
