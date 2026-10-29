import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { isReadOnlyCommand } from "@mendcode/protocol/wire"
import { startDaemon } from "../src"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function temp() { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-eco-test-"))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
function write(file: string, text: string) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text) }

/** A registry tarball (`package/…`) built locally; the daemon's npm access is replaced by a function that returns it. */
function tarball() {
  const root = temp()
  write(path.join(root, "package", "mendcode-package.json"), JSON.stringify({ name: "ecokit", version: "3.1.0", description: "Ecosystem kit" }))
  write(path.join(root, "package", "commands", "review.md"), "Review $ARGUMENTS")
  write(path.join(root, "package", "commands", "ship.md"), "Ship $ARGUMENTS")
  write(path.join(root, "package", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: ship it\n---\nSteps")
  write(path.join(root, "package", "tools", "hello.json"), JSON.stringify({ description: "package hello", command: ["echo", "hi"] }))
  const out = path.join(temp(), "ecokit.tgz")
  expect(Bun.spawnSync(["tar", "-czf", out, "-C", root, "package"]).exitCode).toBe(0)
  return out
}

async function boot() {
  const dir = temp(), project = temp()
  const archive = tarball()
  const integrity = `sha512-${createHash("sha512").update(readFileSync(archive)).digest("base64")}`
  const requested: string[] = []
  const index = { version: 0, packs: [{ id: "ecokit", version: "3.1.0", description: "Ecosystem kit", source: { url: "npm:ecokit@3.1.0", integrity } }] }
  const daemon = await startDaemon({
    dir, socketPath: path.join(dir, "d.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }),
    packageFetchers: { npmPack: async ({ name, version }) => (requested.push(`${name}@${version}`), archive), text: async (url) => (requested.push(url), JSON.stringify(index)) },
  })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "eco-test" })
  await client.connect()
  cleanups.push(() => client.close())
  // Loosely typed on purpose: the assertions read replies of many command types.
  return { client: client as unknown as { send(command: Record<string, unknown>): Promise<{ ok: boolean; result?: any; error?: any }> }, project, requested, integrity, dir }
}

test("an npm spec installs through the daemon with its digest recorded; unpinned specs are refused", async () => {
  const { client, project, requested, integrity } = await boot()
  expect(await client.send({ type: "packages.install", directory: project, source: "npm:ecokit@^3", scope: "user" })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
  expect(requested).toEqual([])
  const reply = await client.send({ type: "packages.install", directory: project, source: `npm:ecokit@3.1.0#${integrity}`, scope: "user" })
  expect(reply).toMatchObject({ ok: true, result: { packages: [{ key: "user:ecokit", install: { source: "npm:ecokit@3.1.0", integrity, pinned: true }, contents: { commands: 2, skills: 1, tools: 1 } }] } })
  expect(requested).toEqual(["ecokit@3.1.0"])
})

test("a remote catalog is fetched only by refresh, then installs its pinned entry", async () => {
  const { client, project, requested } = await boot()
  expect(await client.send({ type: "packages.add-source", directory: project, sourceId: "hub", location: "https://hub.example/index.json" })).toMatchObject({ ok: true, result: { sources: [{ id: "local" }, { id: "hub", enabled: false, remote: true }] } })
  expect(await client.send({ type: "packages.refresh", directory: project, sourceId: "hub" })).toMatchObject({ ok: false, error: { message: expect.stringContaining("disabled") } })
  await client.send({ type: "packages.add-source", directory: project, sourceId: "hub", location: "https://hub.example/index.json", enabled: true })
  expect(await client.send({ type: "packages.search", directory: project, sourceId: "hub" })).toMatchObject({ ok: false })
  expect(requested).toEqual([])
  expect(await client.send({ type: "packages.refresh", directory: project, sourceId: "hub" })).toMatchObject({ ok: true, result: { entries: 1 } })
  expect(await client.send({ type: "packages.search", directory: project, query: "eco" })).toMatchObject({ result: { entries: [{ name: "ecokit", remote: true, state: "available" }] } })
  expect(requested).toEqual(["https://hub.example/index.json"])
  expect(await client.send({ type: "packages.install-catalog", directory: project, name: "ecokit", sourceId: "hub", scope: "project" })).toMatchObject({ ok: true, result: { packages: [{ key: "project:ecokit", enabled: true }] } })
  expect(requested).toEqual(["https://hub.example/index.json", "ecokit@3.1.0"])
})

test("one resource of a package can be switched off and on; the loaders follow and the switch is a setting", async () => {
  const { client, project } = await boot()
  await client.send({ type: "packages.install", directory: project, source: "npm:ecokit@3.1.0", scope: "user" })
  // The package's own commands only: a built-in /review exists and would take over once the package's is switched off.
  const names = async () => ((await client.send({ type: "commands.list", directory: project })).result as { commands: Array<{ name: string; pkg?: string; skill?: boolean }> }).commands.filter((command) => command.pkg === "ecokit" && !command.skill).map((command) => command.name)
  const skills = async () => ((await client.send({ type: "skills.list", directory: project })).result as { skills: Array<{ name: string }> }).skills.map((skill) => skill.name)
  const tools = async () => ((await client.send({ type: "tools.list", directory: project })).result as { tools: Array<{ toolName: string }> }).tools.map((tool) => tool.toolName)
  expect(await names()).toEqual(["review", "ship"])
  expect(await skills()).toContain("deploy")
  expect(await tools()).toEqual(["custom__hello"])

  const config = await client.send({ type: "packages.config", directory: project, key: "user:ecokit" })
  expect(config).toMatchObject({ ok: true, result: { packages: [{ key: "user:ecokit", resources: [{ id: "skills/deploy", enabled: true }, { id: "commands/review" }, { id: "commands/ship" }, { id: "tools/hello" }] }] } })

  for (const resource of ["commands/review", "skills/deploy", "tools/hello"]) expect(await client.send({ type: "packages.resource", directory: project, key: "user:ecokit", resource, enabled: false })).toMatchObject({ ok: true })
  expect(await names()).not.toContain("review")
  expect(await names()).toContain("ship")
  expect(await skills()).not.toContain("deploy")
  expect(await tools()).toEqual([])
  const settings = await client.send({ type: "settings.get" })
  expect((settings.result as { settings: { disabledPackageResources?: string[] } }).settings.disabledPackageResources).toEqual(["user:ecokit/commands/review", "user:ecokit/skills/deploy", "user:ecokit/tools/hello"])
  const status = await client.send({ type: "packages.config", directory: project, key: "user:ecokit" })
  expect((status.result as { packages: Array<{ resources: Array<{ id: string; enabled: boolean }> }> }).packages[0]!.resources.filter((resource) => !resource.enabled).map((resource) => resource.id)).toEqual(["skills/deploy", "commands/review", "tools/hello"])

  for (const resource of ["commands/review", "skills/deploy", "tools/hello"]) await client.send({ type: "packages.resource", directory: project, key: "user:ecokit", resource, enabled: true })
  expect(await names()).toContain("review")
  expect(await skills()).toContain("deploy")
  expect(await tools()).toEqual(["custom__hello"])
  expect((await client.send({ type: "settings.get" })).result).not.toHaveProperty("settings.disabledPackageResources")

  expect(await client.send({ type: "packages.resource", directory: project, key: "user:ecokit", resource: "skills/missing", enabled: false })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
  expect(await client.send({ type: "packages.resource", directory: project, key: "user:absent", resource: "skills/deploy", enabled: false })).toMatchObject({ ok: false })
})

test("catalog fetches and resource switches are never read-only peer commands", () => {
  for (const type of ["packages.refresh", "packages.config", "packages.resource", "packages.install"] as const) expect(isReadOnlyCommand(type)).toBe(false)
})
