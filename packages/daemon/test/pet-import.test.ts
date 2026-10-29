import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Settings } from "@mendcode/protocol"
import { onBackground, sampleSprite, sheetOf, smoothSample } from "../../../apps/cli/test/mascot-sample"
import { PetInput } from "../../protocol/src/pet"
import { readPetLayout } from "../../protocol/src/pet-data"
import { decodePng, type PetImage } from "../../tools/src/pet-decode"
import { IMPORT_BUDGET } from "../../tools/src/pet-import"
import { encodeImagePng } from "../../tools/src/pet-png"
import { contentBox, resample } from "../../tools/src/pet-resample"
import { encodeGif } from "../../tools/test/gif-fixture"
import { createBudgets } from "../src/budgets"
import { createPetGenerator } from "../src/pet-generator"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = (name: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), `mcev-q-${name}-`))
  dirs.push(dir)
  return dir
}

function fixture(initial: Settings = { tier: "full" }) {
  const dir = temp("import-data")
  const source = temp("import-src")
  let settings = initial
  let calls = 0
  const budgets = createBudgets({ dir, settings: () => settings, seed: () => ({ costMicros: 0, knownCalls: 0, unknownCalls: 0 }) })
  const generator = createPetGenerator({ dir, settings: () => settings, budgets, image: () => async () => { calls++; throw new Error("an import makes no image call") } })
  const png = (name: string, image: PetImage) => {
    const file = path.join(source, name)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, encodeImagePng(image))
    return file
  }
  const run = (file: string, extra: object = {}) => generator.manage("local", { action: "import", path: file, ...extra } as never) as Promise<Record<string, any>>
  const manifest = (id: string) => JSON.parse(readFileSync(path.join(dir, "pets", id, "pet.json"), "utf8"))
  const sheet = (id: string) => decodePng(new Uint8Array(readFileSync(path.join(dir, "pets", id, "spritesheet.png"))))
  return { dir, source, generator, png, run, manifest, sheet, calls: () => calls, set: (next: Settings) => { settings = next } }
}

const pixel = sampleSprite()
const closed = sampleSprite({ eyes: "closed" })

describe("/pet import", () => {
  test("one PNG becomes a still pet: a manifest with its layout, a sheet, private files, and not one image call", async () => {
    const item = fixture()
    const made = await item.run(item.png("Aiko.png", pixel))
    expect(made).toMatchObject({ ref: `user:${made.petId}`, name: "Aiko", art: "pixel", frames: 1, states: ["idle"], keyed: false, notes: [] })
    const manifest = item.manifest(made.petId)
    expect(manifest).toMatchObject({ id: made.petId, displayName: "Aiko", spritesheetPath: "spritesheet.png", spriteVersionNumber: 1, imported: true, description: "Imported from Aiko.png" })
    expect(manifest.experimental).toBeUndefined()
    expect(readPetLayout(manifest.layout)).toEqual({ art: "pixel", cell: { width: contentBox(pixel)!.width, height: contentBox(pixel)!.height }, columns: 1, states: { idle: [[0, 120]] } })
    expect(item.sheet(made.petId)).toMatchObject(manifest.layout.cell)
    expect(readdirSync(path.join(item.dir, "pets", made.petId)).sort()).toEqual(["pet.json", "spritesheet.png"])
    expect(statSync(path.join(item.dir, "pets", made.petId, "pet.json")).mode & 0o777).toBe(0o600)
    expect(readdirSync(path.join(item.dir, "pets")).filter((name) => name.startsWith(".staging"))).toEqual([])
    expect(item.calls()).toBe(0)
  })

  test("a sprite sheet animates: --frames cuts it, --ms times it, equal frames are stored once", async () => {
    const item = fixture()
    const made = await item.run(item.png("blink.png", sheetOf([pixel, pixel, closed, pixel])), { name: "Blink", frames: { columns: 4, rows: 1 }, ms: 250 })
    expect(made).toMatchObject({ name: "Blink", frames: 4, states: ["idle"] })
    expect(item.manifest(made.petId).layout.states.idle).toEqual([[0, 250], [0, 250], [1, 250], [0, 250]])
    await expect(item.run(item.png("blink2.png", sheetOf([pixel, closed, pixel])), { name: "Odd", frames: { columns: 5, rows: 1 } })).rejects.toThrow("does not divide into 5x1")
  })

  test("a flat background is keyed to transparent, unless --no-key", async () => {
    const item = fixture()
    const flat = item.png("flat.png", onBackground(pixel, [255, 0, 255]))
    const keyed = await item.run(flat, { name: "Keyed" })
    expect(keyed).toMatchObject({ keyed: true, cell: { width: contentBox(pixel)!.width, height: contentBox(pixel)!.height } })
    const sheet = item.sheet(keyed.petId)
    expect(sheet.rgba[3]).toBe(0)
    for (let at = 0; at < sheet.width * sheet.height; at++) expect(sheet.rgba[at * 4] === 255 && sheet.rgba[at * 4 + 1] === 0 && sheet.rgba[at * 4 + 2] === 255 && sheet.rgba[at * 4 + 3] === 255).toBe(false)
    const kept = await item.run(flat, { name: "Opaque", key: false })
    expect(kept).toMatchObject({ keyed: false, cell: { width: 64, height: 64 } })
    expect(item.sheet(kept.petId).rgba[3]).toBe(255)
  })

  test("an oversized picture is stored at the budget's frame side, never at its own resolution", async () => {
    const item = fixture()
    const made = await item.run(item.png("poster.png", resample(smoothSample(), 2400, 2400, "smooth")), { name: "Poster" })
    expect(made.art).toBe("smooth")
    expect(Math.max(made.cell.width, made.cell.height)).toBe(704)
    expect(made.decodedBytes).toBeLessThanOrEqual(IMPORT_BUDGET.decodedBytes)
    expect(made.storedBytes).toBeLessThan(IMPORT_BUDGET.storedBytes)
    expect(statSync(path.join(item.dir, "pets", made.petId, "spritesheet.png")).size).toBe(made.storedBytes)
  })

  test("a file that is not a picture, a missing one, a relative path and a too-large one are refused and leave nothing behind", async () => {
    const item = fixture()
    const text = path.join(item.source, "notes.png")
    writeFileSync(text, "not a png")
    await expect(item.run(text)).rejects.toThrow("PNG or GIF expected")
    const jpeg = path.join(item.source, "photo.jpg")
    writeFileSync(jpeg, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]))
    await expect(item.run(jpeg)).rejects.toThrow("convert JPEG or WebP first")
    await expect(item.run(path.join(item.source, "nowhere.png"))).rejects.toThrow()
    await expect(item.run("character.png")).rejects.toThrow("full path")
    const empty = item.png("empty.png", { width: 16, height: 16, rgba: new Uint8Array(16 * 16 * 4) })
    await expect(item.run(empty)).rejects.toThrow("empty")
    expect(existsSync(path.join(item.dir, "pets")) ? readdirSync(path.join(item.dir, "pets")) : []).toEqual([])
    expect(PetInput.safeParse({ action: "import", path: "" }).success).toBe(false)
    expect(PetInput.safeParse({ action: "import", path: "/a.png", frames: { columns: 0, rows: 1 } }).success).toBe(false)
    expect(PetInput.safeParse({ action: "import", path: "/a.png", filter: "vector" }).success).toBe(false)
    expect(PetInput.safeParse({ action: "import", path: "/a.png", name: "Aiko", frames: { columns: 4, rows: 2 }, key: false, filter: "smooth", ms: 90 }).success).toBe(true)
  })

  test("a name already taken, or one that is a command word, is refused with what to do", async () => {
    const item = fixture()
    const file = item.png("Aiko.png", pixel)
    const first = await item.run(file)
    await expect(item.run(file)).rejects.toThrow(`A pet named "Aiko" exists; choose another --name, or /pet delete ${first.petId} --confirm first`)
    await expect(item.run(file, { name: "aiko" })).rejects.toThrow("exists")
    await expect(item.run(file, { name: "Mend" })).rejects.toThrow("command word")
    await expect(item.run(item.png("off.png", pixel))).rejects.toThrow("command word")
    expect((await item.run(file, { name: "Aiko two" })).name).toBe("Aiko two")
    expect(readdirSync(path.join(item.dir, "pets"))).toHaveLength(2)
  })

  test("a folder of numbered PNG frames is one animation, in numeric order", async () => {
    const item = fixture()
    for (const [name, image] of [["frame10.png", closed], ["frame2.png", pixel], ["frame1.png", sampleSprite({ lift: 1 })]] as const) item.png(`walk/${name}`, image)
    writeFileSync(path.join(item.source, "walk", "readme.txt"), "ignored")
    const made = await item.run(path.join(item.source, "walk"), { ms: 90 })
    expect(made).toMatchObject({ name: "walk", frames: 3, states: ["idle"] })
    // frame1 (lifted), frame2 (open), frame10 (closed): three different pictures in that order.
    expect(item.manifest(made.petId).layout.states.idle).toEqual([[0, 90], [1, 90], [2, 90]])
    await expect(item.run(path.join(item.source, "walk"), { name: "Sheet", frames: { columns: 2, rows: 1 } })).rejects.toThrow("--frames cuts one sprite sheet")
    mkdirSync(path.join(item.source, "nothing"))
    await expect(item.run(path.join(item.source, "nothing"))).rejects.toThrow("No PNG frames or GIF")
  })

  test("a folder of state folders: names map onto the pet's states, an exact name wins over an alias, unknown ones are noted", async () => {
    const item = fixture()
    item.png("girl/idle/1.png", pixel)
    item.png("girl/idle/2.png", closed)
    item.png("girl/typing/a.png", sampleSprite({ lift: 1 }))
    item.png("girl/running/a.png", closed)
    item.png("girl/happy/a.png", sampleSprite({ lift: 1 }))
    item.png("girl/dancing/a.png", closed)
    item.png("girl/error.png", closed)
    item.png("girl/cover.png", pixel)
    mkdirSync(path.join(item.source, "girl", "waiting"))
    const made = await item.run(path.join(item.source, "girl"), { name: "Girl" })
    expect(made.states).toEqual(["idle", "running", "review", "failed"])
    expect(made.frames).toBe(5)
    expect(made.notes).toEqual(["ignored cover.png, dancing (not a state name)", "ignored waiting (no PNG frames or GIF)", "ignored typing (running is already running)"])
    const layout = item.manifest(made.petId).layout
    expect(layout.states.idle).toHaveLength(2)
    // `running/` (the closed eyes) was used, not `typing/`; the same picture as idle's second frame and as `error.png`: one cell.
    expect(layout.states.running[0][0]).toBe(layout.states.idle[1][0])
    expect(layout.states.failed[0][0]).toBe(layout.states.idle[1][0])
  })

  test("thinking, compacting, agents and sleeping are states of their own, by name or alias, and cost no image call", async () => {
    const item = fixture()
    const up = sampleSprite({ lift: 1 })
    item.png("owl/idle.png", pixel)
    item.png("owl/working/a.png", up)
    item.png("owl/thinking/1.png", closed)
    item.png("owl/thinking/2.png", up)
    item.png("owl/compact.png", closed)
    item.png("owl/subagents/a.png", up)
    item.png("owl/asleep.png", pixel)
    item.png("owl/sleeping/a.png", closed)
    const made = await item.run(path.join(item.source, "owl"), { name: "Owl" })
    expect(made.states).toEqual(["idle", "running", "thinking", "compacting", "agents", "sleeping"])
    expect(made.frames).toBe(7)
    expect(made.notes).toEqual(["ignored asleep.png (sleeping is already sleeping)"])
    const layout = readPetLayout(item.manifest(made.petId).layout)!
    expect(layout.states.thinking).toHaveLength(2)
    // `sleeping/` (the closed eyes) was used, not `asleep.png`: the cell `compact.png` and thinking's first frame have.
    expect(layout.states.sleeping![0]![0]).toBe(layout.states.compacting![0]![0])
    expect(layout.states.agents![0]![0]).toBe(layout.states.running![0]![0])
    expect(item.calls()).toBe(0)

    // `thinking` named the working animation before it was a state: without a `running` it still is, so the pet works as it did.
    item.png("fox/idle.png", pixel)
    item.png("fox/thinking.png", closed)
    const fox = await item.run(path.join(item.source, "fox"), { name: "Fox" })
    expect(fox.states).toEqual(["idle", "running"])
  })

  test("an animated GIF keeps its own frame times, alone or as a state's file", async () => {
    const item = fixture()
    const palette = [[0, 0, 0], [220, 60, 60], [60, 200, 90], [250, 250, 250]]
    const frame = (color: number) => {
      const indexes = new Uint8Array(24 * 24)
      for (let y = 4; y < 20; y++) indexes.fill(color, y * 24 + 6, y * 24 + 18)
      return indexes
    }
    const gif = encodeGif({ width: 24, height: 24, palette, frames: [{ indexes: frame(1), delayCs: 8, transparent: 0, disposal: 2 }, { indexes: frame(2), delayCs: 30, transparent: 0, disposal: 2 }, { indexes: frame(1), delayCs: 12, transparent: 0, disposal: 2 }] })
    const file = path.join(item.source, "blob.gif")
    writeFileSync(file, gif)
    const made = await item.run(file)
    // A flat 12 x 16 block reads as a 6 x 8 one drawn twice as large: pixel art is stored at its real size.
    expect(made).toMatchObject({ name: "blob", frames: 3, art: "pixel", cell: { width: 6, height: 8 } })
    expect(item.manifest(made.petId).layout.states.idle).toEqual([[0, 80], [1, 300], [0, 120]])
    mkdirSync(path.join(item.source, "states"))
    writeFileSync(path.join(item.source, "states", "thinking.gif"), gif)
    const state = await item.run(path.join(item.source, "states"), { name: "Thinker" })
    expect(state.states).toEqual(["running", "idle"])
    expect(item.manifest(state.petId).layout.states.idle).toEqual([[0, 120]])
  })

  test("more frames than the budget holds are refused before anything is written", async () => {
    const item = fixture()
    const gif = encodeGif({ width: 2, height: 2, palette: [[0, 0, 0], [255, 255, 255]], frames: Array.from({ length: IMPORT_BUDGET.frames + 1 }, (_, index) => ({ indexes: new Uint8Array(4).fill(index % 2), delayCs: 5 })) })
    const file = path.join(item.source, "long.gif")
    writeFileSync(file, gif)
    await expect(item.run(file)).rejects.toThrow(`at most ${IMPORT_BUDGET.frames}`)
    expect(existsSync(path.join(item.dir, "pets")) ? readdirSync(path.join(item.dir, "pets")) : []).toEqual([])
  })

  test("an imported pet is renamed, exported and deleted like a generated one, and cannot be regenerated", async () => {
    const item = fixture({ tier: "full", image_generation: { enabled: true, model: "openai/test-image" } })
    const made = await item.run(item.png("Aiko.png", pixel))
    expect(await item.generator.manage("local", { action: "rename", petId: made.petId, name: "Aiko Chan" })).toMatchObject({ ref: made.ref })
    expect(item.manifest(made.petId)).toMatchObject({ displayName: "Aiko Chan", imported: true })
    const exported = await item.generator.manage("local", { action: "export", petId: made.petId })
    expect(readdirSync(path.join(exported.directory as string, "pets", made.petId)).sort()).toEqual(["pet.json", "spritesheet.png"])
    await expect(item.generator.manage("local", { action: "plan-state", petId: made.petId, state: "idle" })).rejects.toThrow("Not a generated pet")
    await item.generator.manage("local", { action: "delete", petId: made.petId, confirmed: true })
    expect(existsSync(path.join(item.dir, "pets", made.petId))).toBe(false)
    expect(item.calls()).toBe(0)
  })

  test("it is the pet companion's: below the full tier, for a remote client and under a deny rule it does nothing", async () => {
    const item = fixture({ tier: "balanced" })
    const file = item.png("Aiko.png", pixel)
    await expect(item.run(file)).rejects.toThrow("full tier")
    item.set({ tier: "balanced", features: { pets: true } })
    expect((await item.run(file)).name).toBe("Aiko")
    await expect(item.generator.manage("remote", { action: "import", path: file }, true)).rejects.toThrow("local only")
    item.set({ tier: "full", tools: { read: false } })
    await expect(item.run(file, { name: "Denied" })).rejects.toThrow("denied")
    // A rule against the paid generator does not stop a free import; plan mode does not either.
    item.set({ tier: "full", defaultPermission: "plan", tools: { pet_generator: false } })
    expect((await item.run(file, { name: "Free" })).name).toBe("Free")
  })
})
