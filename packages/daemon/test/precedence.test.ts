import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createSkillLoader } from "@mendcode/engine-native"
import { extensionLayers } from "@mendcode/packages"
import { conflictRows, describePrecedence, resolvePrecedence, type PrecedenceFacts } from "@mendcode/protocol/wire"
import { startDaemon } from "../src"
import { loadCustomCommands } from "../src/custom-commands"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function temp(prefix: string) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function write(file: string, text: string) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}

const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`
const hooks = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }] } })

/** The same names in the user's folder, a user package, the project's folder and a project package, so every surface has a choice to make. */
function fixture(dir: string, project: string) {
  const userPackage = path.join(dir, "packages", "pk")
  const projectPackage = path.join(project, ".mendcode", "packages", "pp")
  write(path.join(userPackage, "mendcode-package.json"), JSON.stringify({ name: "pk", version: "1.0.0", description: "user package" }))
  write(path.join(projectPackage, "mendcode-package.json"), JSON.stringify({ name: "pp", version: "1.0.0", description: "project package" }))
  for (const root of [userPackage, dir, projectPackage, path.join(project, ".mendcode")]) {
    write(path.join(root, "skills", "shared", "SKILL.md"), skill("shared", `from ${root}`))
    write(path.join(root, "commands", "shared.md"), `---\ndescription: from ${path.basename(root)}\n---\nbody`)
    write(path.join(root, "themes", "shared.json"), JSON.stringify({ label: "x", background: "dark", colors: {} }))
    write(path.join(root, "recipes", "shared.json"), JSON.stringify({ description: "r", roles: {} }))
    write(path.join(root, "mcp.json"), JSON.stringify({ servers: { shared: { command: "true" } } }))
    write(path.join(root, "hooks.json"), hooks)
    write(path.join(root, "workflows", "shared.js"), "export const meta = { name: 'shared' }\n")
    write(path.join(root, "agents", "shared.md"), `---\ndescription: from ${path.basename(root)}\n---\nbody`)
    write(path.join(root, "SYSTEM.md"), `system of ${root}`)
  }
  write(path.join(dir, "skills", "only-user", "SKILL.md"), skill("only-user", "alone"))
}

async function facts(trusted: boolean): Promise<{ rows: ReturnType<typeof resolvePrecedence>; data: PrecedenceFacts; dir: string; project: string }> {
  const dir = temp("mendd-prec-")
  const project = temp("mendd-prec-proj-")
  fixture(dir, project)
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "precedence" })
  await client.connect()
  cleanups.push(() => client.close())
  if (trusted) expect((await client.send({ type: "tools.trust", directory: project, trusted: true })).ok).toBe(true)
  const reply = await client.send({ type: "system.query", directory: project, operation: "precedence" })
  expect(reply.ok).toBe(true)
  const data = ((reply as unknown as { result: { facts: PrecedenceFacts } }).result).facts
  return { rows: resolvePrecedence(data.claims), data, dir, project }
}

test("every file surface names the effective layer and the layers it overrides, in the daemon's own layer order", async () => {
  const { rows, data } = await facts(true)
  expect(data.layers).toEqual(["built in", "package user:pk", "user", "package project:pp", "project"])
  for (const surface of ["skills", "commands", "agents", "themes", "recipes", "mcp", "workflows", "promptFiles"] as const) {
    const row = rows.find((candidate) => candidate.surface === surface && candidate.name.startsWith("shared") || candidate.surface === surface && candidate.name === "SYSTEM.md")
    expect(row, surface).toBeDefined()
    expect(row!.effective, surface).toEqual([{ layer: "project" }])
    expect(row!.overridden.map((entry) => entry.layer), surface).toEqual(["package project:pp", "user", "package user:pk"])
  }
  // Hooks of every layer run together: nothing is overridden.
  const stop = rows.find((row) => row.surface === "hooks" && row.name === "Stop")!
  expect(stop.overridden).toEqual([])
  expect(stop.effective.map((entry) => entry.layer)).toEqual(["package user:pk", "user", "package project:pp", "project"])
  // A name only one layer holds is effective with nothing to report.
  expect(rows.find((row) => row.name === "only-user")).toEqual({ surface: "skills", name: "only-user", effective: [{ layer: "user" }], overridden: [], inactive: [] })
})

test("the report agrees with the loaders that own the precedence", async () => {
  const { rows, dir, project } = await facts(true)
  const layers = extensionLayers({ userDir: dir, directory: project })
  const loaded = createSkillLoader({ userDir: dir, layers: () => layers }).list(project).find((entry) => entry.name === "shared")!
  expect(rows.find((row) => row.surface === "skills" && row.name === "shared")!.effective[0]!.layer).toBe(loaded.pkg ? `package ${loaded.source}:${loaded.pkg}` : loaded.source)
  const command = (await loadCustomCommands({ directory: project, userDir: dir, layers })).find((entry) => entry.name === "shared")!
  expect(rows.find((row) => row.surface === "commands" && row.name === "shared")!.effective[0]!.layer).toBe(command.pkg ? `package ${command.source}:${command.pkg}` : command.source)
})

test("without project trust the project's agents and hooks are listed as not applied and never override", async () => {
  const { rows } = await facts(false)
  const agent = rows.find((row) => row.surface === "agents" && row.name === "shared")!
  expect(agent.effective).toEqual([{ layer: "user" }])
  expect(agent.inactive.map((entry) => entry.layer)).toEqual(["project", "package project:pp"])
  const stop = rows.find((row) => row.surface === "hooks" && row.name === "Stop")!
  expect(stop.effective.map((entry) => entry.layer)).toEqual(["package user:pk", "user"])
  expect(conflictRows(rows).length).toBeGreaterThan(0)
  const text = describePrecedence(rows, { onlyConflicts: true }).flatMap((section) => section.lines).join("\n")
  expect(text).toContain("shared: project · overrides package project:pp, user, package user:pk")
  expect(text).toContain("not applied")
})
