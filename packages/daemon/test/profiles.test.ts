import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import type { MemoryEntry, ModelInfo, ModelsReport, SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import type { ModelCatalog } from "../src/models"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function temp(prefix: string) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const MODELS: ModelInfo[] = [{ id: "gpt-6-luna", name: "GPT-6-Luna", efforts: ["low", "medium", "high"], defaultEffort: "low" }]
const catalog: ModelCatalog = { selectable: true, list: () => MODELS, defaults: { model: "gpt-6-luna", effort: "low" } }

async function boot() {
  const dir = temp("mendd-profiles-")
  const work = temp("profiles-work-")
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), models: catalog, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  const client = createClient({ socketPath: daemon.socketPath, name: "profiles" })
  await client.connect()
  cleanups.push(() => daemon.stop(), () => client.close())
  const company = path.join(work, "acme")
  const personal = path.join(work, "mine")
  const set = await client.send({ type: "settings.set", patch: { profiles: [{ name: "company", directories: [`${company}/*`], defaultPermission: "edits" }] } })
  expect(set).toMatchObject({ ok: true })
  return { daemon, client, company: path.join(company, "api"), personal }
}

const memories = async (client: ReturnType<typeof createClient>, directory: string) => {
  const reply = await client.send({ type: "memory.list", directory })
  return ((reply.ok ? reply.result?.memories : []) as MemoryEntry[]).map((memory) => memory.text)
}

describe("profiles by folder", () => {
  test("user memories stay inside the profile they were saved in; project memories follow their folder", async () => {
    const { client, company, personal } = await boot()
    await client.send({ type: "memory.add", scope: "user", directory: company, text: "Use the company style guide" })
    await client.send({ type: "memory.add", scope: "user", directory: personal, text: "I like terse answers" })
    await client.send({ type: "memory.add", scope: "project", directory: company, text: "api uses pnpm" })
    expect(await memories(client, company)).toEqual(["api uses pnpm", "Use the company style guide"])
    expect(await memories(client, personal)).toEqual(["I like terse answers"])
    const search = await client.send({ type: "memory.search", query: "style", directory: personal })
    expect(search).toMatchObject({ ok: true, result: { memories: [] } })
    // Without a directory (the global view) every profile's memories are listed, each tagged.
    const all = await client.send({ type: "memory.list" })
    expect(((all.ok ? all.result?.memories : []) as MemoryEntry[]).find((memory) => memory.text.includes("company"))?.profile).toBe("company")
  })

  test("a recipe applied in a profile's folder sets that profile's roles only; new sessions take its default permission", async () => {
    const { daemon, client, company, personal } = await boot()
    expect(await client.send({ type: "recipes.apply", directory: company, name: "deep" })).toMatchObject({ ok: true, result: { active: "deep" } })
    const settings = daemon.store.settings.get()
    expect(settings.models).toBeUndefined()
    expect(settings.profiles?.[0]?.models?.main).toEqual({ model: "gpt-6-luna", effort: "high" })
    const listed = await client.send({ type: "recipes.list", directory: personal })
    expect(listed.ok && listed.result?.active).toBeFalsy()
    const created = await client.send({ type: "session.create", directory: company })
    const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
    await Bun.sleep(20)
    expect(daemon.store.permissionModeOf(sessionId)).toBe("edits")
    const models = await client.send({ type: "models.list", sessionId })
    expect((models.ok ? (models.result as ModelsReport) : undefined)?.effective).toEqual({ model: "gpt-6-luna", effort: "high" })
    const other = await client.send({ type: "session.create", directory: personal })
    await Bun.sleep(20)
    expect(daemon.store.permissionModeOf((other.ok ? other.result?.sessionId : undefined) as SessionId)).toBe("ask")
  })
})
