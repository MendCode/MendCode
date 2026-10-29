import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createNativeEngine, createSkillTool, joinSystemParts, loadSystemPrompt } from "@mendcode/engine-native"
import { BUILTIN_TOOLS } from "@mendcode/tools"
import { ContextReport, PackagesReport, createIdFactory, type SessionId, type Tier } from "@mendcode/protocol"
import { effectiveSettings, isReadOnlyCommand } from "@mendcode/protocol/wire"
import { startDaemon } from "../src"
import { systemPartsWith } from "../src/extensions/prompt-files"
import { promptContextParts } from "../src/prompt-context"
import { remoteTokens } from "../src/remote"

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
function temp() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-package-context-")))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const official = path.resolve(import.meta.dir, "../../../examples/official-packages")
const names = readdirSync(official, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()

async function boot() {
  const dir = temp(), project = temp()
  const packaged = await loadSystemPrompt()
  const token = remoteTokens(dir).create({ name: "fixture" }).token
  let systemFor!: (root: string) => string
  const daemon = await startDaemon({
    dir, socketPath: path.join(dir, "d.sock"), defaultDirectory: project,
    http: { enabled: true }, httpListen: false,
    engine: ({ store, skills, extensions, customTools }) => {
      const parts = (root: string) => promptContextParts(dir, root, systemPartsWith({
        root, packaged, files: extensions.prompts.read(root),
        rest: [{ id: "skills", label: "skills", text: skills.block(root) }],
      }))
      systemFor = (root) => joinSystemParts(parts(root))
      return createNativeEngine({
        provider: { id: "no-network", model: "fixture", async *stream() { throw new Error("must not call a model") } },
        tools: [...BUILTIN_TOOLS, createSkillTool(skills)],
        history: { load: async () => [], save: async () => {}, replace: async () => {} },
        cwdFor: (id) => store.sessionDirectory(id)!,
        system: systemFor, systemParts: parts, compactionPrompt: "Unused in base-context measurement",
        permissionPolicy: () => effectiveSettings(store.settings.get()),
        projectTools: async (root, id) => [...await customTools.tools(root), ...await extensions.tools(root, id)],
      })
    },
  })
  cleanup.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "context-budget" })
  await client.connect()
  cleanup.push(() => client.close())
  const created = await client.send({ type: "session.create", directory: project })
  if (!created.ok) throw new Error(created.error.message)
  const sessionId = created.result!.sessionId as SessionId
  const report = async () => {
    const reply = await client.send({ type: "context.query", sessionId })
    if (!reply.ok) throw new Error(reply.error.message)
    return ContextReport.parse(reply.result)
  }
  return { dir, project, client, daemon, token, report, system: () => systemFor(project) }
}

test("W10: each unused official package adds zero base context tokens in every tier and scope", async () => {
  const h = await boot()
  expect(names.length).toBeGreaterThan(0)
  for (const tier of ["minimalist", "balanced", "full"] as Tier[]) {
    expect(await h.client.send({ type: "settings.set", patch: { tier } })).toMatchObject({ ok: true })
    // Full prompt mode exposes skill metadata; focus alone would hide this regression.
    for (const mode of ["focus", "full"] as const) {
      expect(await h.client.send({ type: "prompt.set", directory: h.project, mode })).toMatchObject({ ok: true })
      const baseline = await h.report()
      const baselineSystem = h.system()
      for (const scope of ["user", "project"] as const) {
        for (const name of names) {
          const reply = await h.client.send({ type: "packages.install", directory: h.project, source: path.join(official, name), scope })
          expect(reply.ok).toBe(true)
          const measured = await h.report()
          console.log(`${tier}/${mode}/${scope} ${name}: base=${baseline.estimatedTokens} installed=${measured.estimatedTokens} delta=${measured.estimatedTokens - baseline.estimatedTokens} (chars/4)`)
          expect(measured.estimatedTokens, `${tier}/${mode}/${scope}:${name}`).toBe(baseline.estimatedTokens)
          // Exact text comparison also catches equal-sized replacement/rounding effects.
          expect(measured.sections).toEqual(baseline.sections)
          expect(h.system()).toBe(baselineSystem)
          const listed = await h.client.send({ type: "packages.list", directory: h.project })
          expect(listed.ok).toBe(true)
          if (!listed.ok) throw new Error(listed.error.message)
          const pkg = PackagesReport.parse(listed.result).packages.find((pkg) => pkg.key === `${scope}:${name}`)!
          expect(pkg.contextCost).toMatchObject({ idleTokens: 0, method: "chars/4" })
          expect(pkg.contextCost!.onDemandTokens).toBeGreaterThan(0)
          expect(await h.client.send({ type: "packages.remove", directory: h.project, name, scope })).toMatchObject({ ok: true })
        }
        // Combined installations must also stay free of unused metadata.
        for (const name of names) expect(await h.client.send({ type: "packages.install", directory: h.project, source: path.join(official, name), scope })).toMatchObject({ ok: true })
        expect((await h.report()).sections).toEqual(baseline.sections)
        expect(h.system()).toBe(baselineSystem)
        for (const name of names) expect(await h.client.send({ type: "packages.remove", directory: h.project, name, scope })).toMatchObject({ ok: true })
      }
    }
  }
}, 30_000)

test("the measurement detects an ordinary skill's idle metadata; explicit skills still load on demand", async () => {
  const h = await boot()
  await h.client.send({ type: "settings.set", patch: { tier: "full" } })
  await h.client.send({ type: "prompt.set", directory: h.project, mode: "full" })
  const baseline = await h.report()
  await h.client.send({ type: "packages.install", directory: h.project, source: path.join(official, "mendcode-web-routing"), scope: "project" })
  expect(await h.client.send({ type: "skills.load", directory: h.project, name: "explicit-web" })).toMatchObject({ ok: true, result: { body: expect.stringContaining("fallback disabled") } })
  const folder = path.join(h.project, ".mendcode/packages/mendcode-web-routing/skills/explicit-web")
  writeFileSync(path.join(folder, "SKILL.md"), "---\nname: explicit-web\ndescription: ordinary discovery\n---\nBody")
  expect((await h.report()).estimatedTokens).toBeGreaterThan(baseline.estimatedTokens)
  const listed = await h.client.send({ type: "packages.list", directory: h.project })
  if (!listed.ok) throw new Error(listed.error.message)
  expect(PackagesReport.parse(listed.result).packages[0]!.contextCost!.idleTokens).toBeGreaterThan(0)
})

test("context estimates fail unknown for config/code/symlinks and packages.list is local only", async () => {
  const h = await boot()
  await h.client.send({ type: "packages.install", directory: h.project, source: path.join(official, "mendcode-review"), scope: "project" })
  const folder = path.join(h.project, ".mendcode/packages/mendcode-review")
  const readCost = async () => {
    const reply = await h.client.send({ type: "packages.list", directory: h.project })
    if (!reply.ok) throw new Error(reply.error.message)
    return PackagesReport.parse(reply.result).packages[0]!.contextCost
  }
  const original = await readCost()
  expect(original).toMatchObject({ idleTokens: 0, method: "chars/4" })
  // A prompt override changes the base; never certify it as a zero-cost data package.
  writeFileSync(path.join(folder, "APPEND_SYSTEM.md"), "Injected context")
  expect(await readCost()).toBeUndefined()
  rmSync(path.join(folder, "APPEND_SYSTEM.md"))
  writeFileSync(path.join(folder, "commands/huge.md"), "x".repeat(160_001))
  expect(await readCost()).toBeUndefined()
  rmSync(path.join(folder, "commands/huge.md"))
  expect(await readCost()).toEqual(original)
  mkdirSync(path.join(folder, "commands/nested"))
  const outside = path.join(h.dir, "outside.md")
  writeFileSync(outside, "Fixture data outside the package")
  symlinkSync(outside, path.join(folder, "commands/nested/leak.md"))
  const reply = await h.client.send({ type: "packages.list", directory: h.project })
  expect(reply.ok).toBe(true)
  if (reply.ok) expect(PackagesReport.parse(reply.result).packages[0]).not.toHaveProperty("contextCost")
  expect(isReadOnlyCommand("packages.list")).toBe(false)
  const ids = createIdFactory()
  const remote = await h.daemon.httpAdapter!.fetch(new Request("http://127.0.0.1/command", {
    method: "POST", headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" },
    body: JSON.stringify({ id: ids("command"), clientId: ids("client"), type: "packages.list", directory: h.project }),
  }))
  expect(await remote!.json()).toMatchObject({ error: { code: "forbidden" } })
})
