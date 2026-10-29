import { afterEach, expect, test } from "bun:test"
import path from "node:path"
import { symlinkSync, readFileSync, unlinkSync } from "node:fs"
import { createIdFactory, Command, isReadOnlyCommand, type DebugInput } from "@mendcode/protocol"
import { createDebugSnapshots } from "../src/debug-snapshots"
import { b67Harness, type B67Harness } from "./b67-harness"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function boot() { const h = await b67Harness(); cleanups.push(h.cleanup); return h }
async function data(h: B67Harness, input: DebugInput): Promise<any> {
  const reply = await h.client.debug(h.project, input)
  if (!reply.ok) throw new Error(reply.error.message)
  return reply.report.data
}
function git(h: B67Harness, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: h.project, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString()
}
function repo(h: B67Harness) {
  git(h, "init", "--quiet")
  git(h, "add", ".")
  git(h, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "--quiet", "-m", "fixture")
}

test("B67 protocol validates inputs; debug, snapshots and raw SQL are unavailable to read-only peers", () => {
  const id = createIdFactory()("command"), clientId = createIdFactory()("client")
  expect(Command.safeParse({ id, clientId, type: "debug.query", directory: "/tmp/project", input: { operation: "snapshot.patch", hash: "-option" } }).success).toBe(false)
  expect(Command.safeParse({ id, clientId, type: "debug.query", directory: "/tmp/project", input: { operation: "agent", name: "build", params: [] } }).success).toBe(false)
  expect(Command.safeParse({ id, clientId, type: "db.query", operation: "query", sql: "SELECT 1" }).success).toBe(true)
  expect(isReadOnlyCommand("debug.query")).toBe(false)
  expect(isReadOnlyCommand("db.query")).toBe(false)
})

test("B67 database opens the daemon DB read-only, returns columns, SQL blobs and bounded rows", async () => {
  const h = await boot()
  expect(await h.client.database("path")).toMatchObject({ ok: true, report: { path: path.join(h.dir, "mendd.db") } })
  expect(await h.client.database("query", "SELECT 42 AS value, 'a;b' AS text, x'6162' AS blob")).toMatchObject({ ok: true, report: { columns: ["value", "text", "blob"], rows: [{ value: 42, text: "a;b", blob: { encoding: "base64", content: "YWI=" } }] } })
  expect(await h.client.database("query", "SELECT name FROM sqlite_schema WHERE type='table'")).toMatchObject({ ok: true, report: { rows: expect.any(Array) } })
  expect(await h.client.database("query", "PRAGMA table_info(sessions)")).toMatchObject({ ok: true })
  expect(await h.client.database("query", "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < 2000) SELECT x FROM n")).toMatchObject({ ok: true, report: { rows: expect.any(Array), truncated: true } })
  const empty = await h.client.database("query", "SELECT id FROM sessions WHERE 0")
  expect(empty).toMatchObject({ ok: true, report: { columns: ["id"], rows: [], truncated: false } })
  for (const sql of ["DELETE FROM sessions", "WITH n AS (SELECT 1) DELETE FROM sessions", "ATTACH DATABASE '/tmp/else.db' AS other", "PRAGMA user_version=500", "SELECT 1; SELECT 2", "SELECT missing FROM no_table"]) expect(await h.client.database("query", sql)).toMatchObject({ ok: false, error: { code: "invalid_command" } })
  expect(await h.client.send({ type: "daemon.info" })).toMatchObject({ ok: true })
})

test("B67 config/paths/info/startup/projects/skills describe local v2 state without provider calls", async () => {
  const h = await boot()
  h.put(path.join(h.dir, "skills", "audit", "SKILL.md"), "---\nname: audit\ndescription: Review local sources\n---\nInspect source.\n")
  const session = await h.client.send({ type: "session.create", directory: h.project, title: "Support" })
  expect(session.ok).toBe(true)
  expect(await data(h, { operation: "config" })).toMatchObject({ settings: expect.any(Object), paths: { database: path.join(h.dir, "mendd.db") } })
  expect(await data(h, { operation: "paths" })).toMatchObject({ extensions: path.join(h.dir, "extensions") })
  expect(await data(h, { operation: "info" })).toMatchObject({ engine: "faux", runtime: "MendCode", plugins: [] })
  expect((await data(h, { operation: "startup" })).elapsedMs).toBeGreaterThan(0)
  expect(await data(h, { operation: "projects" })).toMatchObject({ projects: [{ directory: h.project, sessions: 1 }], truncated: false })
  expect((await data(h, { operation: "skills" })).some((skill: any) => skill.name === "audit" && skill.enabled)).toBe(true)
})

test("B67 agent tools obey trust, allow/deny and permission rules; explicit execution needs approval", async () => {
  const h = await boot()
  h.put(path.join(h.dir, "agents", "reader.md"), "---\ndescription: Reads only\nmode: primary\ntools: read\n---\nAPI_KEY=secretvalue123456\n")
  const agent = await data(h, { operation: "agent", name: "reader" })
  expect(agent.tools).toEqual({ read: true, write: false })
  expect(JSON.stringify(agent)).not.toContain("secretvalue123456")
  expect(await h.client.debug(h.project, { operation: "agent", name: "missing" })).toMatchObject({ ok: false })
  expect(await h.client.debug(h.project, { operation: "agent", name: "reader", tool: "write", approve: true })).toMatchObject({ ok: false, error: { message: expect.stringContaining("disabled") } })
  expect(await h.client.debug(h.project, { operation: "agent", name: "reader", tool: "read", params: { path: "README.md" } })).toMatchObject({ ok: false, error: { message: expect.stringContaining("--approve") } })
  const executed = await data(h, { operation: "agent", name: "reader", tool: "read", params: { path: "README.md" }, approve: true })
  expect(executed.result.output).toContain("Project notes")
  expect(executed.sessionId).toMatch(/^ses_/)
  await h.client.send({ type: "settings.set", patch: { permission: { read: "deny" } } })
  expect(await h.client.debug(h.project, { operation: "agent", name: "reader", tool: "read", params: { path: "README.md" }, approve: true })).toMatchObject({ ok: false })
  h.put(path.join(h.project, ".mendcode", "agents", "project-reader.md"), "---\ndescription: Project agent\n---\nRead.\n")
  expect(await h.client.debug(h.project, { operation: "agent", name: "project-reader" })).toMatchObject({ ok: false })
})

test("B67 file search/list/tree/read handle ignore rules, text/diffs/images/binary, caps and containment", async () => {
  const h = await boot()
  repo(h)
  h.put(path.join(h.project, "README.md"), "Changed notes\nAPI_KEY=secretvalue123456\n")
  h.put(path.join(h.project, ".gitignore"), "ignored/\n")
  h.put(path.join(h.project, "ignored", "hidden.md"), "hidden")
  h.put(path.join(h.project, "new.md"), "new\n")
  expect(await data(h, { operation: "file.search", query: "app" })).toContain("src/app.fake")
  const list = await data(h, { operation: "file.list", path: "." })
  expect(list.nodes.find((node: any) => node.name === "ignored")).toMatchObject({ type: "directory", ignored: true })
  expect(list.nodes.some((node: any) => node.name === ".git")).toBe(false)
  const tree = await data(h, { operation: "file.tree", path: "src" })
  expect(tree.lines).toContain("app.fake")
  const file = await data(h, { operation: "file.read", path: "README.md" })
  expect(file.content).toContain("Changed notes")
  expect(JSON.stringify(file)).not.toContain("secretvalue123456")
  expect(file.patch.hunks.length).toBeGreaterThan(0)
  const status = await data(h, { operation: "file.status" })
  expect(status).toContainEqual(expect.objectContaining({ path: "new.md", status: "added" }))
  expect(await data(h, { operation: "file.read", path: "absent.txt" })).toEqual({ type: "text", content: "" })
  h.put(path.join(h.project, "binary.bin"), "hello\0binary")
  expect(await data(h, { operation: "file.read", path: "binary.bin" })).toMatchObject({ type: "binary", content: "" })
  h.put(path.join(h.project, "image.png"), "PNG fixture")
  expect(await data(h, { operation: "file.read", path: "image.png" })).toMatchObject({ encoding: "base64", mimeType: "image/png" })
  h.put(path.join(h.project, "big.txt"), "x".repeat(90000))
  expect(await data(h, { operation: "file.read", path: "big.txt" })).toMatchObject({ truncated: true })
  h.put(path.join(h.root, "outside.txt"), "private")
  symlinkSync(path.join(h.root, "outside.txt"), path.join(h.project, "escape"))
  for (const target of ["../outside.txt", "escape"]) expect(await h.client.debug(h.project, { operation: "file.read", path: target })).toMatchObject({ ok: false, error: { message: expect.stringContaining("escapes project") } })
})

test("B67 snapshots track/patch/diff persist across service instances without changing the project's index", async () => {
  const h = await boot()
  repo(h)
  const index = readFileSync(path.join(h.project, ".git", "index"))
  const { hash } = await data(h, { operation: "snapshot.track" })
  expect(hash).toMatch(/^[a-f0-9]{40}$/)
  h.put(path.join(h.project, "README.md"), "Changed\n")
  unlinkSync(path.join(h.project, "src", "app.fake"))
  h.put(path.join(h.project, "new.md"), "Added\n")
  const patch = await data(h, { operation: "snapshot.patch", hash })
  expect(patch.files).toEqual(["README.md", "new.md", "src/app.fake"].map((file) => path.join(h.project, file)))
  const diff = await data(h, { operation: "snapshot.diff", hash })
  expect(diff.diff).toContain("+Changed")
  expect(diff.diff).toContain("deleted file mode")
  expect(await createDebugSnapshots(h.dir)(h.project, "snapshot.patch", hash)).toEqual(patch)
  expect(readFileSync(path.join(h.project, ".git", "index"))).toEqual(index)
  const { hash: next } = await data(h, { operation: "snapshot.track" })
  expect(next).not.toBe(hash)
  expect((await data(h, { operation: "snapshot.patch", hash: next })).files).toEqual([])
  expect(await h.client.debug(h.project, { operation: "snapshot.diff", hash: "0".repeat(40) })).toMatchObject({ ok: false })
}, 15000)

test("B67 LSP diagnostics/symbols/document-symbols use the daemon and a local fake server", async () => {
  const h = await boot()
  const diagnostics = await data(h, { operation: "lsp.diagnostics", path: "src/app.fake" })
  expect(diagnostics.diagnostics[path.join(h.project, "src/app.fake")]).toHaveLength(1)
  expect(diagnostics.settled).toBe(true)
  expect(await data(h, { operation: "lsp.symbols", query: "execute" })).toContainEqual(expect.objectContaining({ name: "execute0" }))
  expect(await data(h, { operation: "lsp.document-symbols", path: new URL(`file://${h.project}/src/app.fake`).href })).toContainEqual(expect.objectContaining({ name: "Service", children: [expect.objectContaining({ name: "execute" })] }))
  expect(await h.client.debug(h.project, { operation: "lsp.document-symbols", path: "README.md" })).toMatchObject({ ok: false })
}, 10000)
