import { createHash } from "node:crypto"
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { MAX_SYNC_BLOB_CHUNK_BYTES, ProjectRestInfo, RestWorkspaceInfo, SessionEvent, redactEventText, redactSecrets, type ProjectRestInput, type SessionId } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"
import type { ModelMessage } from "@mendcode/engine-native"
import { createWorkspaces } from "./workspaces"
import { createWorktreeManager } from "./worktrees"
import { readGitBranch } from "./git-branch"
import { defaultBranch, projectGit, projectGitRoot, ProjectRestError } from "./project-git"
import { createRestWorktrees } from "./worktree-rest"
import { createWorktreeGc } from "./worktree-gc"
import { normalizeReplay } from "./sync-replay"

/** A session a replay may continue stays bounded: at most this many events, and four blobs mid-upload. */
const MAX_REPLAY_EVENTS = 50_000
const MAX_STAGED_BLOBS = 4

type Catalog = { version: 1; projects: ProjectRestInfo[]; workspaces: RestWorkspaceInfo[] }
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24)
function fail(code: ConstructorParameters<typeof ProjectRestError>[0], message: string): never { throw new ProjectRestError(code, message) }

export function createProjectRest(input: {
  dir: string
  defaultDirectory: string
  store: Store
  workspaces(): ReturnType<typeof createWorkspaces>
  manager: ReturnType<typeof createWorktreeManager>
  busy(sessionId: SessionId): boolean
  /** Like `busy` for the session whose own running turn asks to move: everything except that turn. */
  busyAside(sessionId: SessionId): boolean
  occupied(directory: string): boolean
  release(sessionId: SessionId): void
  /** What a move during a turn drops: the session's approvals (they were given for the old directory), never its running turn. */
  settle(sessionId: SessionId): void
  publish(event: SessionEvent): void
  changed(sessionId: SessionId): void
  updated(project: ProjectRestInfo): void
}) {
  const file = path.join(input.dir, "project-rest.json")
  let catalog: Catalog = { version: 1, projects: [], workspaces: [] }
  if (existsSync(file)) {
    if (statSync(file).size > 2 * 1024 * 1024) throw new Error("Project catalog exceeds limit")
    const value = JSON.parse(readFileSync(file, "utf8"))
    if (value.version !== 1 || !Array.isArray(value.projects) || value.projects.length > 1000 || !Array.isArray(value.workspaces) || value.workspaces.length > 1000) throw new Error("Invalid project catalog")
    catalog = { version: 1, projects: value.projects.map((item: unknown) => ProjectRestInfo.parse(item)), workspaces: value.workspaces.map((item: unknown) => RestWorkspaceInfo.parse(item)) }
  }
  function save(project?: ProjectRestInfo) {
    if (project) {
      const index = catalog.projects.findIndex((item) => item.id === project.id)
      if (index < 0) {
        if (catalog.projects.length >= 1000) fail("busy", "Project limit reached")
        catalog.projects.push(project)
      } else catalog.projects[index] = project
    }
    mkdirSync(input.dir, { recursive: true, mode: 0o700 })
    const temporary = `${file}.tmp`
    writeFileSync(temporary, JSON.stringify(catalog) + "\n", { mode: 0o600 })
    renameSync(temporary, file)
  }
  const trees = createRestWorktrees({ dir: input.dir, manager: input.manager, save, occupied: input.occupied })
  async function current(directory: string, signal?: AbortSignal) {
    const canonical = realpathSync(directory)
    if (!statSync(canonical).isDirectory()) fail("invalid_command", "Project must be a directory")
    const association = catalog.workspaces.find((item) => item.directory === canonical)
    const associated = association && catalog.projects.find((item) => item.id === association.projectID)
    if (associated) return structuredClone(associated)
    const git = await projectGitRoot(canonical, signal)
    const root = git?.main ?? canonical
    const id = `proj_${hash(root)}`
    const known = catalog.projects.find((item) => item.id === id)
    if (known) {
      if (Boolean(known.vcs) !== Boolean(git)) {
        const { vcs: _vcs, ...rest } = known
        const next = { ...rest, ...(git ? { vcs: "git" as const } : {}), time: { ...rest.time, updated: Date.now() } }
        save(next)
        return next
      }
      return structuredClone(known)
    }
    const at = Date.now()
    const project: ProjectRestInfo = { id, worktree: root, ...(git ? { vcs: "git" } : {}), time: { created: at, updated: at }, sandboxes: [] }
    save(project)
    return structuredClone(project)
  }
  async function workspaceList(project: ProjectRestInfo, signal?: AbortSignal) {
    const result: RestWorkspaceInfo[] = []
    for (const native of input.workspaces().list()) {
      const saved = catalog.workspaces.find((item) => item.id === native.id)
      if (saved) { if (saved.projectID === project.id) result.push(saved); continue }
      if (existsSync(native.directory) && (await current(native.directory, signal)).id === project.id) result.push({ ...native, branch: readGitBranch(native.directory).branch ?? null, extra: null, projectID: project.id })
    }
    return result
  }
  async function directories(project: ProjectRestInfo, directory: string, signal?: AbortSignal) {
    return [...new Set([project.worktree, directory, ...project.sandboxes, ...(await workspaceList(project, signal)).map((item) => item.directory)])]
  }
  function family(sessionId: SessionId): SessionId[] {
    const result: SessionId[] = []
    const visit = (id: SessionId) => {
      if (result.includes(id) || result.length >= 500) fail("busy", "Session family exceeds limit")
      result.push(id)
      for (const child of input.store.sessionChildren(id)) visit(child)
    }
    visit(sessionId)
    return result
  }
  /** `inTurn`: the session asking is running its own turn (the `worktree` tool); its turn stays alive and only its approvals are dropped. */
  async function warp(project: ProjectRestInfo, directory: string, sessionId: SessionId, workspaceId: string | null, signal: AbortSignal, inTurn = false) {
    if (!input.store.hasSession(sessionId)) fail("unknown_session", "Unknown session")
    const workspaces = await workspaceList(project, signal)
    const workspace = workspaceId ? workspaces.find((item) => item.id === workspaceId) : undefined
    if (workspaceId && !workspace) fail("target_mismatch", "Workspace belongs to another project or is unavailable")
    const target = workspace ? input.workspaces().resolve({ workspaceId: workspace.id }) : realpathSync(project.worktree)
    const allowed = await directories(project, directory, signal)
    const ids = family(sessionId)
    const info = input.store.sessionInfo(sessionId)!
    if (info.parentId) fail("busy", "Warp the root session with its children")
    for (const id of ids) {
      if (!allowed.includes(input.store.sessionDirectory(id)!)) fail("target_mismatch", "Session belongs to another project")
      const own = inTurn && id === sessionId
      if (own ? input.busyAside(id) : input.busy(id) || input.store.queueOf(id).length) fail("busy", own ? "Session has background work, a pending request or a goal; settle it first" : "Session or child is busy")
    }
    if (signal.aborted) fail("busy", "Request cancelled")
    if (ids.every((id) => input.store.sessionDirectory(id) === target && input.store.projectSync.workspaceId(id) === workspaceId)) return
    const events = input.store.projectSync.move(ids, target, workspaceId)
    for (const id of ids) inTurn && id === sessionId ? input.settle(id) : input.release(id)
    for (const event of events) { input.publish(event); if (!(inTurn && event.sessionId === sessionId)) input.changed(event.sessionId) }
  }
  async function diff(directory: string, mode: "git" | "branch", signal: AbortSignal) {
    const context = await projectGitRoot(directory, signal)
    if (!context) return []
    let ref = "HEAD"
    if (mode === "branch") {
      const base = await defaultBranch(directory, signal)
      if (!base || readGitBranch(directory).branch === base.name) return []
      const merge = await projectGit(directory, ["merge-base", "HEAD", base.ref], signal)
      if (!merge.ok) return []
      ref = merge.out
    } else if (!(await projectGit(directory, ["rev-parse", "--verify", "HEAD"], signal)).ok) ref = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
    const root = context.root
    const names = await projectGit(root, ["diff", ref, "--name-status", "-z", "--no-renames"], signal)
    const stats = await projectGit(root, ["diff", ref, "--numstat", "-z", "--no-renames"], signal)
    const patches = await projectGit(root, ["-c", "core.quotePath=false", "diff", ref, "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=2147483647"], signal)
    if (!names.ok || !stats.ok || !patches.ok) fail("invalid_command", "Git diff unavailable")
    const counts = new Map(stats.out.split("\0").filter(Boolean).map((entry) => { const [add, del, ...file] = entry.split("\t"); return [file.join("\t"), { additions: add === "-" ? 0 : Number(add), deletions: del === "-" ? 0 : Number(del) }] }))
    const chunks = patches.out.split(/^diff --git /m).slice(1).map((chunk) => `diff --git ${chunk}`)
    const tokens = names.out.split("\0").filter(Boolean)
    const files: Array<{ file: string; patch: string; additions: number; deletions: number; status: "added" | "deleted" | "modified" }> = []
    for (let i = 0; i < tokens.length; i += 2) {
      const file = tokens[i + 1]!
      files.push({ file, patch: chunks[i / 2] ?? "", ...(counts.get(file) ?? { additions: 0, deletions: 0 }), status: tokens[i] === "A" ? "added" : tokens[i] === "D" ? "deleted" : "modified" })
    }
    const untracked = await projectGit(root, ["ls-files", "--others", "--exclude-standard", "-z"], signal)
    for (const file of untracked.out.split("\0").filter(Boolean)) {
      const full = path.join(root, file)
      const stat = lstatSync(full)
      let content = ""
      if (stat.isFile() && !stat.isSymbolicLink()) {
        const relative = path.relative(root, realpathSync(full))
        if (relative === ".." || relative.startsWith(`..${path.sep}`)) fail("target_mismatch", "Untracked file leaves the project")
        if (stat.size > 60_000) fail("busy", "Untracked diff exceeds limit")
        const bytes = readFileSync(full)
        if (!bytes.includes(0)) content = bytes.toString("utf8")
      }
      const lines = content ? content.replace(/\n$/, "").split("\n") : []
      files.push({ file, patch: lines.length ? `--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n` : "", additions: lines.length, deletions: 0, status: "added" })
    }
    if (files.length > 300 || Buffer.byteLength(JSON.stringify(files)) > 160_000) fail("busy", "Diff exceeds one frame")
    return files
  }
  async function replay(directory: string, value: Extract<ProjectRestInput, { operation: "sync-replay" }>["input"], signal: AbortSignal) {
    if (realpathSync(value.directory) !== realpathSync(directory)) fail("target_mismatch", "Replay directory must match selected project")
    if (new Set(value.events.map((event) => event.id)).size !== value.events.length) fail("invalid_command", "Duplicate sync event ID")
    const { sessionId: source, entries } = normalizeReplay({ directory, events: value.events })
    // A session this store already has: the replay may resend what is stored (it must match) and continue it.
    const stored = input.store.hasSession(source)
    if (stored && input.store.sessionDirectory(source) !== directory) fail("target_mismatch", "Existing session belongs to another project")
    const existing = stored ? storedHistory(source) : []
    const start = entries[0]!.seq
    if (stored ? start > existing.length : start !== 0) fail(stored ? "busy" : "invalid_command", stored ? `History gap: the stored session ends at sequence ${existing.length - 1}; replay must continue at ${existing.length}` : "Replay requires one complete contiguous history starting at zero")
    const allowed = new Set(["session.created", "turn.started", "turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted", "item.started", "item.delta", "item.completed", "usage.recorded", "session.permission", "queue.added", "queue.changed", "foreground.state"])
    const incoming = entries.map((entry, i) => {
      if (entry.seq !== start + i) fail("invalid_command", "Replay requires one complete contiguous history starting at zero")
      if (!allowed.has(entry.type)) fail("unsupported", "Event requires a runtime projector; replay rejected")
      const parsed = SessionEvent.safeParse({ ...entry.data, type: entry.type, sessionId: source, seq: entry.seq + 1, ...(entry.type === "session.created" ? { directory } : {}) })
      if (!parsed.success) fail("invalid_command", "Invalid native sync event")
      const event = redactEventText(parsed.data)
      if (Buffer.byteLength(JSON.stringify(event)) > 80 * 1024) fail("unsupported", "Event exceeds the replay size limit")
      return event
    })
    // What is stored must match what is resent, event for event; only the rest is new.
    for (const event of incoming) if (event.seq <= existing.length && JSON.stringify(existing[event.seq - 1]) !== JSON.stringify(event)) fail("busy", "Session history conflicts with the stored one")
    const events = incoming.filter((event) => event.seq > existing.length)
    for (const event of events) for (const ref of event.type === "item.completed" ? [...(event.blob ? [event.blob] : []), ...(event.attachments ?? [])] : event.type === "queue.added" ? event.attachments : []) requireBlob(ref)
    const all = [...existing, ...events]
    if (all[0]?.type !== "session.created" || all[0].parentId) fail("unsupported", "Replay requires an independent root session")
    const turns = new Set<string>(), items = new Map<string, Extract<SessionEvent, { type: "item.started" }>>()
    const seenTurns = new Set<string>()
    const completed = new Set<string>(), deltas = new Map<string, string>()
    let queue = 0, foreground = "idle"
    const messages: ModelMessage[] = []
    let storedMessages = 0
    for (const event of all) {
      if (event.seq === existing.length + 1) storedMessages = messages.length
      if (event.type === "session.created" && event.seq !== 1) fail("invalid_command", "Duplicate session creation")
      if (event.type === "turn.started") { if (turns.size || seenTurns.has(event.turnId)) fail("invalid_command", "Overlapping or duplicate turns"); turns.add(event.turnId); seenTurns.add(event.turnId) }
      if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled" || event.type === "turn.interrupted") {
        if ([...items.values()].some((item) => item.turnId === event.turnId && !completed.has(item.itemId))) fail("invalid_command", "Turn ended before item completion")
        if (!turns.delete(event.turnId)) fail("invalid_command", "Unknown turn")
      }
      if (event.type === "item.started") { if (items.has(event.itemId) || !turns.has(event.turnId)) fail("invalid_command", "Invalid item ordering"); items.set(event.itemId, event) }
      if (event.type === "item.delta") { if (!items.has(event.itemId) || completed.has(event.itemId)) fail("invalid_command", "Invalid item delta"); deltas.set(event.itemId, (deltas.get(event.itemId) ?? "") + event.text) }
      if (event.type === "item.completed") {
        const item = items.get(event.itemId)
        if (!item || completed.has(event.itemId)) fail("invalid_command", "Invalid item completion")
        completed.add(event.itemId)
        const content = event.text ?? deltas.get(event.itemId) ?? ""
        if (item.kind === "user_message") messages.push({ role: "user", content })
        if (item.kind === "agent_message" || item.kind === "tool_call") messages.push({ role: "assistant", content: item.kind === "tool_call" ? `[Synced tool result]\n${content}` : content, toolCalls: [] })
      }
      if (event.type === "queue.added") queue++
      if (event.type === "queue.changed") queue = event.queue.length
      if (event.type === "foreground.state") foreground = event.state
    }
    if (turns.size || completed.size !== items.size || queue || foreground !== "idle") fail("busy", "Replay requires a settled session; runtime work is never resumed")
    if (signal.aborted) fail("busy", "Request cancelled")
    if (!events.length) return { sessionID: source }
    if (events.length + existing.length > MAX_REPLAY_EVENTS) fail("busy", "Session history exceeds the replay limit")
    const added = stored ? input.store.projectSync.extend(source, events, messages.slice(storedMessages)) : input.store.projectSync.replay(events, messages)
    for (const event of added) input.publish(event)
    input.changed(source)
    return { sessionID: source }
  }
  /** Every stored event of a session, in order (bounded: a longer history cannot be continued by replay). */
  function storedHistory(sessionId: SessionId): SessionEvent[] {
    const out: SessionEvent[] = []
    for (;;) {
      const page = input.store.readAfter(sessionId, out.length, 1000)
      if (!page.length) return out
      out.push(...page)
      if (out.length > MAX_REPLAY_EVENTS) fail("busy", "Session history exceeds the replay limit")
    }
  }
  /** A blob an event references must already be in the local store, uploaded through `sync-blob-put`. */
  function requireBlob(ref: { sha256: string; bytes: number }) {
    const file = input.store.blobPath(ref.sha256)
    if (!existsSync(file) || input.store.readBlob(ref.sha256).length !== ref.bytes) fail("invalid_command", `Event references blob ${ref.sha256.slice(0, 12)}, which was not uploaded; send it with the blob route first`)
  }
  /** Staged chunks of blobs being uploaded, in memory and bounded; runs are serialized, so no locking. */
  const staging = new Map<string, { bytes: number; mime: string; chunks: Buffer[]; received: number }>()
  function putBlob(request: Extract<ProjectRestInput, { operation: "sync-blob-put" }>["input"]) {
    const chunk = Buffer.from(request.data, "base64")
    if (!chunk.byteLength || chunk.byteLength > MAX_SYNC_BLOB_CHUNK_BYTES || chunk.toString("base64") !== request.data) fail("invalid_command", "Blob chunk is not valid base64 of at most 128 KiB")
    const file = input.store.blobPath(request.sha256)
    if (existsSync(file) && input.store.readBlob(request.sha256).length === request.bytes) { staging.delete(request.sha256); return { sha256: request.sha256, bytes: request.bytes, received: request.bytes, stored: true } }
    let entry = staging.get(request.sha256)
    if (request.offset === 0) {
      staging.delete(request.sha256)
      while (staging.size >= MAX_STAGED_BLOBS) staging.delete(staging.keys().next().value!)
      entry = { bytes: request.bytes, mime: request.mime, chunks: [], received: 0 }
      staging.set(request.sha256, entry)
    }
    if (!entry || entry.received !== request.offset || entry.bytes !== request.bytes) fail("busy", `Blob chunk out of order; expected offset ${entry?.received ?? 0}`)
    if (entry.received + chunk.byteLength > entry.bytes) fail("invalid_command", "Blob chunk exceeds the declared size")
    entry.chunks.push(chunk)
    entry.received += chunk.byteLength
    if (entry.received < entry.bytes) return { sha256: request.sha256, bytes: entry.bytes, received: entry.received, stored: false }
    staging.delete(request.sha256)
    const bytes = Buffer.concat(entry.chunks)
    if (createHash("sha256").update(bytes).digest("hex") !== request.sha256) fail("invalid_command", "Blob content does not match its hash")
    input.store.putBlob(bytes, entry.mime)
    return { sha256: request.sha256, bytes: entry.bytes, received: entry.received, stored: true }
  }
  async function readBlob(project: ProjectRestInfo, directory: string, request: Extract<ProjectRestInput, { operation: "sync-blob-read" }>["input"], signal: AbortSignal) {
    const info = input.store.projectSync.blobInfo(await directories(project, directory, signal), request.sha256)
    const file = input.store.blobPath(request.sha256)
    if (!info || !existsSync(file)) fail("target_mismatch", "No such blob in this project")
    if (request.offset > info.bytes) fail("invalid_command", "Offset is past the end of the blob")
    const length = Math.min(MAX_SYNC_BLOB_CHUNK_BYTES, info.bytes - request.offset)
    const buffer = input.store.readBlob(request.sha256).subarray(request.offset, request.offset + length)
    return { sha256: request.sha256, mime: info.mime, bytes: info.bytes, offset: request.offset, data: buffer.toString("base64"), done: request.offset + length >= info.bytes }
  }
  async function run(directory: string, request: ProjectRestInput, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (signal.aborted) fail("busy", "Request cancelled")
    const project = await current(directory, signal)
    if (signal.aborted) fail("busy", "Request cancelled")
    switch (request.operation) {
      case "list": {
        const dirs = [input.defaultDirectory, ...input.workspaces().list().map((item) => item.directory), ...input.store.listSessions({ limit: 500, roots: false, archived: true }).map((session) => session.directory)]
        for (const dir of new Set(dirs)) if (existsSync(dir)) await current(dir, signal)
        return { projects: catalog.projects.map((item) => structuredClone(item)) }
      }
      case "current": return { project }
      case "update": {
        if (request.projectID !== project.id) fail("target_mismatch", "Project does not match selected directory")
        const next = ProjectRestInfo.parse({ ...project, ...request.patch, ...(request.patch.icon ? { icon: { ...project.icon, ...request.patch.icon } } : {}), time: { ...project.time, updated: Date.now() } })
        save(next)
        input.updated(next)
        return { project: next }
      }
      case "init-git": {
        if (!project.vcs && !(await projectGit(directory, ["init", "--quiet"], signal)).ok) fail("invalid_command", "Git initialization failed")
        const next = await current(directory, signal)
        if (!project.vcs) input.updated(next)
        return { project: next }
      }
      case "path": return { path: { home: homedir(), state: input.dir, config: input.dir, worktree: project.worktree, directory } }
      case "vcs": { const branch = readGitBranch(directory), base = project.vcs ? await defaultBranch(directory, signal) : undefined; return { vcs: { ...(branch.branch ? { branch: branch.branch } : {}), ...(base ? { default_branch: base.name } : {}) } } }
      case "vcs-diff": return { files: await diff(directory, request.mode, signal) }
      case "worktree-list": return { directories: project.sandboxes.filter(existsSync) }
      case "worktree-create": return { worktree: await trees.create(project, directory, request.input, signal) }
      case "worktree-remove": return { removed: await trees.remove(project, directory, request.input.directory, signal) }
      case "worktree-reset": return { reset: await trees.reset(project, directory, request.input.directory, signal) }
      case "workspace-adapters": return { adapters: [{ type: "worktree", name: "Worktree", description: "Create a Git worktree" }, { type: "local", name: "Local directory", description: "Register an existing directory" }] }
      case "workspace-list": return { workspaces: await workspaceList(project, signal) }
      case "workspace-status": return { statuses: (await workspaceList(project, signal)).map((item) => ({ workspaceID: item.id, status: existsSync(item.directory) ? "connected" : "disconnected" })) }
      case "workspace-create": {
        if (catalog.workspaces.length >= 1000) fail("busy", "Workspace limit reached")
        if (request.input.id && input.workspaces().list().some((item) => item.id === request.input.id)) fail("busy", "Workspace ID already exists")
        if (request.input.type === "local" && !request.input.extra?.directory) fail("invalid_command", "Local adapter requires extra.directory")
        if (request.input.type === "worktree" && request.input.branch !== null) fail("unsupported", "Worktree adapter assigns a unique branch; use branch: null")
        const tree = request.input.type === "worktree" ? await trees.create(project, directory, { name: request.input.extra?.name, branch: request.input.extra?.branchName, base: request.input.extra?.base, runStartup: request.input.extra?.runStartup }, signal) : undefined
        const target = tree?.directory ?? realpathSync(request.input.extra!.directory!)
        const native = input.workspaces().create(tree?.name ?? request.input.extra?.name ?? path.basename(target), target, request.input.id)
        const workspace: RestWorkspaceInfo = { ...native, type: request.input.type, branch: tree?.branch ?? readGitBranch(target).branch ?? null, extra: request.input.extra ?? null, projectID: project.id }
        catalog.workspaces.push(workspace)
        save()
        return { workspace }
      }
      case "workspace-remove": {
        // Native registrations can span independent projects and only unregister
        // a directory. Donor-owned workspaces retain their scoped removal policy.
        const native = input.workspaces().list().find((item) => item.id === request.id)
        if (native && !catalog.workspaces.some((item) => item.id === request.id)) return { nativeWorkspace: input.workspaces().remove(native.id) }
        const workspace = (await workspaceList(project, signal)).find((item) => item.id === request.id)
        if (!workspace) return {}
        if (input.occupied(workspace.directory)) fail("busy", "Workspace has sessions or active automation; warp sessions out first")
        if (workspace.type === "worktree") await trees.remove(project, directory, workspace.directory, signal)
        input.workspaces().remove(workspace.id)
        catalog.workspaces = catalog.workspaces.filter((item) => item.id !== workspace.id)
        save()
        return { workspace }
      }
      case "workspace-warp": await warp(project, directory, request.input.sessionID, request.input.id, signal); return {}
      case "sync-steal": {
        const workspace = (await workspaceList(project, signal)).find((item) => item.directory === directory)
        if (!workspace) fail("invalid_command", "Steal requires a selected workspace")
        await warp(project, directory, request.sessionID, workspace.id, signal)
        return { sessionID: request.sessionID }
      }
      case "sync-start": return { started: true, mode: "local", remote: false }
      case "sync-history": {
        let history: { events: SessionEvent[]; hasMore: boolean }
        try { history = input.store.projectSync.history(await directories(project, directory, signal), request.cursors) }
        catch { return fail("invalid_command", "Sync history unavailable") }
        return { events: history.events.map(({ sessionId, seq, type, ...data }) => ({ id: `${sessionId}:${seq - 1}`, aggregate_id: sessionId, seq: seq - 1, type, data })), hasMore: history.hasMore }
      }
      case "sync-replay": return replay(directory, request.input, signal)
      case "sync-blob-put": return putBlob(request.input)
      case "sync-blob-read": return readBlob(project, directory, request.input, signal)
    }
  }
  let pending = Promise.resolve()
  const locks = new Set<string>()
  const calls = new Set<AbortController>()
  let closed = false
  /** Disk upkeep of the worktrees this service created: measured, and removed only when merged, clean and unused. */
  const gc = createWorktreeGc({
    dir: input.dir,
    projects: () => catalog.projects.filter((project) => project.vcs),
    occupied: input.occupied,
    lastSession: (directory) => input.store.listSessions({ directory, roots: false, archived: true, limit: 1 })[0]?.updatedAt ?? 0,
    now: () => Date.now(),
    forget(project, directory) {
      project.sandboxes = project.sandboxes.filter((item) => item !== directory)
      for (const workspace of input.workspaces().list().filter((item) => item.directory === directory)) input.workspaces().remove(workspace.id)
      catalog.workspaces = catalog.workspaces.filter((item) => item.directory !== directory)
      save(project)
    },
  })
  function serialized<T>(work: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new ProjectRestError("busy", "Project service stopped"))
    const result = pending.then(work)
    pending = result.then(() => {}, () => {})
    return result
  }
  /** `/cd`: the whole session family moves to an existing directory, like a warp but to any folder. Idle sessions only. */
  function cd(sessionId: SessionId, requested: string) {
    if (!input.store.hasSession(sessionId)) fail("unknown_session", "Unknown session")
    const info = input.store.sessionInfo(sessionId)!
    if (info.parentId) fail("busy", "Change the directory of the root session, not a child")
    const raw = requested === "~" || requested.startsWith("~/") ? path.join(homedir(), requested.slice(1)) : requested
    let target: string
    try {
      target = realpathSync(path.resolve(info.directory, raw))
      if (!statSync(target).isDirectory()) throw new Error("not a directory")
    } catch { return fail("invalid_command", "No such directory") }
    const ids = family(sessionId)
    for (const id of ids) if (input.busy(id) || input.store.queueOf(id).length) fail("busy", "Session or child is busy")
    if (ids.every((id) => input.store.sessionDirectory(id) === target)) return { directory: target, previous: info.directory }
    const events = input.store.projectSync.move(ids, target, null)
    for (const id of ids) input.release(id)
    for (const event of events) { input.publish(event); input.changed(event.sessionId) }
    return { directory: target, previous: info.directory }
  }
  /** The `worktree` tool: the session moves itself into a workspace (or back to the project checkout with `null`) while its turn runs. */
  function warpInTurn({ directory, sessionId, workspaceId, signal }: { directory: string; sessionId: SessionId; workspaceId: string | null; signal: AbortSignal }) {
    if (closed) return Promise.reject(new ProjectRestError("busy", "Project service stopped"))
    const result = pending.then(async () => {
      const real = realpathSync(directory)
      await warp(await current(real, signal), real, sessionId, workspaceId, signal, true)
    })
    pending = result.then(() => {}, () => {})
    return result
  }
  return { cd, warpInTurn, storage: {
    report: (idleDays: number | undefined, signal?: AbortSignal) => serialized(() => gc.report(idleDays, signal)),
    clean: (options: { idleDays?: number; dryRun?: boolean }) => serialized(() => gc.clean(options)),
    trashBytes: () => gc.trashBytes(),
  }, async close() { closed = true; for (const call of calls) call.abort(); await pending }, locked(directory: string) {
    const resolved = path.resolve(directory)
    return [...locks].some((lock) => resolved === lock || resolved.startsWith(lock + path.sep))
  }, run(directory: string, request: ProjectRestInput, signal: AbortSignal) {
    if (closed) return Promise.reject(new ProjectRestError("busy", "Project service stopped"))
    const controller = new AbortController()
    calls.add(controller)
    signal = AbortSignal.any([signal, controller.signal])
    const result = pending.then(async () => {
      const targets = [realpathSync(directory)]
      const mutation = ["worktree-create", "worktree-remove", "worktree-reset", "workspace-create", "workspace-remove", "init-git"].includes(request.operation)
      if (mutation) {
        targets.push((await current(directory, signal)).worktree, path.join(input.dir, "worktrees"))
        if ((request.operation === "worktree-remove" || request.operation === "worktree-reset")) targets.push(realpathSync(request.input.directory))
        if (request.operation === "workspace-remove") {
          const workspace = input.workspaces().list().find((item) => item.id === request.id)
          if (workspace) targets.push(workspace.directory)
        }
        for (const target of targets) locks.add(target)
      }
      try { return await run(realpathSync(directory), request, signal) }
      finally { if (mutation) for (const target of targets) locks.delete(target) }
    })
    pending = result.then(() => {}, () => {})
    return result.finally(() => calls.delete(controller))
  } }
}
