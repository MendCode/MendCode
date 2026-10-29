import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { parsePetCommand } from "../src/pet-command"
import { parseStartup } from "../src/startup"
import { renderPetPlan, petPlanText, petUsd } from "../src/view/pet-plan"
import { renderPetPicker, petPickerKey } from "../src/view/pet-picker"
import { listPets } from "../src/pets/manifest"
import { readTuiProfile, writeTuiProfile, DEFAULT_TUI_PROFILE } from "../src/view/tui-profile"
import { petAtlas, petFrame } from "../../../packages/tools/src/pet-raster"
import { fixturePng } from "../../../packages/tools/test/pet-fixture"
import { PET_CORE_STATES, type PetPlan } from "../../../packages/protocol/src/pet-data"
import { appHarness, cleanTemps } from "./session-ui-harness"

const dirs: string[] = []
afterEach(() => { cleanTemps(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const plan: PetPlan = { planId: "8ddc8f2f-6590-4e1f-8dab-108753ca0fa9", description: "A small blue owl", states: [...PET_CORE_STATES], calls: 6, estimatedUsd: 0.6, unitUsd: 0.1, model: "openai/test-image", prompt: "fixture", expires: 3_000_000 }
const plain = (rows: ReturnType<typeof renderPetPlan>) => rows.map((line) => line.map((span) => span.text).join("")).join("\n")

test("CLI and slash produce a plan, never an automatic paid call", () => {
  expect(parseStartup(["pet", "new", "small blue owl", "--usd", "0.1", "--optional"]).prompt).toBe("/pet new small blue owl --usd 0.1 --optional")
  expect(parsePetCommand("new small blue owl --usd 0.1 --optional")).toMatchObject({ action: "plan", optional: true, unitUsd: 0.1 })
  expect(parseStartup(["pet", "new", "owl"]).prompt).toBe("/pet new owl")
  const unpriced = parsePetCommand("new owl")
  expect(unpriced).toMatchObject({ action: "plan", description: "owl" })
  expect(unpriced).not.toHaveProperty("unitUsd")
  expect(() => parsePetCommand("new owl --usd")).toThrow("--usd")
  expect(() => parsePetCommand("new owl --usd 0")).toThrow("greater")
  expect(() => parsePetCommand("delete abc")).toThrow("--confirm")
  expect(parsePetCommand("rename user:abc Blue owl")).toMatchObject({ action: "rename", petId: "abc", name: "Blue owl" })
  expect(parsePetCommand("export user:abc")).toMatchObject({ action: "export", petId: "abc" })
  expect(parsePetCommand("off")).toBeUndefined()
})

test("plan card shows the cost with two decimals, or not set, and stays as tall as its content", () => {
  const text = plain(renderPetPlan({ plan, width: 120, height: 40 }))
  expect(text).toContain("image calls  6")
  expect(text).toContain("est. cost    $0.60")
  expect(text).not.toContain("0.600000")
  expect(text).toContain("description and reference image go to the image provider")
  expect(text).toContain("estimate only · failed calls are not refunded")
  expect(text).toContain("y generate · esc cancel")
  expect(text.split("\n").filter((line) => line.includes("│"))).toHaveLength(11)
  expect(petPlanText(plan).join(" ")).toContain("est. cost $0.60")
  const { unitUsd: _unit, estimatedUsd: _estimate, ...unpriced } = plan
  expect(plain(renderPetPlan({ plan: unpriced, width: 80, height: 24 }))).toContain("est. cost    not set")
  expect(petUsd(0.004)).toBe("<$0.01")
})

test("progress shows one row per call with marks and a running count", () => {
  const steps = [{ label: "reference", status: "done" }, { label: "idle", status: "done" }, { label: "running", status: "done" }, { label: "waiting", status: "working" }, { label: "review", status: "pending" }, { label: "failed", status: "pending" }] as const
  const text = plain(renderPetPlan({ plan, width: 80, height: 24, busy: true, progress: { planId: plan.planId, steps: [...steps] } }))
  expect(text).toContain("generating  3/6")
  expect(text).toContain("● idle         done")
  expect(text).toContain("▸ waiting      working")
  expect(text).toContain("○ review       pending")
  expect(text).toContain("cannot cancel while calls run")
  const stopped = plain(renderPetPlan({ plan, width: 80, height: 24, error: "Pet image call failed", progress: { planId: plan.planId, steps: steps.map((step) => step.status === "working" ? { ...step, status: "failed" as const } : step) } }))
  expect(stopped).toContain("× waiting      failed")
  expect(stopped).toContain("esc back")
})

test("a generated pet lists each state with its source and offers its actions", () => {
  const image = petFrame(fixturePng())
  const choice = { ref: "user:ca11b6ae-69d1-4f42-8b56-4bbcea845f80", name: "Blue owl", description: "A blue owl", image, states: [...PET_CORE_STATES], generated: [...PET_CORE_STATES] }
  for (const [width, height] of [[80, 24], [120, 40]] as const) {
    const text = plain(renderPetPicker({ choices: [choice], state: { selected: 0 }, current: "off", width, height }))
    expect(text).toContain("idle     generated")
    expect(text).toContain("waving   fallback idle")
    expect(text).toContain("r regenerate state · n rename · d delete · enter use")
  }
  const state = { selected: 0, state: 2 }
  expect(petPickerKey(state, "r", [choice]).action).toEqual({ type: "fill", text: `/pet regen ${choice.ref} waiting` })
  expect(petPickerKey(state, "n", [choice]).action).toEqual({ type: "fill", text: `/pet rename ${choice.ref} ` })
  expect(petPickerKey(state, "d", [choice]).action).toEqual({ type: "fill", text: `/pet delete ${choice.ref} --confirm` })
  expect(petPickerKey({ selected: 0 }, "\x1b[C", [choice]).state).toEqual({ selected: 0, state: 1 })
  expect(petPickerKey(state, "r", [{ ...choice, ref: "codex:owl" }]).action).toEqual({ type: "none" })
})

test("generated, installed bitmap and built-in pets each keep their own card at 80x24 and 120x40, with and without images", () => {
  const image = petFrame(fixturePng())
  const mend = { ref: "mend", name: "Mend (ASCII)", description: "Official Mend mascot", source: "Built-in", states: ["idle"], preview: [[{ text: "/|[+]|\\", fg: "text" as const }]] }
  const installed = { ref: "user:tiny", name: "Tiny", description: "A 6x4-pixel test pet.", source: "user", image, states: ["idle"] }
  const generated = { ref: "user:ca11b6ae-69d1-4f42-8b56-4bbcea845f80", name: "Blue owl", description: "A blue owl", image, states: [...PET_CORE_STATES], generated: [...PET_CORE_STATES] }
  const choices = [mend, installed, generated]
  for (const [width, height] of [[80, 24], [120, 40]] as const) {
    for (const graphics of [false, true]) {
      const show = (selected: number) => {
        const placements: Parameters<typeof renderPetPicker>[0]["placements"] = []
        const text = plain(renderPetPicker({ choices, state: { selected }, current: "off", width, height, graphics, placements }))
        return { text, placements: placements ?? [] }
      }
      const builtIn = show(0)
      expect(builtIn.placements).toEqual([])
      expect(builtIn.text).toContain("/|[+]|\\")
      const plainPet = show(1)
      expect(plainPet.text).toContain("Source: user")
      expect(plainPet.text).toContain("States: idle")
      expect(plainPet.text).not.toContain("regenerate state")
      expect(graphics ? plainPet.placements : plainPet.text.match(/▀/)).toBeTruthy()
      const owl = show(2)
      expect(owl.text).toContain("regenerate state")
      expect(graphics ? owl.placements : owl.text.match(/▀/)).toBeTruthy()
    }
  }
  expect(petPickerKey({ selected: 1 }, "d", choices).action).toEqual({ type: "none" })
})

test("installed package pet is discoverable and previewed with idle fallback", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-pet-package-"))
  dirs.push(dir)
  const folder = path.join(dir, "owl")
  mkdirSync(folder)
  writeFileSync(path.join(folder, "pet.json"), JSON.stringify({ id: "owl", displayName: "Blue owl", spritesheetPath: "spritesheet.png" }))
  const image = petFrame(fixturePng())
  writeFileSync(path.join(folder, "spritesheet.png"), petAtlas(Object.fromEntries(PET_CORE_STATES.map((state) => [state, image]))))
  const { pets, skipped } = await listPets([{ dir, source: "package" }])
  expect(skipped).toHaveLength(0)
  expect(pets[0]!.ref).toBe("package:owl")
  const rows = renderPetPicker({ choices: [{ ref: "package:owl", name: "Blue owl", description: "Fixture", image, states: [...PET_CORE_STATES] }], state: { selected: 0 }, current: "off", width: 120, height: 40 })
  expect(plain(rows)).toContain("Blue owl")
  expect(plain(rows)).toContain("▀")
})

test("slash UI requires y, escape cancels and remote clients cannot plan", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-pet-ui-"))
  dirs.push(dir)
  const harness = appHarness({ pets: { dirs: [], cacheDir: dir, images: false }, reply: (command) => command.type === "pet.manage" ? { ok: true, result: command.input.action === "plan" ? { plan } : { ref: "user:fixture" } } : command.type === "packages.list" ? { ok: true, result: { directory: dir, packages: [] } } : { ok: true } })
  harness.app.applySettings({ onboarded: true })
  await harness.type("/pet new blue owl --usd 0.1\r")
  expect(harness.text().join("\n")).toContain("image calls  6")
  expect(harness.sentOf("pet.manage")).toHaveLength(1)
  await harness.type("\x1b")
  expect(harness.sentOf("pet.manage")).toHaveLength(1)
  await harness.type("/pet new blue owl --usd 0.1\r")
  await harness.type("y")
  expect(harness.sentOf("pet.manage").at(-1)).toMatchObject({ input: { action: "generate", confirmed: true } })
  const remote = appHarness({ remote: true, pets: { dirs: [], cacheDir: dir, images: false } })
  remote.app.applySettings({ onboarded: true })
  await remote.type("/pet new owl --usd 0.1\r")
  expect(remote.sentOf("pet.manage")).toHaveLength(0)
})

test("deleting the selected pet persists off in the local profile", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-pet-delete-ui-"))
  dirs.push(dir)
  writeTuiProfile(dir, { ...DEFAULT_TUI_PROFILE, pet: "user:fixture" })
  const harness = appHarness({ dataDir: dir, pets: { dirs: [], cacheDir: dir, images: false }, reply: (command) => command.type === "packages.list" ? { ok: true, result: { directory: dir, packages: [] } } : command.type === "pet.manage" ? { ok: true, result: {} } : undefined })
  harness.app.applySettings({ onboarded: true })
  await harness.type("/pet delete fixture --confirm\r")
  expect(readTuiProfile(dir).pet).toBe("off")
})
