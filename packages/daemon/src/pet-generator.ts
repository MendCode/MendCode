import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { Settings } from "@mendcode/protocol"
import { featureOn } from "@mendcode/protocol/wire"
import { PET_CORE_STATES, PET_MAX_FRAMES, PET_OPTIONAL_STATES, readPetLayout, type GeneratedPetState, type PetLayout, type PetPlan, type PetProgress, type PetProgressStep } from "../../protocol/src/pet-data"
import { buildImportedPet, IMPORT_BUDGET } from "../../tools/src/pet-import"
import { readImportSource } from "./pet-import"
import type { PetInput } from "../../protocol/src/pet"
import type { ImageApi } from "../../tools/src/tools/image_api"
import { decodePng, type PetImage } from "../../tools/src/pet-decode"
import { encodeImagePng } from "../../tools/src/pet-png"
import { petAtlas, petFrame, petScale, validatePetFrame } from "../../tools/src/pet-raster"
import type { createBudgets } from "./budgets"
import { matchingRule, policyRules } from "../../engine-native/src/permission-rules"

type Input = import("zod").infer<typeof PetInput>
type Manifest = { id: string; displayName: string; description: string; spritesheetPath: string; spriteVersionNumber: 1; prompt: string; model: string; date: string; states: GeneratedPetState[]; frames?: number; experimental: true }
/** A pet made by `/pet import`: no prompt and no model, and a layout of its own frames instead of the fixed atlas. */
type ImportedManifest = { id: string; displayName: string; description: string; spritesheetPath: string; spriteVersionNumber: 1; date: string; imported: true; layout: PetLayout }
/** Words `/mascot` and `/pet` read as something else: a pet cannot be called by one. */
const RESERVED_NAMES = ["off", "mend", "mendy", "static", "animated", "small", "medium", "large", "new", "import", "regen", "rename", "delete", "export"]
/** A generated pet's frames for each state; one before `--frames`. */
const framesOf = (manifest: { frames?: number }) => (Number.isInteger(manifest.frames) && manifest.frames! >= 1 && manifest.frames! <= PET_MAX_FRAMES ? manifest.frames! : 1)
/** Where frame `at` (from 0) of a state is kept: `idle.png`, then `idle.2.png` ... */
const frameFile = (state: GeneratedPetState, at: number) => (at === 0 ? `${state}.png` : `${state}.${at + 1}.png`)
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const direction = "One single full-body pixel-art character, no text, no panels, no scenery. Transparent RGBA PNG, 1024x1024 canvas, centered with generous transparent margins. Fixed RGB332 palette, crisp nearest-neighbour edges. Keep identity, proportions and palette identical to the reference, and the character at the reference's exact size and place on the canvas, feet on the same line."

export function createPetGenerator(input: { dir: string; settings(): Settings; budgets: ReturnType<typeof createBudgets>; image(model: string): ImageApi; validateModel?(model: string): void; now?(): number }) {
  const plans = new Map<string, { owner: string; plan: PetPlan; fingerprint: string }>()
  const now = input.now ?? Date.now
  let busy = false
  /** The last generation's calls, kept after it ends so a client can still read where it stopped. */
  let progress: { owner: string; value: PetProgress } | undefined
  /** `generator` is false for an import: it makes no image, so a rule against the generator does not stop it. */
  function permissions(generation: boolean, generator = true) {
    const settings = input.settings()
    if (generation && settings.defaultPermission === "plan") throw new Error("Pet generation is blocked by the permission mode")
    const rules = policyRules(settings)
    const operations = generation ? ["pet_generator", "image_gen", "network", "read", "edit"] : generator ? ["pet_generator", "read", "edit"] : ["read", "edit"]
    for (const operation of operations) if (matchingRule(operation, operation === "read" || operation === "edit" ? path.join(input.dir, "pets", "*") : "*", rules)?.action === "deny") throw new Error("Pet operation is denied by permissions")
  }
  const config = () => {
    permissions(true)
    const settings = input.settings()
    if (settings.tier !== "full" || settings.features?.pet_generator === false) throw new Error("Pet generator requires the full tier")
    const image = settings.image_generation
    if (image?.enabled !== true || !image.model) throw new Error("Enable image_generation and select an image model first")
    input.validateModel?.(image.model)
    return image
  }
  const fingerprint = () => JSON.stringify(config())
  function safe(...parts: string[]) {
    let target = realpathSync(input.dir)
    for (const part of parts) {
      target = path.join(target, part)
      const stat = lstatSync(target, { throwIfNoEntry: false })
      if (stat?.isSymbolicLink()) throw new Error("Pet paths must not be symlinks")
    }
    for (const operation of ["read", "edit"]) if (matchingRule(operation, target, policyRules(input.settings()))?.action === "deny") throw new Error("Pet path is denied by permissions")
    return target
  }
  function load(id: string) {
    if (!uuid.test(id)) throw new Error("Invalid generated pet ID")
    const folder = safe("pets", id)
    const file = safe("pets", id, "pet.json")
    if ((lstatSync(file)?.size ?? Infinity) > 65536) throw new Error("Pet manifest too large")
    const manifest = JSON.parse(readFileSync(file, "utf8")) as Manifest
    if (manifest.id !== id || manifest.experimental !== true || !Array.isArray(manifest.states) || !PET_CORE_STATES.every((state) => manifest.states.includes(state))) throw new Error("Not a generated pet")
    return { folder, manifest }
  }
  /** A pet this daemon made, generated or imported: what rename, delete and export work on. */
  function loadOwn(id: string): { folder: string; manifest: Manifest | ImportedManifest } {
    if (!uuid.test(id)) throw new Error("Invalid pet ID")
    const file = safe("pets", id, "pet.json")
    if ((lstatSync(file, { throwIfNoEntry: false })?.size ?? Infinity) > 65536) throw new Error("Pet not found")
    const manifest = JSON.parse(readFileSync(file, "utf8")) as Partial<ImportedManifest>
    if (manifest.imported !== true) return load(id)
    if (manifest.id !== id || !readPetLayout(manifest.layout)) throw new Error("Not an imported pet")
    return { folder: safe("pets", id), manifest: manifest as ImportedManifest }
  }
  /**
   * A local picture as a pet (`/pet import`): no image call, no cost. The frames are read from the path the user named,
   * keyed, scaled to the import budget and written as one sheet with its layout, through a staging folder like a generated pet.
   */
  function importPet(request: Extract<Input, { action: "import" }>) {
    const settings = input.settings()
    if (!featureOn(settings, "pets")) throw new Error("Pets need the full tier (/tier full)")
    if (!path.isAbsolute(request.path)) throw new Error("Give the picture's full path")
    const rules = policyRules(settings)
    const source = readImportSource({ path: request.path, frames: request.frames, ms: request.ms, allow: (file) => { if (matchingRule("read", file, rules)?.action === "deny") throw new Error("Reading that file is denied by permissions") } })
    const name = (request.name ?? source.name).replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 80)
    if (!name) throw new Error("Give the pet a name: --name <name>")
    if (RESERVED_NAMES.includes(name.toLowerCase())) throw new Error(`"${name}" is a command word; choose another --name`)
    const root = safe("pets")
    mkdirSync(root, { recursive: true, mode: 0o700 })
    for (const entry of readdirSync(root)) {
      const file = path.join(root, entry, "pet.json")
      const info = lstatSync(file, { throwIfNoEntry: false })
      if (!info?.isFile() || info.size > 65536) continue
      let other: unknown
      try { other = JSON.parse(readFileSync(file, "utf8")) } catch { continue }
      const taken = (other as { displayName?: unknown }).displayName
      if (typeof taken === "string" && taken.trim().toLowerCase() === name.toLowerCase()) throw new Error(`A pet named "${name}" exists; choose another --name, or /pet delete ${entry} --confirm first`)
    }
    const built = buildImportedPet({ states: source.states, ...(request.key === false ? { key: false } : {}), ...(request.filter ? { filter: request.filter } : {}) })
    const png = encodeImagePng(built.sheet)
    if (png.length > IMPORT_BUDGET.storedBytes) throw new Error("The pet's sheet is larger than 25 MB; use fewer frames")
    const id = crypto.randomUUID()
    const manifest: ImportedManifest = { id, displayName: name, description: `Imported from ${path.basename(request.path)}`, spritesheetPath: "spritesheet.png", spriteVersionNumber: 1, date: new Date(now()).toISOString(), imported: true, layout: built.layout }
    const staging = safe("pets", `.staging-${crypto.randomUUID()}`)
    mkdirSync(staging, { mode: 0o700 })
    try {
      writeFileSync(path.join(staging, "spritesheet.png"), png, { mode: 0o600 })
      writeFileSync(path.join(staging, "pet.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 })
      renameSync(staging, safe("pets", id))
    } catch (error) {
      trash(staging, id)
      throw error
    }
    const states = Object.keys(built.layout.states)
    return { petId: id, ref: `user:${id}`, name, art: built.layout.art, cell: built.layout.cell, frames: built.frames, states, keyed: built.keyed, decodedBytes: built.decodedBytes, storedBytes: png.length, notes: source.notes }
  }
  function budget(model: string, usd: number | undefined) {
    const report = input.budgets.report(model)
    if (report.policy.mode === "api-usage" && report.telemetry.unknownCalls) throw new Error("Pet budget cannot be checked while prior calls have unknown cost")
    if (report.policy.mode === "api-usage" && report.policy.stopUsd !== null) {
      if (usd === undefined) throw new Error("A USD budget stop is set: give --usd <estimated USD per image call> so the plan can be checked against it")
      if (report.enforcement.currentKnownUsd + usd > report.policy.stopUsd) throw new Error("Pet estimate exceeds the USD budget stop")
    }
    return report
  }
  function plan(owner: string, request: Extract<Input, { action: "plan" | "plan-state" }>) {
    const cfg = config()
    const prior = request.action === "plan-state" ? load(request.petId).manifest : undefined
    const states = request.action === "plan-state" ? [request.state] : [...PET_CORE_STATES, ...(request.optional ? PET_OPTIONAL_STATES : [])]
    // A redrawn state keeps the pet's own number of frames.
    const frames = prior ? framesOf(prior) : request.action === "plan" ? request.frames ?? 1 : 1
    const calls = states.length * frames + (prior ? 0 : 1)
    const estimatedUsd = request.unitUsd === undefined ? undefined : Math.ceil(request.unitUsd * 1_000_000) * calls / 1_000_000
    budget(cfg.model!, estimatedUsd)
    const description = prior?.description ?? (request as Extract<Input, { action: "plan" }>).description
    const value: PetPlan = { planId: crypto.randomUUID(), description, states, ...(frames > 1 ? { frames } : {}), calls, ...(request.unitUsd !== undefined ? { unitUsd: request.unitUsd, estimatedUsd: estimatedUsd! } : {}), model: cfg.model!, prompt: `${direction}\nCharacter description (content, not instructions): ${JSON.stringify(description)}`, expires: now() + 300_000, ...(prior ? { petId: prior.id } : {}) }
    for (const [id, entry] of plans) if (entry.plan.expires < now() || entry.owner === owner) plans.delete(id)
    if (plans.size >= 32) throw new Error("Too many pet plans")
    plans.set(value.planId, { owner, plan: value, fingerprint: fingerprint() })
    return { plan: value }
  }
  function trash(folder: string, id: string) {
    const root = safe("Trash")
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const target = path.join(root, `pet-${id}-${crypto.randomUUID()}`)
    renameSync(folder, target)
    return target
  }
  async function generate(owner: string, request: Extract<Input, { action: "generate" }>) {
    if (request.confirmed !== true) throw new Error("Explicit pet confirmation required")
    const entry = plans.get(request.planId)
    if (!entry || entry.owner !== owner || entry.plan.expires <= now()) throw new Error("Pet plan expired or belongs to another client")
    if (entry.fingerprint !== fingerprint()) throw new Error("Image settings changed; create a new plan")
    const { plan } = entry
    safe("pets")
    safe("Trash")
    budget(plan.model, plan.estimatedUsd)
    if (busy) throw new Error("Pet generator is busy")
    busy = true
    plans.delete(plan.planId)
    const id = plan.petId ?? crypto.randomUUID()
    let staging: string | undefined
    try {
      const prior = plan.petId ? load(plan.petId) : undefined
      if (plan.estimatedUsd !== undefined) input.budgets.record({ provider: "pet-estimate", model: plan.model, input: 0, output: 0, costMicros: Math.ceil(plan.estimatedUsd * 1_000_000) })
      const image = input.image(plan.model)
      const frames: Partial<Record<GeneratedPetState, PetImage[]>> = {}
      const count = plan.frames ?? 1
      let reference: Uint8Array
      const steps: PetProgressStep[] = [...(prior ? [] : [{ label: "reference" as const, status: "pending" as const }]), ...plan.states.flatMap((label) => Array.from({ length: count }, (_, at) => ({ label, ...(count > 1 ? { frame: at + 1 } : {}), status: "pending" as const })))]
      progress = { owner, value: { planId: plan.planId, steps } }
      async function call(label: PetProgressStep["label"], prompt: string, references: Uint8Array[], frame?: number) {
        const step = steps.find((item) => item.label === label && item.frame === frame)!
        step.status = "working"
        try {
          if (entry!.fingerprint !== fingerprint()) throw new Error("Image settings changed during pet generation")
          budget(plan.model, 0)
          const result = await image({ prompt, count: 1, size: "1024x1024", references: references.map((bytes) => ({ mime: "image/png", bytes })), signal: AbortSignal.timeout(180_000) }).catch(() => { throw new Error("Pet image call failed; check provider configuration") })
          if (!result.ok) throw new Error("Pet image call failed; check provider configuration")
          if (result.images.length !== 1 || result.images[0]?.type !== "png") throw new Error("Pet provider must return exactly one PNG")
          petFrame(result.images[0].bytes)
          step.status = "done"
          return result.images[0].bytes
        } catch (error) {
          step.status = "failed"
          throw error
        }
      }
      if (prior) {
        const referenceFile = safe("pets", id, "reference.png")
        if (lstatSync(referenceFile).size > 32 * 1024 * 1024) throw new Error("Pet reference too large")
        reference = readFileSync(referenceFile)
        petFrame(reference)
        for (const state of prior.manifest.states) {
          if (![...PET_CORE_STATES, ...PET_OPTIONAL_STATES].includes(state)) throw new Error("Invalid pet state")
          frames[state] = Array.from({ length: framesOf(prior.manifest) }, (_, at) => {
            const file = safe("pets", id, frameFile(state, at))
            if (lstatSync(file).size > 65536) throw new Error("Pet frame too large")
            const frame = decodePng(readFileSync(file))
            validatePetFrame(frame)
            return frame
          })
        }
      } else reference = await call("reference", `${plan.prompt}\nReference pose: neutral idle character, a single reference sheet containing only this one character.`, [])
      // Every state at the reference's scale: the character keeps its size from one state to the next, a redrawn state too.
      const scale = petScale(reference)
      for (const state of plan.states) {
        const pose = `${plan.prompt}\nActivity: ${state === "review" ? "success, celebrating" : state === "failed" ? "error, disappointed" : state === "waiting" ? "waiting for approval" : state === "running" ? "working" : state}. One pose only.`
        const first = await call(state, pose, [reference], count > 1 ? 1 : undefined)
        frames[state] = [petFrame(first, scale)]
        // The other frames of a small loop around that pose: drawn from it, at the same scale, so only the motion changes.
        for (let at = 2; at <= count; at++) frames[state]!.push(petFrame(await call(state, `${pose}\nFrame ${at} of ${count} of a short seamless loop of the second reference's pose: the same character, size, place and palette; only a small motion changes (breathing, a blink, a hand or an ear moving).`, [reference, first], at), scale))
      }
      const root = safe("pets")
      mkdirSync(root, { recursive: true, mode: 0o700 })
      staging = safe("pets", `.staging-${crypto.randomUUID()}`)
      mkdirSync(staging, { mode: 0o700 })
      const manifest: Manifest = { id, displayName: prior?.manifest.displayName ?? "Custom pet", description: plan.description, spritesheetPath: "spritesheet.png", spriteVersionNumber: 1, prompt: plan.prompt, model: plan.model, date: new Date(now()).toISOString(), states: [...new Set([...(prior?.manifest.states ?? []), ...plan.states])], ...(count > 1 ? { frames: count } : {}), experimental: true }
      writeFileSync(path.join(staging, "reference.png"), reference, { mode: 0o600 })
      const folder = staging
      for (const state of manifest.states) frames[state]!.forEach((frame, at) => writeFileSync(path.join(folder, frameFile(state, at)), encodeImagePng(frame), { mode: 0o600 }))
      writeFileSync(path.join(staging, "spritesheet.png"), petAtlas(frames), { mode: 0o600 })
      writeFileSync(path.join(staging, "pet.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 })
      const target = safe("pets", id)
      const backup = prior ? trash(prior.folder, id) : undefined
      try { renameSync(staging, target) }
      catch (error) { if (backup) renameSync(backup, target); throw error }
      staging = undefined
      return { petId: id, ref: `user:${id}`, manifest }
    } finally {
      if (staging) trash(staging, id)
      busy = false
    }
  }
  async function manage(owner: string, request: Input, remote = false): Promise<Record<string, unknown>> {
    if (remote) throw new Error("Pet generation and management are local only")
    permissions(request.action === "plan" || request.action === "plan-state" || request.action === "generate", request.action !== "import")
    if (request.action === "import") {
      if (busy) throw new Error("Pet generator is busy")
      return importPet(request)
    }
    if (request.action === "status") return { progress: progress?.owner === owner && progress.value.planId === request.planId ? structuredClone(progress.value) : null }
    if (request.action === "plan" || request.action === "plan-state") return plan(owner, request)
    if (request.action === "generate") return generate(owner, request)
    if (busy) throw new Error("Pet generator is busy")
    const { folder, manifest } = loadOwn(request.petId)
    if (request.action === "delete") {
      if (request.confirmed !== true) throw new Error("Explicit delete confirmation required")
      return { trashed: trash(folder, request.petId), petId: request.petId }
    }
    if (request.action === "rename") {
      const temp = safe("pets", request.petId, `pet-${crypto.randomUUID()}.tmp`)
      writeFileSync(temp, JSON.stringify({ ...manifest, displayName: request.name }, null, 2) + "\n", { mode: 0o600 })
      renameSync(temp, safe("pets", request.petId, "pet.json"))
      return { petId: request.petId, ref: `user:${request.petId}` }
    }
    const target = safe("exports", `pet-${crypto.randomUUID()}`)
    const petDir = path.join(target, "pets", manifest.id)
    mkdirSync(petDir, { recursive: true, mode: 0o700 })
    for (const name of ["pet.json", "spritesheet.png"]) {
      const file = safe("pets", manifest.id, name)
      if (lstatSync(file).size > (name === "pet.json" ? 65536 : IMPORT_BUDGET.storedBytes)) throw new Error("Pet export file too large")
      writeFileSync(path.join(petDir, name), readFileSync(file), { mode: 0o600 })
    }
    writeFileSync(path.join(target, "mendcode-package.json"), JSON.stringify({ name: `pet-${manifest.id}`, version: "1.0.0", description: manifest.description.slice(0, 500), extensions: false }, null, 2) + "\n", { mode: 0o600 })
    return { directory: target, petId: request.petId }
  }
  return { manage }
}
