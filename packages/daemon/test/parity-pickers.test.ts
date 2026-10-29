import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createNativeEngine, type ModelRequest, type SkillLoader } from "@mendcode/engine-native"
import { HistoryReport, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { resolveModel, type ModelCatalog } from "../src/models"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const catalog: ModelCatalog = { selectable: true, defaults: { model: "local:test" }, list: () => [{ id: "local:test", name: "Local", provider: "local", efforts: ["low", "high"], variants: { precise: { effort: "high", parameters: { temperature: 0, text: { verbosity: "low" } } } } }] }
async function boot(dir: string) {
  const requests: ModelRequest[] = []
  let loader!: SkillLoader
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), models: catalog, info: { engine: "native" }, log: () => {}, engine: ({ store, skills }) => {
    loader = skills
    return createNativeEngine({ provider: { id: "local", model: "test", async *stream(request) { requests.push(request); yield { type: "text", delta: "Local response" }; yield { type: "finish", reason: "stop" } } }, tools: [], history: { load: async () => undefined, save: async () => {}, replace: async () => {} }, compactionPrompt: "Summarize", cwdFor: (id) => store.sessionDirectory(id)!, system: (cwd) => skills.block(cwd), modelFor: (id, role) => resolveModel({ role, session: store.sessionModel(id), roles: {}, catalog }) })
  } })
  cleanup.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "parity-pickers" })
  await client.connect()
  cleanup.push(() => client.close())
  return { daemon, client, requests, loader }
}
function tmp() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-pickers-")))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test("skills toggle persists per project, controls prompt and load, and survives daemon restart", async () => {
  const dir = tmp()
  const project = tmp()
  const folder = path.join(project, ".mendcode", "skills", "review")
  mkdirSync(folder, { recursive: true })
  writeFileSync(path.join(folder, "SKILL.md"), "---\nname: review\ndescription: Review source\n---\nRead callers before changes")
  const h = await boot(dir)
  const listed = await h.client.skills(project)
  expect(listed.ok ? listed.report.skills.find((s) => s.name === "review") : undefined).toMatchObject({ name: "review", enabled: true })
  expect(await h.client.send({ type: "skills.load", directory: project, name: "review" })).toMatchObject({ ok: true, result: { body: "Read callers before changes" } })
  expect((await h.client.send({ type: "skills.set", directory: project, name: "review", enabled: false })).ok).toBe(true)
  expect(h.loader.block(project)).not.toContain("- review:")
  expect(h.loader.load(project, "review")).toBeUndefined()
  expect(await h.client.send({ type: "skills.load", directory: project, name: "review" })).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
  expect(await h.client.send({ type: "skills.set", directory: project, name: "unknown", enabled: false })).toMatchObject({ ok: false })
  h.client.close()
  await h.daemon.stop()
  const restarted = await boot(dir)
  const after = await restarted.client.skills(project)
  expect(after.ok ? after.report.skills.find((s) => s.name === "review")?.enabled : undefined).toBe(false)
  await restarted.client.send({ type: "skills.set", directory: project, name: "review", enabled: true })
  expect(restarted.loader.block(project)).toContain("- review: Review source")
  expect(restarted.loader.load(project, "review")?.body).toContain("Read callers")
})

test("named variants reach the real engine call, history works over the wire, and invalid choices do not persist", async () => {
  const h = await boot(tmp())
  const created = await h.client.send({ type: "session.create", directory: tmp() })
  const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
  expect(await h.client.send({ type: "session.model.set", sessionId, choice: { model: "local:test", variant: "precise" } })).toMatchObject({ ok: true, result: { effective: { variant: "precise", effort: "high", parameters: { temperature: 0 } } } })
  expect(await h.client.send({ type: "session.model.set", sessionId, choice: { model: "local:test", variant: "missing" } })).toMatchObject({ ok: false })
  await h.client.send({ type: "user.submit", sessionId, text: "Prompt", attachments: [] })
  for (let i = 0; i < 100 && !h.requests.length; i++) await Bun.sleep(5)
  expect(h.requests[0]).toMatchObject({ model: "local:test", effort: "high", parameters: { temperature: 0, text: { verbosity: "low" } } })
  let turns = [] as ReturnType<typeof HistoryReport.parse>["turns"]
  for (let i = 0; i < 100; i++) {
    const reply = await h.client.history(sessionId)
    if (reply.ok) turns = HistoryReport.parse(reply.history).turns
    if (turns[0]?.outcome === "completed") break
    await Bun.sleep(5)
  }
  expect(turns[0]?.items.map((item) => item.text)).toEqual(["Prompt", "Local response"])
  await h.client.send({ type: "session.model.set", sessionId, choice: { model: "local:test" } })
  expect(await h.client.send({ type: "models.list", sessionId })).toMatchObject({ ok: true, result: { effective: { model: "local:test" } } })
  const reset = await h.client.send({ type: "models.list", sessionId })
  expect(reset.ok ? (reset.result?.effective as Record<string, unknown>).parameters : "error").toBeUndefined()
})
