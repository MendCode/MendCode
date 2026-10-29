import { afterEach, expect, test } from "bun:test"
import { chmodSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createIdFactory } from "@mendcode/protocol"
import { startDaemon } from "../src/daemon"
import { httpOpenApi } from "../src/http"
import { generateHttpApi } from "../src/http-launch"
import { remoteTokens } from "../src/remote"
import { cleanTemps, tempDir } from "../../../apps/cli/test/session-ui-harness"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); cleanTemps() })
const ids = createIdFactory()
const sha = (text: string) => createHash("sha256").update(text).digest("hex")

async function boot(edit: boolean) {
  const dir = tempDir(), project = realpathSync(tempDir())
  const tokens = remoteTokens(dir), full = tokens.create({ name: "full" }).token, observer = tokens.create({ name: "observer", readOnly: true }).token
  const daemon = await startDaemon({ dir, defaultDirectory: project, socketPath: path.join(dir, "daemon.sock"), http: { enabled: true, ...(edit ? { edit: true } : {}) }, httpListen: false, extensionsEnabled: false, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanup.push(() => daemon.stop())
  const clientId = ids("client")
  const edit_ = async (input: Record<string, unknown>, token = full) => {
    const response = await daemon.httpAdapter!.fetch(new Request("http://127.0.0.1:4096/command", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ type: "file.edit", id: ids("command"), clientId, directory: project, input }) }))
    return { status: response!.status, body: await response!.json() as Record<string, any> }
  }
  return { project, edit: edit_, observer, daemon, full }
}

test("file.edit is refused until the server opts in with edit", async () => {
  const h = await boot(false)
  const reply = await h.edit({ operation: "read", path: "a.txt" })
  expect(reply.status).toBe(501)
  expect(reply.body.error.message).toContain("--edit")
})

test("file.edit reads exact bytes, creates and saves with compare-and-swap", async () => {
  const h = await boot(true)
  const missing = await h.edit({ operation: "read", path: "src/new.ts" })
  expect(missing.body).toEqual({ path: "src/new.ts", content: "", sha256: null, bytes: 0 })
  mkdirSync(path.join(h.project, "src"))
  const created = await h.edit({ operation: "write", path: "src/new.ts", content: "export const a = 1\n", expected: null })
  expect(created.status).toBe(200)
  expect(created.body).toEqual({ path: "src/new.ts", sha256: sha("export const a = 1\n"), bytes: 19 })
  // trailing newline and padding survive the round trip, unlike the trimmed /file/content view
  const read = await h.edit({ operation: "read", path: "src/new.ts" })
  expect(read.body.content).toBe("export const a = 1\n")
  const stale = await h.edit({ operation: "write", path: "src/new.ts", content: "x", expected: sha("other") })
  expect(stale.status).toBe(400)
  expect(stale.body.error.message).toContain("changed on disk")
  const existing = await h.edit({ operation: "write", path: "src/new.ts", content: "new", expected: null })
  expect(existing.status).toBe(400)
  const saved = await h.edit({ operation: "write", path: "src/new.ts", content: "  padded  \n\n", expected: read.body.sha256 })
  expect(saved.status).toBe(200)
  expect(readFileSync(path.join(h.project, "src/new.ts"), "utf8")).toBe("  padded  \n\n")
  expect(readdirSync(path.join(h.project, "src"))).toEqual(["new.ts"])
})

test("file.edit preserves the file mode and refuses a missing parent directory", async () => {
  const h = await boot(true)
  const script = path.join(h.project, "run.sh")
  writeFileSync(script, "echo 1\n")
  chmodSync(script, 0o755)
  const read = await h.edit({ operation: "read", path: "run.sh" })
  await h.edit({ operation: "write", path: "run.sh", content: "echo 2\n", expected: read.body.sha256 })
  expect(statSync(script).mode & 0o777).toBe(0o755)
  const orphan = await h.edit({ operation: "write", path: "nope/file.txt", content: "x", expected: null })
  expect(orphan.status).toBe(400)
  expect(orphan.body.error.message).toContain("Parent directory")
})

test("file.edit stays inside the project, outside .git, away from binaries and over-limit content", async () => {
  const h = await boot(true)
  const outside = realpathSync(tempDir())
  writeFileSync(path.join(outside, "secret.txt"), "outside")
  symlinkSync(outside, path.join(h.project, "link"))
  mkdirSync(path.join(h.project, ".git"))
  writeFileSync(path.join(h.project, ".git/config"), "[core]\n")
  writeFileSync(path.join(h.project, "bin.dat"), Buffer.from([1, 0, 2]))
  writeFileSync(path.join(h.project, "latin1.txt"), Buffer.from([0xe9, 0xe9]))
  for (const target of ["../escape.txt", "link/secret.txt", ".git/config", "sub/../.git/config"]) {
    const reply = await h.edit({ operation: "write", path: target, content: "x", expected: target === "link/secret.txt" ? sha("outside") : null })
    expect(reply.status).toBe(403)
  }
  expect(readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("outside")
  expect(readFileSync(path.join(h.project, ".git/config"), "utf8")).toBe("[core]\n")
  for (const target of ["bin.dat", "latin1.txt"]) expect((await h.edit({ operation: "read", path: target })).status).toBe(400)
  expect((await h.edit({ operation: "read", path: "." })).status).toBe(400)
  const big = await h.edit({ operation: "write", path: "big.txt", content: "é".repeat(60_001), expected: null })
  expect(big.status).toBe(400)
  expect(big.body.error.message).toContain("120000")
  const nul = await h.edit({ operation: "write", path: "nul.txt", content: "a\0b", expected: null })
  expect(nul.status).toBe(400)
})

test("file.edit needs a full token and is not a read-only command", async () => {
  const h = await boot(true)
  const reply = await h.edit({ operation: "read", path: "a.txt" }, h.observer)
  expect(reply.status).toBe(403)
  expect(readdirSync(h.project)).toEqual([])
})

test("native clients use fileEdit and get the same opt-in refusal", async () => {
  for (const enabled of [false, true]) {
    const h = await boot(enabled)
    const client = createClient({ socketPath: h.daemon.socketPath, name: "file-edit", reconnect: false })
    cleanup.push(() => client.close())
    await client.connect()
    const created = await client.fileEdit(h.project, { operation: "write", path: "n.txt", content: "native\n", expected: null })
    if (!enabled) { expect(created).toMatchObject({ ok: false, error: { code: "unsupported" } }); continue }
    expect(created).toEqual({ ok: true, value: { path: "n.txt", sha256: sha("native\n"), bytes: 7 } })
    expect(await client.fileEdit(h.project, { operation: "read", path: "n.txt" })).toMatchObject({ ok: true, value: { content: "native\n" } })
  }
})

test("OpenAPI generated offline matches the served contract and documents file.edit", async () => {
  const h = await boot(true)
  const offline = await generateHttpApi()
  expect(offline).toEqual(httpOpenApi())
  const served = await h.daemon.httpAdapter!.fetch(new Request("http://127.0.0.1:4096/openapi.json", { headers: { Authorization: `Bearer ${h.full}` } }))
  expect(await served!.json()).toEqual(JSON.parse(JSON.stringify(offline)))
  expect(JSON.stringify(offline)).toContain("file.edit")
  expect(JSON.stringify(offline)).not.toContain(h.full)
})
