import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { startDaemon } from "../src"

const BUILTIN_COMMANDS = ["bughunter", "commit", "commit-pr", "commit-push", "init", "pr-comments", "review", "security-review", "ultraplan", "verify", "wiki"].map((name) => ({ name, source: "builtin" }))
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function temp() { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-catalog-test-"))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
async function fixture() {
  const dir = temp(), project = temp(), source = temp()
  writeFileSync(path.join(source, "mendcode-package.json"), JSON.stringify({ name: "review", version: "1.0.0", description: "Review helpers" }))
  mkdirSync(path.join(source, "commands"))
  writeFileSync(path.join(source, "commands", "review.md"), "Review $ARGUMENTS")
  const boot = async () => {
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "d.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
    cleanups.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "catalog-test" })
    await client.connect()
    cleanups.push(() => client.close())
    return { daemon, client }
  }
  return { dir, project, source, boot, ...await boot() }
}

test("catalog/client preview is read-only; install/use selects and disable-all removes the runtime projection", async () => {
  const { client, project, source } = await fixture()
  expect(await client.send({ type: "packages.add-source", directory: project, sourceId: "team", location: source, enabled: true })).toMatchObject({ ok: true })
  expect(await client.packageCatalog(project, "review", "team")).toMatchObject({ ok: true, report: { entries: [{ name: "review", state: "available" }] } })
  expect(await client.packagePreview(project, "team")).toMatchObject({ ok: true, report: { action: "install", problems: [] } })
  expect(await client.send({ type: "packages.list", directory: project })).toMatchObject({ result: { packages: [] } })
  expect(await client.send({ type: "packages.install-source", directory: project, sourceId: "team", scope: "user" })).toMatchObject({ ok: true, result: { packages: [{ enabled: true }] } })
  expect(await client.send({ type: "commands.expand", directory: project, name: "review", args: "v2" })).toMatchObject({ result: { prompt: "Review v2" } })
  expect(await client.send({ type: "packages.disable-all", directory: project })).toMatchObject({ result: { packages: [{ enabled: false }] } })
  expect(await client.send({ type: "commands.list", directory: project })).toMatchObject({ result: { commands: BUILTIN_COMMANDS } })
  expect(await client.send({ type: "packages.install-catalog", directory: project, name: "review", sourceId: "team", scope: "user", replace: true })).toMatchObject({ result: { packages: [{ enabled: true }] } })
  await client.send({ type: "prompt.set", directory: project, mode: "minimal" })
  expect(await client.send({ type: "packages.assets", directory: project })).toMatchObject({ result: { promptMode: "minimal", totals: { commands: 1 } } })
  await client.send({ type: "packages.enable", directory: project, key: "user:review", enabled: false })
  expect(await client.send({ type: "commands.list", directory: project })).toMatchObject({ result: { commands: BUILTIN_COMMANDS } })
  expect(await client.send({ type: "packages.enable", directory: project, key: "user:missing", enabled: true })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
})

test("scope-specific disable-all leaves the other scope active and source/selection persist after restart", async () => {
  const f = await fixture()
  for (const scope of ["user", "project"] as const) await f.client.send({ type: "packages.install", directory: f.project, source: f.source, scope })
  await f.client.send({ type: "packages.add-source", directory: f.project, sourceId: "saved", location: f.source })
  await f.client.send({ type: "packages.disable-all", directory: f.project, scope: "project" })
  f.client.close()
  await f.daemon.stop()
  const { client } = await f.boot()
  expect(await client.send({ type: "packages.list", directory: f.project })).toMatchObject({ result: { packages: [{ source: "user", enabled: true }, { source: "project", enabled: false }] } })
  expect(await client.send({ type: "packages.sources", directory: f.project })).toMatchObject({ result: { sources: [{ id: "local" }, { id: "saved", enabled: false }] } })
  expect(await client.packageCatalog(f.project, "", "saved")).toMatchObject({ ok: false, error: { code: "invalid_command" } })
})

test("invalid sources and missing packages return protocol errors without touching installed packages", async () => {
  const { client, project } = await fixture()
  expect(await client.send({ type: "packages.add-source", directory: project, sourceId: "remote", location: "http://example.test/catalog", enabled: true })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
  expect(await client.send({ type: "packages.show", directory: project, name: "missing" })).toMatchObject({ ok: false })
  expect(await client.send({ type: "packages.install-source", directory: project, sourceId: "missing", scope: "user" })).toMatchObject({ ok: false })
  expect(await client.send({ type: "packages.list", directory: project })).toMatchObject({ result: { packages: [] } })
})

test("deselect and reselect reload user-package extension commands without restarting", async () => {
  const { client, project, source } = await fixture()
  mkdirSync(path.join(source, "extensions"))
  writeFileSync(path.join(source, "extensions", "review.ts"), `export default {
    name: "catalog-review",
    daemon(api) { api.registerCommand({ name: "catalog-review", description: "Review", run() { return { notice: "Review" } } }) }
  }`)
  await client.send({ type: "packages.install", directory: project, source, scope: "user" })
  const hasCommand = async () => {
    const reply = await client.send({ type: "commands.list", directory: project })
    if (!reply.ok) throw new Error(reply.error.message)
    return (reply.result?.commands as Array<{ name: string }>).some((command) => command.name === "catalog-review")
  }
  expect(await hasCommand()).toBe(true)
  await client.send({ type: "packages.enable", directory: project, key: "user:review", enabled: false })
  expect(await hasCommand()).toBe(false)
  await client.send({ type: "packages.enable", directory: project, key: "user:review", enabled: true })
  expect(await hasCommand()).toBe(true)
  await client.send({ type: "packages.disable-all", directory: project })
  expect(await hasCommand()).toBe(false)
  await client.send({ type: "packages.install", directory: project, source, scope: "user", replace: true })
  expect(await hasCommand()).toBe(true)
})
