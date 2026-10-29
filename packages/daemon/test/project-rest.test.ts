import { afterEach, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createClient } from "@mendcode/client"
import { createIdFactory, isReadOnlyCommand, ProjectRestInfo, ProjectRestInput, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src/daemon"
import { httpOpenApi } from "../src/http"
import { remoteTokens } from "../src/remote"
import { cleanTemps, tempDir } from "../../../apps/cli/test/session-ui-harness"

const ids = createIdFactory()
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); cleanTemps() })
async function git(directory: string, ...args: string[]) {
  const child = Bun.spawn(["git", "-C", directory, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } })
  const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(error)
  return out.trim()
}
async function boot(withGit = false) {
  const dir = realpathSync(tempDir("mendcode-b85-data-")), project = realpathSync(tempDir("mendcode-b85-project-"))
  if (withGit) {
    await git(project, "init", "-b", "main")
    writeFileSync(path.join(project, "tracked.txt"), "first\n")
    await git(project, "add", "tracked.txt")
    await git(project, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "seed")
  }
  const tokens = remoteTokens(dir), full = tokens.create({ name: "owner" }).token, observer = tokens.create({ name: "observer", readOnly: true }).token
  const daemon = await startDaemon({ dir, defaultDirectory: project, socketPath: path.join(dir, "mendd.sock"), http: { enabled: true, cors: ["https://client.example"] }, httpListen: false, extensionsEnabled: false, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanup.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "b85-test" })
  await client.connect()
  cleanup.push(() => client.close())
  const request = async (route: string, options: { method?: string; value?: unknown; token?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}) => {
    const response = await daemon.httpAdapter!.fetch(new Request(`http://127.0.0.1:4096${route}`, { method: options.method ?? (options.value === undefined ? "GET" : "POST"), headers: { Authorization: `Bearer ${options.token ?? full}`, "Content-Type": "application/json", ...options.headers }, ...(options.value === undefined ? {} : { body: JSON.stringify(options.value) }), ...(options.signal ? { signal: options.signal } : {}) }))
    if (!response) throw new Error("No adapter response")
    return response
  }
  const json = async (route: string, options: Parameters<typeof request>[1] = {}) => {
    const response = await request(route, options)
    const value = response.status === 204 ? undefined : await response.json()
    expect(response.status, JSON.stringify(value)).toBe(200)
    return value
  }
  return { dir, project, daemon, client, request, json, full, observer, tokens }
}

test("B85 route/auth/schema contracts are opt-in, full-authority, donor-shaped and additive", async () => {
  const h = await boot()
  expect(h.daemon.httpPort).toBeUndefined()
  expect(isReadOnlyCommand("project.rest")).toBe(false)
  const spec = httpOpenApi().paths as Record<string, Record<string, any>>
  const expected = {
    "/experimental/worktree": { get: "worktree.list", post: "worktree.create", delete: "worktree.remove" }, "/experimental/worktree/reset": { post: "worktree.reset" },
    "/project": { get: "project.list" }, "/project/current": { get: "project.current" }, "/project/git/init": { post: "project.initGit" }, "/project/{projectID}": { patch: "project.update" },
    "/path": { get: "path.get" }, "/vcs": { get: "vcs.get" }, "/vcs/diff": { get: "vcs.diff" },
    "/sync/start": { post: "sync.start" }, "/sync/replay": { post: "sync.replay" }, "/sync/steal": { post: "sync.steal" }, "/sync/history": { post: "sync.history.list" },
    "/experimental/workspace": { get: "experimental.workspace.list", post: "experimental.workspace.create" }, "/experimental/workspace/adapter": { get: "experimental.workspace.adapter.list" }, "/experimental/workspace/status": { get: "experimental.workspace.status" }, "/experimental/workspace/{id}": { delete: "experimental.workspace.remove" }, "/experimental/workspace/warp": { post: "experimental.workspace.warp" },
  }
  for (const [route, methods] of Object.entries(expected)) for (const [method, id] of Object.entries(methods)) expect(spec[route]?.[method]?.operationId).toBe(id)
  expect(spec["/experimental/workspace/warp"]?.post.responses["204"]).toBeDefined()
  expect(spec["/project/{projectID}"]?.patch.requestBody.content["application/json"].schema.additionalProperties).toBe(false)
  for (const route of ["/project", "/path", "/vcs", "/experimental/workspace", "/experimental/worktree"]) expect((await h.request(route, { token: h.observer })).status).toBe(403)
  expect((await h.request("/sync/history", { token: h.observer, value: {} })).status).toBe(403)
  expect((await h.request("/project/git/init", { value: {}, headers: { Origin: "https://client.example" } })).status).toBe(403)
  expect((await h.request("/vcs/diff")).status).toBe(400)
  expect((await h.request("/path", { method: "POST", value: {} })).status).toBe(405)
  expect(ProjectRestInput.safeParse({ operation: "update", projectID: "x", patch: { secret: "private" } }).success).toBe(false)
  expect(ProjectRestInput.safeParse({ operation: "workspace-create", input: { type: "remote", branch: null } }).success).toBe(false)
  expect((await h.request("/project/current", { headers: { "x-opencode-directory": tempDir() } })).status).toBe(403)
  h.tokens.revoke("owner")
  expect((await h.request("/project/current")).status).toBe(401)
})

test("project paths, stable IDs, Git init and metadata persist without touching project configuration", async () => {
  const h = await boot()
  const before = await h.json("/project/current")
  expect(ProjectRestInfo.safeParse(before).success).toBe(true)
  expect(before.vcs).toBeUndefined()
  const initialized = await h.json("/project/git/init", { value: {} })
  expect(initialized).toMatchObject({ id: before.id, worktree: h.project, vcs: "git" })
  const subscription = await h.request("/global/event")
  const reader = subscription.body!.getReader()
  await reader.read()
  const updated = await h.json(`/project/${before.id}`, { method: "PATCH", value: { name: "Workspace", icon: { color: "green", url: "https://assets.example/icon.png" }, commands: { start: "printf started" } } })
  expect(updated).toMatchObject({ name: "Workspace", commands: { start: "printf started" } })
  const pushed = new TextDecoder().decode((await reader.read()).value)
  expect(pushed).toContain('"type":"project.updated"')
  expect(pushed).toContain('"name":"Workspace"')
  await reader.cancel()
  const partial = await h.json(`/project/${before.id}`, { method: "PATCH", value: { icon: { color: "white" } } })
  expect(partial.icon).toEqual({ url: "https://assets.example/icon.png", color: "white" })
  expect(partial.commands).toEqual(updated.commands)
  expect(await h.json("/project")).toContainEqual(partial)
  expect(await h.json("/path")).toMatchObject({ state: h.dir, config: h.dir, directory: h.project, worktree: h.project })
  expect(existsSync(path.join(h.project, ".mendcode"))).toBe(false)
  expect(JSON.parse(readFileSync(path.join(h.dir, "project-rest.json"), "utf8")).projects[0]).toEqual(partial)
  expect((await h.request("/project/proj_other", { method: "PATCH", value: { name: "other" } })).status).toBe(403)
  const native = await h.client.restProject(h.project, { operation: "current" })
  expect(native.ok && native.result?.project).toEqual(partial)
}, 15_000)

test("VCS exposes branch/default branch and staged, untracked, binary and branch diffs with bounded patches", async () => {
  const h = await boot(true)
  expect(await h.json("/vcs")).toEqual({ branch: "main", default_branch: "main" })
  writeFileSync(path.join(h.project, "tracked.txt"), "first\nsecond\n")
  await git(h.project, "add", "tracked.txt")
  writeFileSync(path.join(h.project, "new file.txt"), "new\n")
  writeFileSync(path.join(h.project, "binary.bin"), Buffer.from([0, 1, 2]))
  const outside = path.join(h.dir, "private.txt")
  writeFileSync(outside, "not in the project\n")
  symlinkSync(outside, path.join(h.project, "link"))
  const files = await h.json("/vcs/diff?mode=git")
  expect(files.find((item: any) => item.file === "tracked.txt")).toMatchObject({ additions: 1, deletions: 0, status: "modified" })
  expect(files.find((item: any) => item.file === "new file.txt")).toMatchObject({ additions: 1, status: "added" })
  expect(files.find((item: any) => item.file === "binary.bin").patch).toBe("")
  expect(JSON.stringify(files)).not.toContain("not in the project")
  expect(await h.json("/vcs/diff?mode=branch")).toEqual([])
  await git(h.project, "switch", "-c", "feature")
  expect((await h.json("/vcs/diff?mode=branch")).find((item: any) => item.file === "tracked.txt").patch).toContain("+second")
  writeFileSync(path.join(h.project, "large.txt"), "x".repeat(60_001))
  expect((await h.request("/vcs/diff?mode=git")).status).toBe(409)
}, 15_000)

test("worktree lifecycle checks out files, rejects dirty/base/external paths, preserves HEAD and uses Trash", async () => {
  const h = await boot(true)
  expect(await h.json("/experimental/worktree")).toEqual([])
  expect((await h.request("/experimental/worktree", { value: { name: "bad", startCommand: "touch should-not-exist" } })).status).toBe(501)
  const tree = await h.json("/experimental/worktree", { value: { name: "Review" } })
  expect(tree).toMatchObject({ name: "review", branch: "mend/review" })
  expect(readFileSync(path.join(tree.directory, "tracked.txt"), "utf8")).toBe("first\n")
  expect(await h.json("/experimental/worktree")).toEqual([tree.directory])
  const duplicate = await h.json("/experimental/worktree", { value: { name: "Review" } })
  expect(duplicate.directory).not.toBe(tree.directory)
  const reset = (directory: string) => h.request("/experimental/worktree/reset", { value: { directory } })
  expect((await reset(h.project)).status).toBe(403)
  writeFileSync(path.join(tree.directory, "tracked.txt"), "changed\n")
  expect((await reset(tree.directory)).status).toBe(409)
  await git(tree.directory, "add", "tracked.txt")
  await git(tree.directory, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "work")
  const previous = await git(tree.directory, "rev-parse", "HEAD")
  expect(await h.json("/experimental/worktree/reset", { value: { directory: tree.directory } })).toBe(true)
  expect(readFileSync(path.join(tree.directory, "tracked.txt"), "utf8")).toBe("first\n")
  expect(await git(h.project, "for-each-ref", "--format=%(objectname)", "refs/mendcode/worktree-backups/")).toContain(previous)
  expect(await h.json("/experimental/worktree", { method: "DELETE", value: { directory: tree.directory } })).toBe(true)
  expect(existsSync(tree.directory)).toBe(false)
  expect(await git(h.project, "branch", "--list", tree.branch)).toBe("")
  const trash = readdirSync(path.join(h.dir, "trash", "worktrees"))
  expect(trash.some((name) => readFileSync(path.join(h.dir, "trash", "worktrees", name, "tracked.txt"), "utf8") === "first\n")).toBe(true)
  expect(await h.json("/experimental/worktree")).toEqual([duplicate.directory])
}, 30_000)

test("a session born in its own workspace (git.newSessionWorktree) is in the storage report and in the age-based cleaning, like any worktree", async () => {
  const h = await boot(true)
  const created = await h.client.send({ type: "project.rest", directory: h.project, input: { operation: "workspace-create", input: { type: "worktree", branch: null, extra: {} } } })
  expect(created.ok).toBe(true)
  const workspace = (created.ok ? created.result : {}) as { workspace: { id: string; directory: string; branch: string } }
  expect(workspace.workspace.branch).toMatch(/^mend\//)
  const made = await h.client.send({ type: "session.create", directory: h.project, title: "" })
  const sessionId = (made.ok ? (made.result as { sessionId: SessionId }).sessionId : undefined)!
  const warped = await h.client.send({ type: "project.rest", directory: h.project, input: { operation: "workspace-warp", input: { id: workspace.workspace.id as `ws_${string}`, sessionID: sessionId } } })
  expect(warped.ok).toBe(true)
  const report = await h.client.send({ type: "storage.worktrees", idleDays: 0 })
  const listed = (report.ok ? (report.result as { worktrees: Array<{ directory: string; occupied: boolean; removable: boolean; keep?: string }> }).worktrees : [])
  const mine = listed.find((item) => item.directory === workspace.workspace.directory)
  expect(mine).toBeDefined()
  // A session lives in it: cleaning keeps it, and says so.
  expect(mine).toMatchObject({ occupied: true, removable: false })
}, 30_000)

test("startup is opt-in, executes in the worktree, and retained workspace state is truthful on failure", async () => {
  const h = await boot(true)
  const project = await h.json("/project/current")
  await h.json(`/project/${project.id}`, { method: "PATCH", value: { commands: { start: "printf configured > startup.txt" } } })
  const off = await h.json("/experimental/worktree", { value: { name: "off" } })
  expect(existsSync(path.join(off.directory, "startup.txt"))).toBe(false)
  const on = await h.json("/experimental/worktree", { value: { name: "on", runStartup: true, startCommand: "printf additional >> startup.txt" } })
  expect(readFileSync(path.join(on.directory, "startup.txt"), "utf8")).toBe("configuredadditional")
  expect((await h.request("/experimental/worktree", { value: { name: "failed", runStartup: true, startCommand: "exit 2" } })).status).toBe(400)
  expect((await h.json("/experimental/worktree")).some((directory: string) => directory.endsWith("/failed"))).toBe(true)
}, 30_000)

test("workspace adapters, native registration, scoping, warp/detach and steal preserve the session family", async () => {
  const h = await boot(true)
  expect((await h.json("/experimental/workspace/adapter")).map((item: any) => item.type)).toEqual(["worktree", "local"])
  const workspace = await h.json("/experimental/workspace", { value: { type: "worktree", branch: null, extra: { name: "side" } } })
  expect(workspace).toMatchObject({ type: "worktree", branch: "mend/side", extra: { name: "side" } })
  const selected = { "x-mendcode-workspace": workspace.id }
  expect(await h.json("/project/current", { headers: selected })).toMatchObject({ id: workspace.projectID })
  expect(await h.json("/experimental/workspace/status")).toEqual([{ workspaceID: workspace.id, status: "connected" }])
  const sessionId = ids("session"), child = ids("session")
  h.daemon.store.createSession({ id: sessionId, directory: h.project, title: "Root" })
  h.daemon.store.createSession({ id: child, directory: h.project, title: "Child", parentId: sessionId })
  const warp = (id: string | null, target = sessionId) => h.request("/experimental/workspace/warp", { value: { id, sessionID: target } })
  expect((await warp(workspace.id, child)).status).toBe(409)
  expect((await warp(workspace.id)).status).toBe(204)
  for (const id of [sessionId, child]) {
    expect(h.daemon.store.sessionDirectory(id)).toBe(workspace.directory)
    expect(h.daemon.store.readBefore(id, undefined, 1)[0]).toMatchObject({ type: "session.workspace.changed", workspaceID: workspace.id })
  }
  expect((await h.request(`/experimental/workspace/${workspace.id}`, { method: "DELETE" })).status).toBe(409)
  expect((await warp(null)).status).toBe(204)
  expect(h.daemon.store.sessionDirectory(child)).toBe(h.project)
  expect(await h.json("/sync/steal", { value: { sessionID: sessionId }, headers: selected })).toEqual({ sessionID: sessionId })
  expect((await h.request("/sync/steal", { value: { sessionID: sessionId } })).status).toBe(400)
  expect((await warp(null)).status).toBe(204)
  expect(await h.json(`/experimental/workspace/${workspace.id}`, { method: "DELETE" })).toMatchObject({ id: workspace.id })
  expect((await h.request("/project/current", { headers: selected })).status).toBe(403)
  const local = realpathSync(tempDir())
  const registered = await h.json("/experimental/workspace", { value: { adapter: "local", name: "legacy", directory: local } })
  expect(registered.workspace.directory).toBe(local)
  const foreign = await h.json("/project/current", { headers: { "x-mendcode-workspace": registered.workspace.id } })
  expect(foreign.id).not.toBe(workspace.projectID)
  expect(await h.json("/experimental/workspace", { headers: { "x-mendcode-workspace": registered.workspace.id } })).toHaveLength(1)
  const foreignSession = ids("session")
  h.daemon.store.createSession({ id: foreignSession, directory: local, title: "Foreign" })
  expect((await warp(null, foreignSession)).status).toBe(403)
}, 30_000)

test("local directory adapter honors a donor ID, stays project-scoped and never deletes files", async () => {
  const h = await boot()
  const directory = realpathSync(tempDir()), id = `ws_${"a".repeat(24)}`
  writeFileSync(path.join(directory, "keep.txt"), "keep")
  const workspace = await h.json("/experimental/workspace", { value: { id, type: "local", branch: null, extra: { name: "local", directory } } })
  expect(workspace).toMatchObject({ id, type: "local", directory })
  expect((await h.request("/experimental/workspace", { value: { id, type: "local", branch: null, extra: { directory } } })).status).toBe(409)
  expect(await h.json(`/experimental/workspace/${id}`, { method: "DELETE" })).toMatchObject({ id })
  expect(readFileSync(path.join(directory, "keep.txt"), "utf8")).toBe("keep")
  expect((await h.request(`/experimental/workspace/${id}`, { method: "DELETE" })).status).toBe(204)
})

test("sync histories use zero-based cursors and native complete replay is atomic, idempotent and continuable", async () => {
  const source = await boot(), target = await boot()
  const sessionId = ids("session"), turnId = ids("turn"), itemId = ids("item")
  source.daemon.store.createSession({ id: sessionId, directory: source.project, title: "Synced" })
  source.daemon.store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
  source.daemon.store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId, kind: "user_message" })
  source.daemon.store.sessionSink.append({ type: "item.completed", sessionId, itemId, status: "ok", text: "Keep this context" })
  source.daemon.store.sessionSink.append({ type: "turn.completed", sessionId, turnId })
  expect(await source.json("/sync/start", { value: {} })).toBe(true)
  const history = await source.json("/sync/history", { value: {} })
  expect(history.map((entry: any) => entry.seq)).toEqual([0, 1, 2, 3, 4])
  expect(await source.json("/sync/history", { value: { [sessionId]: 2 } })).toHaveLength(2)
  const events = history.map(({ aggregate_id, ...entry }: any) => ({ ...entry, aggregateID: aggregate_id }))
  const replay = { directory: target.project, events }
  expect(await target.json("/sync/replay", { value: replay })).toEqual({ sessionID: sessionId })
  expect(target.daemon.store.engineMessages.load(sessionId, "native")).toEqual([{ role: "user", content: "Keep this context" }])
  expect(await target.json("/sync/replay", { value: replay })).toEqual({ sessionID: sessionId })
  expect(target.daemon.store.readAfter(sessionId, 0)).toHaveLength(5)
  expect((await target.request("/sync/replay", { value: { ...replay, directory: source.project } })).status).toBe(403)
  const pending = ids("session")
  const unsettled = events.slice(0, 4).map((entry: any) => ({ ...entry, aggregateID: pending }))
  expect((await target.request("/sync/replay", { value: { directory: target.project, events: unsettled } })).status).toBe(409)
  expect(target.daemon.store.hasSession(pending)).toBe(false)
  const donor = [{ id: "donor", aggregateID: pending, seq: 0, type: "session.next.prompted.1", data: {} }]
  expect((await target.request("/sync/replay", { value: { directory: target.project, events: donor } })).status).toBe(501)
  const malformed = events.map((entry: any, i: number) => ({ ...entry, aggregateID: pending, ...(i === 3 ? { data: { bad: "invalid" } } : {}) }))
  expect((await target.request("/sync/replay", { value: { directory: target.project, events: malformed } })).status).toBe(400)
  expect(target.daemon.store.hasSession(pending)).toBe(false)
  expect((await target.request("/sync/replay", { value: { directory: target.project, events: events.map((entry: any, i: number) => ({ ...entry, seq: i + 1 })) } })).status).toBe(409)
})

/** A settled session with `turns` complete turns, returned as the replay form of its history. */
function settledHistory(h: Awaited<ReturnType<typeof boot>>, sessionId: SessionId, turns: Array<{ user: string; agent: string; attachments?: Array<{ sha256: string; bytes: number; mime: string }> }>) {
  h.daemon.store.createSession({ id: sessionId, directory: h.project, title: "Incremental" })
  for (const turn of turns) {
    const turnId = ids("turn"), user = ids("item"), agent = ids("item")
    h.daemon.store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
    h.daemon.store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId: user, kind: "user_message" })
    h.daemon.store.sessionSink.append({ type: "item.completed", sessionId, itemId: user, status: "ok", text: turn.user, ...(turn.attachments ? { attachments: turn.attachments } : {}) })
    h.daemon.store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId: agent, kind: "agent_message" })
    h.daemon.store.sessionSink.append({ type: "item.completed", sessionId, itemId: agent, status: "ok", text: turn.agent })
    h.daemon.store.sessionSink.append({ type: "turn.completed", sessionId, turnId })
  }
  return h.daemon.store.projectSync.history([h.project], {}).events.filter((event) => event.sessionId === sessionId).map(({ sessionId: aggregateID, seq, type, ...data }) => ({ id: `${aggregateID}:${seq - 1}`, aggregateID, seq: seq - 1, type, data }))
}

test("native replay continues a stored session from where it ends, resends must match, gaps and conflicts are refused", async () => {
  const source = await boot(), target = await boot(), sessionId = ids("session")
  const history = settledHistory(source, sessionId, [{ user: "first question", agent: "first answer" }, { user: "second question", agent: "second answer" }])
  expect(history).toHaveLength(13)
  const replay = (events: unknown[], directory = target.project) => target.request("/sync/replay", { value: { directory, events } })
  expect((await replay(history.slice(0, 7))).status).toBe(200)
  expect(target.daemon.store.engineMessages.load(sessionId, "native")).toEqual([{ role: "user", content: "first question" }, { role: "assistant", content: "first answer", toolCalls: [] }])
  const gap = await replay(history.slice(8))
  expect(gap.status).toBe(409)
  expect((await gap.json()).error.message).toContain("must continue at 7")
  expect((await replay(history.slice(7))).status).toBe(200)
  expect(target.daemon.store.readAfter(sessionId, 0)).toHaveLength(13)
  expect(target.daemon.store.engineMessages.load(sessionId, "native").map((message: any) => message.content)).toEqual(["first question", "first answer", "second question", "second answer"])
  expect((await replay(history.slice(3))).status).toBe(200)
  expect(target.daemon.store.readAfter(sessionId, 0)).toHaveLength(13)
  const changed = history.slice(5).map((entry: any, i: number) => (i === 0 ? { ...entry, data: { ...entry.data, at: entry.data.at + 1 } } : entry))
  expect((await replay(changed)).status).toBe(409)
  const unsettled = settledHistory(source, ids("session"), [{ user: "q", agent: "a" }]).slice(0, 5)
  expect((await replay(unsettled)).status).toBe(409)
  expect(target.daemon.store.readAfter(sessionId, 0)).toHaveLength(13)
})

test("blobs referenced by replayed events upload in verified chunks first and read back by chunk, only inside the project", async () => {
  const source = await boot(), target = await boot(), sessionId = ids("session")
  const bytes = Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 7) % 251))
  const ref = source.daemon.store.putBlob(bytes, "application/octet-stream")
  const history = settledHistory(source, sessionId, [{ user: "see attachment", agent: "seen", attachments: [ref] }])
  const replay = () => target.request("/sync/replay", { value: { directory: target.project, events: history } })
  const missing = await replay()
  expect(missing.status).toBe(400)
  expect((await missing.json()).error.message).toContain("was not uploaded")
  expect(target.daemon.store.hasSession(sessionId)).toBe(false)
  const chunk = (offset: number, length: number, extra: Record<string, unknown> = {}) => ({ sha256: ref.sha256, bytes: ref.bytes, mime: ref.mime, offset, data: bytes.subarray(offset, offset + length).toString("base64"), ...extra })
  const put = (value: unknown, token?: string) => target.request("/sync/blob", { value, ...(token ? { token } : {}) })
  expect((await put(chunk(0, 100_000), target.observer)).status).toBe(403)
  expect(await (await put(chunk(0, 100_000))).json()).toEqual({ sha256: ref.sha256, bytes: ref.bytes, received: 100_000, stored: false })
  const outOfOrder = await put(chunk(200_000, 100_000))
  expect(outOfOrder.status).toBe(409)
  expect(await (await put(chunk(100_000, 100_000))).json()).toMatchObject({ received: 200_000, stored: false })
  const tampered = { sha256: createHash("sha256").update("abc").digest("hex"), bytes: 3, mime: "text/plain", offset: 0, data: Buffer.from("abd").toString("base64") }
  expect((await put(tampered)).status).toBe(400)
  expect(existsSync(target.daemon.store.blobPath(tampered.sha256))).toBe(false)
  expect(await (await put(chunk(0, 128 * 1024))).json()).toMatchObject({ received: 128 * 1024, stored: false })
  expect(await (await put(chunk(128 * 1024, 128 * 1024))).json()).toMatchObject({ received: 256 * 1024, stored: false })
  expect(await (await put(chunk(256 * 1024, bytes.length - 256 * 1024))).json()).toEqual({ sha256: ref.sha256, bytes: ref.bytes, received: ref.bytes, stored: true })
  expect(readFileSync(target.daemon.store.blobPath(ref.sha256)).equals(bytes)).toBe(true)
  expect((await put({ ...chunk(0, 10), data: "not base64!!" })).status).toBe(400)
  expect((await replay()).status).toBe(200)
  expect(target.daemon.store.readAfter(sessionId, 0).some((event: any) => event.attachments?.[0]?.sha256 === ref.sha256)).toBe(true)
  const read = async (offset: number, h = target, token?: string) => h.request("/sync/blob/read", { value: { sha256: ref.sha256, offset }, ...(token ? { token } : {}) })
  const first = await (await read(0)).json()
  expect(first).toMatchObject({ sha256: ref.sha256, mime: ref.mime, bytes: ref.bytes, offset: 0, done: false })
  expect(Buffer.from(first.data, "base64").byteLength).toBe(128 * 1024)
  const parts = [Buffer.from(first.data, "base64")]
  for (let offset = parts[0]!.byteLength; offset < ref.bytes; offset += 128 * 1024) {
    const next = await (await read(offset)).json()
    parts.push(Buffer.from(next.data, "base64"))
    if (offset + 128 * 1024 >= ref.bytes) expect(next.done).toBe(true)
  }
  expect(Buffer.concat(parts).equals(bytes)).toBe(true)
  expect((await read(0, target, target.observer)).status).toBe(403)
  expect((await read(ref.bytes + 1)).status).toBe(400)
  expect((await target.request("/sync/blob/read", { value: { sha256: "0".repeat(64) } })).status).toBe(403)
  const other = await boot()
  expect((await other.request("/sync/blob/read", { value: { sha256: ref.sha256 } })).status).toBe(403)
  expect(isReadOnlyCommand("project.rest")).toBe(false)
})

/** One donor (v1) session: a user message answered by an assistant message with text, reasoning and a finished tool call. */
function donorHistory(aggregateID = "ses_donor_one", extra: Array<{ type: string; data: Record<string, unknown> }> = []) {
  const at = 1_750_000_000_000
  const user = { id: "msg_u1", sessionID: aggregateID, role: "user", time: { created: at + 10 }, agent: "build", model: { providerID: "p", modelID: "m" } }
  const assistant = { id: "msg_a1", sessionID: aggregateID, role: "assistant", parentID: "msg_u1", time: { created: at + 20, completed: at + 90 }, modelID: "m", providerID: "p", tokens: {}, cost: 0 }
  const events = [
    { type: "session.created.1", data: { sessionID: aggregateID, info: { id: aggregateID, slug: "s", projectID: "pr", directory: "/donor/elsewhere", title: "New session", version: "1", time: { created: at, updated: at } } } },
    { type: "message.updated.1", data: { sessionID: aggregateID, info: user } },
    { type: "message.part.updated.1", data: { sessionID: aggregateID, time: at + 11, part: { id: "prt_1", sessionID: aggregateID, messageID: "msg_u1", type: "text", text: "Summarize the repo" } } },
    { type: "message.updated.1", data: { sessionID: aggregateID, info: { ...assistant, time: { created: at + 20 } } } },
    { type: "message.part.updated.1", data: { sessionID: aggregateID, time: at + 21, part: { id: "prt_2", sessionID: aggregateID, messageID: "msg_a1", type: "step-start" } } },
    { type: "message.part.updated.1", data: { sessionID: aggregateID, time: at + 22, part: { id: "prt_3", sessionID: aggregateID, messageID: "msg_a1", type: "reasoning", text: "Look at the tree", time: { start: at + 22 } } } },
    { type: "message.part.updated.1", data: { sessionID: aggregateID, time: at + 30, part: { id: "prt_4", sessionID: aggregateID, messageID: "msg_a1", type: "tool", callID: "c1", tool: "read", state: { status: "running", input: { path: "a.ts" }, time: { start: at + 30 } } } } },
    { type: "message.part.updated.1", data: { sessionID: aggregateID, time: at + 40, part: { id: "prt_4", sessionID: aggregateID, messageID: "msg_a1", type: "tool", callID: "c1", tool: "read", state: { status: "completed", input: { path: "a.ts" }, output: "export const a = 1", title: "a.ts", metadata: {}, time: { start: at + 30, end: at + 40 } } } } },
    { type: "message.part.updated.1", data: { sessionID: aggregateID, time: at + 50, part: { id: "prt_5", sessionID: aggregateID, messageID: "msg_a1", type: "text", text: "A tiny TypeScript repo." } } },
    { type: "message.updated.1", data: { sessionID: aggregateID, info: assistant } },
    { type: "session.updated.1", data: { sessionID: aggregateID, info: { title: "Repo summary" } } },
    ...extra,
  ]
  return events.map((event, seq) => ({ id: `evt_${seq}`, aggregateID, seq, ...event }))
}

test("a donor v1 history converts to native turns and items, replays as an exact retry, and refuses what has no native equivalent", async () => {
  const target = await boot()
  const replay = (events: unknown[]) => target.request("/sync/replay", { value: { directory: target.project, events } })
  const first = await replay(donorHistory())
  expect(first.status).toBe(200)
  const { sessionID } = await first.json()
  expect(sessionID).toMatch(/^ses_[0-9A-HJKMNP-TV-Z]{26}$/)
  expect(target.daemon.store.sessionInfo(sessionID)).toMatchObject({ title: "Repo summary", directory: target.project })
  const stored = target.daemon.store.readAfter(sessionID, 0)
  expect(stored.map((event: any) => event.type)).toEqual(["session.created", "turn.started", "item.started", "item.completed", "item.started", "item.completed", "item.started", "item.completed", "item.started", "item.completed", "turn.completed"])
  expect(stored[0]).toMatchObject({ at: 1_750_000_000_000, directory: target.project })
  expect(stored.find((event: any) => event.type === "item.started" && event.kind === "tool_call")).toMatchObject({ meta: { tool: "read", title: "a.ts" } })
  expect(stored.filter((event: any) => event.type === "item.completed").map((event: any) => event.text)).toEqual(["Summarize the repo", "Look at the tree", "export const a = 1", "A tiny TypeScript repo."])
  expect(target.daemon.store.engineMessages.load(sessionID, "native")).toEqual([{ role: "user", content: "Summarize the repo" }, { role: "assistant", content: "[Synced tool result]\nexport const a = 1", toolCalls: [] }, { role: "assistant", content: "A tiny TypeScript repo.", toolCalls: [] }])
  expect(await (await replay(donorHistory())).json()).toEqual({ sessionID })
  expect(target.daemon.store.readAfter(sessionID, 0)).toHaveLength(stored.length)
  const history = await target.json("/sync/history", { value: {} })
  expect(history.map((entry: any) => entry.type)).toEqual(stored.map((event: any) => event.type))

  const refused = async (events: unknown[], status: number) => { expect((await replay(events)).status).toBe(status) }
  const part = (id: string, type: string, rest: Record<string, unknown> = {}) => ({ type: "message.part.updated.1", data: { sessionID: "ses_donor_two", time: 1, part: { id, sessionID: "ses_donor_two", messageID: "msg_a1", type, ...rest } } })
  await refused(donorHistory("ses_donor_two", [part("prt_9", "file", { mime: "image/png", url: "data:" })]), 501)
  await refused(donorHistory("ses_donor_two", [part("prt_9", "compaction", { auto: true })]), 501)
  await refused(donorHistory("ses_donor_two", [{ type: "session.deleted.1", data: { sessionID: "ses_donor_two", info: {} } }]), 501)
  await refused(donorHistory("ses_donor_two", [{ type: "session.next.prompted.1", data: {} }]), 501)
  await refused(donorHistory("ses_donor_two", [part("prt_4", "tool", { callID: "c1", tool: "read", state: { status: "running", input: {}, time: { start: 1 } } })]), 409)
  await refused(donorHistory("ses_donor_two", [{ type: "message.updated.1", data: { sessionID: "ses_donor_two", info: { id: "msg_u2", sessionID: "ses_donor_two", role: "user", time: { created: 2_000_000_000_000 } } } }]), 409)
  await refused(donorHistory("ses_donor_two").slice(1), 501)
  await refused([...donorHistory("ses_donor_two").slice(0, 3), { id: "n", aggregateID: "ses_donor_two", seq: 3, type: "turn.started", data: {} }], 400)
  await refused(donorHistory("ses_donor_two").map((entry, i) => (i === 4 ? { ...entry, seq: 9 } : entry)), 400)
  await refused(donorHistory("ses_donor_two").map((entry, i) => (i === 2 ? { ...entry, data: { sessionID: "ses_other", part: {} } } : entry)), 400)
  expect(target.daemon.store.hasSession(sessionID)).toBe(true)
  expect(target.daemon.store.listSessions().filter((row) => row.title === "Repo summary")).toHaveLength(1)
  const failed = donorHistory("ses_donor_three").map((entry) => (entry.type === "message.updated.1" && (entry.data.info as any).role === "assistant" ? { ...entry, data: { ...entry.data, info: { ...(entry.data.info as any), time: { created: 1, completed: 2 }, error: { name: "APIError", data: { message: "rate limited" } } } } } : entry))
  const failedId = (await (await replay(failed)).json()).sessionID
  expect(target.daemon.store.readAfter(failedId, 0).at(-1)).toMatchObject({ type: "turn.failed", error: { code: "APIError", message: "rate limited" } })
})

test("large sync histories drain by cursor without losing events or leaking other projects", async () => {
  const h = await boot(), sessionId = ids("session")
  h.daemon.store.createSession({ id: sessionId, directory: h.project, title: "Paged" })
  const itemId = ids("item")
  for (let i = 0; i < 60; i++) h.daemon.store.sessionSink.append({ type: "item.delta", sessionId, itemId, text: `${i}:` + "x".repeat(4000) })
  const foreign = ids("session"), elsewhere = realpathSync(tempDir())
  h.daemon.store.createSession({ id: foreign, directory: elsewhere, title: "Private project" })
  const first = await h.request("/sync/history", { value: {} })
  expect(first.status).toBe(200)
  expect(first.headers.get("x-mendcode-sync-more")).toBe("true")
  const page = await first.json()
  expect(page.every((entry: any) => entry.aggregate_id === sessionId)).toBe(true)
  const second = await h.request("/sync/history", { value: { [sessionId]: page.at(-1).seq } })
  expect(second.headers.get("x-mendcode-sync-more")).toBe("false")
  const tail = await second.json()
  expect([...page, ...tail].map((entry: any) => entry.seq)).toEqual(Array.from({ length: 61 }, (_, i) => i))
  expect(await h.json("/sync/history", { value: { [sessionId]: 60 } })).toEqual([])
})

test("worktree mutation leases reject session creation during startup and aborted replay stays atomic", async () => {
  const h = await boot(true)
  const preview = await h.client.worktrees(h.project, { operation: "preview", input: { name: "locked" } })
  if (!preview.ok || !preview.report.preview) throw new Error("Missing preview")
  const directory = preview.report.preview.target.path
  const creating = h.request("/experimental/worktree", { value: { name: "locked", runStartup: true, startCommand: "printf waiting > started; while test ! -e release; do sleep 0.01; done" } })
  try {
    for (let i = 0; i < 200 && !existsSync(path.join(directory, "started")); i++) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(existsSync(path.join(directory, "started"))).toBe(true)
    const denied = await h.client.send({ type: "session.create", directory, title: "Race" })
    expect(denied).toMatchObject({ ok: false, error: { code: "busy" } })
    expect(h.daemon.store.listSessions({ directory })).toHaveLength(0)
  } finally {
    writeFileSync(path.join(directory, "release"), "release")
    expect((await creating).status).toBe(200)
  }
  const sessionId = ids("session"), controller = new AbortController()
  controller.abort()
  const response = await h.request("/sync/replay", { signal: controller.signal, value: { directory: h.project, events: [{ id: "event", aggregateID: sessionId, seq: 0, type: "session.created", data: { at: 1, directory: h.project, title: "Cancelled" } }] } })
  // An already-aborted request stops at the HTTP bridge before replay dispatch.
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ error: { code: "internal", message: "HTTP request ended" } })
  expect(h.daemon.store.hasSession(sessionId)).toBe(false)
}, 15_000)
