import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { listPackages } from "@mendcode/packages"
import { PROGRAM_NAME } from "@mendcode/program"
import type { SessionId } from "@mendcode/protocol"
import type { PackagePort, PackageRequest } from "@mendcode/tools"
import { startDaemon } from "../src"
import { TREE_LIMITS } from "../src/package-tree"

const cleanups: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
const temp = () => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "package-approval-")))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}
function write(file: string, text: string, mode?: number) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
  if (mode) chmodSync(file, mode)
}

/** A package shaped like the one a real session could not enable from chat: 31 skills with references, vendored references in nested folders, a 1.1 MB JSON and a few scripts. */
function sedaShaped(root: string) {
  write(path.join(root, "mendcode-package.json"), JSON.stringify({ name: "seda", version: "1.0.0", description: "seda skills" }))
  for (let skill = 0; skill < 31; skill++) {
    const name = `skill-${String(skill).padStart(2, "0")}`
    write(path.join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} workflow\n---\n${"step\n".repeat(400)}`)
    for (const reference of ["rules", "examples"]) write(path.join(root, "skills", name, "references", `${reference}.md`), `${reference} of ${name}\n${"detail ".repeat(2_000)}`)
  }
  for (let vendored = 0; vendored < 196; vendored++) write(path.join(root, "vendor", `group-${vendored % 5}`, "design", `pack-${vendored % 19}`, "refs", `ref-${vendored}.md`), `# vendored ${vendored}\n${"reference text ".repeat(1_500)}`)
  write(path.join(root, "vendor", "group-0", "design", "data", "font-index.json"), JSON.stringify({ fonts: "f".repeat(1_100_000) }))
  write(path.join(root, "vendor", "group-0", "design", "scripts", "live-browser.js"), "export const live = true\n")
  write(path.join(root, "hooks", "guard.sh"), "#!/bin/sh\nexit 0\n", 0o755)
  write(path.join(root, "hooks.json"), JSON.stringify({ hooks: {} }))
  write(path.join(root, "scripts", "build.py"), "print('x')\n")
  write(path.join(root, "commands", "seda.md"), "run seda")
}

async function fixture() {
  const dir = temp(), project = temp(), source = temp()
  sedaShaped(path.join(source, "seda"))
  write(path.join(source, "small", "mendcode-package.json"), JSON.stringify({ name: "small", version: "1.0.0", description: "small package" }))
  write(path.join(source, "small", "skills", "tiny", "SKILL.md"), "---\nname: tiny\ndescription: tiny\n---\ntiny")
  write(path.join(source, "marketplace-index.json"), JSON.stringify({ version: 0, packs: ["seda", "small"].map((name) => ({ id: name, version: "1.0.0", source: { url: name } })) }))
  let getPort!: (id: SessionId) => PackagePort
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "d.sock"), engine: ({ clock, packages }) => { getPort = packages; return createFauxEngine({ clock, deltaMs: 1 }) } })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "package-approval" })
  await client.connect()
  cleanups.push(() => client.close())
  await client.send({ type: "settings.set", patch: { tier: "balanced" } })
  expect(await client.send({ type: "packages.add-source", directory: project, sourceId: "team", location: source, enabled: true })).toMatchObject({ ok: true })
  const created = await client.send({ type: "session.create", directory: project })
  if (!created.ok) throw new Error(created.error.message)
  const port = getPort(created.result!.sessionId as SessionId)
  const apply = async (request: PackageRequest) => { await port.preview(request); return port.run(request) }
  const installedDir = (name: string) => listPackages({ userDir: dir, directory: project }).find((pkg) => pkg.name === name)!.dir
  return { port, apply, installedDir }
}

const install = (name: string): PackageRequest => ({ action: "install", name, sourceId: "team", scope: "user" })

describe("a package of the size of a real skill pack is approved from chat", () => {
  test("the fixture is over what the approval used to take (256 files, 2 MiB), and over neither hard limit", async () => {
    const root = temp()
    sedaShaped(root)
    const { readPackageTree } = await import("../src/package-tree")
    const { summary } = readPackageTree(root, "")
    expect(summary.files).toBeGreaterThan(256)
    expect(summary.bytes).toBeGreaterThan(2 * 1024 * 1024)
    expect(summary.files).toBeLessThan(TREE_LIMITS.files)
    expect(summary.bytes).toBeLessThan(TREE_LIMITS.bytes)
  })

  test("the approval is a bounded summary: counts per folder, size, the largest files and every runnable file in full", async () => {
    const { port } = await fixture()
    const text = await port.preview(install("seda"))
    expect(text.length).toBeLessThan(48 * 1024)
    const report = JSON.parse(text)
    expect(report.tree.files).toBeGreaterThan(290)
    expect(report.tree.bytes).toBeGreaterThan(5_000_000)
    expect(report.tree.folders.map((folder: { name: string }) => folder.name)).toEqual(expect.arrayContaining(["vendor", "skills", "hooks", "scripts", "commands", "(root)"]))
    expect(report.tree.folders[0]).toMatchObject({ name: "vendor" })
    expect(report.tree.largest[0]).toEqual({ path: "vendor/group-0/design/data/font-index.json", bytes: expect.any(Number) })
    expect(report.tree.largest).toHaveLength(TREE_LIMITS.largest)
    expect(report.tree.runnable).toEqual([
      { path: "hooks.json", bytes: expect.any(Number), why: "hook or configuration" },
      { path: "hooks/guard.sh", bytes: expect.any(Number), why: "executable bit" },
      { path: "scripts/build.py", bytes: expect.any(Number), why: "script or binary" },
      { path: "vendor/group-0/design/scripts/live-browser.js", bytes: expect.any(Number), why: "script or binary" },
    ])
    expect(report.capabilityScan).toContain("runnable list")
    expect(report.contents).toMatchObject({ skills: 31 })
  })

  test("install, then enable from chat with the same approval flow, and a byte changed after the preview voids the approval", async () => {
    const { port, apply, installedDir } = await fixture()
    await apply(install("seda"))
    const request: PackageRequest = { action: "enable", key: "user:seda" }
    const preview = JSON.parse(await port.preview(request))
    expect(preview.tree.files).toBeGreaterThan(290)
    await port.preview(request)
    write(path.join(installedDir("seda"), "vendor", "group-0", "design", "refs", "ref-0.md"), "changed after the preview")
    await expect(port.run(request)).rejects.toThrow("approval")
    await apply(request)
    expect(await port.run({ action: "info", key: "user:seda" })).toMatchObject({ key: "user:seda" })
  })

  test("a small package still previews with a small summary", async () => {
    const { port } = await fixture()
    const report = JSON.parse(await port.preview(install("small")))
    expect(report.tree).toMatchObject({ files: 2, runnable: [] })
    expect(report.capabilityScan).toBeUndefined()
  })
})

describe("a tree over a hard limit is refused with the limit, the measured value and the shell command", () => {
  const refused = async (prepare: (installed: string) => void, request: (name: string) => PackageRequest = (name) => ({ action: "enable", key: `user:${name}` })) => {
    const { port, apply, installedDir } = await fixture()
    await apply(install("small"))
    prepare(installedDir("small"))
    return port.preview(request("small")).then(() => "accepted", (error: Error) => error.message)
  }

  test("too many files", async () => {
    const message = await refused((installed) => { for (let file = 0; file <= TREE_LIMITS.files; file++) write(path.join(installed, "refs", `f${file}.md`), "x") })
    expect(message).toMatch(new RegExp(`files \\(limit ${TREE_LIMITS.files}, found 20\\d\\d\\)`))
    expect(message).toContain(`${PROGRAM_NAME} package enable small`)
    expect(message).toContain("Nothing was changed")
    expect(message).not.toContain("approval budget")
  })

  test("too many bytes", async () => {
    const message = await refused((installed) => write(path.join(installed, "refs", "big.bin"), "x".repeat(TREE_LIMITS.bytes + 1024 * 1024)))
    expect(message).toContain("total size (limit 20.0 MB, found 21.0 MB)")
    expect(message).toContain(`${PROGRAM_NAME} package enable small`)
  })

  test("nested too deep", async () => {
    const message = await refused((installed) => write(path.join(installed, ...Array.from({ length: TREE_LIMITS.depth + 1 }, (_, level) => `d${level}`), "x.md"), "x"))
    expect(message).toContain(`nested folders (limit ${TREE_LIMITS.depth} levels, found ${TREE_LIMITS.depth + 1} levels)`)
  })

  test("more runnable files than the approval can list one by one", async () => {
    const message = await refused((installed) => { for (let file = 0; file <= TREE_LIMITS.runnable; file++) write(path.join(installed, "scripts", `run-${file}.sh`), "echo") })
    expect(message).toContain("scripts, hooks, tools and executables, which the approval must list one by one")
    expect(message).toMatch(new RegExp(`\\(limit ${TREE_LIMITS.runnable}, found ${TREE_LIMITS.runnable + 1}\\)`))
  })

  test("the alternative follows the request: disable, remove, switch-look and a project package name their own command", async () => {
    const big = (installed: string) => { for (let file = 0; file <= TREE_LIMITS.files; file++) write(path.join(installed, "refs", `f${file}.md`), "x") }
    expect(await refused(big, (name) => ({ action: "disable", key: `user:${name}` }))).toContain(`${PROGRAM_NAME} package disable small`)
    expect(await refused(big, (name) => ({ action: "remove", key: `user:${name}` }))).toContain(`${PROGRAM_NAME} package remove small`)
    expect(await refused(big, (name) => ({ action: "info", key: `user:${name}` }))).toContain(`${PROGRAM_NAME} package check `)
  })

  test("links stay refused, as before", async () => {
    const outside = temp()
    write(path.join(outside, "private.txt"), "test-only data")
    const message = await refused((installed) => symlinkSync(path.join(outside, "private.txt"), path.join(installed, "linked.txt")))
    expect(message).toContain("Linked package resources cannot be approved")
  })
})
