import { afterEach, expect, test } from "bun:test"
import { mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createLspManager } from "@mendcode/lsp"
import { FileContent, FileNode, FileSearchMatch, FileStatus, createIdFactory, type FileRestInput } from "@mendcode/protocol"
import { startDaemon } from "../src/daemon"
import { httpConfig, httpOpenApi } from "../src/http"
import { createFileFrecency } from "../src/file-frecency"
import { readFileApi } from "../src/file-rest"
import { fileProcess } from "../src/file-rest-process"
import { remoteTokens } from "../src/remote"
import { cleanTemps, tempDir } from "../../../apps/cli/test/session-ui-harness"
import { toolGate } from "../../../scripts/test-budget"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); cleanTemps() })
const ids = createIdFactory()
function put(root: string, file: string, value: string | Buffer) { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), value) }
function git(root: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } })
  if (result.exitCode) throw new Error(result.stderr.toString())
  return result.stdout.toString()
}
function init(root: string) { git(root, "init", "-q"); git(root, "config", "user.name", "test"); git(root, "config", "user.email", "test@example.invalid") }
async function boot(lsp?: ReturnType<typeof createLspManager>) {
  const dir = tempDir(), project = realpathSync(tempDir())
  const tokens = remoteTokens(dir), full = tokens.create({ name: "full" }).token, observer = tokens.create({ name: "observer", readOnly: true }).token
  const daemon = await startDaemon({ dir, defaultDirectory: project, socketPath: path.join(dir, "daemon.sock"), http: { enabled: true }, httpListen: false, extensionsEnabled: false, ...(lsp ? { lsp } : {}), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanup.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "B35", reconnect: false })
  cleanup.push(() => client.close())
  await client.connect()
  const clientId = ids("client")
  const request = async (route: string, options: { token?: string; method?: string; headers?: Record<string, string>; value?: unknown; signal?: AbortSignal } = {}) => {
    const response = await daemon.httpAdapter!.fetch(new Request(`http://127.0.0.1:4096${route}`, { method: options.method ?? (options.value ? "POST" : "GET"), headers: { Authorization: `Bearer ${options.token ?? full}`, "Content-Type": "application/json", ...options.headers }, ...(options.value ? { body: JSON.stringify(options.value) } : {}), ...(options.signal ? { signal: options.signal } : {}) }))
    if (!response) throw new Error("Unexpected WebSocket response")
    return response
  }
  return { dir, project, daemon, client, tokens, full, observer, request, command: (input: FileRestInput, token = full) => request("/command", { token, value: { type: "file.rest.read", id: ids("command"), clientId, directory: project, input } }) }
}

/** `/find` and `/find/file` are backed by ripgrep (docs/file-rest.md: missing ripgrep is a 501, never a download), so these cases need it; the workflow installs it and lists it in MENDCODE_REQUIRE_TOOLS. */
const rg = toolGate("rg")

rg.test(`B35 text search returns ripgrep JSON byte offsets and ten matches per file${rg.suffix}`, async () => {
  const h = await boot()
  put(h.project, "src/app.ts", `é execute\n${"execute twice execute\n".repeat(12)}`)
  put(h.project, ".hidden.ts", "execute\n")
  put(h.project, ".git/private", "execute\n")
  const response = await h.request("/find?pattern=execute")
  expect(response.status).toBe(200)
  const matches = FileSearchMatch.array().parse(await response.json())
  expect(matches.filter((match) => match.path.text === "src/app.ts")).toHaveLength(10)
  expect(matches.find((match) => match.path.text === "src/app.ts")).toEqual({ path: { text: "src/app.ts" }, lines: { text: "é execute\n" }, line_number: 1, absolute_offset: 0, submatches: [{ match: { text: "execute" }, start: 3, end: 10 }] })
  expect(matches.some((match) => match.path.text.startsWith(".git/"))).toBe(false)
  expect(matches.some((match) => match.path.text === ".hidden.ts")).toBe(true)
  const native = await h.client.filesApi(h.project, { operation: "find.text", pattern: "execute" })
  expect(native.ok).toBe(true)
  const byLocation = (a: { path: { text: string }; line_number: number }, b: { path: { text: string }; line_number: number }) => a.path.text.localeCompare(b.path.text) || a.line_number - b.line_number
  if (native.ok) expect(native.value.sort(byLocation)).toEqual(matches.sort(byLocation))
  expect(await (await h.request("/find?pattern=absent")).json()).toEqual([])
  expect((await h.request("/find?pattern=%5B")).status).toBe(400)
})

rg.test(`B35 name search defaults to directories, respects type/dirs/limits and prioritizes opened files${rg.suffix}`, async () => {
  const h = await boot()
  init(h.project)
  put(h.project, "src/alpha.ts", "alpha")
  put(h.project, "src/beta.ts", "beta")
  put(h.project, ".hidden/item.ts", "hidden")
  put(h.project, "ignored/item.ts", "ignored")
  put(h.project, ".gitignore", "ignored/\n")
  expect(await (await h.request("/find/file?query=")).json()).toEqual(["src/", ".hidden/"])
  expect(await (await h.request("/find/file?query=src&type=directory")).json()).toEqual(["src/"])
  expect(await (await h.request("/find/file?query=bt&dirs=false")).json()).toEqual(["src/beta.ts"])
  expect(await (await h.request("/find/file?query=src&type=file&dirs=true&limit=1")).json()).toHaveLength(1)
  const before = await h.client.filesApi(h.project, { operation: "find.files", query: "", dirs: false })
  expect(before.ok).toBe(true)
  expect((await h.request("/file/content?path=src/beta.ts")).status).toBe(200)
  const after = await h.client.filesApi(h.project, { operation: "find.files", query: "", dirs: false })
  expect(after.ok).toBe(true)
  if (after.ok) expect(after.value[0]).toBe("src/beta.ts")
  const fresh = createFileFrecency(h.dir)
  expect(fresh.score(h.project, "src/beta.ts")).toBeGreaterThan(0)
  expect(readFileSync(path.join(h.dir, "file-frecency.json"), "utf8")).not.toContain('"beta"')
})

test("B35 file list uses donor nodes, directory-first order and ignore metadata", async () => {
  const h = await boot(), external = realpathSync(tempDir())
  init(h.project)
  put(h.project, "src/app.ts", "source")
  put(h.project, "ignored.log", "ignored")
  put(h.project, "keep.log", "kept")
  put(h.project, ".gitignore", "*.log\n")
  put(h.project, ".ignore", "!keep.log\n")
  put(h.project, ".DS_Store", "excluded")
  symlinkSync(external, path.join(h.project, "external"))
  symlinkSync(path.join(h.project, "src"), path.join(h.project, "internal"))
  const nodes = FileNode.array().parse(await (await h.request("/file?path=")).json())
  expect(nodes[0]!.type).toBe("directory")
  expect(nodes.find((node) => node.name === "src")).toEqual({ name: "src", path: "src", absolute: path.join(h.project, "src"), type: "directory", ignored: false })
  expect(nodes.find((node) => node.name === "ignored.log")?.ignored).toBe(true)
  expect(nodes.find((node) => node.name === "keep.log")?.ignored).toBe(false)
  expect(nodes.some((node) => [".git", ".DS_Store", "external"].includes(node.name))).toBe(false)
  expect(nodes.find((node) => node.name === "internal")?.type).toBe("directory")
  expect(await (await h.request("/file?path=missing")).json()).toEqual([])
  expect((await h.client.filesApi(h.project, { operation: "file.list", path: "src" }))).toMatchObject({ ok: true, value: [{ name: "app.ts", path: "src/app.ts" }] })
})

test("B35 file content preserves donor text/image/binary shapes and full-context staged/unstaged patches", async () => {
  const h = await boot()
  init(h.project)
  put(h.project, "app.ts", "first\nold\nlast\n")
  put(h.project, "staged.ts", "old\n")
  git(h.project, "add", "."); git(h.project, "commit", "-qm", "initial")
  put(h.project, "app.ts", "first\nnew\nlast\n")
  put(h.project, "staged.ts", "new\n")
  git(h.project, "add", "staged.ts")
  for (const file of ["app.ts", "staged.ts"]) {
    const reply = await h.client.filesApi(h.project, { operation: "file.read", path: file })
    expect(reply.ok).toBe(true)
    if (!reply.ok) continue
    const content = FileContent.parse(reply.value)
    expect(content.content).toContain("new")
    expect(content.content.endsWith("\n")).toBe(false)
    expect(content.patch).toMatchObject({ oldFileName: file, newFileName: file, oldHeader: "old", newHeader: "new" })
    expect(content.patch!.hunks[0]!.lines).toContain("-old")
    expect(content.patch!.hunks[0]!.lines).toContain("+new")
    expect(content.diff).toContain(`--- ${file}\told`)
    if (file === "app.ts") expect(content.patch!.hunks[0]!.lines).toContain(" first")
  }
  put(h.project, "image.png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  put(h.project, "binary.bin", Buffer.from([0, 1, 2]))
  expect(await (await h.request("/file/content?path=image.png")).json()).toEqual({ type: "text", content: "iVBORw0KGgo=", encoding: "base64", mimeType: "image/png" })
  expect(await (await h.request("/file/content?path=binary.bin")).json()).toEqual({ type: "binary", content: "" })
  expect(await (await h.request("/file/content?path=missing.ts")).json()).toEqual({ type: "text", content: "" })
  expect(await (await h.request("/file/content?path=missing.png")).json()).toEqual({ type: "text", content: "" })
})

test("B35 Git status has counts, untracked/deleted states, NUL-safe names and selected-subdirectory scope", async () => {
  const h = await boot()
  expect(await (await h.request("/file/status")).json()).toEqual([])
  init(h.project)
  put(h.project, "src/app.ts", "old\n")
  put(h.project, "src/deleted.ts", "delete\n")
  put(h.project, "outside.ts", "outside\n")
  git(h.project, "add", "."); git(h.project, "commit", "-qm", "initial")
  put(h.project, "src/app.ts", "new\nextra\n")
  put(h.project, "outside.ts", "changed\n")
  renameSync(path.join(h.project, "src/deleted.ts"), path.join(realpathSync(tempDir()), "deleted.ts"))
  put(h.project, "src/weird\tname.ts", "new\n")
  const files = FileStatus.array().parse(await (await h.request("/file/status")).json())
  expect(files).toContainEqual({ path: "src/app.ts", added: 2, removed: 1, status: "modified" })
  expect(files.filter((file) => file.path === "src/deleted.ts")).toEqual([{ path: "src/deleted.ts", added: 0, removed: 0, status: "deleted" }])
  expect(files).toContainEqual({ path: "src/weird\tname.ts", added: 2, removed: 0, status: "added" })
  const reply = await h.client.filesApi(path.join(h.project, "src"), { operation: "file.status" })
  expect(reply.ok).toBe(true)
  if (reply.ok) { expect(reply.value.map((file) => file.path)).toEqual(["app.ts", "deleted.ts", "weird\tname.ts"]); expect(reply.value.some((file) => file.path.includes("outside"))).toBe(false) }
})

test("B35 all routes and native reads reject observer tokens and invalid queries before returning project content", async () => {
  const h = await boot()
  put(h.project, "private.ts", "private source")
  expect(httpConfig(h.dir).enabled).toBe(false)
  for (const route of ["/find?pattern=private", "/find/file?query=private", "/find/symbol?query=private", "/file?path=", "/file/content?path=private.ts", "/file/status"]) {
    const denied = await h.request(route, { token: h.observer })
    expect(denied.status).toBe(403)
    expect(await denied.text()).not.toContain("private source")
  }
  expect((await h.command({ operation: "file.read", path: "private.ts" }, h.observer)).status).toBe(403)
  for (const route of ["/find", "/file", "/file/content", "/find/symbol", "/find/file?query=&limit=0", "/find/file?query=&limit=201", "/find/file?query=&dirs=maybe", "/find/file?query=x&query=y", "/file/status?path=extra"]) expect((await h.request(route)).status).toBe(400)
  expect((await h.request("/file/status", { method: "POST" })).status).toBe(405)
  const spec = httpOpenApi().paths as Record<string, any>
  for (const [route, id] of [["/find", "find.text"], ["/find/file", "find.files"], ["/find/symbol", "find.symbols"], ["/file", "file.list"], ["/file/content", "file.read"], ["/file/status", "file.status"]]) expect(spec[route!]!.get.operationId).toBe(id)
  expect(spec["/find/file"].get.parameters.find((param: any) => param.name === "limit").schema.maximum).toBe(200)
  expect((await h.request("/file/status", { token: "invalid" })).status).toBe(401)
})

test("B35 registered workspace selection and canonical path checks reject traversal and external symlinks", async () => {
  const h = await boot(), other = realpathSync(tempDir())
  put(h.project, "same.ts", "project")
  put(other, "same.ts", "other")
  const registration = await h.request("/experimental/workspace", { value: { directory: other, name: "other" } })
  expect(registration.status).toBe(200)
  expect(await (await h.request(`/file/content?path=same.ts&directory=${encodeURIComponent(other)}`)).json()).toEqual({ type: "text", content: "other" })
  symlinkSync(other, path.join(h.project, "external"))
  symlinkSync(path.join(other, "same.ts"), path.join(h.project, "link.ts"))
  for (const target of ["../escape.ts", other + "/same.ts", "external/same.ts", "external/missing.ts", "link.ts"]) {
    expect((await h.request(`/file/content?path=${encodeURIComponent(target)}`)).status).toBe(403)
    expect((await h.client.filesApi(h.project, { operation: "file.read", path: target }))).toMatchObject({ ok: false, error: { code: "forbidden" } })
  }
  expect((await h.request("/file?path=external")).status).toBe(403)
  expect((await h.request("/file/status?directory=/unregistered")).status).toBe(403)
})

rg.test(`B35 name search never lists a symlink that leaves the project${rg.suffix}`, async () => {
  const h = await boot(), other = realpathSync(tempDir())
  put(other, "same.ts", "other")
  symlinkSync(path.join(other, "same.ts"), path.join(h.project, "link.ts"))
  const search = await h.client.filesApi(h.project, { operation: "find.files", query: "link" })
  expect(search).toEqual({ ok: true, value: [] })
})

test("without ripgrep or git on PATH, find answers unsupported (HTTP 501) and reading and listing still work", () => {
  const empty = tempDir(), project = realpathSync(tempDir())
  put(project, "src/app.ts", "export const value = 1\n")
  const source = pathToFileURL(path.join(import.meta.dir, "../src/file-rest.ts")).href
  const script = `
    import { readFileApi } from ${JSON.stringify(source)}
    const ask = async (input) => readFileApi({ directory: ${JSON.stringify(project)}, input }).then((reply) => ({ ok: true, value: reply.value }), (error) => ({ ok: false, code: error.code, message: error.message }))
    console.log(JSON.stringify({
      text: await ask({ operation: "find.text", pattern: "value" }),
      files: await ask({ operation: "find.files", query: "app" }),
      read: await ask({ operation: "file.read", path: "src/app.ts" }),
      list: await ask({ operation: "file.list", path: "src" }),
      status: await ask({ operation: "file.status" }),
    }))`
  const run = Bun.spawnSync([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe", env: { PATH: empty, HOME: empty } })
  expect(run.exitCode, run.stderr.toString()).toBe(0)
  const answers = JSON.parse(run.stdout.toString())
  // http-files.ts maps exactly this message to HTTP 501.
  expect(answers.text).toEqual({ ok: false, code: "unsupported", message: "ripgrep is not installed" })
  expect(answers.files).toEqual({ ok: false, code: "unsupported", message: "ripgrep is not installed" })
  expect(answers.read).toEqual({ ok: true, value: { type: "text", content: "export const value = 1" } })
  expect(answers.list.value.map((node: { name: string }) => node.name)).toEqual(["app.ts"])
  expect(answers.status).toEqual({ ok: true, value: [] })
})

test("B35 file and frame limits fail explicitly, cancellation kills local processes", async () => {
  const h = await boot()
  put(h.project, "large.txt", "x".repeat(120_001))
  put(h.project, "escaped.txt", "\x01".repeat(100_000))
  for (const target of ["large.txt", "escaped.txt"]) {
    const response = await h.request(`/file/content?path=${target}`)
    expect(response.status).toBe(400)
    expect(await response.text()).toContain("limit")
  }
  expect((await h.request("/file/content?path=large.txt", { signal: AbortSignal.abort() })).status).toBe(400)
  const abort = new AbortController()
  const process = fileProcess([Bun.which("bun")!, "-e", "setTimeout(() => {}, 10000)"], h.project, abort.signal)
  abort.abort()
  await expect(process).rejects.toThrow()
  expect(await h.client.send({ type: "daemon.info" })).toMatchObject({ ok: true })
})

test("B35 workspace symbols reuse local live LSPs, filter project URIs and leave cold discovery empty", async () => {
  const lsp = createLspManager({ settleMs: 10, registryLoader: () => ({ servers: [{ id: "fake", command: [process.execPath, path.join(import.meta.dir, "../../lsp/test/fixtures/fake-lsp.ts")], extensions: [".fake"], rootMarkers: [] }], issues: [], disableDownload: true }) })
  cleanup.push(() => lsp.stop())
  const h = await boot(lsp), other = realpathSync(tempDir())
  put(h.project, "app.fake", "function execute() {}")
  put(other, "other.fake", "function other() {}")
  expect(await (await h.request("/find/symbol?query=execute")).json()).toEqual([])
  expect(lsp.running()).toEqual([])
  expect((await h.client.lsp({ directory: h.project, filePath: "app.fake", line: 1, character: 1, operation: "hover" })).ok).toBe(true)
  await lsp.query({ cwd: other, filePath: "other.fake", line: 1, character: 1, operation: "hover" })
  const symbols = await (await h.request("/find/symbol?query=execute")).json()
  expect(symbols).toHaveLength(10)
  expect(symbols.every((item: any) => item.location.uri === pathToFileURL(path.join(h.project, "app.fake")).href)).toBe(true)
  expect(await h.client.filesApi(h.project, { operation: "find.symbols", query: "__empty__" })).toEqual({ ok: true, value: [] })
  expect((await h.request("/find/symbol?query=__error__")).status).toBe(400)
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
  const filtered = await readFileApi({ directory: h.project, input: { operation: "find.symbols", query: "" }, symbols: async () => ({ result: [{ name: "outside", kind: 12, location: { uri: pathToFileURL(path.join(other, "other.fake")).href, range } }, { name: "invalid", kind: 12, location: { uri: "file://%", range } }] }) })
  expect(filtered.value).toEqual([])
})
