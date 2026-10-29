import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import type { CustomToolsReport } from "@mendcode/protocol"
import type { CustomToolRegistry } from "@mendcode/tools"
import { startDaemon } from "../src"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const manifest = (description: string) => JSON.stringify({ description, command: ["./run.sh"], args: { type: "object", properties: { text: { type: "string" } } } })

async function boot() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mendd-tools-")))
  const project = realpathSync(mkdtempSync(path.join(tmpdir(), "mendd-tools-proj-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => rmSync(project, { recursive: true, force: true }))
  mkdirSync(path.join(project, ".mendcode", "tools"), { recursive: true })
  mkdirSync(path.join(dir, "tools"), { recursive: true })
  writeFileSync(path.join(project, ".mendcode", "tools", "wc.json"), manifest("project tool"))
  writeFileSync(path.join(dir, "tools", "hello.json"), manifest("user tool"))
  let registry: CustomToolRegistry | undefined
  const daemon = await startDaemon({
    dir,
    socketPath: path.join(dir, "mendd.sock"),
    engine: ({ clock, customTools }) => ((registry = customTools), createFauxEngine({ clock, deltaMs: 1 })),
  })
  cleanups.push(() => daemon.stop())
  const globals: Array<{ type: string; settings?: { trustedToolDirs?: string[] } }> = []
  const client = createClient({ socketPath: daemon.socketPath, name: "tools", onGlobal: (e) => void globals.push(e as never) })
  await client.connect()
  cleanups.push(() => client.close())
  return { client, project, dir, registry: () => registry!, globals }
}

describe("custom tools commands", () => {
  test("tools.list shows user tools as trusted and project tools as not trusted until tools.trust", async () => {
    const { client, project, registry } = await boot()
    const listed = await client.send({ type: "tools.list", directory: project })
    expect(listed).toMatchObject({ ok: true })
    const report = (listed.ok ? listed.result : undefined) as CustomToolsReport
    expect(report.directory).toBe(project)
    expect(report.tools.map((t) => [t.toolName, t.source, t.trusted])).toEqual([["custom__hello", "user", true], ["custom__wc", "project", false]])
    expect((await registry().tools(project)).map((t) => t.name)).toEqual(["custom__hello"])
  })
  test("tools.trust persists the directory in settings, broadcasts settings.changed and turns the tools on; untrust turns them off", async () => {
    const { client, project, registry, globals } = await boot()
    const trusted = await client.send({ type: "tools.trust", directory: project, trusted: true })
    expect(trusted.ok && (trusted.result as CustomToolsReport).tools.every((t) => t.trusted)).toBe(true)
    expect(await client.send({ type: "settings.get" })).toMatchObject({ ok: true, result: { settings: { trustedToolDirs: [project] } } })
    expect((await registry().tools(project)).map((t) => t.name).sort()).toEqual(["custom__hello", "custom__wc"])
    await client.send({ type: "tools.trust", directory: project, trusted: true })
    expect(await client.send({ type: "settings.get" })).toMatchObject({ result: { settings: { trustedToolDirs: [project] } } })
    const untrusted = await client.send({ type: "tools.trust", directory: project, trusted: false })
    expect(untrusted.ok && (untrusted.result as CustomToolsReport).tools.find((t) => t.source === "project")?.trusted).toBe(false)
    const settings = await client.send({ type: "settings.get" })
    expect(settings.ok && (settings.result as { settings: Record<string, unknown> }).settings.trustedToolDirs).toBeUndefined()
    expect((await registry().tools(project)).map((t) => t.name)).toEqual(["custom__hello"])
    expect(globals.filter((e) => e.type === "settings.changed")).toHaveLength(3)
  })
  test("relative directories are resolved so the trusted path is absolute", async () => {
    const { client } = await boot()
    const reply = await client.send({ type: "tools.trust", directory: "some/relative", trusted: true })
    expect(reply.ok).toBe(true)
    const settings = await client.send({ type: "settings.get" })
    expect(settings.ok && (settings.result as { settings: { trustedToolDirs: string[] } }).settings.trustedToolDirs[0]).toBe(path.resolve("some/relative"))
  })
  test("trust matches a project however its path is spelled (symlinked directories)", async () => {
    const { client, project, registry, dir } = await boot()
    const link = path.join(dir, "link-to-project")
    symlinkSync(project, link)
    await client.send({ type: "tools.trust", directory: link, trusted: true })
    expect((await registry().tools(project)).map((t) => t.name)).toContain("custom__wc")
    expect((await registry().tools(link)).map((t) => t.name)).toContain("custom__wc")
  })
})
