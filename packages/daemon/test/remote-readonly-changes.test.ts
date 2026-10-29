import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { startDaemon } from "../src"
import { readChanges } from "../src/changes"
import { remoteTokens } from "../src/remote"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const credential = `sk-proj-${"a1B2c3D4".repeat(5)}`

async function boot() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-readonly-changes-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const project = path.join(dir, "project")
  mkdirSync(project)
  const initialized = Bun.spawnSync(["git", "init", "-q", project])
  if (initialized.exitCode) throw new Error(initialized.stderr.toString())
  writeFileSync(path.join(project, "credential.txt"), `API_KEY=${credential}\n`)
  writeFileSync(path.join(dir, "outside-secret.txt"), `outside ${credential}\n`)
  symlinkSync(path.join(dir, "outside-secret.txt"), path.join(project, "link.txt"))
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), listen: "127.0.0.1:0", engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanups.push(() => daemon.stop())
  const writer = createClient({ socketPath: daemon.socketPath, name: "local" })
  await writer.connect()
  cleanups.push(() => writer.close())
  expect((await writer.send({ type: "session.create", directory: project })).ok).toBe(true)
  const token = remoteTokens(dir).create({ name: "observer", readOnly: true }).token
  const reader = createClient({ name: "observer", remote: { hostname: "127.0.0.1", port: daemon.remotePort!, token } })
  await reader.connect()
  cleanups.push(() => reader.close())
  return { reader, project }
}

test("a read-only peer gets no change report: raw diffs and untracked contents stay local", async () => {
  const { reader, project } = await boot()
  for (const command of [{ type: "changes.query" as const, directory: project }, { type: "changes.file" as const, directory: project, path: "credential.txt" }, { type: "changes.file" as const, directory: project, path: "link.txt" }]) {
    const reply = await reader.send(command)
    expect(reply).toMatchObject({ ok: false, error: { code: "forbidden" } })
    expect(JSON.stringify(reply)).not.toContain(credential)
  }
})

test("a read-only peer can only name directories of known projects, never browse the machine", async () => {
  const { reader, project } = await boot()
  const outside = path.dirname(project)
  const probes = [
    { type: "files.search" as const, directory: outside, query: "" },
    { type: "git.status" as const, directory: outside },
    { type: "memory.list" as const, directory: outside },
    { type: "scratchpad.get" as const, directory: outside },
  ]
  for (const probe of probes) expect(await reader.send(probe)).toMatchObject({ ok: false, error: { code: "forbidden" } })
  // Reading a session's own directory, or one inside it, still works.
  expect(await reader.send({ type: "git.status", directory: project })).toMatchObject({ ok: true })
  mkdirSync(path.join(project, "src"))
  expect(await reader.send({ type: "files.search", directory: path.join(project, "src"), query: "" })).toMatchObject({ ok: true })
})

test("the change report does not read through an untracked symlink to a file outside the repository", async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-changes-link-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const project = path.join(dir, "project")
  mkdirSync(project)
  expect(Bun.spawnSync(["git", "init", "-q", project]).exitCode).toBe(0)
  writeFileSync(path.join(dir, "outside-secret.txt"), `outside ${credential}\n`)
  symlinkSync(path.join(dir, "outside-secret.txt"), path.join(project, "link.txt"))
  const report = await readChanges(project)
  expect(JSON.stringify(report)).not.toContain(credential)
  expect(report.files.map((file) => file.path)).toEqual(["link.txt"])
})
