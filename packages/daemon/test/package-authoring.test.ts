import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { Command, PackageAuthoringReport, PackageDeleteLocalReport, PackagesReport, createIdFactory, isReadOnlyCommand } from "@mendcode/protocol"
import { startDaemon } from "../src"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-author-daemon-"))), project = path.join(dir, "project")
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(path.join(project, ".mendcode/commands"), { recursive: true })
  writeFileSync(path.join(project, ".mendcode/commands/review.md"), "Review $ARGUMENTS")
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "d.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "package-author-test" })
  await client.connect()
  cleanups.push(() => client.close())
  return { dir, project, daemon, client }
}

test("create/update/delete-local cross client + protocol + daemon with real local snapshots and no activation", async () => {
  const f = await fixture()
  f.daemon.store.settings.set({ models: { main: { model: "scripted", effort: "medium", parameters: { metadata: { apiKey: "private-model-value" } } } }, defaultPermission: "ask", memoryEnabled: false })
  const created = await f.client.authorPackage(f.project, "create", { metadata: { id: "review", title: "Review Kit" } })
  expect(created.ok).toBe(true)
  if (!created.ok) throw new Error(created.error.message)
  expect(PackageAuthoringReport.parse(created.report)).toMatchObject({ action: "create", activated: false, signed: false, artifacts: ["commands/review.md"] })
  const data = readFileSync(path.join(f.project, created.report.packagePath, "runtime-pack.json"), "utf8")
  expect(JSON.parse(data)).toMatchObject({ settings: { models: { main: { model: "scripted", effort: "medium" } }, memory: { memoryEnabled: false }, permissions: { defaultPermission: "ask" } } })
  expect(data).not.toContain("private-model-value")
  expect(await f.client.packageCatalog(f.project, "review", "local")).toMatchObject({ ok: true, report: { entries: [{ name: "review", state: "available" }] } })
  expect(await f.client.packagePreview(f.project, "local", "review")).toMatchObject({ ok: true, report: { problems: [] } })
  expect(await f.client.send({ type: "packages.list", directory: f.project })).toMatchObject({ result: { packages: [] } })
  const updated = await f.client.authorPackage(f.project, "update", { metadata: { version: "2.0.0" } })
  expect(updated).toMatchObject({ ok: true, report: { version: "2.0.0", title: "Review Kit" } })
  if (!updated.ok) throw new Error(updated.error.message)
  expect(existsSync(path.join(f.project, updated.report.backupPath!))).toBe(true)
  const installed = await f.client.send({ type: "packages.install-catalog", directory: f.project, name: "review", sourceId: "local", scope: "project" })
  expect(installed.ok).toBe(true)
  if (!installed.ok) throw new Error(installed.error.message)
  expect(PackagesReport.parse(installed.result)).toMatchObject({ packages: [{ manifest: { title: "Review Kit", version: "2.0.0" } }] })
  const removed = await f.client.deleteLocalPackage(f.project)
  expect(removed.ok).toBe(true)
  if (!removed.ok) throw new Error(removed.error.message)
  expect(PackageDeleteLocalReport.parse(removed.report)).toMatchObject({ selectionCleared: true, localArtifactsTouched: false })
  expect(existsSync(path.join(f.project, ".mendcode/commands/review.md"))).toBe(true)
  expect(await f.client.send({ type: "packages.list", directory: f.project })).toMatchObject({ result: { packages: [{ name: "review" }] } })
})

test("protocol rejects unsupported options and authoring mutations are never read-only commands", () => {
  const ids = createIdFactory(), base = { id: ids("command"), clientId: ids("client"), directory: "/tmp/project" }
  for (const type of ["packages.create", "packages.update", "packages.delete-local"] as const) {
    expect(Command.safeParse({ ...base, type }).success).toBe(true)
    expect(isReadOnlyCommand(type)).toBe(false)
  }
  for (const extra of [{ include: ["unknown"] }, { metadata: { id: "../escape" } }, { metadata: { signatureRequired: true } }, { activate: true }]) expect(Command.safeParse({ ...base, type: "packages.create", ...extra }).success).toBe(false)
})

test("failed secret audit returns an actionable daemon error and leaves the authored revision unchanged", async () => {
  const { project, client } = await fixture()
  const created = await client.authorPackage(project, "create", { include: ["commands"] })
  if (!created.ok) throw new Error(created.error.message)
  const file = path.join(project, created.report.manifestPath), before = readFileSync(file, "utf8")
  writeFileSync(path.join(project, ".mendcode/commands/review.md"), `sk-proj-${"A1b2c3d4".repeat(6)}`)
  expect(await client.authorPackage(project, "update", { metadata: { version: "3" } })).toMatchObject({ ok: false, error: { code: "invalid_command", message: expect.stringContaining("credentials") } })
  expect(readFileSync(file, "utf8")).toBe(before)
  expect(await client.deleteLocalPackage(project)).toMatchObject({ ok: true })
  expect(await client.deleteLocalPackage(project)).toMatchObject({ ok: true, report: { removed: [] } })
})
