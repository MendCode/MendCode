import path from "node:path"
import { randomBytes } from "node:crypto"
import type { ProjectRestInput, RestWorkspaceInfo, SessionId, Settings } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"
import type { WorktreeMove, WorktreePort } from "@mendcode/tools"
import { readGitBranch } from "./git-branch"

/** What the port needs of the project service; `createProjectRest` provides both. */
export type WorktreeHost = {
  run(directory: string, request: ProjectRestInput, signal: AbortSignal): Promise<Record<string, unknown>>
  warpInTurn(input: { directory: string; sessionId: SessionId; workspaceId: string | null; signal: AbortSignal }): Promise<void>
}

const failed = (message: string): WorktreeMove => ({ ok: false, message })
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))
const slugOf = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
const TYPE = /^[a-z][a-z0-9-]{0,19}$/
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/
const DEFAULT_PREFIX = "mend/"

/** How the `worktreeBranch` setting says a new worktree's branch is named, for the model to read in `status`. */
export function branchNamingText(naming: Settings["worktreeBranch"]) {
  const mode = naming?.mode ?? "static"
  if (mode === "semantic") return "Branch naming: choose a short type for branch (such as fix, feat, chore or docs); the branch is <type>/<name>."
  if (mode === "custom") return `Branch naming: name the whole branch yourself in branch.${naming?.instruction ? ` Instruction from the user: ${JSON.stringify(naming.instruction)}` : ""}`
  return `Branch naming: ${naming?.prefix ?? DEFAULT_PREFIX}<name> (branch is ignored).`
}

/**
 * The name and branch a new worktree gets under the `worktreeBranch` rules: `static` always `<prefix><name>`, `semantic` the
 * model's type as the prefix, `custom` the branch the model named. The default (`mend/<name>`) is left to the project
 * service, so nothing changes for a user who never set the option.
 */
export function worktreeNames({ naming, name, branch }: { naming: Settings["worktreeBranch"]; name?: string | undefined; branch?: string | undefined }): { ok: true; name: string; branch?: string; note?: string } | { ok: false; message: string } {
  const mode = naming?.mode ?? "static"
  const slug = slugOf(name ?? "") || `work-${randomBytes(4).toString("hex")}`
  if (slug === "." || slug === "..") return { ok: false, message: "invalid worktree name" }
  const prefix = naming?.prefix ?? DEFAULT_PREFIX
  const fallback = prefix === DEFAULT_PREFIX ? { ok: true as const, name: slug } : { ok: true as const, name: slug, branch: `${prefix}${slug}` }
  const wanted = branch?.trim()
  if (mode === "semantic") {
    const type = wanted?.replace(/\/+$/, "").toLowerCase()
    if (!type) return { ...fallback, note: "no branch type was given, so the static prefix was used" }
    if (!TYPE.test(type)) return { ok: false, message: "branch must be a short type such as fix, feat or chore (lowercase letters, digits, dashes)" }
    return { ok: true, name: slug, branch: `${type}/${slug}` }
  }
  if (mode === "custom") {
    if (!wanted) return { ...fallback, note: "no branch name was given, so the static prefix was used" }
    if (!BRANCH.test(wanted) || wanted.includes("..") || wanted.endsWith("/") || wanted.endsWith(".lock") || wanted.includes("//")) return { ok: false, message: "branch is not a valid branch name" }
    return { ok: true, name: slug, branch: wanted }
  }
  return fallback
}

/**
 * The `worktree` tool for one session. A worktree is a workspace of the project (the one `/warp` lists): `enter` creates
 * it with `workspace-create` and moves the session into it while its turn runs, `exit` moves back to the checkout and,
 * when asked, removes the worktree under the same safety rules as `/warp` (clean, merged, no other session in it).
 * Only a main session moves; its children, background commands and goals must be settled (the move refuses otherwise).
 */
export function createWorktreePort({ sessionId, store, host, dataDir, settings = () => ({}), signal = new AbortController().signal }: { sessionId: SessionId; store: Store; host: WorktreeHost; dataDir: string; settings?: () => Pick<Settings, "worktreeBranch">; signal?: AbortSignal }): WorktreePort {
  const info = () => store.sessionInfo(sessionId)
  const workspaceId = () => store.projectSync.workspaceId(sessionId)
  const naming = () => settings().worktreeBranch

  async function workspaces(directory: string): Promise<RestWorkspaceInfo[]> {
    const listed = (await host.run(directory, { operation: "workspace-list" }, signal)) as { workspaces?: RestWorkspaceInfo[] }
    return listed.workspaces ?? []
  }
  async function workspaceOf(directory: string, id: string): Promise<RestWorkspaceInfo | undefined> {
    return (await workspaces(directory)).find((item) => item.id === id)
  }
  /** One worktree by id, name, branch or directory; the answer says when none or several fit. */
  function pick(all: readonly RestWorkspaceInfo[], target: string): { ok: true; workspace: RestWorkspaceInfo } | { ok: false; message: string } {
    const wanted = target.trim()
    const lower = wanted.toLowerCase()
    const exact = all.filter((item) => item.id === wanted || item.directory === wanted || item.branch === wanted || item.name === wanted)
    const found = exact.length ? exact : all.filter((item) => item.name.toLowerCase() === lower || (item.branch ?? "").toLowerCase() === lower)
    if (found.length === 1) return { ok: true, workspace: found[0]! }
    return { ok: false, message: found.length ? `${JSON.stringify(wanted)} matches ${found.length} worktrees; use its id or directory from worktree list` : `no worktree of this project matches ${JSON.stringify(wanted)}; worktree list shows them` }
  }

  function problems(action: "enter" | "exit" | "handoff" | "close"): string[] {
    const session = info()
    if (!session) return ["unknown session"]
    if (session.parentId) return ["only the main session of a conversation can change worktree, not a sub-agent"]
    if (action === "enter" && workspaceId() !== null) return ["this session is already in a worktree; exit it first"]
    if (action === "exit" && workspaceId() === null) return ["this session is not in a worktree"]
    return []
  }
  const describe = (workspace: RestWorkspaceInfo) => `${workspace.name}${workspace.branch ? ` (branch ${workspace.branch})` : ""} at ${workspace.directory}`

  const port: WorktreePort = {
    status() {
      const session = info()
      if (!session) return "unknown session"
      const id = workspaceId()
      const naming_ = branchNamingText(naming())
      if (id === null) return `Working in the project checkout ${session.directory}${readGitBranch(session.directory).branch ? ` (branch ${readGitBranch(session.directory).branch})` : ""}. Use worktree enter for an isolated copy, or worktree list to see the existing ones. ${naming_}`
      return `Working in a worktree (${id}) at ${session.directory}${readGitBranch(session.directory).branch ? ` on branch ${readGitBranch(session.directory).branch}` : ""}. Use worktree exit to return to the project checkout. ${naming_}`
    },

    async list() {
      const session = info()
      if (!session) return "unknown session"
      const current = workspaceId()
      let all: RestWorkspaceInfo[]
      try { all = await workspaces(session.directory) } catch (error) { return `Could not list the worktrees: ${reason(error)}` }
      const trees = all.filter((item) => item.type === "worktree")
      const lines = trees.slice(0, 50).map((item) => `${item.id === current ? "*" : "-"} ${item.name}${item.branch ? ` · branch ${item.branch}` : ""} · ${item.directory}${item.id === current ? " · this session" : ""}`)
      const where = current === null ? `This session works in the project checkout ${session.directory}.` : `This session works in the worktree marked *; worktree exit goes back to the checkout.`
      return [`${trees.length} worktree${trees.length === 1 ? "" : "s"} of this project (target for handoff and close: name, branch, id or directory).`, ...lines, ...(trees.length > 50 ? [`... ${trees.length - 50} more`] : []), where].join("\n")
    },

    async preview({ action, name, branch, base, target, remove }) {
      const found = problems(action)
      if (found.length) return { problems: found }
      const session = info()!
      if (action === "enter") {
        const names = worktreeNames({ naming: naming(), name, branch })
        if (!names.ok) return { problems: [names.message] }
        const where = names.branch ?? `${DEFAULT_PREFIX}${names.name}`
        return { problems: [], detail: `Create a git worktree${name ? ` named ${JSON.stringify(name)}` : ""} on a new branch ${where}${base ? ` starting from ${base}` : ""} under ${path.join(dataDir, "worktrees")} and move this session into it. Now in ${session.directory}; that checkout is not edited. File and shell tools run in the worktree from then on.` }
      }
      if (action === "handoff" || action === "close") {
        if (!target && action === "handoff") return { problems: ["handoff needs target"] }
        let all: RestWorkspaceInfo[]
        try { all = await workspaces(session.directory) } catch (error) { return { problems: [reason(error)] } }
        const own = workspaceId()
        const picked = target ? pick(all.filter((item) => item.type === "worktree"), target) : own ? { ok: true as const, workspace: all.find((item) => item.id === own) } : { ok: false as const, message: "this session is not in a worktree; give a target" }
        if (!picked.ok) return { problems: [picked.message] }
        if (!picked.workspace) return { problems: ["this session's worktree is not registered"] }
        if (action === "handoff") return picked.workspace.id === own ? { problems: ["this session already works in that worktree"] } : { problems: [], detail: `Move this session from ${session.directory} into the existing worktree ${describe(picked.workspace)}. Nothing in either directory is edited.` }
        return { problems: [], detail: `Delete the worktree ${describe(picked.workspace)} when it is clean, its branch is merged and no session works in it.${picked.workspace.id === own ? " This session leaves it first and returns to the project checkout." : ""}` }
      }
      return { problems: [], detail: `Move this session out of ${session.directory} back to the project checkout.${remove ? " The worktree is deleted if it is clean and its branch is merged; otherwise it is kept." : " The worktree and its branch are kept."}` }
    },

    async handoff({ target }) {
      const found = problems("handoff")
      if (found.length) return failed(found[0]!)
      const session = info()!
      let workspace: RestWorkspaceInfo
      try {
        const picked = pick((await workspaces(session.directory)).filter((item) => item.type === "worktree"), target)
        if (!picked.ok) return failed(picked.message)
        workspace = picked.workspace
        if (workspace.id === workspaceId()) return failed("this session already works in that worktree")
        await host.warpInTurn({ directory: session.directory, sessionId, workspaceId: workspace.id, signal })
      } catch (error) {
        return failed(`could not move into the worktree: ${reason(error)}`)
      }
      return { ok: true, directory: workspace.directory, text: `Moved into the existing worktree ${describe(workspace)}. File and shell tools run there now; ${session.directory} is untouched. Commit your work there before you leave.` }
    },

    async close({ target }) {
      const found = problems("close")
      if (found.length) return failed(found[0]!)
      const session = info()!
      const own = workspaceId()
      let workspace: RestWorkspaceInfo | undefined
      try {
        const trees = (await workspaces(session.directory)).filter((item) => item.type === "worktree")
        if (target) {
          const picked = pick(trees, target)
          if (!picked.ok) return failed(picked.message)
          workspace = picked.workspace
        } else workspace = trees.find((item) => item.id === own)
      } catch (error) { return failed(reason(error)) }
      if (!workspace) return failed(target ? "no such worktree" : "this session is not in a worktree; give a target")
      if (workspace.id === own) {
        const left = await port.exit({ remove: true })
        return left.ok ? { ok: true, text: left.text, directory: left.directory } : failed(left.message)
      }
      try {
        await host.run(session.directory, { operation: "workspace-remove", id: workspace.id }, signal)
        return { ok: true, text: `Closed the worktree ${describe(workspace)}; its branch was merged and deleted with it.` }
      } catch (error) {
        return failed(`the worktree ${describe(workspace)} was kept: ${reason(error)}`)
      }
    },

    async enter({ name, branch, base }) {
      const found = problems("enter")
      if (found.length) return failed(found[0]!)
      const session = info()!
      const names = worktreeNames({ naming: naming(), name, branch })
      if (!names.ok) return failed(names.message)
      let workspace: RestWorkspaceInfo | undefined
      try {
        const created = (await host.run(session.directory, { operation: "workspace-create", input: { type: "worktree", branch: null, extra: { name: names.name, ...(names.branch ? { branchName: names.branch } : {}), ...(base ? { base } : {}) } } }, signal)) as { workspace?: RestWorkspaceInfo }
        workspace = created.workspace
        if (!workspace) return failed("the worktree was not created")
        await host.warpInTurn({ directory: session.directory, sessionId, workspaceId: workspace.id, signal })
      } catch (error) {
        // A worktree that exists but could not be entered would be left behind: take it back out.
        if (workspace) await host.run(session.directory, { operation: "workspace-remove", id: workspace.id }, signal).catch(() => undefined)
        return failed(`could not enter a worktree: ${reason(error)}`)
      }
      return { ok: true, directory: workspace.directory, text: `Entered worktree ${workspace.name}${workspace.branch ? ` on branch ${workspace.branch}` : ""} at ${workspace.directory}${base ? `, started from ${base}` : ""}. This session now works there: file and shell tools run in the worktree and the checkout ${session.directory} is untouched.${names.note ? ` (${names.note}.)` : ""} Commit your work in the worktree before you exit.` }
    },

    async exit({ remove }) {
      const found = problems("exit")
      if (found.length) return failed(found[0]!)
      const session = info()!
      const id = workspaceId()!
      let workspace: RestWorkspaceInfo | undefined
      try {
        workspace = await workspaceOf(session.directory, id)
        await host.warpInTurn({ directory: session.directory, sessionId, workspaceId: null, signal })
      } catch (error) {
        return failed(`could not leave the worktree: ${reason(error)}`)
      }
      const checkout = info()!.directory
      const where = workspace ? ` ${workspace.name} (${workspace.directory}${workspace.branch ? `, branch ${workspace.branch}` : ""})` : ""
      if (!remove) return { ok: true, directory: checkout, text: `Left the worktree${where}; it is kept, with its branch, for the user. This session works in ${checkout} again.` }
      try {
        await host.run(checkout, { operation: "workspace-remove", id }, signal)
        return { ok: true, directory: checkout, text: `Left and removed the worktree${where}. This session works in ${checkout} again.` }
      } catch (error) {
        return { ok: true, directory: checkout, text: `Left the worktree${where}, but did not remove it (${reason(error)}); it is kept for the user. This session works in ${checkout} again.` }
      }
    },
  }
  return port
}
