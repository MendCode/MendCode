import { LocalContext } from "@/util/local-context"
import { AppFileSystem } from "@mendcode/core/filesystem"
import type * as Project from "./project"

export interface InstanceContext {
  directory: string
  worktree: string
  project: Project.Info
}

export const context = LocalContext.create<InstanceContext>("instance")

/**
 * Check if a path is within the project boundary.
 * Returns true if path is inside ctx.directory OR ctx.worktree.
 * Paths within the worktree but outside the working directory should not trigger external_directory permission.
 */
export function containsPath(filepath: string, ctx: InstanceContext): boolean {
  const target = AppFileSystem.resolve(filepath)
  const directory = AppFileSystem.resolve(ctx.directory)
  if (AppFileSystem.contains(directory, target)) return true
  // Non-git projects set worktree to "/" which would match ANY absolute path.
  // Skip worktree check in this case to preserve external_directory permissions.
  const worktree = AppFileSystem.resolve(ctx.worktree)
  if (worktree === "/") return false
  return AppFileSystem.contains(worktree, target)
}
