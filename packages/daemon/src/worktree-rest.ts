import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, realpathSync, renameSync } from "node:fs"
import path from "node:path"
import type { ProjectRestInfo } from "@mendcode/protocol"
import { killProcessTree } from "@mendcode/tools"
import { createWorktreeManager } from "./worktrees"
import { defaultBranch, projectGit, ProjectRestError } from "./project-git"

export function createRestWorktrees(input: {
  dir: string
  manager: ReturnType<typeof createWorktreeManager>
  save(project: ProjectRestInfo): void
  occupied(directory: string): boolean
}) {
  async function startup(directory: string, commands: string[], signal: AbortSignal) {
    for (const command of commands.filter((value) => value.trim())) {
      if (signal.aborted) throw new ProjectRestError("busy", "Request cancelled")
      const child = Bun.spawn([process.platform === "win32" ? "cmd.exe" : "/bin/sh", process.platform === "win32" ? "/c" : "-c", command], { cwd: directory, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: process.platform !== "win32" })
      const stop = () => killProcessTree({ pid: child.pid, signal: "SIGKILL", fallback: (name) => { try { child.kill(name) } catch { /* already gone */ } } })
      const timer = setTimeout(stop, 30_000)
      signal.addEventListener("abort", stop, { once: true })
      try { if (await child.exited !== 0) throw new ProjectRestError("invalid_command", "Startup failed; worktree retained") }
      finally { stop(); clearTimeout(timer); signal.removeEventListener("abort", stop) }
    }
  }
  async function target(project: ProjectRestInfo, directory: string, value: string, signal: AbortSignal) {
    const resolved = realpathSync(value)
    if (!project.sandboxes.includes(resolved)) throw new ProjectRestError("target_mismatch", "Only daemon-created worktrees can be changed")
    const preview = (await input.manager.query(directory, { operation: "reset", target: resolved })).preview
    if (!preview || preview.blocked) throw new ProjectRestError("busy", "Worktree must be clean, available and owned; base checkout is protected")
    if (input.occupied(resolved)) throw new ProjectRestError("busy", "Worktree has sessions or active automation")
    if (!(await projectGit(resolved, ["status", "--porcelain", "--untracked-files=all", "--ignored=matching"], signal)).out) return preview.target
    throw new ProjectRestError("busy", "Worktree contains changes or ignored files")
  }
  return {
    /** `branch` (a full branch name) and `base` (the ref it starts from, for a stacked change) are internal: the REST payload does not carry them. */
    async create(project: ProjectRestInfo, directory: string, values: { name?: string | undefined; branch?: string | undefined; base?: string | undefined; startCommand?: string | undefined; runStartup?: boolean | undefined }, signal: AbortSignal) {
      if (!project.vcs) throw new ProjectRestError("invalid_command", "Worktrees require Git")
      if (project.sandboxes.length >= 500) throw new ProjectRestError("busy", "Worktree limit reached")
      if (values.startCommand?.trim() && !values.runStartup) throw new ProjectRestError("unsupported", "Startup commands require runStartup: true")
      const slug = values.name?.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || `work-${randomBytes(4).toString("hex")}`
      if (slug === "." || slug === "..") throw new ProjectRestError("invalid_command", "Invalid worktree name")
      let preview
      for (let attempt = 0; attempt < 10; attempt++) {
        const name = attempt ? `${slug}-${randomBytes(3).toString("hex")}` : slug
        const report = await input.manager.query(directory, { operation: "preview", input: { name, ...(values.branch ? { branch: values.branch } : {}), ...(values.base ? { base: values.base } : {}) } })
        if (report.preview && !report.preview.blocked) { preview = report.preview; break }
        if (values.branch && report.preview?.blockReasons.includes("Branch already exists")) throw new ProjectRestError("busy", `Branch ${values.branch} already exists`)
        if (report.preview?.blockReasons.some((reason) => reason === "Base ref does not resolve to a commit")) throw new ProjectRestError("invalid_command", `Base ${values.base ?? "HEAD"} does not resolve to a commit`)
        if (report.preview?.blockReasons.includes("Invalid branch name")) throw new ProjectRestError("invalid_command", `Invalid branch name ${values.branch ?? ""}`)
        if (!report.preview || report.preview.blockReasons.some((reason) => !["Branch already exists", "Target path already exists"].includes(reason))) throw new ProjectRestError("invalid_command", "Cannot create worktree; a valid Git HEAD is required")
      }
      if (!preview) throw new ProjectRestError("busy", "Worktree name is occupied")
      const record = preview.target
      mkdirSync(path.dirname(record.path), { recursive: true, mode: 0o700 })
      // Checkout is synchronous: clients never receive a directory with an empty index.
      const result = await projectGit(directory, ["worktree", "add", "-b", record.branch!, record.path, ...(values.base ? [values.base] : [])], signal)
      if (!result.ok) throw new ProjectRestError("invalid_command", "Git worktree creation failed")
      project.sandboxes = [...project.sandboxes, realpathSync(record.path)]
      input.save(project)
      await input.manager.change(directory, { operation: "adopt", target: record.path })
      if (values.runStartup) await startup(record.path, [project.commands?.start ?? "", values.startCommand ?? ""], signal)
      return { name: path.basename(record.path), branch: record.branch!, directory: record.path }
    },
    async remove(project: ProjectRestInfo, directory: string, value: string, signal: AbortSignal) {
      const record = await target(project, directory, value, signal)
      if (record.branch && !(await projectGit(directory, ["merge-base", "--is-ancestor", record.branch, "HEAD"], signal)).ok) throw new ProjectRestError("busy", "Worktree branch has unmerged commits")
      const trash = path.join(input.dir, "trash", "worktrees", `${path.basename(record.path)}-${randomBytes(6).toString("hex")}`)
      mkdirSync(path.dirname(trash), { recursive: true, mode: 0o700 })
      renameSync(record.path, trash)
      const removed = await projectGit(directory, ["worktree", "remove", "--force", record.path], signal)
      if (!removed.ok) {
        if (!existsSync(record.path)) renameSync(trash, record.path)
        throw new ProjectRestError("invalid_command", "Git worktree removal failed")
      }
      project.sandboxes = project.sandboxes.filter((item) => item !== record.path)
      input.save(project)
      if (record.branch && !(await projectGit(directory, ["branch", "-d", "--", record.branch], signal)).ok) throw new ProjectRestError("busy", "Worktree retained in Trash; branch cleanup requires review")
      return true
    },
    async reset(project: ProjectRestInfo, directory: string, value: string, signal: AbortSignal) {
      const record = await target(project, directory, value, signal)
      const base = await defaultBranch(directory, signal)
      if (!base) throw new ProjectRestError("invalid_command", "Default branch unavailable")
      if (record.branch === base.name) throw new ProjectRestError("busy", "Default branch is protected")
      const previous = await projectGit(record.path, ["rev-parse", "HEAD"], signal)
      // Preserve committed work before moving the branch; dirty/ignored files never reach reset.
      const backup = `refs/mendcode/worktree-backups/${randomBytes(12).toString("hex")}`
      if (!previous.ok || !(await projectGit(record.path, ["update-ref", backup, previous.out], signal)).ok) throw new ProjectRestError("invalid_command", "Could not preserve worktree HEAD")
      if (!(await projectGit(record.path, ["reset", "--hard", base.ref], signal)).ok) throw new ProjectRestError("invalid_command", "Git worktree reset failed")
      return true
    },
  }
}
