import type { SessionId, WorktreeRead, WorktreeChange, WorktreeReport } from "@mendcode/protocol"
import type { AppContext } from "./context"
import type { WorktreesPageState, WarpRow } from "../../view/worktrees-page"
import { preload } from "../lazy-pages"
import { featureOn } from "@mendcode/protocol/wire"

type RestInput = import("@mendcode/protocol").ProjectRestInput

export function createWorktrees(ctx: AppContext) {
  const { input, state, requestFrame, say } = ctx
  const directory = () => input.directory ?? "."
  const unavailable = "Workspaces unavailable in read-only mode"
  async function rest(operation: RestInput) {
    const reply = await input.send({ type: "project.rest", directory: directory(), input: operation })
    if (!reply.ok) throw new Error(reply.error.message)
    return reply.result as Record<string, unknown>
  }
  /** Reload workspaces, the project root and which are reachable. Keeps the page's selection in range. */
  async function loadWarp(view: WorktreesPageState) {
    if (input.remote?.readOnly) { view.error = unavailable; return }
    view.busy = true
    view.error = ""
    requestFrame()
    try {
      const [list, current, status] = await Promise.all([rest({ operation: "workspace-list" }), rest({ operation: "current" }), rest({ operation: "workspace-status" })])
      const statuses = new Map(((status.statuses ?? []) as { workspaceID: string; status: string }[]).map((item) => [item.workspaceID, item.status]))
      view.workspaces = ((list.workspaces ?? []) as WarpRow[]).map((item) => ({ id: item.id, name: item.name, type: item.type, branch: item.branch, directory: item.directory, status: statuses.get(item.id) ?? "unknown" }))
      const root = (current.project as { worktree?: string } | undefined)?.worktree
      if (root) view.projectPath = root
      view.currentDirectory = directory()
      // Inside the Git page each row says whether it has uncommitted changes (what `worktree.query` already knows); best effort, and only there.
      if (featureOn(state.settingsNow, "git_hub")) {
        const probe = await input.send({ type: "worktree.query", directory: directory(), query: { operation: "status" } }).catch(() => undefined)
        if (probe?.ok) view.dirty = new Set(((probe.result as WorktreeReport | undefined)?.records ?? []).filter((record) => !record.dirty.clean).map((record) => record.path))
      }
      view.selected = Math.min(view.selected, view.workspaces.length + 1)
      view.confirmRemove = undefined
    } catch (error) { view.error = error instanceof Error ? error.message : String(error) }
    finally { view.busy = false; requestFrame() }
  }
  /** `workspace-warp`: the session and its children move to a workspace (null = the project root). */
  const warpSession = (id: string | null, sessionId: SessionId) => rest({ operation: "workspace-warp", input: { id: id as `ws_${string}` | null, sessionID: sessionId } })
  /** `workspace-create` for a worktree (the daemon names the branch and the folder) or an existing directory; the one request `/warp` → New workspace sends. */
  async function makeWorkspace(name: string, dir: string) {
    const extra = { ...(dir ? { directory: dir } : {}), ...(name ? { name } : {}) }
    const result = await rest({ operation: "workspace-create", input: { type: dir ? "local" : "worktree", branch: null, extra } })
    return result.workspace as WarpRow
  }
  /**
   * `git.newSessionWorktree`: a session just created in a Git project is moved into a fresh workspace, the way `/warp` → New workspace does it (same
   * requests, same naming), before the terminal enters it. Returns one line saying why the session stays in the project, or undefined when it moved
   * or the setting does not apply (off, tier without the Git page, remote client). Never throws: a session that could not be moved is still a session.
   */
  async function placeNewSession(sessionId: SessionId): Promise<string | undefined> {
    if (state.settingsNow.git?.newSessionWorktree !== true || !featureOn(state.settingsNow, "git_hub") || input.remote) return undefined
    try {
      const current = await rest({ operation: "current" })
      if ((current.project as { vcs?: string } | undefined)?.vcs !== "git") return "New session stays in the project: it is not a Git repository"
      const created = await makeWorkspace("", "")
      try { await warpSession(created.id, sessionId) }
      catch (error) { throw new Error(`could not move into ${created.name}: ${error instanceof Error ? error.message : String(error)}`) }
      return undefined
    } catch (error) {
      const why = (error instanceof Error ? error.message : String(error)).replace(/^\[[A-Z]+\]: /, "").split("\n")[0]!.slice(0, 160)
      return `New session stays in the project: no workspace (${why})`
    }
  }
  /** Move the session and its children to a workspace (null = the project root), then return to the chat. */
  async function warpTo(view: WorktreesPageState, id: string | null, label: string) {
    if (view.busy) return false
    if (input.remote?.readOnly) { view.error = unavailable; requestFrame(); return false }
    view.busy = true
    view.error = ""
    requestFrame()
    try {
      await warpSession(id, state.sessionId)
      state.page = "chat"
      say(`Moved to ${label}`, "info")
      return true
    } catch (error) { view.error = error instanceof Error ? error.message : String(error); return false }
    finally { view.busy = false; requestFrame() }
  }
  async function createWorkspace(view: WorktreesPageState, name: string, dir: string) {
    if (view.busy) return
    if (!dir && !name) { view.error = "Name required"; return }
    view.busy = true
    view.error = ""
    requestFrame()
    try {
      const created = await makeWorkspace(name, dir)
      view.form = undefined
      view.busy = false
      if (!await warpTo(view, created.id, created.name)) await loadWarp(view)
    } catch (error) { view.error = error instanceof Error ? error.message : String(error) }
    finally { view.busy = false; requestFrame() }
  }
  async function removeWorkspace(view: WorktreesPageState, row: WarpRow) {
    if (view.confirmRemove !== row.id) { view.confirmRemove = row.id; view.error = ""; return }
    view.confirmRemove = undefined
    try { await rest({ operation: "workspace-remove", id: row.id as `ws_${string}` }); await loadWarp(view) }
    catch (error) { view.error = error instanceof Error ? error.message : String(error) }
  }
  async function warpKey(view: WorktreesPageState, key: string) {
    const rows = view.workspaces ?? []
    const count = rows.length + 2
    const row = view.selected >= 2 ? rows[view.selected - 2] : undefined
    if (key === "q") state.page = "chat"
    else if (key === "\t") { view.detailsFocused = !view.detailsFocused; view.scroll = 0 }
    else if (["\x1b[A", "k", "\x1b[5~"].includes(key)) {
      if (view.detailsFocused) view.scroll = Math.max(0, view.scroll - (key === "\x1b[5~" ? 10 : 1))
      else view.selected = Math.max(0, view.selected - 1)
      view.confirmRemove = undefined
    } else if (["\x1b[B", "j", "\x1b[6~"].includes(key)) {
      if (view.detailsFocused) view.scroll += key === "\x1b[6~" ? 10 : 1
      else view.selected = Math.min(count - 1, view.selected + 1)
      view.confirmRemove = undefined
    } else if (key === "r") await loadWarp(view)
    else if (key === "c" || (key === "\r" || key === "o") && view.selected === 0) {
      if (input.remote?.readOnly) view.error = unavailable
      else { view.form = { selected: 0, values: ["", ""], cursors: [0, 0] }; view.error = "" }
    } else if ((key === "\r" || key === "o") && view.selected === 1) {
      if (view.projectPath && view.currentDirectory === view.projectPath) view.error = "Local project is already active"
      else await warpTo(view, null, "project")
    } else if ((key === "\r" || key === "o") && row) {
      if (row.directory === view.currentDirectory) view.error = "Session is already in this workspace"
      else await warpTo(view, row.id, row.name)
    } else if (key === "x" && row) await removeWorkspace(view, row)
    requestFrame()
  }
  async function request(view: WorktreesPageState, command: WorktreeRead | WorktreeChange, write = false) {
    if (view.busy) return
    if (write && input.remote?.readOnly) { view.error = "Registry writes disabled in read-only mode"; requestFrame(); return }
    view.busy = true
    view.error = ""
    view.scroll = 0
    requestFrame()
    try {
      const reply = write
        ? await input.send({ type: "worktree.change", directory: directory(), change: command as WorktreeChange })
        : await input.send({ type: "worktree.query", directory: directory(), query: command as WorktreeRead })
      if (!reply.ok) view.error = reply.error.message
      else {
        view.report = reply.result as WorktreeReport
        view.preview = view.report.preview
        view.selected = Math.min(view.selected, Math.max(0, view.report.records.length - 1))
        view.scroll = 0
        if (write && view.report.ok) view.form = undefined
      }
    } catch (error) { view.error = error instanceof Error ? error.message : String(error) }
    finally { view.busy = false; requestFrame() }
  }
  function form(view: WorktreesPageState) {
    if (input.remote?.readOnly) { view.error = "Registry writes disabled in read-only mode"; return }
    view.form = { selected: 0, values: ["", "", "", "", ""], cursors: [0, 0, 0, 0, 0] }
    view.preview = undefined
    view.error = ""
  }
  async function worktreesCommand(text: string) {
    const match = /^\/(worktrees|warp)(?:\s+(.*))?$/.exec(text.trim())
    if (!match) return false
    await preload("worktrees")
    const view: WorktreesPageState = { mode: match[1] === "warp" ? "warp" : "manager", selected: 0, scroll: 0, readOnly: input.remote?.readOnly ?? false }
    state.worktrees = view
    state.page = view.mode === "warp" ? "warp" : "worktrees"
    if (view.mode === "warp") {
      await loadWarp(view)
      const target = match[2]?.trim()
      if (target && !view.error) {
        const lower = target.toLowerCase()
        const row = (view.workspaces ?? []).find((item) => [item.id, item.name, item.branch ?? "", item.directory].some((value) => value === target || value.toLowerCase() === lower))
        if (lower === "local" || lower === "project") await warpTo(view, null, "project")
        else if (row) await warpTo(view, row.id, row.name)
        else view.error = `No workspace matches "${target.slice(0, 60)}"`
        requestFrame()
      }
      return true
    }
    await request(view, { operation: "status" })
    if (match[2]) await request(view, { operation: "open", target: match[2] })
    return true
  }
  async function worktreesKey(key: string) {
    const view = state.worktrees
    if (!view) return
    if (key === "\x1b") {
      if (view.form) view.form = undefined
      else if (view.preview) view.preview = undefined
      else state.page = "chat"
      requestFrame()
      return
    }
    if (view.form) {
      const editor = view.form
      const index = editor.selected
      const fields = editor.values.length
      const warp = view.mode === "warp"
      const value = editor.values[index] ?? ""
      const cursor = editor.cursors[index] ?? value.length
      if (key === "\r" && warp) await createWorkspace(view, (editor.values[0] ?? "").trim(), (editor.values[1] ?? "").trim())
      else if (key === "\r") {
        const [name, branch, base, path, focus] = editor.values
        if (!name?.trim()) view.error = "Name required"
        else await request(view, { operation: "create", input: { name: name.trim(), ...(branch ? { branch } : {}), ...(base ? { base } : {}), ...(path ? { path } : {}), ...(focus ? { focus } : {}) } }, true)
      } else if (["\t", "\x1b[B", "\x1b[Z", "\x1b[A"].includes(key)) editor.selected = (index + (key === "\x1b[Z" || key === "\x1b[A" ? fields - 1 : 1)) % fields
      else if (key === "\x1b[D") editor.cursors[index] = Math.max(0, cursor - 1)
      else if (key === "\x1b[C") editor.cursors[index] = Math.min(value.length, cursor + 1)
      else if (key === "\x01" || key === "\x1b[H") editor.cursors[index] = 0
      else if (key === "\x05" || key === "\x1b[F") editor.cursors[index] = value.length
      else if (key === "\x7f" && cursor > 0) { editor.values[index] = value.slice(0, cursor - 1) + value.slice(cursor); editor.cursors[index] = cursor - 1 }
      else if (key === "\x1b[3~") editor.values[index] = value.slice(0, cursor) + value.slice(cursor + 1)
      else if (!/[\x00-\x1f\x7f]/.test(key) && value.length + key.length <= (warp ? index === 1 ? 4096 : 100 : index === 3 ? 4096 : index === 1 || index === 2 ? 200 : 100)) {
        editor.values[index] = value.slice(0, cursor) + key + value.slice(cursor)
        editor.cursors[index] = cursor + key.length
      }
      requestFrame()
      return
    }
    if (view.preview) {
      if (["\x1b[A", "k", "\x1b[5~"].includes(key)) view.scroll = Math.max(0, view.scroll - (key === "\x1b[5~" ? 10 : 1))
      if (["\x1b[B", "j", "\x1b[6~"].includes(key)) view.scroll += key === "\x1b[6~" ? 10 : 1
      requestFrame()
      return
    }
    if (view.mode === "warp") { await warpKey(view, key); return }
    const count = view.report?.records.length ?? 0
    if (key === "q") state.page = "chat"
    else if (key === "\t") { view.detailsFocused = !view.detailsFocused; view.scroll = 0 }
    else if (["\x1b[A", "k", "\x1b[5~"].includes(key)) {
      if (view.detailsFocused) view.scroll = Math.max(0, view.scroll - (key === "\x1b[5~" ? 10 : 1))
      else view.selected = Math.max(0, view.selected - 1)
    } else if (["\x1b[B", "j", "\x1b[6~"].includes(key)) {
      if (view.detailsFocused) view.scroll += key === "\x1b[6~" ? 10 : 1
      else view.selected = Math.min(Math.max(0, count - 1), view.selected + 1)
    }
    else if (key === "r" || key === "d") await request(view, { operation: key === "d" ? "doctor" : "status" })
    else if (key === "c") form(view)
    else {
      const open = key === "o" || key === "\r"
      const target = view.report?.records[view.selected]
      if (target && (open || ["a", "x", "z"].includes(key))) {
        await request(view, { operation: open ? "open" : key === "a" ? "adopt" : key === "x" ? "remove" : "reset", target: target.id }, key === "a")
      }
    }
    requestFrame()
  }
  return { worktreesCommand, worktreesKey, placeNewSession }
}
