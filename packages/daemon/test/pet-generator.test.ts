import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { BudgetPolicy, type Settings } from "@mendcode/protocol"
import type { ImageApi, ImageApiInput } from "../../tools/src/tools/image_api"
import { fixturePng } from "../../tools/test/pet-fixture"
import { PetInput } from "../../protocol/src/pet"
import { PET_CORE_STATES, PET_IMPORT_STATES, type PetPlan } from "../../protocol/src/pet-data"
import { PACKAGE_KINDS } from "../../protocol/src/package-kinds"
import { createBudgets } from "../src/budgets"
import { createPetGenerator } from "../src/pet-generator"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture(provider?: ImageApi) {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-pet-new-"))
  dirs.push(dir)
  let settings: Settings = { tier: "full", image_generation: { enabled: true, model: "openai/test-image" }, budgets: BudgetPolicy.parse({ mode: "api-usage", stopUsd: 10 }) }
  let time = 1_000_000
  const calls: ImageApiInput[] = []
  const budgets = createBudgets({ dir, settings: () => settings, seed: () => ({ costMicros: 0, knownCalls: 0, unknownCalls: 0 }) })
  const image: ImageApi = async (request) => { calls.push(request); return provider ? provider(request) : { ok: true, model: "test-image", images: [{ bytes: fixturePng(), type: "png" }] } }
  const generator = createPetGenerator({ dir, settings: () => settings, budgets, image: () => image, now: () => time })
  const plan = async (optional = false) => (await generator.manage("local", { action: "plan", description: "Small blue owl", unitUsd: 0.1, optional })).plan as PetPlan
  const generate = (value: PetPlan) => generator.manage("local", { action: "generate", planId: value.planId, confirmed: true })
  return { dir, calls, budgets, generator, plan, generate, set: (patch: Partial<Settings>) => { settings = { ...settings, ...patch } }, expire: () => { time += 300_001 } }
}

test("plan has exact cost/calls and requires explicit owner-bound confirmation", async () => {
  const item = fixture()
  const plan = await item.plan()
  expect(plan).toMatchObject({ calls: 6, estimatedUsd: 0.6, states: [...PET_CORE_STATES] })
  expect(item.calls).toHaveLength(0)
  expect(existsSync(path.join(item.dir, "pets"))).toBe(false)
  expect(PetInput.safeParse({ action: "generate", planId: plan.planId }).success).toBe(false)
  expect(PetInput.safeParse({ action: "generate", planId: plan.planId, confirmed: false }).success).toBe(false)
  await expect(item.generator.manage("other", { action: "generate", planId: plan.planId, confirmed: true })).rejects.toThrow("another client")
  expect((await item.plan(true)).calls).toBe(8)
  item.expire()
  await expect(item.generate(plan)).rejects.toThrow("expired")
  expect(item.calls).toHaveLength(0)
})

test("the states only an import brings are never generated: the plans are the calls they were, and none can be asked for", async () => {
  const item = fixture()
  expect((await item.plan()).states).toEqual(["idle", "running", "waiting", "review", "failed"])
  expect(await item.plan(true)).toMatchObject({ calls: 8, estimatedUsd: 0.8, states: ["idle", "running", "waiting", "review", "failed", "waving", "jumping"] })
  const petId = "8ddc8f2f-6590-4e1f-8dab-108753ca0fa9"
  expect(PetInput.safeParse({ action: "plan-state", petId, state: "jumping" }).success).toBe(true)
  for (const state of PET_IMPORT_STATES) expect(PetInput.safeParse({ action: "plan-state", petId, state }).success).toBe(false)
  // A `--frames` sheet still has at most the seven generated rows.
  expect(PetInput.safeParse({ action: "import", path: "/tmp/sheet.png", frames: { columns: 4, rows: 7 } }).success).toBe(true)
  expect(PetInput.safeParse({ action: "import", path: "/tmp/sheet.png", frames: { columns: 4, rows: 8 } }).success).toBe(false)
  expect(item.calls).toHaveLength(0)
})

test("budget is checked at plan and confirmation, including unknown prior calls", async () => {
  const item = fixture()
  item.set({ budgets: BudgetPolicy.parse({ mode: "api-usage", stopUsd: 0.5 }) })
  await expect(item.plan()).rejects.toThrow("USD budget")
  item.set({ budgets: BudgetPolicy.parse({ mode: "api-usage", stopUsd: 1 }) })
  const plan = await item.plan()
  item.budgets.record({ provider: "fixture", model: plan.model, input: 0, output: 0, costMicros: 500_000 })
  await expect(item.generate(plan)).rejects.toThrow("USD budget")
  item.budgets.record()
  await expect(item.plan()).rejects.toThrow("unknown cost")
  expect(item.calls).toHaveLength(0)
})

test("a plan without a price estimates and reserves nothing, and a USD stop refuses it", async () => {
  const item = fixture()
  item.set({ budgets: BudgetPolicy.parse({ mode: "api-usage", stopUsd: null }) })
  const unpriced = (await item.generator.manage("local", { action: "plan", description: "Small blue owl" })).plan as PetPlan
  expect(unpriced.calls).toBe(6)
  expect(unpriced).not.toHaveProperty("unitUsd")
  expect(unpriced).not.toHaveProperty("estimatedUsd")
  await item.generate(unpriced)
  expect(item.calls).toHaveLength(6)
  expect(item.budgets.report("openai/test-image").enforcement.currentKnownUsd).toBe(0)
  item.set({ budgets: BudgetPolicy.parse({ mode: "api-usage", stopUsd: 10 }) })
  await expect(item.generator.manage("local", { action: "plan", description: "Small blue owl" })).rejects.toThrow("--usd")
})

test("status reports each call of the running generation to its owner only", async () => {
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  let count = 0
  const item = fixture(async () => { if (++count === 3) await gate; return { ok: true, model: "test-image", images: [{ bytes: fixturePng(), type: "png" }] } })
  const plan = await item.plan()
  const running = item.generate(plan)
  while (count < 3) await Bun.sleep(5)
  const seen = (await item.generator.manage("local", { action: "status", planId: plan.planId })).progress as { steps: Array<{ label: string; status: string }> }
  expect(seen.steps.map((step) => `${step.label}:${step.status}`)).toEqual(["reference:done", "idle:done", "running:working", "waiting:pending", "review:pending", "failed:pending"])
  expect((await item.generator.manage("other", { action: "status", planId: plan.planId })).progress).toBeNull()
  release!()
  await running
  const end = (await item.generator.manage("local", { action: "status", planId: plan.planId })).progress as { steps: Array<{ status: string }> }
  expect(end.steps.every((step) => step.status === "done")).toBe(true)
})

test("local-only, tier, explicit tool deny and plan mode prevent generation", async () => {
  const item = fixture()
  await expect(item.generator.manage("peer", { action: "plan", description: "owl", unitUsd: 1 }, true)).rejects.toThrow("local only")
  item.set({ tier: "balanced" })
  await expect(item.plan()).rejects.toThrow("full tier")
  item.set({ tier: "full", tools: { image_gen: false } })
  await expect(item.plan()).rejects.toThrow("denied")
  item.set({ tools: {}, defaultPermission: "plan" })
  await expect(item.plan()).rejects.toThrow("permission mode")
  expect(item.calls).toHaveLength(0)
})

test("install, regenerate one state, rename, portable package export and Trash delete", async () => {
  const item = fixture()
  const result = await item.generate(await item.plan())
  const petId = result.petId as string
  expect(item.calls).toHaveLength(6)
  expect(item.calls[0]!.references).toHaveLength(0)
  for (const call of item.calls.slice(1)) {
    expect(call.references).toHaveLength(1)
    expect(call.references[0]!.bytes).toEqual(fixturePng())
    expect(call.size).toBe("1024x1024")
    expect(call.prompt).toContain("RGB332")
  }
  const petDir = path.join(item.dir, "pets", petId)
  const idle = readFileSync(path.join(petDir, "idle.png"))
  const manifest = JSON.parse(readFileSync(path.join(petDir, "pet.json"), "utf8"))
  expect(manifest).toMatchObject({ experimental: true, model: "openai/test-image", spritesheetPath: "spritesheet.png" })
  const regen = (await item.generator.manage("local", { action: "plan-state", petId, state: "failed", unitUsd: 0.1 })).plan as PetPlan
  expect(regen.calls).toBe(1)
  await item.generate(regen)
  expect(item.calls).toHaveLength(7)
  expect(readFileSync(path.join(petDir, "idle.png"))).toEqual(idle)
  await item.generator.manage("local", { action: "rename", petId, name: "Owl" })
  const exported = await item.generator.manage("local", { action: "export", petId })
  const exportedDir = exported.directory as string
  expect(JSON.parse(readFileSync(path.join(exportedDir, "mendcode-package.json"), "utf8"))).toMatchObject({ extensions: false })
  expect(JSON.parse(readFileSync(path.join(exportedDir, "pets", petId, "pet.json"), "utf8"))).toMatchObject({ displayName: "Owl" })
  expect(PACKAGE_KINDS.find((kind) => kind.id === "pets")).toMatchObject({ selection: "pets", executable: false })
  item.set({ image_generation: { enabled: false } })
  const deleted = await item.generator.manage("local", { action: "delete", petId, confirmed: true })
  expect(existsSync(petDir)).toBe(false)
  expect(existsSync(deleted.trashed as string)).toBe(true)
})

test("changed config, provider failures and symlinks leave no installed partial pet", async () => {
  const changed = fixture()
  const plan = await changed.plan()
  changed.set({ image_generation: { enabled: true, model: "openai/changed" } })
  await expect(changed.generate(plan)).rejects.toThrow("settings changed")
  const invalid = fixture(async () => ({ ok: true, model: "fake", images: [{ bytes: new Uint8Array([1]), type: "png" }] }))
  await expect(invalid.generate(await invalid.plan())).rejects.toThrow("signature")
  expect(existsSync(path.join(invalid.dir, "pets"))).toBe(false)
  expect(invalid.budgets.report("test").telemetry.recordedUsd).toBe(0.6)
  const failed = fixture(async () => ({ ok: false, message: "private-token-never-echo" }))
  await expect(failed.generate(await failed.plan())).rejects.toThrow("check provider configuration")
  const thrown = fixture(async () => { throw new Error("private-token-never-echo") })
  await expect(thrown.generate(await thrown.plan())).rejects.toThrow("check provider configuration")
  const linked = fixture()
  symlinkSync(changed.dir, path.join(linked.dir, "pets"))
  await expect(linked.generate(await linked.plan())).rejects.toThrow("symlinks")
})

test("--frames draws a small loop for every state from its first pose, one call a frame, and a redrawn state keeps it", async () => {
  const item = fixture()
  const plan = (await item.generator.manage("local", { action: "plan", description: "Small blue owl", unitUsd: 0.1, frames: 3 })).plan as PetPlan
  expect(plan).toMatchObject({ frames: 3, calls: 16, estimatedUsd: 1.6 })
  expect(PetInput.safeParse({ action: "plan", description: "owl", frames: 5 }).success).toBe(false)
  const result = await item.generate(plan) as { petId: string }
  expect(item.calls).toHaveLength(16)
  // A frame after the first is drawn from the reference and that state's first pose.
  expect(item.calls.filter((call) => call.references?.length === 2)).toHaveLength(10)
  const folder = path.join(item.dir, "pets", result.petId)
  expect(JSON.parse(readFileSync(path.join(folder, "pet.json"), "utf8")).frames).toBe(3)
  for (const state of PET_CORE_STATES) for (const file of [`${state}.png`, `${state}.2.png`, `${state}.3.png`]) expect(existsSync(path.join(folder, file))).toBe(true)
  const redraw = (await item.generator.manage("local", { action: "plan-state", petId: result.petId, state: "idle", unitUsd: 0.1 })).plan as PetPlan
  expect(redraw).toMatchObject({ frames: 3, calls: 3 })
  await item.generate(redraw)
  expect(item.calls).toHaveLength(19)
  expect(JSON.parse(readFileSync(path.join(folder, "pet.json"), "utf8")).frames).toBe(3)
})
